/**
 * 浏览器宿主池 (Browser Host Pool)
 * 纳管共享 Chromium 进程（宿主），支持一会话一 Context、同目标分散、容量放置、回收与崩溃检测。
 */

import { randomUUID } from 'node:crypto'
import type { Browser, BrowserContext } from 'playwright'
import {
  FACTORY_BROWSER_PREWARM,
  type PlatformBrowserPrewarm,
  type PrewarmStatusDto,
} from '@cairn/shared'
import { AdaptivePrewarmController } from './prewarm-adaptive.js'
import {
  BrowserRuntimeError,
  openSharedSession,
  type BrowserHandle,
  type LaunchSessionOpts,
} from './runtime.js'

export type HostState = 'STARTING' | 'ACTIVE' | 'DRAINING' | 'DEAD'

export type HostReservation = {
  sessionId: string
  hostId: string
  kind: 'NEW' | 'EXISTING'
  spreadKeys: string[]
  colocated: boolean
}

export type TargetSpreadMode = 'strict' | 'prefer'

export type HostPoolConfig = {
  maxContextsPerHost: number
  hostMaxAgeSeconds: number
  hostRssHighWatermarkMb: number
  targetSpread: TargetSpreadMode
  idleCloseDelayMs: number
  maxSharedHosts?: number
  maxBrowserHosts?: number
  browserMemoryBudgetMb?: number
  prewarmPolicy?: PlatformBrowserPrewarm
  /**
   * 独占（DEDICATED）宿主不在本池纳管，但同属 maxBrowserHosts 总预算。
   * 由 SessionManager 按当前活句柄计算，放置与预热预算据此计入。
   */
  dedicatedHostCountProvider?: () => number
}

/** 预热池节点观测契约：SSOT 在 @cairn/shared prewarmStatusSchema，此处随池状态产出 */
export type PrewarmStatus = PrewarmStatusDto

/** RSS 采样超过该年龄视为过旧：停止新增预热、不填充放置高水位（不把未知内存当 0） */
const MEMORY_SAMPLE_STALE_MS = 5 * 60_000
/** 无任何实测样本时的保守空宿主内存估计（Chromium 空实例典型 150-250MB，留启动余量） */
const FALLBACK_EMPTY_HOST_RSS_MB = 256

export const DEFAULT_HOST_POOL_CONFIG: HostPoolConfig = {
  maxContextsPerHost: 6,
  hostMaxAgeSeconds: 14_400,
  hostRssHighWatermarkMb: 0,
  targetSpread: 'strict',
  idleCloseDelayMs: 60_000,
}

export type HostSnapshot = {
  hostId: string
  state: HostState
  isConnected: boolean
  contextsCount: number
  targetKeys: Set<string>
  rssMb?: number
  launchedAt: number
}

export type PlacementResult =
  | { action: 'USE_HOST'; hostId: string }
  | { action: 'CREATE_HOST' }
  | { action: 'CLOSE_IDLE_AND_CREATE'; idleHostId: string }
  | { action: 'CAPACITY_EXCEEDED'; reason: string }

/**
 * 提取同系统分散键（§3 第 7 条）：targetId 与 entryUrl hostname 之一相同即算同一系统
 */
export function computeTargetSpreadKeys(targetId: string, entryUrl?: string | null): string[] {
  const keys: string[] = [`target:${targetId}`]
  if (entryUrl) {
    try {
      const parsed = new URL(entryUrl)
      if (parsed.hostname) {
        keys.push(`host:${parsed.hostname.toLowerCase()}`)
      }
    } catch {
      // invalid URL ignored
    }
  }
  return keys
}

/**
 * 宿主放置算法（纯函数）
 */
