import { getDomain } from 'tldts'
import {
  isSystemAddress,
  matchesPageHealthIgnore,
  matchesScriptIgnore,
  mergePageHealthSamples,
  normalizePageUrl,
  originsFromTargetUrls,
  redactPageHealthText,
  resolveNetworkHealthConfig,
  resolveScriptErrorsConfig,
  statusClassOf,
  MAX_WATCHED_REQUESTS,
  type PageHealthDrain,
  type PageHealthFact,
  type PageHealthSample,
  type PageHealthStepInfo,
  type WatchedRequest,
  type ResolvedNetworkHealthConfig,
  type ResolvedScriptErrorsConfig,
  type RuntimeInvariant,
  type RunSnapshot,
} from '@cairn/shared'

/** 步骤结束后这么久内发起的请求仍算「第 N 步之后」；超过的（调试挂起、等待认证、人工接管）一律不计。 */
export const PAGE_HEALTH_GAP_MS = 5_000
/** 取数前最多缓存的待判定违规，超出只计数。 */
const MAX_PENDING = 500

type Emitter = {
  on(event: string, handler: (...args: any[]) => void): unknown
  off(event: string, handler: (...args: any[]) => void): unknown
}

type RequestLike = {
  url(): string
  method(): string
  resourceType(): string
  failure(): { errorText: string } | null
  /** 请求完成后的时间线：responseEnd 为相对 startTime 的毫秒数，未完成为 -1。 */
  timing?(): { responseEnd: number }
}
type ResponseLike = { url(): string; status(): number; request(): RequestLike }

type RequestMeta = { step: PageHealthStepInfo; afterStep: boolean }

type PendingEvent = {
  sample: PageHealthSample
  origin: string
  /** document 请求一律计入，不走系统地址判定。 */
  isDocument: boolean
  network: boolean
}

/**
 * 一开始就算「系统地址」的源：目标入口与登录页。
 * 不能只等页面加载后再学：复用会话时本次运行可能一次整页跳转都没有，入口系统的接口错误会被漏掉。
 * allowedOrigins 是访问范围移除（迁移 0147）前的旧快照字段，新快照不再写。
 */
export function pageHealthKnownOrigins(run: Pick<RunSnapshot, 'targetAuth' | 'allowedOrigins' | 'loginOrigin'>): string[] {
  const origins = new Set<string>(run.allowedOrigins ?? [])
  if (run.targetAuth) for (const origin of originsFromTargetUrls(run.targetAuth.entryUrl, run.targetAuth.loginUrl)) origins.add(origin)
  if (run.loginOrigin) origins.add(run.loginOrigin)
  return [...origins]
}

export function registrableDomainOf(host: string): string | null {
  return getDomain(host, { allowPrivateDomains: false }) ?? null
}

/**
 * 运行占用期间的页面健康被动采集器：只监听，不拦截。
 *
 * 归属：请求记发起时刻所在的步骤，异常记发生时刻所在的步骤；步骤之间 5 秒内发生的归到前一步骤并标记「之后」。
 * 系统地址判定在取数时刻做（一个源先被请求、后来才加载过页面，取数时也能算进去）。
 */
export class PageHealthCollector {
  private readonly network: ResolvedNetworkHealthConfig | null
  private readonly script: ResolvedScriptErrorsConfig | null
  private readonly knownOrigins: Set<string>
  private readonly metas = new WeakMap<object, RequestMeta | null>()
  private pending: PendingEvent[] = []
  private dropped = 0
  private active: PageHealthStepInfo | null = null
  private last: { info: PageHealthStepInfo; endedAt: number } | null = null
  private attached = false
  private readonly handlers: Array<[string, (...args: any[]) => void]> = []

  constructor(
    private context: Emitter,
    options: {
      invariants: readonly RuntimeInvariant[]
      knownOrigins: readonly string[]
      /** 成功条件 page_request 的关注清单：只记录命中的请求（不受系统地址限制）。 */
      watchRules?: readonly { match: string; method?: string }[]
      now?: () => number
    },
  ) {
    const net = options.invariants.find((item) => item.kind === 'network_health')
    const script = options.invariants.find((item) => item.kind === 'script_errors')
    this.network = net ? resolveNetworkHealthConfig(net.network) : null
    this.script = script ? resolveScriptErrorsConfig(script.script) : null
    this.knownOrigins = new Set(options.knownOrigins)
    this.watchRules = options.watchRules ?? []
    this.now = options.now ?? Date.now
  }

