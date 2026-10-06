import { vi } from "vitest"
vi.mock("@cairn/db", async (original) => ({
  ...(await original()),
  getSessionOperation: vi.fn(async () => null),
  getSessionById: vi.fn(async (db, id) => id === "00000000-0000-4000-8000-000000000011" ? { id, status: "OPEN" } : null),
  getWorkerById: vi.fn(async () => ({ id: "worker" })),
  getRun: vi.fn(async () => ({ status: "RUNNING", placement: {} })),
  touchSessionUsed: vi.fn(async () => true),
  findSessionByAuthWaitRun: vi.fn(async () => null),
  findAuthWaitLeaseForRun: vi.fn(async () => null),
  findAuthWaitLeaseForOperation: vi.fn(async () => null),
  findActiveLeaseRow: vi.fn(async () => null),
}))

import { describe, expect, it } from 'vitest'
import { BrowserSessionManager } from './session-manager.js'

const stop = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('./screencast.js', async (original) => {
  const actual = await original<typeof import('./screencast.js')>()
  return {
    ...actual,
    startScreencast: vi.fn(async (_page: unknown, pageRef: { pageId: string } | (() => { pageId: string })) => ({
      latest: {
        pageRef: typeof pageRef === 'function' ? pageRef() : pageRef,
        frameId: 'f-1',
        width: 1280,
        height: 720,
        capturedAt: new Date().toISOString(),
        image: 'data:image/jpeg;base64,ZmFrZQ==',
      },
      stop,
    })),
    refreshScreencastIfStale: vi.fn(async () => undefined),
  }
})

const sessionId = '00000000-0000-4000-8000-000000000011'
const runId = '00000000-0000-4000-8000-000000000012'
const actorId = '00000000-0000-4000-8000-000000000013'
const pageId = '00000000-0000-4000-8000-000000000014'

function subscribeManager() {
  const page = {
    isClosed: () => false,
    url: () => 'https://shop.example.com/app',
    viewportSize: () => ({ width: 1280, height: 720 }),
  }
  const live = {
    sessionId,
    autoInputClosed: false,
    inputAccepting: false,
    serial: Promise.resolve(),
    receipts: new Map(),
    lastSeq: 0,
    controlEpoch: 0,
    pages: new Map([[pageId, { pageId, runId, documentEpoch: 1, page, kind: 'run' }]]),
    currentPageIdByRun: new Map([[runId, pageId]]),
    currentPageIdByLease: new Map(),
    runPages: new Map(),
    screencasts: new Map(),
    screencastObservers: new Map(),
    allowedOrigins: ['https://shop.example.com'],
    handle: { basePage: page },
  }
  const session = {
    id: sessionId,
    generation: 1,
    ownerWorkerId: 'test-worker',
    ownerWorkerInstanceId: 'test-worker',
    authControlActorId: null,
    authControlExpiresAt: null,
  }
  const run = { status: 'RUNNING' }
  const manager = Object.create(BrowserSessionManager.prototype) as BrowserSessionManager
  Object.assign(manager, {
    dbHandle: {},
    workerInstanceId: 'test-worker',
    options: { workerId: 'test-worker' },
    lives: new Map([[sessionId, live]]),
    leaseToRun: new Map(),
    leaseToSession: new Map(),
    requireLiveAuthSession: async () => ({ session, live, run }),
    sessionOwnedHere: () => true,
    registrationLive: () => true,
  })
  return { manager, live }
}

