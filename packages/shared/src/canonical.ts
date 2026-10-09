import { syncSha256 } from './sha256-sync.js'

/**
 * 键排序的 JSON。给摘要用，不引入 node:crypto。
 * `undefined` 字段省略，与 JSON.stringify 对对象的习惯一致。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

/**
 * SHA-256 摘要（hex）。优先走 SubtleCrypto；明文 HTTP（非安全上下文）下
 * `crypto.subtle` 是 undefined——私有化交付的控制台常跑在局域网明文 HTTP 上，
 * 直接调用会抛 TypeError，前端表现为「点击采纳后毫无反应」。此时退回纯 TS
 * 同步实现，输出与 SubtleCrypto 逐字节一致。
 */
export async function sha256Hex(raw: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return syncSha256(raw)
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(raw))
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
