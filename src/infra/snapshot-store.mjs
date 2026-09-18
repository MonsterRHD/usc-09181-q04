import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * 内容寻址快照库：以输入快照哈希为键保存“模型当时看到的输入”。
 * 同一哈希天然只存一份，重复写幂等。任何预警都能通过 snapshotHash
 * 取回当时的完整输入，而不是一段无法回溯的分数。
 */
export class SnapshotStore {
  constructor({ dir }) {
    this.dir = path.join(dir, 'snapshots');
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
  }

  snapshotPath(snapshotHash) {
    return path.join(this.dir, `${snapshotHash}.json`);
  }

  async put(snapshotHash, record) {
    await fs.writeFile(this.snapshotPath(snapshotHash), JSON.stringify(record, null, 2), {
      flag: 'wx',
    }).catch((err) => {
      if (err.code !== 'EEXIST') throw err;
    });
  }

  async get(snapshotHash) {
    try {
      return JSON.parse(await fs.readFile(this.snapshotPath(snapshotHash), 'utf8'));
    } catch {
      return null;
    }
  }
}
