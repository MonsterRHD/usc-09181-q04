import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventStore } from '../src/infra/event-store.mjs';
import { SnapshotStore } from '../src/infra/snapshot-store.mjs';
import { ConcurrentModificationError } from '../src/domain/errors.mjs';

async function freshStore() {
  const dir = await mkdtemp(path.join(tmpdir(), 'evt-'));
  const store = new EventStore({ dir });
  await store.init();
  return { dir, store };
}

const ev = (type, payload = {}) => ({ type, payload, actor: { userId: 'u' }, occurredAt: new Date().toISOString() });

test('追加后可按序读回，序列号连续且哈希链完整', async () => {
  const { store } = await freshStore();
  await store.createStream('A1');
  const first = await store.append('A1', [ev('OPEN'), ev('MAT', { x: 1 })], { expectedRevision: 0 });
  assert.equal(first.length, 2);
  const loaded = await store.load('A1');
  assert.deepEqual(loaded.map((e) => e.sequenceNumber), [1, 2]);
  assert.equal(loaded[0].prevHash, null);
  assert.equal(loaded[1].prevHash, loaded[0].hash);
});

test('expectedRevision 不匹配时抛并发冲突', async () => {
  const { store } = await freshStore();
  await store.createStream('A1');
  await store.append('A1', [ev('OPEN')], { expectedRevision: 0 });
  await assert.rejects(
    () => store.append('A1', [ev('MAT')], { expectedRevision: 0 }),
    (err) => err instanceof ConcurrentModificationError
  );
});

test('createStream 对已存在流冲突', async () => {
  const { store } = await freshStore();
  await store.createStream('A1');
  await assert.rejects(() => store.createStream('A1'), ConcurrentModificationError);
});

test('篡改任意事件内容会在加载校验时暴露', async () => {
  const { store, dir } = await freshStore();
  await store.createStream('A1');
  await store.append('A1', [ev('OPEN'), ev('MAT', { score: 30 }), ev('MAT', { score: 90 })], {
    expectedRevision: 0,
  });

  // 字节级改写第二条的 payload
  const file = path.join(dir, 'events', 'A1.jsonl');
  let raw = await readFile(file, 'utf8');
  const tampered = raw.replace('"score":30', '"score":99');
  assert.notEqual(tampered, raw);
  await import('node:fs/promises').then((fs) => fs.writeFile(file, tampered));

  await assert.rejects(() => store.load('A1'), /哈希校验失败|prevHash 不匹配/);
});

test('删除中间事件导致序列号断裂被发现', async () => {
  const { store, dir } = await freshStore();
  await store.createStream('A1');
  await store.append('A1', [ev('OPEN'), ev('MAT'), ev('MAT')], { expectedRevision: 0 });
  const file = path.join(dir, 'events', 'A1.jsonl');
  const lines = (await readFile(file, 'utf8')).trim().split('\n');
  await import('node:fs/promises').then((fs) => fs.writeFile(file, `${lines[0]}\n${lines[2]}\n`));
  await assert.rejects(() => store.load('A1'), /序列号断裂|prevHash/);
});

test('同流并发追加在串行锁下不交错、不丢事件', async () => {
  const { store } = await freshStore();
  await store.createStream('A1');
  await store.append('A1', [ev('OPEN')], { expectedRevision: 0 });

  // 三路并发，每路读最新长度后追加；锁内重读保证最终全部落库。
  const writers = [0, 1, 2].map((i) =>
    store.withLock('A1', async () => {
      const cur = await store.load('A1', { verify: false });
      return store.append('A1', [ev(`MAT${i}`)], { expectedRevision: cur.length });
    })
  );
  await Promise.all(writers);
  const loaded = await store.load('A1');
  assert.equal(loaded.length, 4, 'OPEN + 3 个 MAT，无丢失');
  assert.deepEqual(loaded.slice(1).map((e) => e.type), ['MAT0', 'MAT1', 'MAT2']);
});

test('前一个临界区抛错不会毒化同流后续锁', async () => {
  const { store } = await freshStore();
  await store.createStream('A1');
  await store.append('A1', [ev('OPEN')], { expectedRevision: 0 });
  await assert.rejects(
    store.withLock('A1', async () => {
      throw new Error('boom');
    }),
    /boom/
  );
  const result = await store.withLock('A1', async () => 'recovered');
  assert.equal(result, 'recovered');
});

test('快照库内容寻址、重复写幂等', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'snap-'));
  const snaps = new SnapshotStore({ dir });
  await snaps.init();
  await snaps.put('h1', { snapshotHash: 'h1', input: { a: 1 } });
  await snaps.put('h1', { snapshotHash: 'h1', input: { a: 1 } }); // 不抛
  const got = await snaps.get('h1');
  assert.deepEqual(got.input, { a: 1 });
  assert.equal(await snaps.get('missing'), null);
});

test('追加非法 JSON 行会被识别', async () => {
  const { store, dir } = await freshStore();
  await store.createStream('A1');
  await store.append('A1', [ev('OPEN')], { expectedRevision: 0 });
  await appendFile(path.join(dir, 'events', 'A1.jsonl'), '{not json\n');
  await assert.rejects(() => store.load('A1'), /合法 JSON/);
});
