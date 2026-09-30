/**
 * P4 完整功能验收：单 Worker 三场景浏览器屏障重叠执行、会话独立、strict 宿主分散与第 4 条上限等待
 * 覆盖用例：A10, A11, A12
 */
import { createServer, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  claimRun,
  consoleAccounts,
  createRunWithSnapshot,
  createScenarioWithVersion,
  eq,
  getRun,
  grantAdminScope,
  newId,
  openIsolatedDb,
  registerWorker,
  schemaFor,
  targetAccounts,
  targets,
  type DbHandle,
} from '@cairn/db/testing'
import {
  DEFAULT_SESSION_POLICY,
  type Step,
  type RunGrant,
} from '@cairn/shared'
import { WORKER_TEST_PROTOCOLS } from '../__tests__/worker-protocols.js'
import { isChromiumAvailableCached } from '../testing/chromium-probe.js'
import { createBrowserPort } from './port.js'
import { BrowserSessionManager } from './session-manager.js'
import { LocalObjectStore } from '@cairn/storage'
import { ObjectService } from '../objects/object.service.js'
import { ExecutionEngine } from '../engine/engine.js'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_p4b`

describe('P4: 单 Worker 浏览器屏障重叠执行与容量边界验收 (A10 / A11 / A12)', { timeout: 180_000 }, () => {
  let hasBrowser = false
  let handle: DbHandle
  let manager: BrowserSessionManager
  let engine: ExecutionEngine
  let server: ReturnType<typeof createServer> | undefined
  let baseUrl = ''
  let actorId: string
  let targetId: string
  let accountId: string
  let workerId: string
  let workerInstanceId: string
  let objectDir = ''

  // 屏障控制
  let barrierWaiters: ServerResponse[] = []
  let barrierPromiseResolve: () => void
  let barrierReachedPromise: Promise<void>

  let expectedWaiters = 3

  function resetBarrier(expectedCount = 3) {
    expectedWaiters = expectedCount
    barrierWaiters = []
    barrierReachedPromise = new Promise<void>((resolve) => {
      barrierPromiseResolve = resolve
    })
  }

  function releaseBarrier() {
    for (const res of barrierWaiters) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><html><body><div id="status">barrier-passed</div></body></html>`)
    }
    barrierWaiters = []
  }

  beforeAll(async () => {
    hasBrowser = await isChromiumAvailableCached()
    if (!hasBrowser) return

    handle = await openIsolatedDb(SCHEMA)
    actorId = newId()
    targetId = newId()
    accountId = newId()

    resetBarrier(3)

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/login') {
        if (req.method === 'POST') {
          res.writeHead(302, { Location: '/', 'Set-Cookie': 'auth=ok; Path=/' })
          res.end()
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html><html><body>
          <form method="POST" action="/login">
            <input name="username" value="" />
            <input name="password" type="password" value="" />
            <button type="submit">Login</button>
          </form>
        </body></html>`)
        return
      }

      if (url.pathname === '/barrier') {
        barrierWaiters.push(res)
        if (barrierWaiters.length >= expectedWaiters) {
          barrierPromiseResolve()
        }
        return
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><html><body><div id="status">ready</div></body></html>`)
    })

    await new Promise<void>((ready) => server!.listen(0, '127.0.0.1', ready))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('lab port')
    baseUrl = `http://127.0.0.1:${address.port}`

    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'p4-admin',
      email: `p4-${actorId}@example.com`,
      status: 'active',
    })
    await grantAdminScope(handle.db, actorId)

    // 创建 SHARED + concurrent 目标
    await handle.db.insert(targets).values({
      id: targetId,
      code: `p4-${SCHEMA.slice(-8)}`,
      name: 'P4 Barrier Lab Target',
      entryUrl: `${baseUrl}/`,
      loginUrl: `${baseUrl}/login`,
      authMethod: 'password',
      captchaMode: 'none',
      loginFields: {
        username: { by: 'name', value: 'username' },
        password: { by: 'name', value: 'password' },
        submit: { by: 'css', value: 'button[type=submit]' },
      },
      sessionPolicy: {
        accountSessionMode: 'concurrent',
        browserIsolation: 'SHARED',
      },
    })

    // 创建 cap=3 账号
    await handle.db.insert(targetAccounts).values({
      id: accountId,
      targetId,
      displayName: 'p4-account',
      username: 'p4-user',
      status: 'active',
      maxConcurrentSessions: 3,
    })

    objectDir = mkdtempSync(join(tmpdir(), 'cairn-p4b-obj-'))
    const objects = new ObjectService(
      handle,
      new LocalObjectStore(objectDir, 32 * 1024 * 1024),
      {
        retainDays: 30,
        pendingTtlSeconds: 3600,
        maxBytes: 32 * 1024 * 1024,
        traceMaxBytes: 128 * 1024 * 1024,
        videoMaxBytes: 128 * 1024 * 1024,
        uploadMaxAttempts: 3,
      },
    )

    workerId = `p4-${SCHEMA.slice(-8)}`
    workerInstanceId = newId()
    await registerWorker(handle.db, {
      workerId,
      instanceId: workerInstanceId,
      capacity: 8,
      maxSessions: 8,
      lostAfterSeconds: 60,
      protocolCapabilities: [...WORKER_TEST_PROTOCOLS],
    })

    const profileRoot = mkdtempSync(join(tmpdir(), 'cairn-p4b-prof-'))
    manager = new BrowserSessionManager(handle, {
      workerId,
      workerInstanceId,
      profileRoot,
      headless: true,
      maxSessions: 8,
      defaultLeaseTtlSeconds: 60,
      defaultAuthWaitSeconds: 60,
      heartbeatMs: 60_000,
      poolTargetSpread: 'strict',
    })
    manager.resolveCredential = async () => ({ username: 'p4-user', password: 'secret-password' })
    await manager.reconcileOwn()

    engine = new ExecutionEngine(handle, createBrowserPort(manager, objects))
  })

  afterAll(async () => {
    if (server) {
      releaseBarrier()
      await new Promise<void>((done) => server!.close(() => done()))
    }
    if (manager) await manager.shutdown()
    if (handle) await handle.close()
    if (objectDir) rmSync(objectDir, { recursive: true, force: true })
  }, 30_000)

  async function createBarrierRun(runIndex: number) {
    const steps: Step[] = [
      {
        id: newId(),
        name: `打开屏障页-${runIndex}`,
        type: 'navigate',
        effectType: 'IDEMPOTENT',
        input: { url: `${baseUrl}/barrier?id=${runIndex}` },
      },
      {
        id: newId(),
        name: `提取屏障结果-${runIndex}`,
        type: 'extract',
        effectType: 'READ_ONLY',
        outputKey: 'result',
        input: {
          target: {
            framePath: [],
            candidates: [{ by: 'css', value: '#status' }],
          },
          as: 'text',
        },
      },
    ]

    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `p4-scenario-${runIndex}-${newId()}`,
      steps,
      actor: { id: actorId },
    })

    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: accountId,
      actor: { id: actorId },
      sessionPolicy: {
        browserIsolation: 'SHARED',
        reuse: 'NEW_PAGE' as const,
      },
    })

    return created.detail.id
  }

  async function claimThisRun(runId: string): Promise<RunGrant> {
    const grant = await claimRun(handle, {
      workerId,
      instanceId: workerInstanceId,
      leaseTtlSeconds: 60,
    })
    expect(grant?.runId).toBe(runId)
    return grant!
  }

  it('A10 / A11 / A12: 三场景通过浏览器屏障保持重叠执行，会话独立且 strict 分散，第四条在上限处被拒且释放后可复用', async () => {
    if (!hasBrowser) return

    // 1. 创建三个场景的 Run
    const run1Id = await createBarrierRun(1)
    const grant1 = await claimThisRun(run1Id)

    const run2Id = await createBarrierRun(2)
    const grant2 = await claimThisRun(run2Id)

    const run3Id = await createBarrierRun(3)
    const grant3 = await claimThisRun(run3Id)

    // 创建第四个 Run 备用
    const run4Id = await createBarrierRun(4)

    // 2. 同时启动三条运行
    const execPromise1 = engine.execute(run1Id, { grant: grant1 })
    const execPromise2 = engine.execute(run2Id, { grant: grant2 })
    const execPromise3 = engine.execute(run3Id, { grant: grant3 })

    // 3. 等待三条运行同时到达浏览器屏障
    await barrierReachedPromise

    // 4. 验证此时三条运行的状态、租约和宿主情况
    const { runs, sessionLeases, browserSessions } = schemaFor(handle.db)

    // 4.1 三条运行均处于 RUNNING 状态
    const r1 = await getRun(handle.db, run1Id)
    const r2 = await getRun(handle.db, run2Id)
    const r3 = await getRun(handle.db, run3Id)
    expect(r1.status).toBe('RUNNING')
    expect(r2.status).toBe('RUNNING')
    expect(r3.status).toBe('RUNNING')

    // 4.2 数据库中有且仅有 3 条处于 ACTIVE 状态的会话租约
    const activeLeases = await handle.db
      .select()
      .from(sessionLeases)
      .where(eq(sessionLeases.status, 'ACTIVE'))
    expect(activeLeases).toHaveLength(3)
    const leaseRunIds = activeLeases.map((l) => l.runId)
    expect(leaseRunIds).toContain(run1Id)
    expect(leaseRunIds).toContain(run2Id)
    expect(leaseRunIds).toContain(run3Id)

    // 4.3 数据库中该账号分配了三个不同的槽位 (1, 2, 3)
    const accountSessions = await handle.db
      .select()
      .from(browserSessions)
      .where(eq(browserSessions.targetAccountId, accountId))
    expect(accountSessions).toHaveLength(3)
    const slots = new Set(accountSessions.map((s) => s.accountSlot))
    expect(slots.size).toBe(3)
    expect(slots).toEqual(new Set([1, 2, 3]))

    // 4.4 A12: strict targetSpread 下，同目标的三个共享会话各自落入不同宿主
    const hostIds = new Set(accountSessions.map((s) => s.hostId).filter(Boolean))
    expect(hostIds.size).toBe(3)

    // 4.5 A11: 此时第四条 Run 尝试申请会话，由于达到账号并发上限 (cap=3)，必须被拒绝
    const run4Detail = await getRun(handle.db, run4Id)
    const run4Grant: RunGrant = {
      runId: run4Id,
      leaseId: newId(),
      fencingToken: 1,
      holderWorkerId: workerId,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
    const acquire4Blocked = await manager.acquire(run4Detail.snapshot, run4Grant)
    expect(acquire4Blocked).toMatchObject({
      ok: false,
      code: 'SESSION_BUSY',
    })

    // 5. 放行屏障，让前三条运行顺利完成
    releaseBarrier()
    await Promise.all([execPromise1, execPromise2, execPromise3])

    // 6. 验证前三条运行的执行结果与事实记录
    const finished1 = await getRun(handle.db, run1Id)
    const finished2 = await getRun(handle.db, run2Id)
    const finished3 = await getRun(handle.db, run3Id)
    expect(finished1.status).toBe('SUCCEEDED')
    expect(finished2.status).toBe('SUCCEEDED')
    expect(finished3.status).toBe('SUCCEEDED')
    expect(finished1.context.result).toBe('barrier-passed')
    expect(finished2.context.result).toBe('barrier-passed')
    expect(finished3.context.result).toBe('barrier-passed')

    // 7. 前三条运行完成后释放了会话占用，第四条 Run 现在可以成功领取并复用健康会话
    const grant4 = await claimThisRun(run4Id)
    resetBarrier(1)
    const execPromise4 = engine.execute(run4Id, { grant: grant4 })
    await barrierReachedPromise
    releaseBarrier()
    await execPromise4

    const finished4 = await getRun(handle.db, run4Id)
    expect(finished4.status).toBe('SUCCEEDED')
    expect(finished4.context.result).toBe('barrier-passed')

    // 验证第四条运行没有新建多余槽位（总槽位仍然 <= 3）
    const totalSessions = await handle.db
      .select()
      .from(browserSessions)
      .where(eq(browserSessions.targetAccountId, accountId))
    expect(totalSessions.length).toBeLessThanOrEqual(3)
  })
})