export function decideHostPlacement(
  hosts: readonly HostSnapshot[],
  spreadKeys: readonly string[],
  config: {
    maxContextsPerHost: number
    maxSessions: number
    maxSharedHosts?: number
    targetSpread: TargetSpreadMode
    hostRssHighWatermarkMb: number
    /** 独占宿主计入 maxBrowserHosts 总预算，但不参与共享放置候选 */
    dedicatedHosts?: number
  },
  totalActiveSessionsCount: number,
): PlacementResult {
  if (totalActiveSessionsCount >= config.maxSessions) {
    return { action: 'CAPACITY_EXCEEDED', reason: 'worker_sessions_capacity_reached' }
  }

  const maxSharedHosts = config.maxSharedHosts ?? config.maxSessions
  const dedicatedHosts = config.dedicatedHosts ?? 0

  // 1. 过滤候选：ACTIVE 或 STARTING、未满、未超 RSS 高水位
  const validCandidates = hosts.filter((h) => {
    if (h.state !== 'ACTIVE' && h.state !== 'STARTING') return false
    if (h.state === 'ACTIVE' && !h.isConnected) return false
    if (h.contextsCount >= config.maxContextsPerHost) return false
    if (config.hostRssHighWatermarkMb > 0 && h.rssMb !== undefined) {
      if (h.rssMb >= config.hostRssHighWatermarkMb) return false
    }
    return true
  })

  // 2. 根据同目标分散将候选分为 clean（不含同系统键）与 colocated（含同系统键）
  const cleanCandidates: HostSnapshot[] = []
  const colocatedCandidates: HostSnapshot[] = []

  for (const candidate of validCandidates) {
    const hasSameSystem = spreadKeys.some((k) => candidate.targetKeys.has(k))
    if (hasSameSystem) {
      colocatedCandidates.push(candidate)
    } else {
      cleanCandidates.push(candidate)
    }
  }

  // 3. 排序策略：优先已 ACTIVE 且 contexts 多的优先，容量相同时选启动较早的
  const sortPacking = (a: HostSnapshot, b: HostSnapshot) => {
    if (a.state !== b.state) {
      if (a.state === 'ACTIVE') return -1
      if (b.state === 'ACTIVE') return 1
    }
    if (b.contextsCount !== a.contextsCount) {
      return b.contextsCount - a.contextsCount
    }
    return a.launchedAt - b.launchedAt
  }

  if (cleanCandidates.length > 0) {
    cleanCandidates.sort(sortPacking)
    return { action: 'USE_HOST', hostId: cleanCandidates[0]!.hostId }
  }

  // 4. 无 clean 候选，判断是否可新建宿主（独占宿主占用的预算一并计入）
  const aliveSharedHosts = hosts.filter((h) => h.state !== 'DEAD')
  if (aliveSharedHosts.length + dedicatedHosts < maxSharedHosts) {
    return { action: 'CREATE_HOST' }
  }

  // 已达宿主上限，检查是否有空闲的空宿主（contextsCount === 0）
  const emptyHost = aliveSharedHosts.find((h) => h.contextsCount === 0)
  if (emptyHost) {
    return { action: 'CLOSE_IDLE_AND_CREATE', idleHostId: emptyHost.hostId }
  }

  // 无法新建：若 prefer，则降级复用同目标宿主；若 strict，返回容量不足
  if (config.targetSpread === 'prefer' && colocatedCandidates.length > 0) {
    colocatedCandidates.sort(sortPacking)
    return { action: 'USE_HOST', hostId: colocatedCandidates[0]!.hostId }
  }

  return { action: 'CAPACITY_EXCEEDED', reason: 'target_spread_strict_exhausted' }
}

export type ManagedHost = {
  hostId: string
  browser: Browser | null
  launchedAt: number
  state: HostState
  contexts: Map<string, { context: BrowserContext; spreadKeys: string[]; explicitClose: boolean }>
  pendingContexts: Set<string>
  targets: Map<string, number>
  idleTimer?: NodeJS.Timeout
  maxAgeTimer?: NodeJS.Timeout
  isExplicitClose: boolean
  readyDeferred?: {
    promise: Promise<Browser>
    resolve: (b: Browser) => void
    reject: (err: unknown) => void
  }
}

async function waitWithTimeoutAndSignal<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    throw signal.reason ?? new Error('Aborted')
  }
  let timer: NodeJS.Timeout | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new BrowserRuntimeError('BROWSER_UNAVAILABLE', '等待宿主就绪超时')),
      timeoutMs,
    )
  })
  const abortPromise = signal
    ? new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason ?? new Error('Aborted')), {
          once: true,
        })
      })
    : null

  try {
    return await Promise.race([promise, timeoutPromise, ...(abortPromise ? [abortPromise] : [])])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export class SimpleMutex {
  private queue: Array<() => void> = []
  private locked = false

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }

  private acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.queue.push(resolve)
    })
  }

  private release(): void {
    const next = this.queue.shift()
    if (next) {
      next()
    } else {
      this.locked = false
    }
  }
}

export class BrowserHostPool {
  private hosts = new Map<string, ManagedHost>()
  private placementMutex = new SimpleMutex()
  private hostLostCount = 0
  private prewarmPolicy: PlatformBrowserPrewarm = FACTORY_BROWSER_PREWARM
  private policyRevision = 0
  private maxBrowserHosts: number
  private browserMemoryBudgetMb: number
  private adaptiveController: AdaptivePrewarmController
  private warmHits = 0
  private coldMisses = 0
  private reuseHits = 0
  private prewarmAbortControllers = new Set<AbortController>()
  private underMemoryPressure = false
  private lastPrewarmError?: string
  private lastPrewarmSkipReason?: string
  private isShuttingDown = false
  private prewarmReconcileTimer?: NodeJS.Timeout
  private memorySample?: {
    sampledAt: number
    totalRssBytes: number
    perHostRssBytes: Map<string, number>
  }

