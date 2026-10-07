import { z } from 'zod'
import type { JsonValue } from './wire.js'

/**
 * 页面健康约束：运行期间页面发出的接口 / 资源错误与脚本未捕获异常。
 *
 * 只监听、不拦截；违规才产生结果行，没有违规什么都不记（见 docs/spec 页面接口与脚本错误守卫）。
 * 本文件只放不依赖浏览器的纯逻辑：配置契约、地址归一化、忽略规则、样本合并、可读摘要、结果识别。
 */

export const PAGE_HEALTH_KINDS = ['network_health', 'script_errors'] as const
export type PageHealthKind = (typeof PAGE_HEALTH_KINDS)[number]

export function isPageHealthKind(kind: string | null | undefined): kind is PageHealthKind {
  return kind === 'network_health' || kind === 'script_errors'
}

/** 结果行 `expected.kind` 等于约束 kind；可靠性、模块质量、助手等消费方据此排除页面健康结果。 */
export function isPageHealthResult(result: { expected?: JsonValue | unknown } | null | undefined): boolean {
  const expected = result?.expected
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return false
  return isPageHealthKind((expected as { kind?: unknown }).kind as string | undefined)
}

export const PAGE_HEALTH_RESOURCE_TYPES = ['document', 'xhr', 'fetch', 'script', 'stylesheet', 'image', 'font', 'other'] as const
export type PageHealthResourceType = (typeof PAGE_HEALTH_RESOURCE_TYPES)[number]
export const DEFAULT_PAGE_HEALTH_RESOURCE_TYPES: readonly PageHealthResourceType[] = [
  'document',
  'xhr',
  'fetch',
  'script',
  'stylesheet',
]

export const PAGE_HEALTH_STATUS_CLASSES = ['4xx', '5xx'] as const
export type PageHealthStatusClass = (typeof PAGE_HEALTH_STATUS_CLASSES)[number]

export const MAX_PAGE_HEALTH_IGNORE = 50
export const MAX_PAGE_HEALTH_EXTRA_ORIGINS = 20
/** 每个取数窗口最多保留的去重样本数。 */
export const MAX_PAGE_HEALTH_SAMPLES = 50
/** 结果行 actual 里带的样本数。 */
export const PAGE_HEALTH_RESULT_SAMPLES = 10
/** 每次运行最多逐条落结果行与证据的有违规取数次数。 */
export const MAX_PAGE_HEALTH_RECORDED_WINDOWS = 50

/** 关键接口耗时阈值：匹配「源 + 路径」（规则同忽略清单），可限定方法；是浏览器视角的耗时，不是服务端 SLA。 */
export const pageHealthSlowRuleSchema = z.strictObject({
  match: z.string().trim().min(1).max(256),
  method: z.string().trim().toUpperCase().regex(/^[A-Z]{1,10}$/).optional(),
  maxMs: z.number().int().min(1).max(600_000),
})
export type PageHealthSlowRule = z.infer<typeof pageHealthSlowRuleSchema>
export const MAX_PAGE_HEALTH_SLOW_RULES = 20

export const networkHealthConfigSchema = z.strictObject({
  slowRules: z.array(pageHealthSlowRuleSchema).max(MAX_PAGE_HEALTH_SLOW_RULES).optional(),
  /** 每条耗时规则整次运行允许超阈的次数，超过才算违规；默认 0（每次命中都不得超阈）。 */
  slowAllowExceed: z.number().int().min(0).max(1000).optional(),
  statusClasses: z.array(z.enum(PAGE_HEALTH_STATUS_CLASSES)).min(1).max(2).optional(),
  requestFailed: z.boolean().optional(),
  resourceTypes: z.array(z.enum(PAGE_HEALTH_RESOURCE_TYPES)).min(1).max(PAGE_HEALTH_RESOURCE_TYPES.length).optional(),
  includeExternal: z.boolean().optional(),
  extraOrigins: z.array(z.string().trim().min(1).max(256)).max(MAX_PAGE_HEALTH_EXTRA_ORIGINS).optional(),
  ignore: z.array(z.string().trim().min(1).max(256)).max(MAX_PAGE_HEALTH_IGNORE).optional(),
})
export type NetworkHealthConfig = z.infer<typeof networkHealthConfigSchema>

