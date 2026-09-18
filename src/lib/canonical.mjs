import crypto from 'node:crypto';

/**
 * 递归稳定序列化：对象键按字典序输出，保证同一份输入在任何进程中得到同一字符串。
 * 证据快照哈希、事件链哈希都依赖它，禁止改成 JSON.stringify。
 */
export function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const body = Object.keys(value)
      .sort()
      // 与 JSON.stringify 持久化形态保持一致：undefined 值的键不参与序列化，
      // 否则“写盘前含 undefined 键、读盘后键消失”会导致哈希链校验失败。
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function newId(prefix = '') {
  return `${prefix}${crypto.randomUUID()}`;
}
