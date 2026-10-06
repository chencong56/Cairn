/**
 * 生成 RFC 4122 v4 UUID。
 *
 * 不能直接调用 `crypto.randomUUID`：它只在安全上下文（HTTPS / localhost）可用，而识途控制台在私有化交付里
 * 常跑在局域网明文 HTTP 上，那里它是 undefined，直接调用会抛 TypeError，表现为按钮点击后毫无反应。
 * `getRandomValues` 不受该限制；ESLint 禁止在本文件之外直接使用 `crypto.randomUUID`。
 */
export function newUuid(): string {
  const c = globalThis.crypto
  if (typeof c.randomUUID === 'function') return c.randomUUID()
  const bytes = c.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
  return [hex.slice(0, 4), hex.slice(4, 6), hex.slice(6, 8), hex.slice(8, 10), hex.slice(10)]
    .map((part) => part.join(''))
    .join('-')
}