export const scriptErrorsConfigSchema = z.strictObject({
  includeConsoleError: z.boolean().optional(),
  ignore: z.array(z.string().trim().min(1).max(256)).max(MAX_PAGE_HEALTH_IGNORE).optional(),
})
export type ScriptErrorsConfig = z.infer<typeof scriptErrorsConfigSchema>

export type ResolvedNetworkHealthConfig = {
  statusClasses: readonly PageHealthStatusClass[]
  requestFailed: boolean
  resourceTypes: readonly PageHealthResourceType[]
  includeExternal: boolean
  extraOrigins: readonly string[]
  ignore: readonly string[]
  slowRules: readonly PageHealthSlowRule[]
  slowAllowExceed: number
}

export type ResolvedScriptErrorsConfig = {
  includeConsoleError: boolean
  ignore: readonly string[]
}

export function resolveNetworkHealthConfig(config?: NetworkHealthConfig | null): ResolvedNetworkHealthConfig {
  return {
    statusClasses: config?.statusClasses ?? PAGE_HEALTH_STATUS_CLASSES,
    requestFailed: config?.requestFailed ?? true,
    resourceTypes: config?.resourceTypes ?? DEFAULT_PAGE_HEALTH_RESOURCE_TYPES,
    includeExternal: config?.includeExternal ?? false,
    extraOrigins: config?.extraOrigins ?? [],
    ignore: config?.ignore ?? [],
    slowRules: config?.slowRules ?? [],
    slowAllowExceed: config?.slowAllowExceed ?? 0,
  }
}

export function resolveScriptErrorsConfig(config?: ScriptErrorsConfig | null): ResolvedScriptErrorsConfig {
  return {
    includeConsoleError: config?.includeConsoleError ?? false,
    ignore: config?.ignore ?? [],
  }
}

// ---------------------------------------------------------------------------
// 地址归一化与忽略规则
// ---------------------------------------------------------------------------

export type NormalizedPageUrl = { origin: string; path: string; display: string }

const NUMERIC_SEGMENT = /^\d{4,}$/
const LONG_RANDOM_SEGMENT = /^[A-Za-z0-9_-]{24,}$/
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 路径里像 ID 的段（纯数字 ≥ 4 位、UUID、长随机串）替换为 `*`，同时满足脱敏与合并。 */
export function normalizePagePath(pathname: string): string {
  const segments = pathname.split('/').map((segment) => {
    if (!segment) return segment
    let decoded = segment
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      // 保留原样
    }
    if (NUMERIC_SEGMENT.test(decoded) || UUID_SEGMENT.test(decoded) || LONG_RANDOM_SEGMENT.test(decoded)) return '*'
    return decoded.length > 80 ? `${decoded.slice(0, 80)}…` : decoded
  })
  return segments.join('/') || '/'
}

/** 去掉查询串、片段、账号信息；非 http(s) 返回 null。 */
export function normalizePageUrl(raw: string): NormalizedPageUrl | null {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  const path = normalizePagePath(parsed.pathname)
  return { origin: parsed.origin, path, display: `${parsed.origin}${path}` }
}