  private readonly now: () => number
  private readonly watchRules: readonly { match: string; method?: string }[]
  private watched: WatchedRequest[] = []
  private watchedDropped = 0
  private readonly statusByRequest = new WeakMap<object, number>()

  get enabled(): boolean {
    return this.network !== null || this.script !== null || this.watchRules.length > 0
  }

  attach(): void {
    if (this.attached || !this.enabled) return
    this.attached = true
    const add = (event: string, handler: (...args: any[]) => void) => {
      this.context.on(event, handler)
      this.handlers.push([event, handler])
    }
    if (this.network || this.watchRules.length > 0) {
      add('request', (request: RequestLike) => this.onRequest(request))
      add('response', (response: ResponseLike) => this.onResponse(response))
      add('requestfailed', (request: RequestLike) => this.onRequestFailed(request))
      if ((this.network?.slowRules.length ?? 0) > 0 || this.watchRules.length > 0) {
        add('requestfinished', (request: RequestLike) => this.onRequestFinished(request))
      }
    }
    if (this.script) {
      add('weberror', (webError: { error(): Error }) => this.onScriptError(webError))
      if (this.script.includeConsoleError) {
        add('console', (message: { type(): string; text(): string; location(): { url: string; lineNumber: number } }) =>
          this.onConsole(message),
        )
      }
    }
  }

  isBoundTo(context: unknown): boolean {
    return this.context === context
  }

  /** 会话在运行中被重建、浏览器上下文换了：摘掉旧监听，挂到新上下文，已缓存的违规与系统地址保留。 */
  rebind(context: Emitter): void {
    const wasAttached = this.attached
    for (const [event, handler] of this.handlers) {
      try {
        this.context.off(event, handler)
      } catch {
        // 旧上下文已关闭
      }
    }
    this.handlers.length = 0
    this.attached = false
    this.context = context
    if (wasAttached) this.attach()
  }

  dispose(): void {
    if (!this.attached) return
    for (const [event, handler] of this.handlers) {
      try {
        this.context.off(event, handler)
      } catch {
        // 上下文已关闭
      }
    }
    this.handlers.length = 0
    this.attached = false
    this.pending = []
  }

  beginStep(info: PageHealthStepInfo): void {
    this.active = info
  }

  endStep(): void {
    if (this.active) this.last = { info: this.active, endedAt: this.now() }
    this.active = null
  }

  private metaNow(): RequestMeta | null {
    if (this.active) return { step: this.active, afterStep: false }
    if (this.last && this.now() - this.last.endedAt <= PAGE_HEALTH_GAP_MS) return { step: this.last.info, afterStep: true }
    return null
  }

  private onRequest(request: RequestLike): void {
    this.metas.set(request, this.metaNow())
  }

  private onResponse(response: ResponseLike): void {
    const request = response.request()
    let status = 0
    try {
      status = response.status()
    } catch {
      return
    }
    let resourceType = 'other'
    try {
      resourceType = request.resourceType()
    } catch {
      // 保持 other
    }
    const url = normalizePageUrl(response.url())
    if (!url) return
    // 只要拿到 HTTP 响应的页面加载，其源就成为系统地址（状态码不限）。
    if (resourceType === 'document') this.knownOrigins.add(url.origin)
    if (this.watchRules.length > 0) this.statusByRequest.set(request, status)
    const config = this.network
    if (!config) return
    const cls = statusClassOf(status)
    if (!cls || !config.statusClasses.includes(cls)) return
    const meta = this.metas.get(request)
    if (!meta) return
    this.push(config, request, url, resourceType, meta, { type: 'http', status })
  }

  /** 耗时阈值：浏览器视角从发起到响应结束的毫秒数，不是服务端耗时。允许超阈次数按规则整次运行累计。 */
  private readonly slowHits = new Map<number, number>()

