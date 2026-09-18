import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { hashValue } from './canonical.mjs';

/**
 * 只追加事件存储（JSONL，每行一条事件）。
 *
 * 事件结构：
 *   { eventId, seq, applicationId, type, actor, at, data, prevHash, hash }
 *
 * hash = H(规范化负载 || prevHash)，逐条成链：
 *   - 已提交事件的任何静默改写都会在重载/校验时让链断裂；
 *   - seq 为存储级全局序号（审计事实的总顺序）；
 *   - 申请版本内的顺序由聚合在重放时另行计算。
 *
 * 幂等：append 以 eventId 去重，重复回调只返回旧事件，绝不产生第二条。
 * 持久化：appendFileSync 对单行小写入在 O_APPEND 下为单次写，
 *         Node 单线程同步执行，天然串行，不存在并发写竞争。
 */
export class EventStore {
  constructor(file) {
    this.file = file;
    this.events = [];
    this.byEventId = new Map();
    this.tailHash = 'GENESIS';
    this.seq = 0;
    if (file && existsSync(file)) this._load();
  }

  _load() {
    const lines = readFileSync(this.file, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const evt = JSON.parse(trimmed);
      if (evt.prevHash !== this.tailHash) {
        throw new Error(
          `事件链断裂 @seq=${evt.seq}：prevHash 不匹配（日志被截断、乱序或篡改）`,
        );
      }
      if (evt.hash !== computeHash(evt, evt.prevHash)) {
        throw new Error(`事件内容被篡改 @seq=${evt.seq} eventId=${evt.eventId}`);
      }
      this.events.push(evt);
      this.byEventId.set(evt.eventId, evt);
      this.tailHash = evt.hash;
      this.seq = evt.seq;
    }
  }

  /**
   * 同步追加。返回 { event, duplicate }。
   * 调用方应给每个外部动作提供稳定 eventId（回调号、请求幂等键）。
   */
  append(type, { applicationId, data = {}, actor = { role: 'SYSTEM' }, eventId, at }) {
    if (eventId && this.byEventId.has(eventId)) {
      return { event: this.byEventId.get(eventId), duplicate: true };
    }
    const seq = this.seq + 1;
    const evt = {
      eventId: eventId || `evt_${seq}`,
      seq,
      applicationId,
      type,
      actor,
      at: at || new Date().toISOString(),
      data,
      prevHash: this.tailHash,
    };
    evt.hash = computeHash(evt, this.tailHash);
    if (this.file) appendFileSync(this.file, `${JSON.stringify(evt)}\n`);
    this.events.push(evt);
    this.byEventId.set(evt.eventId, evt);
    this.tailHash = evt.hash;
    this.seq = seq;
    return { event: evt, duplicate: false };
  }

  stream(applicationId) {
    return this.events.filter((e) => e.applicationId === applicationId);
  }

  all() {
    return this.events.slice();
  }

  /** 全量哈希链校验，审计端点使用。 */
  verify() {
    let prev = 'GENESIS';
    for (const evt of this.events) {
      if (evt.prevHash !== prev || evt.hash !== computeHash(evt, evt.prevHash)) {
        return { ok: false, brokenAt: evt.seq, eventId: evt.eventId, count: this.events.length };
      }
      prev = evt.hash;
    }
    return { ok: true, count: this.events.length, tailHash: this.tailHash };
  }
}

/** 哈希只覆盖业务负载字段（不含 hash 自身）；键顺序由 stableStringify 固定。 */
function computeHash(evt, prevHash) {
  const payload = {
    eventId: evt.eventId,
    seq: evt.seq,
    applicationId: evt.applicationId,
    type: evt.type,
    actor: evt.actor,
    at: evt.at,
    data: evt.data,
  };
  return hashValue({ payload, prevHash });
}