  constructor(
    private readonly workerId: string,
    private readonly config: HostPoolConfig = DEFAULT_HOST_POOL_CONFIG,
    private readonly launchHostOverride?: (hostId: string) => Promise<Browser>,
    private readonly onHostCrashCallback?: (hostId: string, sessionIds: string[]) => void,
    private readonly onContextCrashCallback?: (hostId: string, sessionId: string) => void,
    private readonly defaultLaunchOpts?: { headless?: boolean; executablePath?: string },
    private readonly workerInstanceId?: string,
  ) {
    this.maxBrowserHosts = config.maxBrowserHosts ?? config.maxSharedHosts ?? 10
    this.browserMemoryBudgetMb = config.browserMemoryBudgetMb ?? 0
    if (config.prewarmPolicy) {
      this.prewarmPolicy = config.prewarmPolicy
    }
    this.adaptiveController = new AdaptivePrewarmController({
      minIdle: this.prewarmPolicy.minIdle,
      maxIdle: this.prewarmPolicy.maxIdle,
    })
    if (config.prewarmPolicy && config.prewarmPolicy.mode !== 'off') {
      this.schedulePrewarmReconcile()
    }
  }

  getHostCount(): number {
    return [...this.hosts.values()].filter((h) => h.state !== 'DEAD').length
  }

  getContextCount(): number {
    let count = 0
    for (const h of this.hosts.values()) {
      if (h.state !== 'DEAD') count += h.contexts.size
    }
    return count
  }

  getHostLostCount(): number {
    return this.hostLostCount
  }

  getHostsSnapshot(): HostSnapshot[] {
    const sample = this.freshMemorySample()
    return [...this.hosts.values()].map((h) => ({
      hostId: h.hostId,
      state: h.state,
      isConnected: Boolean(h.browser && h.browser.isConnected()),
      contextsCount: h.contexts.size + (h.pendingContexts?.size ?? 0),
      targetKeys: new Set(h.targets.keys()),
      launchedAt: h.launchedAt,
      rssMb: sample ? (sample.perHostRssBytes.get(h.hostId) ?? 0) / 1024 / 1024 : undefined,
    }))
  }

  /** 采样缺失或过旧时返回 undefined：放置高水位与预热预算都按「未知」处理 */
  private freshMemorySample() {
    if (!this.memorySample) return undefined
    if (Date.now() - this.memorySample.sampledAt > MEMORY_SAMPLE_STALE_MS) return undefined
    return this.memorySample
  }

  /**
   * 由 Runtime 周期性推送受管进程树 RSS 采样：
   * - 填充宿主快照 rssMb，放置高水位分支据此生效；
   * - 配置了内存预算时，总 RSS 触顶即进入内存压力（取消补热、回收空宿主）。
   */
  updateMemorySample(sample: {
    sampledAt: number
    totalRssBytes: number
    perHostRssBytes: Map<string, number>
  }): void {
    this.memorySample = sample
    const budgetBytes = (this.browserMemoryBudgetMb || 0) * 1024 * 1024
    if (budgetBytes > 0 && sample.totalRssBytes >= budgetBytes) {
      if (!this.underMemoryPressure) this.setMemoryPressure(true)
    } else if (this.underMemoryPressure) {
      this.setMemoryPressure(false)
    }
  }

  getHost(hostId: string): ManagedHost | undefined {
    return this.hosts.get(hostId)
  }