  /** 命中关注清单的请求（成功条件 page_request 求值用）：按原始路径预匹配，记命中的清单下标。 */
  private recordWatched(request: RequestLike, status: number, durationMs: number | undefined, failed: boolean): void {
    if (this.watchRules.length === 0) return
    const meta = this.metas.get(request)
    if (!meta) return
    let raw: URL
    try {
      raw = new URL(request.url())
    } catch {
      return
    }
    if (raw.protocol !== 'http:' && raw.protocol !== 'https:') return
    const method = request.method().toUpperCase()
    const target = { origin: raw.origin, path: raw.pathname }
    const hits: number[] = []
    this.watchRules.forEach((rule, index) => {
      if ((!rule.method || rule.method === method) && matchesPageHealthIgnore(target, [rule.match])) hits.push(index)
    })
    if (hits.length === 0) return
    if (this.watched.length >= MAX_WATCHED_REQUESTS) {
      this.watchedDropped += 1
      return
    }
    const display = normalizePageUrl(request.url())
    this.watched.push({
      method,
      url: display?.display ?? `${raw.origin}${raw.pathname}`,
      status,
      ...(durationMs !== undefined ? { durationMs: Math.round(durationMs) } : {}),
      ...(failed ? { failed: true } : {}),
      rules: hits,
      stepId: meta.step.stepId,
      ...(meta.step.stepRunId ? { stepRunId: meta.step.stepRunId } : {}),
      ...(meta.step.attemptId ? { attemptId: meta.step.attemptId } : {}),
    })
  }

  /** 不清空地取某个步骤发起的命中请求（引擎在宽限期内轮询用）。 */
  peekWatched(stepId: string): WatchedRequest[] {
    return this.watched.filter((item) => item.stepId === stepId)
  }

  private onRequestFinished(request: RequestLike): void {
    let duration = -1
    try {
      duration = request.timing?.().responseEnd ?? -1
    } catch {
      duration = -1
    }
    this.recordWatched(request, this.statusByRequest.get(request) ?? 0, duration >= 0 ? duration : undefined, false)
    const config = this.network
    if (!config || config.slowRules.length === 0) return
    const meta = this.metas.get(request)
    if (!meta) return
    if (!(duration >= 0)) return
    const url = normalizePageUrl(request.url())
    if (!url) return
    const method = request.method()
    const index = config.slowRules.findIndex(
      (rule) => (!rule.method || rule.method === method) && matchesPageHealthIgnore(url, [rule.match]),
    )
    if (index < 0) return
    const rule = config.slowRules[index]!
    if (duration <= rule.maxMs) return
    const hits = (this.slowHits.get(index) ?? 0) + 1
    this.slowHits.set(index, hits)
    if (hits <= config.slowAllowExceed) return
    let resourceType = 'other'
    try {
      resourceType = request.resourceType()
    } catch {
      // 保持 other
    }
    this.push(config, request, url, resourceType, meta, { type: 'slow', durationMs: Math.round(duration), maxMs: rule.maxMs })
  }

  private onRequestFailed(request: RequestLike): void {
    if (!(request.failure()?.errorText ?? '').includes('ERR_ABORTED')) this.recordWatched(request, 0, undefined, true)
    const config = this.network
    if (!config || !config.requestFailed) return
    const meta = this.metas.get(request)
    if (!meta) return
    const errorText = request.failure()?.errorText ?? 'net::ERR_FAILED'
    // 页面跳走或主动取消不是页面问题，与导航结果判定口径一致。
    if (errorText.includes('ERR_ABORTED')) return
    const url = normalizePageUrl(request.url())
    if (!url) return
    let resourceType = 'other'
    try {
      resourceType = request.resourceType()
    } catch {
      // 保持 other
    }
    this.push(config, request, url, resourceType, meta, { type: 'request_failed', text: redactPageHealthText(errorText, 120) })
  }

