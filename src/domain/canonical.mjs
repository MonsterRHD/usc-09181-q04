import { createHash, randomBytes } from 'node:crypto';

/**
 * 规范化 JSON：对象键递归排序，数组保持顺序。
 * 任何需要被哈希/固化的结构（快照、事件、摘要）都必须经过它，
 * 保证同一语义内容在重放时得到完全一致的哈希。
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function hashValue(value) {
  return sha256(stableStringify(value));
}

export function randomId(prefix) {
  return `${prefix}_${randomBytes(10).toString('hex')}`;
}

export function nowIso() {
  return new Date().toISOString();
}