  /**
   * 阶段 1：短锁预定宿主与容量
   */
  private async reservePlacement(
    sessionId: string,
    spreadKeys: string[],
    totalActiveSessionsCount: number,
    maxSessions: number,
    signal?: AbortSignal,
  ): Promise<{ reservation: HostReservation; hostToLaunch?: ManagedHost; idleHostToClose?: string }> {
    return this.placementMutex.runExclusive(async () => {
      signal?.throwIfAborted()

      const snapshots = this.getHostsSnapshot()
      const placement = decideHostPlacement(
        snapshots,
        spreadKeys,
        {
          maxContextsPerHost: this.config.maxContextsPerHost,
          maxSessions,
          // 共享宿主放置帽与预热预算同一来源：不再把 maxSessions 暗当共享宿主硬上限
          maxSharedHosts: this.config.maxSharedHosts ?? this.maxBrowserHosts,
          targetSpread: this.config.targetSpread,
          hostRssHighWatermarkMb: this.config.hostRssHighWatermarkMb,
          dedicatedHosts: this.dedicatedHostCount(),
        },
        totalActiveSessionsCount,
      )

      if (placement.action === 'CAPACITY_EXCEEDED') {
        throw new BrowserRuntimeError('BROWSER_UNAVAILABLE', `宿主池无可用容量: ${placement.reason}`)
      }

      let idleHostToClose: string | undefined
      if (placement.action === 'CLOSE_IDLE_AND_CREATE') {
        idleHostToClose = placement.idleHostId
      }

      if (placement.action === 'CREATE_HOST' || placement.action === 'CLOSE_IDLE_AND_CREATE') {
        this.coldMisses += 1
        this.adaptiveController.recordDemand('coldMiss')
        const hostId = randomUUID()
        let resolveReady!: (b: Browser) => void
        let rejectReady!: (err: unknown) => void
        const readyPromise = new Promise<Browser>((res, rej) => {
          resolveReady = res
          rejectReady = rej
        })

        const newHost: ManagedHost = {
          hostId,
          browser: null,
          launchedAt: Date.now(),
          state: 'STARTING',
          contexts: new Map(),
          pendingContexts: new Set([sessionId]),
          targets: new Map(),
          isExplicitClose: false,
          readyDeferred: {
            promise: readyPromise,
            resolve: resolveReady,
            reject: rejectReady,
          },
        }
        for (const k of spreadKeys) {
          newHost.targets.set(k, 1)
        }
        this.hosts.set(hostId, newHost)
        return {
          reservation: {
            sessionId,
            hostId,
            kind: 'NEW',
            spreadKeys,
            colocated: false,
          },
          hostToLaunch: newHost,
          idleHostToClose,
        }
      }

      // USE_HOST
      const host = this.hosts.get(placement.hostId)
      if (
        !host ||
        (host.state !== 'ACTIVE' && host.state !== 'STARTING') ||
        (host.browser && !host.browser.isConnected())
      ) {
        this.coldMisses += 1
        this.adaptiveController.recordDemand('coldMiss')
        const hostId = randomUUID()
        let resolveReady!: (b: Browser) => void
        let rejectReady!: (err: unknown) => void
        const readyPromise = new Promise<Browser>((res, rej) => {
          resolveReady = res
          rejectReady = rej
        })
        const fallbackHost: ManagedHost = {
          hostId,
          browser: null,
          launchedAt: Date.now(),
          state: 'STARTING',
          contexts: new Map(),
          pendingContexts: new Set([sessionId]),
          targets: new Map(),
          isExplicitClose: false,
          readyDeferred: {
            promise: readyPromise,
            resolve: resolveReady,
            reject: rejectReady,
          },
        }
        for (const k of spreadKeys) {
          fallbackHost.targets.set(k, 1)
        }
        this.hosts.set(hostId, fallbackHost)
        return {
          reservation: {
            sessionId,
            hostId,
            kind: 'NEW',
            spreadKeys,
            colocated: false,
          },
          hostToLaunch: fallbackHost,
          idleHostToClose,
        }
      }

      const isWarmEmpty = host.contexts.size === 0 && host.pendingContexts.size === 0
      if (isWarmEmpty) {
        this.warmHits += 1
        this.adaptiveController.recordDemand('warmHit')
      } else {
        this.reuseHits += 1
      }

      if (host.idleTimer) {
        clearTimeout(host.idleTimer)
        host.idleTimer = undefined
      }

      const colocated = spreadKeys.some((k) => host.targets.has(k))
      for (const k of spreadKeys) {
        host.targets.set(k, (host.targets.get(k) ?? 0) + 1)
      }
      host.pendingContexts.add(sessionId)

      return {
        reservation: {
          sessionId,
          hostId: host.hostId,
          kind: 'EXISTING',
          spreadKeys,
          colocated,
        },
        idleHostToClose,
      }
    })
  }

  async acquireContext(
    sessionId: string,
    spreadKeys: string[],
    opts: LaunchSessionOpts,
    totalActiveSessionsCount: number,
    maxSessions: number,
    signal?: AbortSignal,
  ): Promise<{ handle: BrowserHandle; hostId: string; colocated: boolean }> {
    // 阶段 1：短锁预定
    const { reservation, hostToLaunch, idleHostToClose } = await this.reservePlacement(
      sessionId,
      spreadKeys,
      totalActiveSessionsCount,
      maxSessions,
      signal,
    )

    if (idleHostToClose) {
      await this.closeHostInternal(idleHostToClose).catch(() => {})
    }

    let browser: Browser | null = null
    let handle: BrowserHandle | null = null

    // 阶段 2：锁外异步执行（启动 Browser 或等待就绪后 openSharedSession）
    try {
      signal?.throwIfAborted()

      if (reservation.kind === 'NEW' && hostToLaunch) {
        try {
          browser = await this.launchBrowser(reservation.hostId)
          hostToLaunch.browser = browser
          hostToLaunch.readyDeferred?.resolve(browser)
        } catch (err) {
          hostToLaunch.readyDeferred?.reject(err)
          throw err
        }
      } else {
        const host = this.hosts.get(reservation.hostId)
        if (!host || host.state === 'DEAD') {
          throw new BrowserRuntimeError('BROWSER_UNAVAILABLE', '预定宿主已失效')
        }
        if (host.browser && host.browser.isConnected()) {
          browser = host.browser
        } else if (host.readyDeferred) {
          browser = await waitWithTimeoutAndSignal(host.readyDeferred.promise, 30_000, signal)
        } else {
          throw new BrowserRuntimeError('BROWSER_UNAVAILABLE', '预定宿主未就绪')
        }
      }

      signal?.throwIfAborted()
      handle = await openSharedSession({ browser, hostId: reservation.hostId }, opts)

      // 阶段 3：短锁确认与挂载
      await this.commitReservation(reservation, browser, handle)
      this.schedulePrewarmReconcile()
      return { handle, hostId: reservation.hostId, colocated: reservation.colocated }
    } catch (error) {
      // 阶段 3 异常回退：关闭 Context、回滚预占、回收宿主
      if (handle?.context) {
        await handle.context.close().catch(() => {})
      }
      await this.rollbackReservation(reservation, browser)
      this.schedulePrewarmReconcile()
      throw error
    }
  }

