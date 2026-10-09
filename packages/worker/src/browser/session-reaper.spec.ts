import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dropDisposedHandles, reap } from './session-reaper.js'
import type { BrowserSessionManager } from './session-manager.js'

vi.mock('@cairn/db', async (load) => ({
  ...(await load<typeof import('@cairn/db')>()),
  reapSessionLeases: vi.fn(async () => ({ settled: 3, scanned: 3 })),
  listReapableSessions: vi.fn(async () => []),
  listRequestedCloseSessions: vi.fn(async () => []),
  markSessionsClosing: vi.fn(async () => undefined),
  setSessionProbe: vi.fn(async () => true),
  getSessionById: vi.fn(async () => ({ id: 's', status: 'CLOSED', ownerWorkerId: 'other', version: 1, generation: 1 })),
}))

vi.mock('./runtime.js', async (load) => {
  const actual = await load<typeof import('./runtime.js')>()
  return {
    ...actual,
    probeHealth: vi.fn(async () => 'HEALTHY'),
    closePage: vi.fn(async () => undefined),
    stopSession: vi.fn(async () => undefined),
  }
})

function context() {
  const live = {
    handle: { basePage: { isClosed: () => false } },
    runPages: new Map(),
    screencasts: new Map(),
    lastPage: undefined,
  }
  const ctx = {
    browserUnavailable: false,
    dbHandle: {},
    logger: { log: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    options: { workerId: 'w' },
    workerInstanceId: 'i',
    ownerScope: () => ({ workerId: 'w', ownerWorkerInstanceId: 'i' }),
    dropDisposedHandles: vi.fn(async () => 0),
    sampleBrowserMemory: vi.fn(async () => {}),
    close: vi.fn(async () => 'stopped' as const),
    lives: new Map([['s', live]]),
    leaseToSession: new Map([['lease-1', 's']]),
    guard: { revoke: vi.fn() },
  }
  return ctx
}

describe('sessions.reap 拆分', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('无动作的回收周期只打 debug，有动作才打 info', async () => {
    const quiet = context()
    quiet.lives.clear()
    await reap.call(quiet as unknown as BrowserSessionManager, { includeGlobalLeases: false })
    expect(quiet.logger.log).not.toHaveBeenCalledWith(expect.anything(), 'reap.cycle')
    expect(quiet.logger.debug).toHaveBeenCalledWith(expect.objectContaining({ screencasts: 0 }), 'reap.cycle')

    const busy = context()
    await reap.call(busy as unknown as BrowserSessionManager)
    expect(busy.logger.log).toHaveBeenCalledWith(expect.objectContaining({ leasesExpired: 3 }), 'reap.cycle')
  })

  it('默认仍扫全局会话租约', async () => {
    const { reapSessionLeases } = await import('@cairn/db')
    const result = await reap.call(context() as unknown as BrowserSessionManager)
    expect(reapSessionLeases).toHaveBeenCalledOnce()
    expect(result.leasesExpired).toBe(3)
  })

  it('PS16 本进程 reap 不扫全局租约，已处置句柄仍按库状态收敛', async () => {
    const { reapSessionLeases, getSessionById } = await import('@cairn/db')
    const { stopSession } = await import('./runtime.js')
    const ctx = context()
    ctx.dropDisposedHandles = dropDisposedHandles as any
    const result = await reap.call(ctx as unknown as BrowserSessionManager, { includeGlobalLeases: false })
    expect(reapSessionLeases).not.toHaveBeenCalled()
    expect(getSessionById).toHaveBeenCalledWith(ctx.dbHandle, 's')
    expect(stopSession).toHaveBeenCalledOnce()
    expect(ctx.lives.size).toBe(0)
    expect(ctx.leaseToSession.size).toBe(0)
    expect(ctx.guard.revoke).toHaveBeenCalledWith('lease-1')
    expect(result.leasesExpired).toBe(0)
  })
})
