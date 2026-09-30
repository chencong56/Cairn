import { describe, expect, it, vi } from 'vitest'
import {
  computeTargetSpreadKeys,
  decideHostPlacement,
  BrowserHostPool,
  type HostSnapshot,
} from './host-pool.js'

import { withTestOccupancy } from './test-occupancy.js'

describe('Host Pool Pure Placement & Logic (§8.1)', () => {
  it('分散键提取：targetId 相同或入口主机名相同都判为同一系统', () => {
    const k1 = computeTargetSpreadKeys('target-1', 'https://example.com/app/login')
    const k2 = computeTargetSpreadKeys('target-2', 'http://example.com:8080/portal')
    const k3 = computeTargetSpreadKeys('target-1', 'https://other.org/')

    expect(k1).toContain('target:target-1')
    expect(k1).toContain('host:example.com')

    expect(k2).toContain('target:target-2')
    expect(k2).toContain('host:example.com')

    // k1 and k2 share host:example.com
    const overlap12 = k1.some((k) => k2.includes(k))
    expect(overlap12).toBe(true)

    // k1 and k3 share target:target-1
    const overlap13 = k1.some((k) => k3.includes(k))
    expect(overlap13).toBe(true)
  })

  it('放置算法：空池时返回 CREATE_HOST', () => {
    const decision = decideHostPlacement(
      [],
      ['target:t1'],
      { maxContextsPerHost: 6, maxSessions: 4, targetSpread: 'strict', hostRssHighWatermarkMb: 0 },
      0,
    )
    expect(decision).toEqual({ action: 'CREATE_HOST' })
  })

  it('放置算法：总会话数已满返回 CAPACITY_EXCEEDED', () => {
    const decision = decideHostPlacement(
      [],
      ['target:t1'],
      { maxContextsPerHost: 6, maxSessions: 4, targetSpread: 'strict', hostRssHighWatermarkMb: 0 },
      4,
    )
    expect(decision.action).toBe('CAPACITY_EXCEEDED')
  })

  it('放置算法：DRAINING 与 DEAD 排除，内存高水位排除', () => {
    const hosts: HostSnapshot[] = [
      {
        hostId: 'h-draining',
        state: 'DRAINING',
        isConnected: true,
        contextsCount: 1,
        targetKeys: new Set(),
        launchedAt: 1000,
      },
      {
        hostId: 'h-dead',
        state: 'DEAD',
        isConnected: false,
        contextsCount: 0,
        targetKeys: new Set(),
        launchedAt: 2000,
      },
      {
        hostId: 'h-rss-high',
        state: 'ACTIVE',
        isConnected: true,
        contextsCount: 1,
        targetKeys: new Set(),
        rssMb: 500,
        launchedAt: 3000,
      },
    ]

    const decision = decideHostPlacement(
      hosts,
      ['target:t1'],
      { maxContextsPerHost: 6, maxSessions: 4, targetSpread: 'strict', hostRssHighWatermarkMb: 400 },
      2,
    )
    expect(decision).toEqual({ action: 'CREATE_HOST' })
  })

  it('放置算法：优先装满（contexts 多的优先）以节约内存', () => {
    const hosts: HostSnapshot[] = [
      {
        hostId: 'h-1',
        state: 'ACTIVE',
        isConnected: true,
        contextsCount: 1,
        targetKeys: new Set(['target:other1']),
        launchedAt: 1000,
      },
      {
        hostId: 'h-2',
        state: 'ACTIVE',
        isConnected: true,
        contextsCount: 4,
        targetKeys: new Set(['target:other2']),
        launchedAt: 2000,
      },
      {
        hostId: 'h-3',
        state: 'ACTIVE',
        isConnected: true,
        contextsCount: 2,
        targetKeys: new Set(['target:other3']),
        launchedAt: 3000,
      },
    ]

    const decision = decideHostPlacement(
      hosts,
      ['target:new-system'],
      { maxContextsPerHost: 6, maxSessions: 10, targetSpread: 'strict', hostRssHighWatermarkMb: 0 },
      7,
    )
    expect(decision).toEqual({ action: 'USE_HOST', hostId: 'h-2' })
  })

  it('放置算法：strict 下排除同目标宿主，容量不足新建宿主', () => {
    const hosts: HostSnapshot[] = [
      {
        hostId: 'h-1',
        state: 'ACTIVE',
        isConnected: true,
        contextsCount: 2,
        targetKeys: new Set(['target:systemA']),
        launchedAt: 1000,
      },
    ]

    const decision = decideHostPlacement(
      hosts,
      ['target:systemA'],
      { maxContextsPerHost: 6, maxSessions: 4, targetSpread: 'strict', hostRssHighWatermarkMb: 0 },
      2,
    )
    expect(decision).toEqual({ action: 'CREATE_HOST' })
  })

  it('放置算法：strict 下到达宿主上限且无可关空宿主返回 CAPACITY_EXCEEDED', () => {
    const hosts: HostSnapshot[] = [
      {
        hostId: 'h-1',
        state: 'ACTIVE',
        isConnected: true,
        contextsCount: 1,
        targetKeys: new Set(['target:systemA']),
        launchedAt: 1000,
      },
      {
        hostId: 'h-2',
        state: 'ACTIVE',
        isConnected: true,
        contextsCount: 1,
        targetKeys: new Set(['target:systemA']),
        launchedAt: 2000,
      },
    ]

    const decision = decideHostPlacement(
      hosts,
      ['target:systemA'],
      { maxContextsPerHost: 6, maxSessions: 4, maxSharedHosts: 2, targetSpread: 'strict', hostRssHighWatermarkMb: 0 },
      2,
    )
    expect(decision.action).toBe('CAPACITY_EXCEEDED')
  })

  it('放置算法：prefer 模式下资源不足回落到含同目标的宿主', () => {
    const hosts: HostSnapshot[] = [
      {
        hostId: 'h-1',
        state: 'ACTIVE',
        isConnected: true,
        contextsCount: 2,
        targetKeys: new Set(['target:systemA']),
        launchedAt: 1000,
      },
      {
        hostId: 'h-2',
        state: 'ACTIVE',
        isConnected: true,
        contextsCount: 3,
        targetKeys: new Set(['target:systemA']),
        launchedAt: 2000,
      },
    ]

    const decision = decideHostPlacement(
      hosts,
      ['target:systemA'],
      { maxContextsPerHost: 6, maxSessions: 10, maxSharedHosts: 2, targetSpread: 'prefer', hostRssHighWatermarkMb: 0 },
      5,
    )
    expect(decision).toEqual({ action: 'USE_HOST', hostId: 'h-2' })
  })

  it('放置算法：到达上限但存在空闲空宿主时，先关闭空宿主再新建', () => {
    const hosts: HostSnapshot[] = [
      {
        hostId: 'h-full',
        state: 'ACTIVE',
        isConnected: true,
        contextsCount: 2,
        targetKeys: new Set(['target:systemA']),
        launchedAt: 1000,
      },
      {
        hostId: 'h-idle-empty',
        state: 'DRAINING',
        isConnected: true,
        contextsCount: 0,
        targetKeys: new Set(),
        launchedAt: 2000,
      },
    ]

    const decision = decideHostPlacement(
      hosts,
      ['target:systemA'],
      { maxContextsPerHost: 6, maxSessions: 6, maxSharedHosts: 2, targetSpread: 'strict', hostRssHighWatermarkMb: 0 },
      2,
    )
    expect(decision).toEqual({ action: 'CLOSE_IDLE_AND_CREATE', idleHostId: 'h-idle-empty' })
  })

  it('并发放置测试：10 次并发放置同一系统的不同账号，strict 下无同宿主冲突', async () => {
    const mockBrowsers: any[] = []
    const pool = new BrowserHostPool(
      'worker-concurrency-test',
      {
        maxContextsPerHost: 6,
        hostMaxAgeSeconds: 14400,
        hostRssHighWatermarkMb: 0,
        targetSpread: 'strict',
        idleCloseDelayMs: 60000,
      },
      async (hostId) => {
        const b = {
          hostId,
          isConnected: () => true,
          close: async () => {},
          on: () => {},
          newContext: async () => {
            // Add a small jitter delay to test interleaving
            await new Promise((r) => setTimeout(r, 10))
            return {
              newPage: async () => ({}),
              on: () => {},
              close: async () => {},
            }
          },
        }
        mockBrowsers.push(b)
        return b as any
      },
    )

    const spreadKeys = ['target:systemA']
    const handles = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        withTestOccupancy(() =>
          pool.acquireContext(`session-${i}`, spreadKeys, { headless: true }, i, 10),
        ),
      ),
    )

    // With strict mode and targetSpread, each session must have been assigned to a different host
    const hostIds = handles.map((h) => h.hostId)
    const uniqueHosts = new Set(hostIds)
    expect(uniqueHosts.size).toBe(5)
  })

  it('宿主崩溃事件测试：意外断开时置 DEAD 并回调受影响会话', async () => {
    let disconnectCb: (() => void) | undefined
    let crashedHost = ''
    let affected: string[] = []

    const pool = new BrowserHostPool(
      'worker-crash-test',
      {
        maxContextsPerHost: 6,
        hostMaxAgeSeconds: 14400,
        hostRssHighWatermarkMb: 0,
        targetSpread: 'strict',
        idleCloseDelayMs: 60000,
      },
      async (hostId) => {
        return {
          hostId,
          isConnected: () => true,
          close: async () => {},
          on: (event: string, cb: () => void) => {
            if (event === 'disconnected') disconnectCb = cb
          },
          newContext: async () => ({
            newPage: async () => ({}),
            on: () => {},
            close: async () => {},
          }),
        } as any
      },
      (hostId, sessionIds) => {
        crashedHost = hostId
        affected = sessionIds
      },
    )

    const handle = await withTestOccupancy(() =>
      pool.acquireContext('sess-crash-1', ['t1'], { headless: true }, 0, 5),
    )
    expect(pool.getHostCount()).toBe(1)
    expect(pool.getContextCount()).toBe(1)

    // Simulate unexpected crash
    disconnectCb?.()

    expect(crashedHost).toBe(handle.hostId)
    expect(affected).toEqual(['sess-crash-1'])
    expect(pool.getHostLostCount()).toBe(1)
    expect(pool.getContextCount()).toBe(0)
  })

  it('A09: 慢宿主启动不被长锁串行阻塞，并发启动时间重叠且 strict 保持独立宿主', async () => {
    let launch1Start = 0
    let launch1End = 0
    let launch2Start = 0
    let launch2End = 0
    let hostIndex = 0

    const pool = new BrowserHostPool(
      'worker-a09-test',
      {
        maxContextsPerHost: 6,
        hostMaxAgeSeconds: 14400,
        hostRssHighWatermarkMb: 0,
        targetSpread: 'strict',
        idleCloseDelayMs: 60000,
      },
      async (hostId) => {
        const idx = ++hostIndex
        if (idx === 1) {
          launch1Start = Date.now()
          await new Promise((r) => setTimeout(r, 60))
          launch1End = Date.now()
        } else {
          launch2Start = Date.now()
          await new Promise((r) => setTimeout(r, 60))
          launch2End = Date.now()
        }
        return {
          hostId,
          isConnected: () => true,
          close: async () => {},
          on: () => {},
          newContext: async () => ({
            newPage: async () => ({}),
            on: () => {},
            close: async () => {},
          }),
        } as any
      },
    )

    const t0 = Date.now()
    const [h1, h2] = await Promise.all([
      withTestOccupancy(() =>
        pool.acquireContext('session-1', ['target:sysA'], { headless: true }, 0, 5),
      ),
      withTestOccupancy(() =>
        pool.acquireContext('session-2', ['target:sysA'], { headless: true }, 1, 5),
      ),
    ])
    const totalElapsed = Date.now() - t0

    expect(h1.hostId).not.toBe(h2.hostId)
    expect(pool.getHostCount()).toBe(2)
    expect(pool.getContextCount()).toBe(2)

    // Parallel overlapping: total elapsed time should be < 110ms (rather than 60 + 60 = 120ms+)
    expect(totalElapsed).toBeLessThan(110)
    // Launch 2 started before launch 1 finished
    expect(launch2Start).toBeLessThan(launch1End + 15)
  })

  it('A23: 启动前取消立即拒绝且不创建宿主；启动中取消回滚预约并安全关闭宿主，不影响其它并发会话', async () => {
    let hostClosed = false
    let hostCreated = false

    const pool = new BrowserHostPool(
      'worker-a23-test',
      {
        maxContextsPerHost: 6,
        hostMaxAgeSeconds: 14400,
        hostRssHighWatermarkMb: 0,
        targetSpread: 'strict',
        idleCloseDelayMs: 60000,
      },
      async (hostId) => {
        hostCreated = true
        await new Promise((r) => setTimeout(r, 50))
        return {
          hostId,
          isConnected: () => true,
          close: async () => {
            hostClosed = true
          },
          on: () => {},
          newContext: async () => ({
            newPage: async () => ({}),
            on: () => {},
            close: async () => {},
          }),
        } as any
      },
    )

    // Case 1: Pre-aborted signal throws immediately without creating a host
    const preAborted = new AbortController()
    preAborted.abort()
    await expect(
      withTestOccupancy(() =>
        pool.acquireContext('sess-pre-abort', ['t1'], { headless: true }, 0, 5, preAborted.signal),
      ),
    ).rejects.toThrow()
    expect(hostCreated).toBe(false)
    expect(pool.getHostCount()).toBe(0)

    // Case 2: In-flight abort during host launch: reservation rolls back and host closes
    const inFlight = new AbortController()
    setTimeout(() => inFlight.abort(), 15)

    const abortPromise = withTestOccupancy(() =>
      pool.acquireContext('sess-in-flight', ['t2'], { headless: true }, 0, 5, inFlight.signal),
    )
    await expect(abortPromise).rejects.toThrow()

    // Allow out-of-lock cleanup to finish
    await new Promise((r) => setTimeout(r, 70))
    expect(hostClosed).toBe(true)
    expect(pool.getHostCount()).toBe(0)
    expect(pool.getContextCount()).toBe(0)

    // Case 3: Concurrent session that was not aborted succeeds cleanly
    const hNormal = await withTestOccupancy(() =>
      pool.acquireContext('sess-normal', ['t3'], { headless: true }, 0, 5),
    )
    expect(hNormal.hostId).toBeDefined()
    expect(hNormal.handle).toBeDefined()
    expect(pool.getHostCount()).toBe(1)
    expect(pool.getContextCount()).toBe(1)
  })

  it('A15: 固定预热冷热命中对比：启动自动补齐预热宿主、会话命中无进程冷启动、命中后后台自动补齐且受预算上限约束', async () => {
    let launchCount = 0
    const pool = new BrowserHostPool(
      'worker-a15-test',
      {
        maxContextsPerHost: 6,
        hostMaxAgeSeconds: 14400,
        hostRssHighWatermarkMb: 0,
        targetSpread: 'strict',
        idleCloseDelayMs: 60000,
        maxBrowserHosts: 2,
        prewarmPolicy: {
          mode: 'fixed',
          fixedIdle: 1,
          minIdle: 1,
          maxIdle: 5,
        },
      },
      async (hostId) => {
        launchCount++
        return {
          hostId,
          isConnected: () => true,
          close: async () => {},
          on: () => {},
          newContext: async () => ({
            newPage: async () => ({}),
            on: () => {},
            close: async () => {},
          }),
        } as any
      },
    )

    // Wait for initial prewarm reconcile triggered by constructor
    await pool.reconcilePrewarm()

    // 1. Initial prewarm created 1 empty host without business sessions
    expect(launchCount).toBe(1)
    expect(pool.getHostCount()).toBe(1)
    expect(pool.getContextCount()).toBe(0)
    let status = pool.getPrewarmStatus()
    expect(status.actualIdleCount).toBe(1)
    expect(status.warmHits).toBe(0)
    expect(status.coldMisses).toBe(0)

    // 2. First session arrives: hits warm host without launching a new browser
    const h1 = await withTestOccupancy(() =>
      pool.acquireContext('session-1', ['target:sysA'], { headless: true }, 0, 5),
    )
    expect(launchCount).toBe(1) // No new browser launch!
    status = pool.getPrewarmStatus()
    expect(status.warmHits).toBe(1)
    expect(status.coldMisses).toBe(0)
    expect(pool.getContextCount()).toBe(1)

    // Wait for background replenish to complete
    await pool.reconcilePrewarm()
    // Now launchCount is 2 (the replenished idle host)
    expect(launchCount).toBe(2)
    expect(pool.getHostCount()).toBe(2)
    status = pool.getPrewarmStatus()
    expect(status.actualIdleCount).toBe(1)

    // 3. Second session arrives for the same system: strict spread forces placement onto the replenished empty warm host
    const h2 = await withTestOccupancy(() =>
      pool.acquireContext('session-2', ['target:sysA'], { headless: true }, 1, 5),
    )
    expect(launchCount).toBe(2) // No new launch!
    status = pool.getPrewarmStatus()
    expect(status.warmHits).toBe(2)
    expect(status.coldMisses).toBe(0)
    expect(h1.hostId).not.toBe(h2.hostId)

    // 4. Third session arrives for a third system: packs onto an existing host (reuse hit)
    const h3 = await withTestOccupancy(() =>
      pool.acquireContext('session-3', ['target:sysC'], { headless: true }, 2, 5),
    )
    expect(launchCount).toBe(2) // No new launch!
    status = pool.getPrewarmStatus()
    expect(status.reuseHits).toBe(1)
    expect([h1.hostId, h2.hostId]).toContain(h3.hostId)

    // 5. Budget constraint: maxBrowserHosts is 2, currently 2 hosts are active with sessions.
    // Background prewarm cannot exceed maxBrowserHosts.
    await pool.reconcilePrewarm()
    expect(launchCount).toBe(2) // No over-provisioning
    status = pool.getPrewarmStatus()
    expect(status.effectiveTarget).toBe(0)
    expect(status.lastPrewarmSkipReason).toContain('budget_limit_2_busy_2')

    await pool.shutdown()
  })

  it('A16: 预热宿主防抖与生命周期保护：预热目标内空宿主不受 idleTimer 误杀、多余空宿主自动关闭、maxAge 到期平滑轮转、内存压力归零回收', async () => {
    const closedHosts: string[] = []
    const pool = new BrowserHostPool(
      'worker-a16-test',
      {
        maxContextsPerHost: 6,
        hostMaxAgeSeconds: 0.1, // 100ms for testing maxAge rotation
        hostRssHighWatermarkMb: 0,
        targetSpread: 'strict',
        idleCloseDelayMs: 30, // 30ms for testing idle close
        maxBrowserHosts: 4,
        prewarmPolicy: {
          mode: 'fixed',
          fixedIdle: 1,
          minIdle: 1,
          maxIdle: 5,
        },
      },
      async (hostId) => {
        return {
          hostId,
          isConnected: () => true,
          close: async () => {
            closedHosts.push(hostId)
          },
          on: () => {},
          newContext: async () => ({
            newPage: async () => ({}),
            on: () => {},
            close: async () => {},
          }),
        } as any
      },
    )

    // 1. Initial warm host
    await pool.reconcilePrewarm()
    expect(pool.getHostCount()).toBe(1)
    const initialHostId = pool.getHostsSnapshot()[0]!.hostId

    // 2. Idle timer test: wait 50ms (> idleCloseDelayMs 30ms).
    // The warm host must NOT be killed because it is within prewarm target.
    await new Promise((r) => setTimeout(r, 50))
    expect(pool.getHostCount()).toBe(1)
    expect(closedHosts).not.toContain(initialHostId)

    // 3. Max age rotation test: after 100ms total, initialHostId reaches maxAge,
    // drains and closes, and pool replenishes with a fresh warm host!
    await new Promise((r) => setTimeout(r, 90))
    expect(closedHosts).toContain(initialHostId)
    // Replenished host is present
    expect(pool.getHostCount()).toBe(1)
    const newHostId = pool.getHostsSnapshot()[0]!.hostId
    expect(newHostId).not.toBe(initialHostId)

    // 4. Memory pressure test:
    // Acquire a context on the current host
    await withTestOccupancy(() =>
      pool.acquireContext('session-mem', ['target:sysA'], { headless: true }, 0, 5),
    )
    // Background prewarm launches an idle host
    await pool.reconcilePrewarm()
    expect(pool.getHostCount()).toBe(2)

    // Trigger memory pressure
    pool.setMemoryPressure(true)
    let status = pool.getPrewarmStatus()
    expect(status.underMemoryPressure).toBe(true)
    expect(status.effectiveTarget).toBe(0)

    // Idle warm host is closed, but the active session host remains alive!
    expect(pool.getHostCount()).toBe(1)
    expect(pool.getContextCount()).toBe(1)

    // Release memory pressure -> prewarm recovers
    pool.setMemoryPressure(false)
    await pool.reconcilePrewarm()
    expect(pool.getHostCount()).toBe(2)

    await pool.shutdown()
  })

  it('A17 & A20: 自适应预热阶梯扩缩容与动态配置热切换：off/fixed/adaptive 切换无缝排空与补齐，可观测性指标准确', async () => {
    let closedCount = 0
    const pool = new BrowserHostPool(
      'worker-a17-a20-test',
      {
        maxContextsPerHost: 6,
        hostMaxAgeSeconds: 14400,
        hostRssHighWatermarkMb: 0,
        targetSpread: 'strict',
        idleCloseDelayMs: 60000,
        maxBrowserHosts: 5,
        prewarmPolicy: {
          mode: 'off',
          fixedIdle: 1,
          minIdle: 1,
          maxIdle: 5,
        },
      },
      async (hostId) => {
        return {
          hostId,
          isConnected: () => true,
          close: async () => {
            closedCount++
          },
          on: () => {},
          newContext: async () => ({
            newPage: async () => ({}),
            on: () => {},
            close: async () => {},
          }),
        } as any
      },
    )

    // 1. Initial mode is 'off': 0 hosts
    expect(pool.getHostCount()).toBe(0)
    let status = pool.getPrewarmStatus()
    expect(status.mode).toBe('off')
    expect(status.configuredTarget).toBe(0)
    expect(status.effectiveTarget).toBe(0)

    // 2. Dynamic switch: off -> fixed (revision 1)
    pool.setPrewarmPolicy(
      {
        mode: 'fixed',
        fixedIdle: 2,
        minIdle: 1,
        maxIdle: 5,
      },
      1,
    )
    await pool.reconcilePrewarm()
    expect(pool.getHostCount()).toBe(2)
    status = pool.getPrewarmStatus()
    expect(status.mode).toBe('fixed')
    expect(status.policyRevision).toBe(1)
    expect(status.configuredTarget).toBe(2)
    expect(status.actualIdleCount).toBe(2)

    // 3. Dynamic switch: fixed -> off (revision 2)
    // Warm idle hosts must be cleanly closed immediately
    pool.setPrewarmPolicy(
      {
        mode: 'off',
        fixedIdle: 1,
        minIdle: 1,
        maxIdle: 5,
      },
      2,
    )
    expect(pool.getHostCount()).toBe(0)
    expect(closedCount).toBe(2)
    status = pool.getPrewarmStatus()
    expect(status.mode).toBe('off')
    expect(status.policyRevision).toBe(2)
    expect(status.effectiveTarget).toBe(0)

    // 4. Dynamic switch: off -> adaptive (revision 3)
    pool.setPrewarmPolicy(
      {
        mode: 'adaptive',
        fixedIdle: 1,
        minIdle: 1,
        maxIdle: 5,
      },
      3,
    )
    await pool.reconcilePrewarm()
    // Adaptive starts at minIdle (1)
    expect(pool.getHostCount()).toBe(1)
    status = pool.getPrewarmStatus()
    expect(status.mode).toBe('adaptive')
    expect(status.policyRevision).toBe(3)
    expect(status.configuredTarget).toBe(1)
    expect(status.actualIdleCount).toBe(1)

    await pool.shutdown()
  })
})
