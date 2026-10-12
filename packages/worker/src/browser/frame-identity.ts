import type { FrameStep } from '@cairn/shared'

export const FRAME_URL_PATTERN_MAX = 512
/** 短于这个的 pathname 太容易误伤（`/`、`/a`），不做路径重叠回退。 */
export const FRAME_PATH_MIN_CHARS = 4

const EPHEMERAL_URL = /^(?:about:blank|about:srcdoc|javascript:|data:)/i

export type FrameHop = {
  name?: string
  src?: string
  href?: string
  selector?: string
}

/**
 * 从 iframe 的 src（重定向前）和当前 location（落地后）抽出可回放的身份。
 * 优先落地 path，去掉 query / hash，避免 token、时间戳把描述符写死。
 */
export function stableFrameUrlPattern(src: string, locationHref: string, max = FRAME_URL_PATTERN_MAX): string | undefined {
  const fromLocation = framePathIdentity(locationHref)
  if (fromLocation) return fromLocation.slice(0, max)
  const fromSrc = framePathIdentity(src)
  if (fromSrc) return fromSrc.slice(0, max)
  const raw = locationHref.trim() || src.trim()
  if (!raw || EPHEMERAL_URL.test(raw)) return undefined
  return raw.slice(0, max)
}

/** 只留 pathname；相对地址、带 query 的 src 都能收成同一条。 */
export function framePathIdentity(value: string): string | undefined {
  const trimmed = value.trim()
  if (!trimmed || EPHEMERAL_URL.test(trimmed)) return undefined
  try {
    const url = new URL(trimmed, 'http://cairn.invalid')
    if (url.protocol === 'about:' || url.protocol === 'javascript:' || url.protocol === 'data:') return undefined
    const path = url.pathname
    if (!path || path === '/') return undefined
    return path
  } catch {
    const cut = trimmed.split(/[?#]/)[0]?.trim()
    if (!cut || cut === '/') return undefined
    return cut
  }
}

/**
 * urlPattern 命中当前 frame URL，或仍写在 iframe 元素上的 src（跳转后属性通常不变）。
 * 旧描述符记的是跳转 src，新描述符记的是落地 path，两边都要能回放。
 */
export function frameUrlPatternHits(pattern: string, currentUrl: string, ...iframeSrcs: Array<string | undefined>): boolean {
  if (!pattern) return true
  // `/` 会出现在几乎所有 URL 里，短 pattern 只走后面的 path 重叠，避免误伤。
  if (pattern.length >= FRAME_PATH_MIN_CHARS) {
    if (currentUrl.includes(pattern)) return true
    for (const src of iframeSrcs) {
      if (src && src.includes(pattern)) return true
    }
  }
  const patternId = framePathIdentity(pattern)
  if (!patternId || patternId.length < FRAME_PATH_MIN_CHARS) return false
  if (pathsOverlap(patternId, framePathIdentity(currentUrl))) return true
  for (const src of iframeSrcs) {
    if (pathsOverlap(patternId, framePathIdentity(src ?? ''))) return true
  }
  return false
}

export function frameStepsFromHops(hops: FrameHop[], maxDepth = 4): FrameStep[] {
  const steps: FrameStep[] = []
  for (const hop of hops.slice(0, maxDepth)) {
    const urlPattern = stableFrameUrlPattern(hop.src ?? '', hop.href ?? '')
    const step: FrameStep = {
      ...(hop.name ? { name: hop.name } : {}),
      ...(urlPattern ? { urlPattern } : {}),
      ...(hop.selector ? { selector: hop.selector } : {}),
    }
    if (step.urlPattern || step.name || step.selector) steps.push(step)
  }
  return steps
}

function pathsOverlap(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false
  if (left.length < FRAME_PATH_MIN_CHARS || right.length < FRAME_PATH_MIN_CHARS) return false
  return left === right || left.includes(right) || right.includes(left)
}