describe('画面订阅生命周期', () => {
  it('20 次连接/关闭不残留观察者或采集句柄', async () => {
    const { manager, live } = subscribeManager()
    stop.mockClear()
    for (let i = 0; i < 20; i += 1) {
      const controller = new AbortController()
      const seen = new Promise<void>((resolve) => {
        void manager.subscribeRunFrames({
          runId,
          actorId,
          onFrame: () => {
            resolve()
            controller.abort()
          },
          signal: controller.signal,
        })
      })
      await seen
      await vi.waitFor(() => expect(manager.countScreencastObservers(sessionId)).toBe(0))
    }
    expect(stop).toHaveBeenCalledTimes(20)
    expect(live.screencasts.size).toBe(0)
    expect(manager.countScreencastObservers(sessionId)).toBe(0)
    const db = await import('@cairn/db')
    expect(vi.mocked(db.touchSessionUsed)).toHaveBeenCalled()
  })

  it('会话实例订阅在 getRun 找不到运行时仍持续出帧', async () => {
    const { manager, live } = subscribeManager()
    const db = await import('@cairn/db')
    vi.mocked(db.getRun).mockRejectedValue(Object.assign(new Error('运行不存在'), { code: 'RUN_NOT_FOUND' }))
    Object.assign(manager, {
      lookupRunSession: async () => ({
        run: { id: sessionId, status: 'RUNNING', placement: { sessionId } },
        session: {
          id: sessionId,
          generation: 1,
          ownerWorkerId: 'test-worker',
          ownerWorkerInstanceId: 'test-worker',
          authControlActorId: null,
          authControlExpiresAt: null,
        },
        live,
      }),
      pageForView: () => live.pages.get(pageId),
    })
    stop.mockClear()
    let frames = 0
    const controller = new AbortController()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`只收到 ${frames} 帧`)), 2000)
      void manager.subscribeRunFrames({
        runId: sessionId,
        actorId,
        onFrame: () => {
          frames += 1
          if (frames >= 2) {
            clearTimeout(timer)
            controller.abort()
            resolve()
          }
        },
        signal: controller.signal,
      })
    })
    expect(frames).toBeGreaterThanOrEqual(2)
    vi.mocked(db.getRun).mockResolvedValue({ status: 'RUNNING', placement: {} } as never)
  })

  describe('认证等待期画面门禁', () => {
    function waitingManager() {
      const { manager, live } = subscribeManager()
      const original = manager.requireLiveAuthSession.bind(manager)
      const waitingRun = { id: runId, status: 'WAITING_FOR_AUTH', placement: { sessionId } }
      Object.assign(manager, {
        requireLiveAuthSession: async (id: string) => ({
          ...(await original(id)),
          run: waitingRun,
        }),
        // 定时复核走 lookupRunSession：必须同样返回等待登录态，才能覆盖「复核时漏传控制资格」的回归。
        lookupRunSession: async () => ({
          run: waitingRun,
          session: {
            id: sessionId,
            generation: 1,
            ownerWorkerId: 'test-worker',
            ownerWorkerInstanceId: 'test-worker',
            authControlActorId: null,
            authControlExpiresAt: null,
          },
          live,
        }),
      })
      return manager
    }

    it('无控制资格且未持有输入权时拒绝出帧', async () => {
      const manager = waitingManager()
      await expect(
        manager.subscribeRunFrames({
          runId,
          actorId,
          onFrame: () => undefined,
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: 'AUTH_CONTROL_INVALID' })
    })

    it('有控制资格者未取得输入权也能持续只读出帧（不会在定时复核时被判无权断流）', async () => {
      const manager = waitingManager()
      const controller = new AbortController()
      let frames = 0
      let ended = false
      const done = manager
        .subscribeRunFrames({
          runId,
          actorId,
          actorCanControl: true,
          onFrame: () => {
            frames += 1
            if (frames >= 3) controller.abort()
          },
          signal: controller.signal,
        })
        .then(() => {
          ended = true
        })
      await vi.waitFor(() => expect(frames).toBeGreaterThanOrEqual(3), { timeout: 4000 })
      await done
      expect(ended).toBe(true)
      expect(controller.signal.aborted).toBe(true)
    })
  })

  describe('所看页与页列表变化', () => {
    function viewingManager() {
      const { manager, live } = subscribeManager()
      const session = {
        id: sessionId,
        generation: 1,
        ownerWorkerId: 'test-worker',
        ownerWorkerInstanceId: 'test-worker',
        authControlActorId: null,
        authControlExpiresAt: null,
      }
      Object.assign(live, { pagesRevision: 7 })
      Object.assign(manager, {
        lookupRunSession: async () => ({ run: { id: runId, status: 'RUNNING', placement: { sessionId } }, session, live }),
      })
      return { manager, live }
    }

    it('帧携带页登记表序号，Web 据此重取页列表', async () => {
      const { manager } = viewingManager()
      const controller = new AbortController()
      const frame = await new Promise<{ pagesRevision?: number }>((resolve) => {
        void manager.subscribeRunFrames({
          runId,
          actorId,
          pageId,
          onFrame: (next) => {
            controller.abort()
            resolve(next)
          },
          signal: controller.signal,
        })
      })
      expect(frame.pagesRevision).toBe(7)
    })

    it('指定的页不属于该运行时拒绝订阅，不静默换成当前页', async () => {
      const { manager, live } = viewingManager()
      live.pages.get(pageId)!.runId = sessionId
      await expect(
        manager.subscribeRunFrames({ runId, actorId, pageId, onFrame: () => undefined, signal: new AbortController().signal }),
      ).rejects.toMatchObject({ code: 'PAGE_STALE' })
    })

    it('所看的页在订阅中被撤登记时以 PAGE_STALE 结束；跟随当前页的订阅正常结束', async () => {
      const { manager, live } = viewingManager()
      let frames = 0
      const viewing = manager.subscribeRunFrames({
        runId,
        actorId,
        pageId,
        onFrame: () => {
          frames += 1
          live.pages.delete(pageId)
        },
        signal: new AbortController().signal,
      })
      await expect(viewing).rejects.toMatchObject({ code: 'PAGE_STALE' })
      expect(frames).toBe(1)

      const followed = viewingManager()
      const following = followed.manager.subscribeRunFrames({
        runId,
        actorId,
        onFrame: () => {
          followed.live.pages.delete(pageId)
        },
        signal: new AbortController().signal,
      })
      await expect(following).resolves.toBeUndefined()
    })
  })
})
