import { promises as fs } from 'node:fs';
import path from 'node:path';
import { stableStringify, sha256, newId } from '../lib/canonical.mjs';
import { ConcurrentModificationError, NotFoundError } from '../domain/errors.mjs';

/**
 * 仅追加事件存储（JSONL，每申请一个流文件）。
 *
 * 三条保证：
 *  1. 事件永不就地修改，状态只能通过折叠事件得到（重启即重放）；
 *  2. 每条事件含 prevHash/hash 哈希链，任何字节级篡改在加载校验时暴露；
 *  3. 同一流的命令在进程内串行提交，配合 expectedRevision 乐观并发控制，
 *     “补件与撤回回调并发到达”时有确定次序、不会互相覆盖。
 */

function eventHash({ eventId, applicationId, sequenceNumber, type, payload, actor, occurredAt, prevHash }) {
  return sha256(
    stableStringify({
      eventId,
      applicationId,
      sequenceNumber,
      type,
      payload,
      actor: actor ?? null,
      occurredAt,
      prevHash,
    })
  );
}

export class EventStore {
  constructor({ dir } = {}) {
    this.dir = dir;
    this.eventsDir = path.join(dir, 'events');
    /** applicationId -> Promise 链：把同流的并发提交排队。 */
    this.locks = new Map();
  }

  async init() {
    await fs.mkdir(this.eventsDir, { recursive: true });
  }

  streamPath(applicationId) {
    return path.join(this.eventsDir, `${applicationId}.jsonl`);
  }

  async exists(applicationId) {
    try {
      await fs.access(this.streamPath(applicationId));
      return true;
    } catch {
      return false;
    }
  }

  /** 加载并校验整条事件流；任一哈希不匹配立即报错（审计链断裂，拒绝服务该流）。 */
  async load(applicationId, { verify = true } = {}) {
    let raw;
    try {
      raw = await fs.readFile(this.streamPath(applicationId), 'utf8');
    } catch {
      throw new NotFoundError(`授信申请不存在: ${applicationId}`);
    }
    const events = [];
    let prevHash = null;
    for (const [index, line] of raw.split('\n').entries()) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch (err) {
        throw new Error(`事件流 ${applicationId} 第 ${index + 1} 行不是合法 JSON: ${err.message}`);
      }
      if (verify) {
        if (event.sequenceNumber !== index + 1) {
          throw new Error(`事件流 ${applicationId} 第 ${index + 1} 行序列号断裂`);
        }
        if (event.prevHash !== prevHash) {
          throw new Error(`事件流 ${applicationId} 第 ${index + 1} 行 prevHash 不匹配（事件链被改写）`);
        }
        if (event.hash !== eventHash(event)) {
          throw new Error(`事件流 ${applicationId} 第 ${index + 1} 行哈希校验失败（事件内容被篡改）`);
        }
      }
      prevHash = event.hash;
      events.push(event);
    }
    return events;
  }

  async listApplicationIds() {
    const files = await fs.readdir(this.eventsDir).catch(() => []);
    return files.filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -'.jsonl'.length));
  }

  withLock(applicationId, fn) {
    const prior = this.locks.get(applicationId) ?? Promise.resolve();
    const next = prior.then(fn, fn); // 无论前一个成功与否都放行，失败不毒化队列
    // 锁条目在整条链结束后保留为已完成的 promise，内存占用可忽略。
    this.locks.set(applicationId, next.catch(() => {}));
    return next;
  }

  /**
   * 原子追加一组事件（调用方必须已持有该流的 withLock 临界区）。
   * expectedRevision 为调用前读取到的事件数；文件当前行数不符则并发冲突。
   */
  async append(applicationId, candidateEvents, { expectedRevision } = {}) {
    if (candidateEvents.length === 0) return [];

    const stored = [];
    const current = await this.load(applicationId, { verify: false }).catch((err) => {
      if (err instanceof NotFoundError) return [];
      throw err;
    });

    if (expectedRevision !== undefined && expectedRevision !== current.length) {
      throw new ConcurrentModificationError(
        `事件流版本冲突：期望 ${expectedRevision}，实际 ${current.length}`
      );
    }

    let prevHash = current.at(-1)?.hash ?? null;
    let sequenceNumber = current.length;
    const lines = [];
    for (const ce of candidateEvents) {
      sequenceNumber += 1;
      const envelope = {
        eventId: newId('evt_'),
        applicationId,
        sequenceNumber,
        type: ce.type,
        payload: ce.payload,
        actor: ce.actor ?? null,
        occurredAt: ce.occurredAt,
        prevHash,
      };
      envelope.hash = eventHash(envelope);
      prevHash = envelope.hash;
      lines.push(JSON.stringify(envelope));
      stored.push(envelope);
    }

    await fs.appendFile(this.streamPath(applicationId), `${lines.join('\n')}\n`);
    return stored;
  }

  /** 开立流：若文件已存在则冲突（applicationId 由调用方给定，便于回调寻址）。 */
  async createStream(applicationId) {
    try {
      await fs.writeFile(this.streamPath(applicationId), '', { flag: 'wx' });
    } catch (err) {
      if (err.code === 'EEXIST') {
        throw new ConcurrentModificationError(`授信申请已存在: ${applicationId}`);
      }
      throw err;
    }
  }
}
