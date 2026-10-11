import { createHash, randomUUID } from 'node:crypto'
import {
  TABLE_NETWORK_CAPTURE_MAX_BYTES,
  TABLE_NETWORK_CAPTURE_MAX_ENTRIES,
  TABLE_NETWORK_RESPONSE_MAX_BYTES,
  normalizePageUrl,
  type TableNetworkMatch,
  type TableNetworkPlan,
} from '@cairn/shared'

/**
 * 受管页面的接口响应被动捕获：只监听本页发出的 xhr / fetch，不拦截、不重放、不修改。
 *
 * 只留去敏地址（去掉查询串，数字 / UUID 段换成 *）、方法、状态码、时间与 JSON 正文；请求头、Cookie 一律不存。
 * 有界缓冲：最近 TABLE_NETWORK_CAPTURE_MAX_ENTRIES 个、总计 TABLE_NETWORK_CAPTURE_MAX_BYTES，先进先出；
 * 单个超过 TABLE_NETWORK_RESPONSE_MAX_BYTES 的只记一条“过大”，不留正文。
 */

type Emitter = {
  on(event: string, handler: (...args: any[]) => void): unknown
  off(event: string, handler: (...args: any[]) => void): unknown
}

type FrameLike = { page(): object; parentFrame(): unknown }
export type CaptureRequestLike = {
  url(): string
  method(): string
  resourceType(): string
  isNavigationRequest(): boolean
  frame(): FrameLike
}
export type CaptureResponseLike = {
  url(): string
  status(): number
  request(): CaptureRequestLike
  headers(): Record<string, string>
  text(): Promise<string>
}

export type CapturedResponse = {
  id: string
  /** 发出请求的页面（对象身份，只在本进程内比较）。 */
  page: object
  requestAt: number
  at: number
  method: string
  /** 去敏地址：origin + 规整后的路径。 */
  url: string
  status: number
  contentType?: string
  byteSize: number
  /** JSON 正文（只有能解析、且不超限时才有）。 */
  body?: string
  json: boolean
  tooLarge?: boolean
  digest?: string
}

type Inflight = { page: object; requestAt: number; method: string; url: string }

export type NetworkFindResult =
  | { ok: true; entry: CapturedResponse & { body: string } }
  | { ok: false; code: string; message: string }

export function matchesNetworkEntry(entry: Pick<CapturedResponse, 'url' | 'method'>, match: TableNetworkMatch): boolean {
  if (match.method && entry.method.toUpperCase() !== match.method) return false
  return entry.url.includes(match.url.trim())
}

const statusOk = (status: number, expected?: number) => (expected === undefined ? status >= 200 && status < 300 : status === expected)

export class NetworkCapture {
  private entries: CapturedResponse[] = []
  private totalBytes = 0
  private readonly inflight = new Map<object, Inflight>()
  /** 每个页面最近一次主框架整页跳转（发起时刻）：“页面加载以来”的起点。 */
  private readonly navAt = new WeakMap<object, number>()
  private stepStartedAt: number | null = null
  private readonly waiters = new Set<() => void>()
  private readonly handlers: Array<[string, (...args: any[]) => void]> = []
  private attached = false
  readonly startedAt: number
  lastUsedAt: number

  private idleTimer: NodeJS.Timeout | undefined

  constructor(
    private context: Emitter,
    private readonly now: () => number = Date.now,
    /** 编写期临时捕获：这么久没人用就自动停止并清空（运行期随租约结束，不设）。 */
    private readonly idle?: { ms: number; onIdle: () => void },
  ) {
    this.startedAt = now()
    this.lastUsedAt = this.startedAt
    this.touch()
  }