  private push(
    config: ResolvedNetworkHealthConfig,
    request: RequestLike,
    url: { origin: string; path: string; display: string },
    resourceType: string,
    meta: RequestMeta,
    detail: { type: 'http' | 'request_failed' | 'slow'; status?: number; text?: string; durationMs?: number; maxMs?: number },
  ): void {
    if (!(config.resourceTypes as readonly string[]).includes(resourceType)) return
    if (matchesPageHealthIgnore(url, config.ignore)) return
    if (this.pending.length >= MAX_PENDING) {
      this.dropped += 1
      return
    }
    this.pending.push({
      origin: url.origin,
      isDocument: resourceType === 'document',
      network: true,
      sample: {
        type: detail.type,
        url: url.display,
        method: request.method(),
        ...(detail.status !== undefined ? { status: detail.status } : {}),
        ...(detail.text ? { text: detail.text } : {}),
        ...(detail.durationMs !== undefined ? { durationMs: detail.durationMs, maxMs: detail.maxMs } : {}),
        resourceType,
        count: 1,
        stepId: meta.step.stepId,
        ...(meta.step.stepRunId ? { stepRunId: meta.step.stepRunId } : {}),
        ...(meta.step.attemptId ? { attemptId: meta.step.attemptId } : {}),
        ...(meta.afterStep ? { afterStep: true } : {}),
      },
    })
  }

  private pushScript(message: string, source?: string): void {
    const config = this.script
    if (!config) return
    const meta = this.metaNow()
    if (!meta) return
    const text = redactPageHealthText(message)
    if (!text || matchesScriptIgnore(text, config.ignore)) return
    if (this.pending.length >= MAX_PENDING) {
      this.dropped += 1
      return
    }
    const normalized = source ? normalizePageUrl(source) : null
    this.pending.push({
      origin: normalized?.origin ?? '',
      isDocument: false,
      network: false,
      sample: {
        type: 'script_error',
        text,
        ...(normalized ? { url: normalized.display } : {}),
        count: 1,
        stepId: meta.step.stepId,
        ...(meta.step.stepRunId ? { stepRunId: meta.step.stepRunId } : {}),
        ...(meta.step.attemptId ? { attemptId: meta.step.attemptId } : {}),
        ...(meta.afterStep ? { afterStep: true } : {}),
      },
    })
  }

  private onScriptError(webError: { error(): Error }): void {
    let error: Error | undefined
    try {
      error = webError.error()
    } catch {
      return
    }
    const stackUrl = /\bat .*?\(?(https?:\/\/[^\s)]+?)(?::\d+){0,2}\)?(?:\n|$)/.exec(error?.stack ?? '')?.[1]
    this.pushScript(error?.message || String(error), stackUrl)
  }

  private onConsole(message: { type(): string; text(): string; location(): { url: string; lineNumber: number } }): void {
    if (message.type() !== 'error') return
    let source: string | undefined
    try {
      source = message.location().url || undefined
    } catch {
      source = undefined
    }
    this.pushScript(message.text(), source)
  }

  /** 取回上次取数以来的违规（已按系统地址过滤、合并）。 */
  drain(): PageHealthDrain {
    const events = this.pending
    this.pending = []
    this.watched = []
    this.watchedDropped = 0
    const dropped = this.dropped
    this.dropped = 0
    const network = this.network
    const kept: PendingEvent[] = []
    for (const event of events) {
      if (event.network && network && !event.isDocument && !network.includeExternal) {
        const system = isSystemAddress(event.origin, {
          knownOrigins: this.knownOrigins,
          extraOrigins: network.extraOrigins,
          registrableDomain: registrableDomainOf,
        })
        if (!system) continue
      }
      kept.push(event)
    }
    const build = (kind: 'network_health' | 'script_errors', isNetwork: boolean): PageHealthFact | undefined => {
      const samples = kept.filter((event) => event.network === isNetwork).map((event) => event.sample)
      if (samples.length === 0) return undefined
      const merged = mergePageHealthSamples(samples)
      const byClass: Record<string, number> = {}
      for (const sample of samples) {
        const key =
          sample.type === 'http'
            ? (statusClassOf(sample.status ?? 0) ?? 'other')
            : sample.type === 'request_failed'
              ? 'failed'
              : sample.type === 'slow'
                ? 'slow'
                : 'script'
        byClass[key] = (byClass[key] ?? 0) + sample.count
      }
      return {
        kind,
        total: samples.reduce((sum, sample) => sum + sample.count, 0),
        byClass,
        samples: merged.samples,
      }
    }
    return {
      ...(network ? { network: build('network_health', true) } : {}),
      ...(this.script ? { script: build('script_errors', false) } : {}),
      dropped,
    }
  }
}