  private async commitReservation(
    reservation: HostReservation,
    browser: Browser,
    handle: BrowserHandle,
  ): Promise<void> {
    await this.placementMutex.runExclusive(async () => {
      const host = this.hosts.get(reservation.hostId)
      if (!host || host.state === 'DEAD') {
        throw new BrowserRuntimeError('BROWSER_UNAVAILABLE', '宿主已失效')
      }

      if (reservation.kind === 'NEW') {
        host.state = 'ACTIVE'
        browser.on('disconnected', () => {
          if (!host.isExplicitClose && host.state !== 'DEAD') {
            host.state = 'DEAD'
            this.hostLostCount += 1
            const activeSessions = [...host.contexts.keys()]
            host.contexts.clear()
            host.pendingContexts.clear()
            host.targets.clear()
            this.onHostCrashCallback?.(host.hostId, activeSessions)
            this.schedulePrewarmReconcile()
          }
        })

        if (this.config.hostMaxAgeSeconds > 0) {
          host.maxAgeTimer = setTimeout(() => {
            if (host.state === 'ACTIVE') {
              host.state = 'DRAINING'
              if (host.contexts.size === 0 && host.pendingContexts.size === 0) {
                void this.closeHostInternal(host.hostId).then(() => {
                  this.schedulePrewarmReconcile()
                })
              }
            }
          }, this.config.hostMaxAgeSeconds * 1000)
        }
      }

      const entry = { context: handle.context, spreadKeys: reservation.spreadKeys, explicitClose: false }
      host.contexts.set(reservation.sessionId, entry)
      host.pendingContexts.delete(reservation.sessionId)

      handle.context.on('close', () => {
        if (!entry.explicitClose && host.state !== 'DEAD') {
          this.releaseContextReservation(host, reservation.sessionId, reservation.spreadKeys)
          this.onContextCrashCallback?.(host.hostId, reservation.sessionId)
        }
      })
    })
  }

  private async rollbackReservation(
    reservation: HostReservation,
    browser: Browser | null,
  ): Promise<void> {
    await this.placementMutex.runExclusive(async () => {
      const host = this.hosts.get(reservation.hostId)
      if (!host) return

      host.pendingContexts.delete(reservation.sessionId)
      this.releaseSpreadKeys(host, reservation.spreadKeys)

      if (reservation.kind === 'NEW') {
        host.state = 'DEAD'
        if (browser && browser.isConnected()) {
          await browser.close().catch(() => {})
        } else if (host.browser && host.browser.isConnected()) {
          await host.browser.close().catch(() => {})
        }
        this.hosts.delete(reservation.hostId)
      } else {
        if (host.contexts.size === 0 && host.pendingContexts.size === 0) {
          if (host.state === 'DRAINING') {
            void this.closeHostInternal(host.hostId)
          } else if (host.state === 'ACTIVE') {
            this.scheduleHostIdleClose(host)
          }
        }
      }
    })
  }

  async releaseContext(sessionId: string, spreadKeys?: string[]): Promise<void> {
    let host: ManagedHost | undefined
    for (const h of this.hosts.values()) {
      if (h.contexts.has(sessionId) || h.pendingContexts.has(sessionId)) {
        host = h
        break
      }
    }
    if (!host) return

    const entry = host.contexts.get(sessionId)
    const keys = spreadKeys ?? entry?.spreadKeys ?? []
    if (entry) {
      entry.explicitClose = true
      await entry.context.close().catch(() => {})
      host.contexts.delete(sessionId)
    }
    host.pendingContexts.delete(sessionId)

    this.releaseSpreadKeys(host, keys)

    if (host.contexts.size === 0 && host.pendingContexts.size === 0) {
      if (host.state === 'DRAINING') {
        await this.closeHostInternal(host.hostId)
      } else if (host.state === 'ACTIVE') {
        this.scheduleHostIdleClose(host)
      }
      this.schedulePrewarmReconcile()
    }
  }

  private releaseSpreadKeys(host: ManagedHost, spreadKeys: string[]) {
    for (const key of spreadKeys) {
      const cur = host.targets.get(key)
      if (cur !== undefined) {
        if (cur <= 1) host.targets.delete(key)
        else host.targets.set(key, cur - 1)
      }
    }
  }

  private releaseContextReservation(host: ManagedHost, sessionId: string, spreadKeys: string[]) {
    host.contexts.delete(sessionId)
    host.pendingContexts.delete(sessionId)
    this.releaseSpreadKeys(host, spreadKeys)
    if (host.contexts.size === 0 && host.pendingContexts.size === 0) {
      if (host.state === 'DRAINING') {
        void this.closeHostInternal(host.hostId)
      } else if (host.state === 'ACTIVE') {
        this.scheduleHostIdleClose(host)
      }
      this.schedulePrewarmReconcile()
    }
  }