  private touch(): void {
    this.lastUsedAt = this.now()
    if (!this.idle) return
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.dispose()
      this.idle?.onIdle()
    }, this.idle.ms)
    this.idleTimer.unref?.()
  }

  attach(): void {
    if (this.attached) return
    this.attached = true
    const add = (event: string, handler: (...args: any[]) => void) => {
      this.context.on(event, handler)
      this.handlers.push([event, handler])
    }
    add('request', (request: CaptureRequestLike) => this.onRequest(request))
    add('response', (response: CaptureResponseLike) => void this.onResponse(response))
    add('requestfailed', (request: CaptureRequestLike) => this.settle(request))
  }

  isBoundTo(context: unknown): boolean {
    return this.context === context
  }

  /** 会话重建、浏览器上下文换了：挂到新上下文，已捕获的保留。 */
  rebind(context: Emitter): void {
    this.detach()
    this.context = context
    this.attach()
  }

  dispose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    this.detach()
    this.entries = []
    this.totalBytes = 0
    this.inflight.clear()
    this.notify()
  }

  private detach(): void {
    for (const [event, handler] of this.handlers) {
      try {
        this.context.off(event, handler)
      } catch {
        // 上下文已关闭
      }
    }
    this.handlers.length = 0
    this.attached = false
  }

  beginStep(): void {
    this.stepStartedAt = this.now()
  }

  list(page?: object): CapturedResponse[] {
    this.touch()
    return page ? this.entries.filter((e) => e.page === page) : [...this.entries]
  }

  get(id: string): CapturedResponse | undefined {
    this.touch()
    return this.entries.find((e) => e.id === id)
  }

  /** 页面加载以来的起点（页面没有在捕获期间整页跳转过时，取捕获开始时刻）。 */
  pageLoadedAt(page: object): number {
    return this.navAt.get(page) ?? this.startedAt
  }

  private onRequest(request: CaptureRequestLike): void {
    let frame: FrameLike
    try {
      frame = request.frame()
    } catch {
      return
    }
    let page: object
    try {
      page = frame.page()
    } catch {
      return
    }
    if (request.isNavigationRequest() && !frame.parentFrame()) {
      this.navAt.set(page, this.now())
      return
    }
    const type = request.resourceType()
    if (type !== 'xhr' && type !== 'fetch') return
    const url = normalizePageUrl(request.url())
    if (!url) return
    this.inflight.set(request, { page, requestAt: this.now(), method: request.method().toUpperCase(), url: url.display })
  }

  private settle(request: object): void {
    if (this.inflight.delete(request)) this.notify()
  }

  private async onResponse(response: CaptureResponseLike): Promise<void> {
    const request = response.request()
    const meta = this.inflight.get(request)
    if (!meta) return
    try {
      let status = 0
      let headers: Record<string, string> = {}
      try {
        status = response.status()
        headers = response.headers()
      } catch {
        return
      }
      const contentType = headers['content-type']?.slice(0, 128)
      const declared = Number(headers['content-length'])
      const entry: CapturedResponse = {
        id: randomUUID(),
        page: meta.page,
        requestAt: meta.requestAt,
        at: this.now(),
        method: meta.method,
        url: meta.url,
        status,
        ...(contentType ? { contentType } : {}),
        byteSize: Number.isFinite(declared) ? declared : 0,
        json: false,
      }
      if (Number.isFinite(declared) && declared > TABLE_NETWORK_RESPONSE_MAX_BYTES) {
        entry.tooLarge = true
      } else {
        let text: string | undefined
        try {
          text = await response.text()
        } catch {
          // 重定向、被取消或页面已关闭：只记元信息
        }
        if (text !== undefined) {
          const size = Buffer.byteLength(text)
          entry.byteSize = size
          if (size > TABLE_NETWORK_RESPONSE_MAX_BYTES) entry.tooLarge = true
          else if (looksJson(text, contentType)) {
            entry.json = true
            entry.body = text
            entry.digest = `sha256:${createHash('sha256').update(text).digest('hex')}`
          }
        }
      }
      this.push(entry)
    } finally {
      this.settle(request)
    }
  }

  private push(entry: CapturedResponse): void {
    this.entries.push(entry)
    this.totalBytes += entry.body ? Buffer.byteLength(entry.body) : 0
    while (this.entries.length > TABLE_NETWORK_CAPTURE_MAX_ENTRIES || this.totalBytes > TABLE_NETWORK_CAPTURE_MAX_BYTES) {
      const dropped = this.entries.shift()
      if (!dropped) break
      this.totalBytes -= dropped.body ? Buffer.byteLength(dropped.body) : 0
    }
    this.notify()
  }

  private notify(): void {
    for (const wake of [...this.waiters]) wake()
  }

  private waitForChange(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.waiters.delete(done)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, Math.max(0, ms))
      this.waiters.add(done)
      signal?.addEventListener('abort', done, { once: true })
    })
  }

  /**
   * 按读取计划找响应：只看本页、窗口内的；还有匹配的请求在途、或窗口内还没有匹配时，最多等 waitMs。
   * 找不到是“来源未找到”，不是空表。
   */
  async find(plan: Pick<TableNetworkPlan, 'match' | 'pick' | 'window'>, page: object, signal?: AbortSignal): Promise<NetworkFindResult> {
    this.touch()
    const since = plan.window.since === 'step_start' ? (this.stepStartedAt ?? this.now()) : this.pageLoadedAt(page)
    const deadline = this.now() + plan.window.waitMs
    const sameRequest = (e: { page: object; requestAt: number; url: string; method: string }) =>
      e.page === page && e.requestAt >= since && matchesNetworkEntry(e, plan.match)
    for (;;) {
      if (signal?.aborted) return { ok: false, code: 'CANCELLED', message: '已取消' }
      const hits = this.entries.filter(sameRequest)
      const pending = [...this.inflight.values()].some(sameRequest)
      const expired = this.now() >= deadline
      if ((hits.length > 0 && !pending) || expired) return this.decide(hits, plan, expired && pending)
      await this.waitForChange(Math.min(500, Math.max(0, deadline - this.now())), signal)
    }
  }

  private decide(hits: CapturedResponse[], plan: Pick<TableNetworkPlan, 'match' | 'pick' | 'window'>, stillPending: boolean): NetworkFindResult {
    const desc = `${plan.match.method ?? ''} ${plan.match.url}`.trim()
    if (hits.length === 0) {
      return {
        ok: false,
        code: 'TABLE_SOURCE_NOT_FOUND',
        message: stillPending
          ? `等了 ${Math.round(plan.window.waitMs / 1000)} 秒，匹配「${desc}」的接口还没有返回`
          : `${plan.window.since === 'step_start' ? '本步开始后' : '当前页面加载以来'}没有匹配「${desc}」的接口响应`,
      }
    }
    const good = hits.filter((e) => statusOk(e.status, plan.match.status))
    if (good.length === 0) {
      const last = hits[hits.length - 1]!
      return { ok: false, code: 'TABLE_NETWORK_STATUS_MISMATCH', message: `匹配的接口返回了状态码 ${last.status}（${last.method} ${last.url}），期望${plan.match.status ?? ' 2xx'}` }
    }
    if (plan.pick === 'single' && good.length > 1) {
      return { ok: false, code: 'TABLE_NETWORK_MULTIPLE', message: `窗口内匹配「${desc}」的响应有 ${good.length} 个，按“必须只有一个”不能确定读哪个；可收窄地址或改为“取最近一个”` }
    }
    const entry = good[good.length - 1]!
    if (entry.tooLarge) return { ok: false, code: 'TABLE_NETWORK_RESPONSE_TOO_LARGE', message: `接口响应超过 ${TABLE_NETWORK_RESPONSE_MAX_BYTES / 1024 / 1024} MB 上限，没有保留正文` }
    if (!entry.json || entry.body === undefined) return { ok: false, code: 'TABLE_NETWORK_NOT_JSON', message: `匹配的接口返回的不是 JSON（${entry.contentType ?? '未知类型'}）` }
    return { ok: true, entry: entry as CapturedResponse & { body: string } }
  }
}

function looksJson(text: string, contentType: string | undefined): boolean {
  const head = text.trimStart()[0]
  if (head !== '{' && head !== '[') return false
  if (contentType && !/json|text\/plain|text\/html|javascript/i.test(contentType)) return false
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}
