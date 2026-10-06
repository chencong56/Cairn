/** 路径与 origin 的纯工具函数。目标「访问范围」规则机制已移除，这里只保留与规则无关的判定。 */

export function isPublishedAccessPathPrefix(value: string): boolean {
  return value.startsWith('/') && value.length <= 512 && !/[?#]/.test(value)
}

export function accessPathMatches(pathname: string, prefix: string): boolean {
  if (prefix === '/') return true
  const normalized = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
  return pathname === normalized || pathname.startsWith(`${normalized}/`)
}

export function accessPathMatchesExact(pathname: string, prefix: string): boolean {
  const normalized = prefix === '/' ? '/' : prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
  if (normalized === '/') return pathname === '/' || pathname === ''
  return pathname === normalized || pathname === `${normalized}/`
}

export function parseHttpUrl(url: string): URL | null {
  try {
    const parsed = new URL(url)
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export function canonicalOrigin(value: string): string | null {
  return parseHttpUrl(value)?.origin ?? null
}