  private scheduleHostIdleClose(host: ManagedHost) {
    if (host.idleTimer) clearTimeout(host.idleTimer)
    host.idleTimer = setTimeout(() => {
      if (host.contexts.size === 0 && host.pendingContexts.size === 0 && host.state === 'ACTIVE') {
        const emptyActiveHosts = [...this.hosts.values()].filter(
          (h) => h.state === 'ACTIVE' && h.contexts.size === 0 && h.pendingContexts.size === 0,
        )
        const target = this.getEffectivePrewarmTarget()
        if (emptyActiveHosts.length > target) {
          void this.closeHostInternal(host.hostId)
        }
      }
    }, this.config.idleCloseDelayMs)
  }

  private async launchBrowser(hostId: string): Promise<Browser> {
    try {
      if (this.launchHostOverride) {
        return await this.launchHostOverride(hostId)
      } else {
        const { chromium } = await import('playwright')
        const args = ['--disable-dev-shm-usage', `--cairn-host=${this.workerId}/${hostId}`]
        if (this.workerInstanceId) {
          args.push(`--cairn-instance=${this.workerInstanceId}`)
        }
        return await chromium.launch({
          headless: this.defaultLaunchOpts?.headless ?? true,
          executablePath: this.defaultLaunchOpts?.executablePath,
          args,
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new BrowserRuntimeError('BROWSER_LAUNCH_FAILED', `启动宿主失败: ${message}`)
    }
  }

  async closeHostInternal(hostId: string): Promise<void> {
    const host = this.hosts.get(hostId)
    if (!host) return
    host.isExplicitClose = true
    host.state = 'DEAD'
    if (host.idleTimer) clearTimeout(host.idleTimer)
    if (host.maxAgeTimer) clearTimeout(host.maxAgeTimer)
    for (const entry of host.contexts.values()) {
      entry.explicitClose = true
      await entry.context.close().catch(() => {})
    }
    host.contexts.clear()
    host.pendingContexts.clear()
    host.targets.clear()
    if (host.browser && host.browser.isConnected()) {
      await host.browser.close().catch(() => {})
    }
    this.hosts.delete(hostId)
  }

  async drainHost(hostId: string): Promise<void> {
    const host = this.hosts.get(hostId)
    if (!host) return
    host.state = 'DRAINING'
    if (host.contexts.size === 0 && host.pendingContexts.size === 0) {
      await this.closeHostInternal(hostId)
    }
  }

  // --- 预热管理能力 (P5 / P6) ---

  getEffectivePrewarmTarget(): number {
    if (this.underMemoryPressure || this.isShuttingDown) return 0
    if (this.prewarmPolicy.mode === 'off') return 0

    let baseTarget = 0
    if (this.prewarmPolicy.mode === 'fixed') {
      baseTarget = this.prewarmPolicy.fixedIdle
    } else if (this.prewarmPolicy.mode === 'adaptive') {
      const evalRes = this.adaptiveController.evaluate(Date.now(), this.canUpscaleBudget())
      baseTarget = evalRes.step
    }

    const nonDeadHosts = [...this.hosts.values()].filter((h) => h.state !== 'DEAD')
    const busyHostsCount =
      nonDeadHosts.filter((h) => h.contexts.size > 0 || h.pendingContexts.size > 0).length +
      this.dedicatedHostCount()
    const budgetAllowed = Math.max(0, this.maxBrowserHosts - busyHostsCount)
    let effective = Math.min(baseTarget, budgetAllowed)
    if (effective < baseTarget) {
      this.lastPrewarmSkipReason = `budget_limit_${this.maxBrowserHosts}_busy_${busyHostsCount}`
    } else {
      this.lastPrewarmSkipReason = undefined
    }

    // 内存预算门控：采样缺失/过旧不新增预热；新鲜时按剩余预算与空宿主实测成本收敛
    if (this.browserMemoryBudgetMb > 0 && effective > 0) {
      const sample = this.freshMemorySample()
      if (!sample) {
        effective = 0
        this.lastPrewarmSkipReason = 'rss_sample_stale_or_missing'
      } else {
        const emptyHostMb = this.estimateEmptyHostRssMb(sample)
        const spareMb = this.browserMemoryBudgetMb - sample.totalRssBytes / 1024 / 1024
        const memoryAllowed = Math.max(0, Math.floor(spareMb / emptyHostMb))
        if (memoryAllowed < effective) {
          effective = memoryAllowed
          this.lastPrewarmSkipReason = `memory_budget_${Math.round(spareMb)}mb_cost_${Math.round(emptyHostMb)}mb`
        }
      }
    }
    return effective
  }

  /**
   * 空宿主内存成本估计：优先用当前池内空宿主实测均值；
   * 无空宿主样本时用最小宿主 RSS（空宿主必然不重于任何在用宿主）；
   * 完全无样本时用保守常数。共享页会导致多宿主 RSS 汇总偏大，估计值只用于准入。
   */
  private estimateEmptyHostRssMb(sample: { perHostRssBytes: Map<string, number> }): number {
    const emptyHostRss: number[] = []
    let minHostMb = Number.POSITIVE_INFINITY
    for (const h of this.hosts.values()) {
      if (h.state === 'DEAD') continue
      const rssMb = (sample.perHostRssBytes.get(h.hostId) ?? 0) / 1024 / 1024
      if (rssMb <= 0) continue
      minHostMb = Math.min(minHostMb, rssMb)
      if (h.contexts.size === 0 && h.pendingContexts.size === 0) emptyHostRss.push(rssMb)
    }
    if (emptyHostRss.length > 0) {
      return emptyHostRss.reduce((sum, v) => sum + v, 0) / emptyHostRss.length
    }
    if (Number.isFinite(minHostMb)) return minHostMb
    return FALLBACK_EMPTY_HOST_RSS_MB
  }

  private canUpscaleBudget(): boolean {
    const nonDeadHosts = [...this.hosts.values()].filter((h) => h.state !== 'DEAD')
    return nonDeadHosts.length + this.dedicatedHostCount() + 1 <= this.maxBrowserHosts && !this.underMemoryPressure
  }

  private dedicatedHostCount(): number {
    return this.config.dedicatedHostCountProvider?.() ?? 0
  }

  schedulePrewarmReconcile(delayMs = 0): void {
    if (this.isShuttingDown || this.prewarmPolicy.mode === 'off') return
    if (this.prewarmReconcileTimer) {
      clearTimeout(this.prewarmReconcileTimer)
    }
    this.prewarmReconcileTimer = setTimeout(() => {
      this.prewarmReconcileTimer = undefined
      void this.reconcilePrewarm()
    }, delayMs)
  }

  async reconcilePrewarm(): Promise<void> {
    if (this.isShuttingDown || this.underMemoryPressure) return
    const target = this.getEffectivePrewarmTarget()
    if (target <= 0) return

    const emptyActiveHosts = [...this.hosts.values()].filter(
      (h) => h.state === 'ACTIVE' && h.contexts.size === 0 && h.pendingContexts.size === 0,
    )
    const startingWarmHosts = [...this.hosts.values()].filter(
      (h) => h.state === 'STARTING' && h.contexts.size === 0 && h.pendingContexts.size === 0,
    )

    const currentTotalWarm = emptyActiveHosts.length + startingWarmHosts.length
    if (currentTotalWarm < target) {
      const needed = target - currentTotalWarm
      const launches: Promise<void>[] = []
      for (let i = 0; i < needed; i++) {
        launches.push(this.launchPrewarmHost())
      }
      await Promise.all(launches)
    } else if (emptyActiveHosts.length > target) {
      this.reconcileExcessEmptyHosts(target)
    }
  }

  private async launchPrewarmHost(): Promise<void> {
    if (this.isShuttingDown || this.underMemoryPressure) return
    const hostId = randomUUID()
    const abortController = new AbortController()
    this.prewarmAbortControllers.add(abortController)

    let resolveReady!: (b: Browser) => void
    let rejectReady!: (err: unknown) => void
    const readyPromise = new Promise<Browser>((res, rej) => {
      resolveReady = res
      rejectReady = rej
    })

    const warmHost: ManagedHost = {
      hostId,
      browser: null,
      launchedAt: Date.now(),
      state: 'STARTING',
      contexts: new Map(),
      pendingContexts: new Set(),
      targets: new Map(),
      isExplicitClose: false,
      readyDeferred: {
        promise: readyPromise,
        resolve: resolveReady,
        reject: rejectReady,
      },
    }

    this.hosts.set(hostId, warmHost)

    try {
      if (abortController.signal.aborted || this.isShuttingDown || this.underMemoryPressure) {
        throw new Error('Prewarm cancelled')
      }
      const browser = await this.launchBrowser(hostId)
      if (abortController.signal.aborted || this.isShuttingDown || this.underMemoryPressure) {
        await browser.close().catch(() => {})
        throw new Error('Prewarm cancelled')
      }

      await this.placementMutex.runExclusive(async () => {
        if (warmHost.state === 'DEAD' || warmHost.isExplicitClose) {
          await browser.close().catch(() => {})
          return
        }
        warmHost.browser = browser
        warmHost.state = 'ACTIVE'
        warmHost.readyDeferred?.resolve(browser)

        browser.on('disconnected', () => {
          if (!warmHost.isExplicitClose && warmHost.state !== 'DEAD') {
            warmHost.state = 'DEAD'
            this.hostLostCount += 1
            const activeSessions = [...warmHost.contexts.keys()]
            warmHost.contexts.clear()
            warmHost.pendingContexts.clear()
            warmHost.targets.clear()
            this.onHostCrashCallback?.(warmHost.hostId, activeSessions)
            this.schedulePrewarmReconcile()
          }
        })

        if (this.config.hostMaxAgeSeconds > 0) {
          warmHost.maxAgeTimer = setTimeout(() => {
            if (warmHost.state === 'ACTIVE') {
              warmHost.state = 'DRAINING'
              if (warmHost.contexts.size === 0 && warmHost.pendingContexts.size === 0) {
                void this.closeHostInternal(warmHost.hostId).then(() => {
                  this.schedulePrewarmReconcile()
                })
              }
            }
          }, this.config.hostMaxAgeSeconds * 1000)
        }
      })
    } catch (err) {
      this.lastPrewarmError = err instanceof Error ? err.message : String(err)
      await this.placementMutex.runExclusive(async () => {
        warmHost.state = 'DEAD'
        warmHost.readyDeferred?.reject(err)
        this.hosts.delete(hostId)
      })
    } finally {
      this.prewarmAbortControllers.delete(abortController)
    }
  }

  private cancelInFlightPrewarms(): void {
    for (const ac of this.prewarmAbortControllers) {
      ac.abort()
    }
    this.prewarmAbortControllers.clear()
    // 同步快照本次要取消的目标，延迟的互斥清理只删这些宿主：
    // 若按状态重新匹配，清理任务获得锁时可能误删取消之后新启动的预热宿主。
    const targets = [...this.hosts.values()]
      .filter((h) => h.state === 'STARTING' && h.contexts.size === 0 && h.pendingContexts.size === 0)
      .map((h) => h.hostId)
    if (targets.length === 0) return
    void this.placementMutex.runExclusive(async () => {
      for (const hostId of targets) {
        const host = this.hosts.get(hostId)
        if (host && host.state === 'STARTING' && host.contexts.size === 0 && host.pendingContexts.size === 0) {
          host.state = 'DEAD'
          this.hosts.delete(hostId)
        }
      }
    })
  }

  private reconcileExcessEmptyHosts(target: number): void {
    const emptyActiveHosts = [...this.hosts.values()].filter(
      (h) => h.state === 'ACTIVE' && h.contexts.size === 0 && h.pendingContexts.size === 0,
    )
    if (emptyActiveHosts.length > target) {
      const toClose = emptyActiveHosts.slice(target)
      for (const h of toClose) {
        h.state = 'DRAINING'
        void this.closeHostInternal(h.hostId)
      }
    }
  }

  setPrewarmPolicy(policy: PlatformBrowserPrewarm, revision?: number): void {
    this.prewarmPolicy = policy
    if (revision !== undefined) {
      this.policyRevision = revision
    }
    this.adaptiveController.updateBounds(policy.minIdle, policy.maxIdle)
    if (policy.mode === 'off') {
      this.cancelInFlightPrewarms()
      this.reconcileExcessEmptyHosts(0)
    } else {
      const target = this.getEffectivePrewarmTarget()
      this.reconcileExcessEmptyHosts(target)
      this.schedulePrewarmReconcile()
    }
  }

  setMemoryPressure(underPressure: boolean): void {
    this.underMemoryPressure = underPressure
    if (underPressure) {
      this.cancelInFlightPrewarms()
      this.reconcileExcessEmptyHosts(0)
    } else {
      this.schedulePrewarmReconcile()
    }
  }

  getPrewarmStatus(): PrewarmStatus {
    const emptyActiveCount = [...this.hosts.values()].filter(
      (h) => h.state === 'ACTIVE' && h.contexts.size === 0 && h.pendingContexts.size === 0,
    ).length
    const startingCount = [...this.hosts.values()].filter((h) => h.state === 'STARTING').length
    const activeCount = [...this.hosts.values()].filter((h) => h.state === 'ACTIVE').length
    const drainingCount = [...this.hosts.values()].filter((h) => h.state === 'DRAINING').length
    let contextsCount = 0
    for (const h of this.hosts.values()) {
      if (h.state !== 'DEAD') contextsCount += h.contexts.size
    }

    const effectiveTarget = this.getEffectivePrewarmTarget()
    const configuredTarget =
      this.prewarmPolicy.mode === 'off'
        ? 0
        : this.prewarmPolicy.mode === 'fixed'
          ? this.prewarmPolicy.fixedIdle
          : this.adaptiveController.getCurrentStep()

    return {
      mode: this.prewarmPolicy.mode,
      policyRevision: this.policyRevision,
      configuredTarget,
      effectiveTarget,
      actualIdleCount: emptyActiveCount,
      startingCount,
      activeCount,
      drainingCount,
      contextsCount,
      warmHits: this.warmHits,
      coldMisses: this.coldMisses,
      reuseHits: this.reuseHits,
      lastAdjustmentReason: this.adaptiveController.getLastReason(),
      underMemoryPressure: this.underMemoryPressure,
      lastPrewarmError: this.lastPrewarmError,
      lastPrewarmSkipReason: this.lastPrewarmSkipReason,
      managedRssBytes: this.memorySample?.totalRssBytes,
      memoryBudgetMb: this.browserMemoryBudgetMb,
      rssSampleAgeMs: this.memorySample ? Date.now() - this.memorySample.sampledAt : undefined,
    }
  }

  async shutdown(): Promise<void> {
    this.isShuttingDown = true
    if (this.prewarmReconcileTimer) {
      clearTimeout(this.prewarmReconcileTimer)
      this.prewarmReconcileTimer = undefined
    }
    this.cancelInFlightPrewarms()
    const hostIds = [...this.hosts.keys()]
    for (const hostId of hostIds) {
      await this.closeHostInternal(hostId)
    }
  }

  async drainAll(): Promise<void> {
    await this.shutdown()
  }
}