function globToRegExp(pattern: string): RegExp {
  let out = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        out += '.*'
        index += 1
      } else {
        out += '[^/]*'
      }
    } else {
      out += char.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${out}$`)
}

/**
 * 忽略规则匹配「源 + 路径」（不含查询串）。以 `/` 开头的规则只匹配路径，方便不写域名。
 * `*` 不跨 `/`，`**` 跨 `/`。
 */
export function matchesPageHealthIgnore(url: { origin: string; path: string }, patterns: readonly string[]): boolean {
  for (const pattern of patterns) {
    const target = pattern.startsWith('/') ? url.path : `${url.origin}${url.path}`
    if (globToRegExp(pattern).test(target)) return true
  }
  return false
}

/** 脚本异常消息：包含任一忽略文本即忽略（不区分大小写）。 */
export function matchesScriptIgnore(message: string, patterns: readonly string[]): boolean {
  const lower = message.toLowerCase()
  return patterns.some((pattern) => lower.includes(pattern.toLowerCase()))
}

const SECRETISH = /(password|passwd|token|secret|authorization)\s*[=:]\s*\S+/gi
const EMAILISH = /\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g

export function redactPageHealthText(text: string, max = 300): string {
  return text.replace(SECRETISH, '$1=***').replace(EMAILISH, '[redacted-email]').replace(/\s+/g, ' ').trim().slice(0, max)
}

// ---------------------------------------------------------------------------
// 样本、事实与摘要
// ---------------------------------------------------------------------------

export type PageHealthSample = {
  type: 'http' | 'request_failed' | 'script_error' | 'slow'
  /** 慢请求：实际耗时与阈值（毫秒，浏览器视角）。 */
  durationMs?: number
  maxMs?: number
  /** 归一化地址（源 + 路径）；脚本异常为来源文件，可能缺省。 */
  url?: string
  method?: string
  status?: number
  /** 请求失败的错误文本或脚本异常消息（已脱敏、截断）。 */
  text?: string
  resourceType?: string
  count: number
  /** 发起（或发生）时所在的步骤。 */
  stepId?: string
  stepRunId?: string
  attemptId?: string
  /** 发生在两个浏览器步骤之间的间隙。 */
  afterStep?: boolean
}

export type PageHealthFact = {
  kind: PageHealthKind
  /** 违规总数（含合并计数，含超出样本上限的部分）。 */
  total: number
  /** 按类别计数：http 为 `4xx` / `5xx`，其余为 `failed` / `script`。 */
  byClass: Record<string, number>
  samples: PageHealthSample[]
}

/** Worker 采集器一次取数的结果（引擎与浏览器适配层之间的契约）。 */
export type PageHealthDrain = {
  network?: PageHealthFact
  script?: PageHealthFact
  /** 未能缓存、因此既没有样本也没有分类的违规数。 */
  dropped: number
}

export type PageHealthStepInfo = { stepId: string; stepRunId?: string; attemptId?: string }

export function pageHealthSampleKey(sample: PageHealthSample): string {
  return [sample.type, sample.method ?? '', sample.url ?? '', sample.status ?? '', sample.text ?? '', sample.stepRunId ?? sample.stepId ?? '', sample.afterStep ? 'g' : ''].join('|')
}

export function statusClassOf(status: number): PageHealthStatusClass | null {
  if (status >= 400 && status < 500) return '4xx'
  if (status >= 500 && status < 600) return '5xx'
  return null
}

/** 合并相同样本、累加计数；超出上限的样本只进 total，由调用方统计。 */
export function mergePageHealthSamples(
  samples: readonly PageHealthSample[],
  limit = MAX_PAGE_HEALTH_SAMPLES,
): { samples: PageHealthSample[]; overflow: number } {
  const merged = new Map<string, PageHealthSample>()
  let overflow = 0
  for (const sample of samples) {
    const key = pageHealthSampleKey(sample)
    const existing = merged.get(key)
    if (existing) {
      existing.count += sample.count
      if (sample.durationMs !== undefined) existing.durationMs = Math.max(existing.durationMs ?? 0, sample.durationMs)
    } else if (merged.size < limit) {
      merged.set(key, { ...sample })
    } else {
      overflow += sample.count
    }
  }
  return { samples: [...merged.values()], overflow }
}

export function pageHealthSampleText(sample: PageHealthSample): string {
  if (sample.type === 'http') return `${sample.method ?? 'GET'} ${sample.url ?? '-'} → ${sample.status ?? '-'}`
  if (sample.type === 'slow') return `${sample.method ?? 'GET'} ${sample.url ?? '-'} 耗时 ${sample.durationMs ?? '-'}ms（阈值 ${sample.maxMs ?? '-'}ms）`
  if (sample.type === 'request_failed') return `${sample.method ?? 'GET'} ${sample.url ?? '-'} 请求失败${sample.text ? `（${sample.text}）` : ''}`
  return `脚本异常：${sample.text ?? '-'}${sample.url ? `（${sample.url}）` : ''}`
}

/** 单行摘要，例如「POST https://x/api/order → 503 ×2」。 */
export function pageHealthSampleLine(sample: PageHealthSample): string {
  return `${pageHealthSampleText(sample)}${sample.count > 1 ? ` ×${sample.count}` : ''}`
}

export function pageHealthFactToJson(fact: PageHealthFact): JsonValue {
  return JSON.parse(JSON.stringify(fact)) as JsonValue
}

export function pageHealthFactFromJson(value: unknown): PageHealthFact | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as { kind?: unknown; total?: unknown; byClass?: unknown; samples?: unknown }
  if (!isPageHealthKind(raw.kind as string | undefined)) return null
  const samples = Array.isArray(raw.samples)
    ? (raw.samples as unknown[]).filter((item): item is PageHealthSample => {
        if (!item || typeof item !== 'object') return false
        const sample = item as { type?: unknown; count?: unknown }
        return (
          (sample.type === 'http' || sample.type === 'request_failed' || sample.type === 'script_error' || sample.type === 'slow') &&
          typeof sample.count === 'number'
        )
      })
    : []
  const byClass =
    raw.byClass && typeof raw.byClass === 'object' && !Array.isArray(raw.byClass)
      ? Object.fromEntries(
          Object.entries(raw.byClass as Record<string, unknown>).filter(([, v]) => typeof v === 'number'),
        ) as Record<string, number>
      : {}
  return {
    kind: raw.kind as PageHealthKind,
    total: typeof raw.total === 'number' ? raw.total : samples.reduce((sum, item) => sum + item.count, 0),
    byClass,
    samples,
  }
}

export function pageHealthFactFromResult(result: { actual?: unknown } | null | undefined): PageHealthFact | null {
  return pageHealthFactFromJson(result?.actual)
}

/** 拼出「共 3 处：第 2 步 POST … → 503 ×2；第 4 步 GET … → 404」。stepLabel 返回步骤序号文案。 */
export function pageHealthSummaryText(
  facts: readonly PageHealthFact[],
  stepLabel: (sample: PageHealthSample) => string,
  maxItems = 6,
): string {
  const total = facts.reduce((sum, fact) => sum + fact.total, 0)
  const items = facts.flatMap((fact) => fact.samples)
  const shown = items.slice(0, maxItems).map((sample) => {
    const label = stepLabel(sample)
    return `${label ? `${label} ` : ''}${pageHealthSampleLine(sample)}`
  })
  const rest = total - items.slice(0, maxItems).reduce((sum, sample) => sum + sample.count, 0)
  return `共 ${total} 处：${shown.join('；')}${rest > 0 ? `；另有 ${rest} 处` : ''}`
}

export const PAGE_HEALTH_KIND_LABELS: Record<PageHealthKind, string> = {
  network_health: '页面接口不得报错',
  script_errors: '页面脚本不得出现未捕获异常',
}

/** 违规计数的人话：「3 处接口错误 · 1 处脚本异常」。 */
export function pageHealthCountsText(facts: readonly PageHealthFact[]): string {
  const netFacts = facts.filter((f) => f.kind === 'network_health')
  const slow = netFacts.reduce((s, f) => s + (f.byClass.slow ?? 0), 0)
  const net = netFacts.reduce((s, f) => s + f.total, 0) - slow
  const script = facts.filter((f) => f.kind === 'script_errors').reduce((s, f) => s + f.total, 0)
  return [
    net > 0 ? `${net} 处接口错误` : '',
    slow > 0 ? `${slow} 处接口耗时超阈` : '',
    script > 0 ? `${script} 处脚本异常` : '',
  ].filter(Boolean).join(' · ')
}

// ---------------------------------------------------------------------------
// 系统地址判定（纯函数，注册域由调用方注入，shared 不依赖公共后缀表）
// ---------------------------------------------------------------------------

const INTRANET_SUFFIXES = ['.local', '.lan', '.internal', '.intranet', '.corp', '.home', '.localdomain'] as const

function ipv4Octets(host: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!match) return null
  const octets = match.slice(1).map(Number)
  return octets.every((n) => n >= 0 && n <= 255) ? octets : null
}

/** 主机名本身像内网：内网 IP 字面量、单段主机名、内网后缀。只看 URL 写法，不看服务器 IP，走代理也成立。 */
export function looksIntranetHost(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) return false
  const v4 = ipv4Octets(host)
  if (v4) {
    const [a, b] = v4 as [number, number, number, number]
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254)
    )
  }
  if (host.includes(':')) {
    return host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)
  }
  if (!host.includes('.')) return true
  return INTRANET_SUFFIXES.some((suffix) => host.endsWith(suffix))
}

export function isIpLiteralHost(rawHost: string): boolean {
  const host = rawHost.replace(/^\[|\]$/g, '')
  return ipv4Octets(host) !== null || host.includes(':')
}

function hostOf(origin: string): string | null {
  try {
    return new URL(origin).hostname.toLowerCase()
  } catch {
    return null
  }
}

function extraOriginMatches(origin: string, patterns: readonly string[]): boolean {
  const host = hostOf(origin)
  for (const pattern of patterns) {
    const trimmed = pattern.trim().toLowerCase()
    if (!trimmed) continue
    if (trimmed.includes('://')) {
      try {
        if (new URL(trimmed).origin === origin.toLowerCase()) return true
      } catch {
        // 忽略非法附加地址
      }
      continue
    }
    if (!host) continue
    const hostPattern = trimmed.replace(/:\d+$/, '')
    if (hostPattern.startsWith('*.')) {
      if (host === hostPattern.slice(2) || host.endsWith(hostPattern.slice(1))) return true
    } else if (host === hostPattern) {
      return true
    }
  }
  return false
}

/**
 * 子资源的目标是否属于「系统地址」。页面加载（document）由调用方直接计入，不走这里。
 * - a/b：`knownOrigins`（入口、登录源、本次运行加载过页面的源）
 * - c：与 knownOrigins 同站（registrableDomain 相同；IP 只认同一主机，忽略端口）
 * - d：地址写法像内网
 * - e：附加系统地址
 */
export function isSystemAddress(
  origin: string,
  input: {
    knownOrigins: ReadonlySet<string>
    extraOrigins?: readonly string[]
    registrableDomain: (host: string) => string | null
  },
): boolean {
  if (input.knownOrigins.has(origin)) return true
  const host = hostOf(origin)
  if (!host) return false
  if (looksIntranetHost(host)) return true
  if (extraOriginMatches(origin, input.extraOrigins ?? [])) return true
  const ip = isIpLiteralHost(host)
  const registrable = ip ? host : input.registrableDomain(host)
  for (const known of input.knownOrigins) {
    const knownHost = hostOf(known)
    if (!knownHost) continue
    if (ip || isIpLiteralHost(knownHost)) {
      if (knownHost === host) return true
      continue
    }
    const knownRegistrable = input.registrableDomain(knownHost)
    if (registrable && knownRegistrable && registrable === knownRegistrable) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// 页面请求条件（成功条件 page_request）：命中的请求与求值（纯函数，Worker 与测试共用）
// ---------------------------------------------------------------------------

/** 采集器按「关注清单」记录的命中请求。完成的请求 status 为响应状态码，失败的请求为 0。 */
export type WatchedRequest = {
  method: string
  /** 归一化地址（源 + 路径）。 */
  url: string
  status: number
  /** 浏览器视角耗时（毫秒），未知为 undefined。 */
  durationMs?: number
  stepId?: string
  stepRunId?: string
  attemptId?: string
  /** 请求失败（连接被拒绝等）。 */
  failed?: boolean
  /** 命中的关注清单下标（按快照里 page_request 条件的顺序）；规则按原始路径匹配，展示用的 url 已把编号段归一。 */
  rules?: number[]
}

export type PageRequestRuleLike = {
  match: string
  method?: string
  status: '2xx' | '2xx_3xx'
  maxMs?: number
  minCount?: number
  graceMs?: number
}

export const MAX_WATCHED_REQUESTS = 200

export function pageRequestStatusOk(rule: Pick<PageRequestRuleLike, 'status'>, status: number): boolean {
  if (status >= 200 && status < 300) return true
  return rule.status === '2xx_3xx' && status >= 300 && status < 400
}

export function pageRequestRuleMatches(rule: Pick<PageRequestRuleLike, 'match' | 'method'>, request: Pick<WatchedRequest, 'method' | 'url'>): boolean {
  if (rule.method && rule.method !== request.method.toUpperCase()) return false
  const parsed = normalizePageUrl(request.url)
  if (!parsed) return false
  return matchesPageHealthIgnore(parsed, [rule.match])
}

export type PageRequestEvaluation = {
  verdict: 'PASS' | 'FAIL'
  /** 命中规则的请求（含不满足状态 / 耗时的）。 */
  matched: WatchedRequest[]
  /** 命中且满足状态与耗时的请求数。 */
  satisfied: number
  /** 不满足时的人话原因。 */
  reason?: string
}

/**
 * 判定一条规则：命中请求里满足状态（与耗时上限）的数量 ≥ minCount 即通过。
 * 多次命中时，状态与耗时以**最后一次**命中为准（重试 / 轮询类接口后一次更可信）：
 * 只要最后一次命中满足就算满足，前面失败的不拖累。
 */
export function evaluatePageRequestRule(
  rule: PageRequestRuleLike,
  requests: readonly WatchedRequest[],
  /** 已由采集器按原始路径预匹配（requests 只含命中该规则的请求）。 */
  options: { prematched?: boolean } = {},
): PageRequestEvaluation {
  const matched = options.prematched ? [...requests] : requests.filter((request) => pageRequestRuleMatches(rule, request))
  const minCount = rule.minCount ?? 1
  const okOf = (request: WatchedRequest) =>
    !request.failed && pageRequestStatusOk(rule, request.status) && (rule.maxMs === undefined || (request.durationMs ?? 0) <= rule.maxMs)
  const last = matched[matched.length - 1]
  const satisfied = matched.filter(okOf).length
  if (matched.length === 0) {
    return { verdict: 'FAIL', matched, satisfied: 0, reason: '步骤期间没有出现该请求' }
  }
  if (matched.length >= minCount && satisfied >= minCount && last && okOf(last)) {
    return { verdict: 'PASS', matched, satisfied }
  }
  if (matched.length < minCount) {
    return { verdict: 'FAIL', matched, satisfied, reason: `只出现 ${matched.length} 次，至少需要 ${minCount} 次` }
  }
  if (last?.failed) return { verdict: 'FAIL', matched, satisfied, reason: '请求失败（没有拿到响应）' }
  if (last && !pageRequestStatusOk(rule, last.status)) {
    return { verdict: 'FAIL', matched, satisfied, reason: `返回 ${last.status}，期望 ${rule.status === '2xx' ? '2xx' : '2xx 或 3xx'}` }
  }
  if (last && rule.maxMs !== undefined && (last.durationMs ?? 0) > rule.maxMs) {
    return { verdict: 'FAIL', matched, satisfied, reason: `耗时 ${last.durationMs}ms，超过上限 ${rule.maxMs}ms` }
  }
  return { verdict: 'FAIL', matched, satisfied, reason: `满足条件的请求只有 ${satisfied} 次，至少需要 ${minCount} 次` }
}

export function describePageRequestRule(rule: PageRequestRuleLike): string {
  return `${rule.method ? `${rule.method} ` : ''}${rule.match} 返回 ${rule.status === '2xx' ? '2xx' : '2xx / 3xx'}${rule.maxMs ? `，耗时 ≤ ${rule.maxMs}ms` : ''}${rule.minCount && rule.minCount > 1 ? `，至少 ${rule.minCount} 次` : ''}`
}

/** 从快照的成功条件清单里取出 page_request 条件（保持清单顺序，下标即采集器关注清单的下标）。 */
export function pageRequestEntriesOf<T extends { rule: { kind: string } }>(
  manifest: { entries: readonly T[] } | null | undefined,
): Array<T & { rule: PageRequestRuleLike & { kind: 'page_request' } }> {
  return (manifest?.entries ?? []).filter((entry) => entry.rule.kind === 'page_request') as never
}
