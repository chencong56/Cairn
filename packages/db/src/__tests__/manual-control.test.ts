import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  type Step,
} from '@cairn/shared'
import { DRIVERS, openContractDb, grantAdminScope } from './contract-fixture.js'
import { grantScopedPermissions } from '../testing.js'
import { schemaFor } from '../native.js'
import { newId } from '../id.js'
import { forceGrantForRun } from './lease-harness.js'
import {
  acquireAuthControl,
  assertRunDebugOwner,
  claimSessionUse,
  computeRunPlacement,
  heartbeatAuthControl,
  cancelSessionOperation,
  claimSessionOperation,
  createRunWithSnapshot,
  createScenarioWithVersion,
  createSession,
  findEvictableSession,
  getAccountSessionDetail,
  registerWorker,
  requestMaintenanceOperation,
  setSessionStatus,
  type NativeHandle as DbHandle,
} from '../test-entry.js'

const echoStep: Step = {
  id: '00000000-0000-4000-8000-0000000000d1',
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'hello' },
}

const OPERATOR_PERMISSIONS = ['target:read', 'session:read', 'session:view', 'session:control', 'session:manage', 'run:read', 'run:execute']

describe.each(DRIVERS)('%s 受管会话共享观看与手动操作互斥（P0）', { timeout: 60_000 }, (driver) => {
  let handle: DbHandle
  let targetId: string
  let alice: string
  let bob: string
  let admin: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `mc_${Date.now().toString(36)}`)
    const { consoleAccounts, targets } = schemaFor(handle.db)
    alice = newId()
    bob = newId()
    admin = newId()
    targetId = newId()
    for (const [id, name] of [
      [alice, 'Alice'],
      [bob, 'Bob'],
      [admin, 'Admin'],
    ] as const) {
      await handle.db.insert(consoleAccounts).values({
        id,
        displayName: name,
        email: `${name.toLowerCase()}-${id}@example.com`,
        status: 'active',
      })
    }
    await grantScopedPermissions(handle.db, alice, OPERATOR_PERMISSIONS)
    await grantScopedPermissions(handle.db, bob, OPERATOR_PERMISSIONS)
    await grantAdminScope(handle.db, admin)
    await handle.db.insert(targets).values({
      id: targetId,
      code: `mc-${targetId.slice(0, 8)}`,
      name: '手动操作夹具',
      entryUrl: 'https://example.com',
    })
  })

  afterAll(async () => {
    await handle.close()
  })

  afterEach(async () => {
    const { runs, browserSessions, sessionLeases, sessionOperations, targets } = schemaFor(handle.db)
    await handle.db.update(sessionLeases).set({ status: 'RELEASED', releasedAt: new Date() })
    await handle.db.update(sessionOperations).set({ status: 'CANCELLED', finishedAt: new Date() }).where(eq(sessionOperations.status, 'QUEUED'))
    await handle.db.update(browserSessions).set({ status: 'CLOSED', closedAt: new Date(), closeReason: 'cleanup' })
    await handle.db.update(runs).set({ status: 'CANCELLED', finishedAt: new Date() })
    await handle.db.update(targets).set({ sessionPolicy: null }).where(eq(targets.id, targetId))
  })

  async function makeAccount(label: string, maxConcurrentSessions = 1): Promise<string> {
    const { targetAccounts } = schemaFor(handle.db)
    const id = newId()
    await handle.db.insert(targetAccounts).values({
      id,
      targetId,
      displayName: label,
      username: `u-${label}-${id.slice(0, 6)}`,
      status: 'active',
      maxConcurrentSessions,
    })
    return id
  }

  async function seedWorker(suffix: string) {
    const workerId = `mc-${suffix}-${newId().slice(0, 8)}`
    const instanceId = newId()
    await registerWorker(handle.db, {
      workerId,
      instanceId,
      capacity: 8,
      maxSessions: 8,
      lostAfterSeconds: 60,
      roles: ['executor'],
    })
    return { workerId, instanceId }
  }

  async function openSession(accountId: string, worker: { workerId: string; instanceId: string }, accountSlot = 1) {
    const created = await createSession(handle.db, {
      key: { targetId, targetAccountId: accountId },
      ownerWorkerId: worker.workerId,
      ownerWorkerInstanceId: worker.instanceId,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
      accountSlot,
    })
    if (!created.ok) throw new Error('createSession failed')
    await setSessionStatus(handle.db, {
      sessionId: created.session.id,
      expectedVersion: created.session.version,
      status: 'OPEN',
      ownerWorkerId: worker.workerId,
      ownerWorkerInstanceId: worker.instanceId,
    })
    const [row] = await handle.db
      .select()
      .from(schemaFor(handle.db).browserSessions)
      .where(eq(schemaFor(handle.db).browserSessions.id, created.session.id))
    return row!
  }

  function acquire(session: { id: string; generation: number }, worker: { workerId: string; instanceId: string }, actorId: string) {
    return acquireAuthControl(handle.db, {
      sessionId: session.id,
      runId: session.id,
      actor: { id: actorId },
      workerId: worker.workerId,
      workerInstanceId: worker.instanceId,
      sessionGeneration: session.generation,
    })
  }

  function request(
    accountId: string,
    actorId: string,
    body: Record<string, unknown>,
  ) {
    return requestMaintenanceOperation(handle.db, {
      key: { targetId, targetAccountId: accountId },
      body: { idempotencyKey: `idem-${newId()}`, ...body } as never,
      actor: { id: actorId },
    })
  }

  it('MC01 别人已在准备同一账号时，后来的 PREPARE 跟随同一个操作而不是冲突', async () => {
    const accountId = await makeAccount('mc01')
    const first = await request(accountId, alice, { kind: 'PREPARE' })
    expect(first.created).toBe(true)
    const second = await request(accountId, bob, { kind: 'PREPARE' })
    expect(second.created).toBe(false)
    expect(second.operation?.id).toBe(first.operation?.id)
  })

  it('MC02 多实例时，跟随只匹配同一实例或同为新建的操作', async () => {
    const accountId = await makeAccount('mc02', 3)
    const { targets } = schemaFor(handle.db)
    await handle.db.update(targets).set({ sessionPolicy: { accountSessionMode: 'concurrent' } }).where(eq(targets.id, targetId))
    const worker = await seedWorker('mc02')
    const one = await openSession(accountId, worker, 1)
    const two = await openSession(accountId, worker, 2)
    const first = await request(accountId, alice, {
      kind: 'PREPARE',
      expectedSessionId: one.id,
      expectedGeneration: one.generation,
    })
    expect(first.created).toBe(true)
    const follow = await request(accountId, bob, {
      kind: 'PREPARE',
      expectedSessionId: one.id,
      expectedGeneration: one.generation,
    })
    expect(follow.created).toBe(false)
    expect(follow.operation?.id).toBe(first.operation?.id)
    const other = await request(accountId, bob, {
      kind: 'PREPARE',
      expectedSessionId: two.id,
      expectedGeneration: two.generation,
    })
    expect(other.created).toBe(true)
    expect(other.operation?.id).not.toBe(first.operation?.id)
  })

  it('MC03 他人手动操作时，关闭／重启／清除登录数据被拒，持有人本人可以', async () => {
    const accountId = await makeAccount('mc03')
    const worker = await seedWorker('mc03')
    const session = await openSession(accountId, worker)
    await acquire(session, worker, alice)
    for (const kind of ['CLOSE', 'RESTART'] as const) {
      await expect(
        request(accountId, bob, { kind, expectedSessionId: session.id, expectedGeneration: session.generation }),
      ).rejects.toMatchObject({ code: 'AUTH_CONTROL_HELD' })
    }
    await expect(
      request(accountId, bob, {
        kind: 'RESET_PROFILE',
        confirmAccountId: accountId,
        expectedSessionId: session.id,
        expectedGeneration: session.generation,
      }),
    ).rejects.toMatchObject({ code: 'AUTH_CONTROL_HELD' })
    const own = await request(accountId, alice, {
      kind: 'CLOSE',
      expectedSessionId: session.id,
      expectedGeneration: session.generation,
    })
    expect(own.created).toBe(true)
  })

  it('MC04 操作权过期后，别人的关闭请求放行', async () => {
    const accountId = await makeAccount('mc04')
    const worker = await seedWorker('mc04')
    const session = await openSession(accountId, worker)
    await acquire(session, worker, alice)
    const { browserSessions } = schemaFor(handle.db)
    await handle.db
      .update(browserSessions)
      .set({ authControlExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(browserSessions.id, session.id))
    const closed = await request(accountId, bob, {
      kind: 'CLOSE',
      expectedSessionId: session.id,
      expectedGeneration: session.generation,
    })
    expect(closed.created).toBe(true)
  })

  it('MC05 已受理破坏性操作的实例不再发放手动操作权', async () => {
    const accountId = await makeAccount('mc05')
    const worker = await seedWorker('mc05')
    const session = await openSession(accountId, worker)
    const pending = await request(accountId, bob, {
      kind: 'RESTART',
      expectedSessionId: session.id,
      expectedGeneration: session.generation,
    })
    expect(pending.created).toBe(true)
    await expect(acquire(session, worker, alice)).rejects.toMatchObject({ code: 'SESSION_PENDING_DESTRUCTIVE' })
    const detail = await getAccountSessionDetail(handle.db, { targetId, targetAccountId: accountId })
    expect(detail.instances[0]?.pendingDestructive).toMatchObject({ kind: 'RESTART', requestedByName: 'Bob' })
  })

  it('MC06 领取时复查：受理后才出现的他人操作权会让关闭操作被取消', async () => {
    const accountId = await makeAccount('mc06')
    const worker = await seedWorker('mc06')
    const session = await openSession(accountId, worker)
    const pending = await request(accountId, bob, {
      kind: 'CLOSE',
      expectedSessionId: session.id,
      expectedGeneration: session.generation,
    })
    // 绕过受理时的检查，直接构造「排队中的关闭 + 他人有效操作权」。
    const { browserSessions, sessionOperations } = schemaFor(handle.db)
    await handle.db
      .update(browserSessions)
      .set({ authControlActorId: alice, authControlExpiresAt: new Date(Date.now() + 60_000), authControlTokenHash: 'x' })
      .where(eq(browserSessions.id, session.id))
    const claimed = await claimSessionOperation(handle.db, {
      workerId: worker.workerId,
      instanceId: worker.instanceId,
      leaseTtlSeconds: 30,
    })
    expect(claimed?.operation.id === pending.operation?.id).toBe(false)
    const [row] = await handle.db.select().from(sessionOperations).where(eq(sessionOperations.id, pending.operation!.id))
    expect(row?.status).toBe('CANCELLED')
    expect(row?.errorCode).toBe('AUTH_CONTROL_HELD')
  })

  it('MC07 取消：发起人和 session:dispose 可以，其他有 session:control 的人不行', async () => {
    const accountId = await makeAccount('mc07')
    const first = await request(accountId, alice, { kind: 'PREPARE' })
    await expect(cancelSessionOperation(handle.db, { operationId: first.operation!.id, actor: { id: bob } })).rejects.toMatchObject({
      code: 'OPERATION_NOT_OWNED',
    })
    const byAdmin = await cancelSessionOperation(handle.db, { operationId: first.operation!.id, actor: { id: admin } })
    expect(byAdmin.status).toBe('CANCELLED')
    const second = await request(accountId, alice, { kind: 'PREPARE' })
    const byOwner = await cancelSessionOperation(handle.db, { operationId: second.operation!.id, actor: { id: alice } })
    expect(byOwner.status).toBe('CANCELLED')
  })

  it('MC08 账号会话详情按实例给出操作人、占用方和进行中操作', async () => {
    const accountId = await makeAccount('mc08', 3)
    const { targets } = schemaFor(handle.db)
    await handle.db.update(targets).set({ sessionPolicy: { accountSessionMode: 'concurrent' } }).where(eq(targets.id, targetId))
    const worker = await seedWorker('mc08')
    const one = await openSession(accountId, worker, 1)
    const two = await openSession(accountId, worker, 2)
    await acquire(one, worker, alice)
    const op = await request(accountId, bob, {
      kind: 'VERIFY_AUTH',
      expectedSessionId: two.id,
      expectedGeneration: two.generation,
    })
    const detail = await getAccountSessionDetail(handle.db, { targetId, targetAccountId: accountId })
    expect(detail.session).toBeNull()
    const byId = new Map(detail.instances.map((item) => [item.id, item]))
    expect(byId.get(one.id)?.manualControl).toMatchObject({ actorId: alice, actorName: 'Alice' })
    expect(byId.get(two.id)?.manualControl).toBeNull()
    expect(detail.activeOperations).toHaveLength(1)
    expect(detail.activeOperations[0]).toMatchObject({
      id: op.operation!.id,
      sessionId: two.id,
      requestedBy: { id: bob, name: 'Bob' },
    })
  })

  it('MC09 容量驱逐不选有手动操作权的实例', async () => {
    const accountId = await makeAccount('mc09')
    const worker = await seedWorker('mc09')
    const session = await openSession(accountId, worker)
    await acquire(session, worker, alice)
    expect(await findEvictableSession(handle.db, worker.workerId, worker.instanceId)).toBeNull()
  })

  it('MC10 调试挂起的运行只归交互发起人，其他人被拒', async () => {
    const accountId = await makeAccount('mc10')
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `mc10-${newId()}`,
      steps: [echoStep],
      actor: { id: alice },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: accountId,
      actor: { id: alice },
    })
    const { runs } = schemaFor(handle.db)
    await handle.db.update(runs).set({ status: 'HOLDING' }).where(eq(runs.id, created.detail.id))
    await expect(assertRunDebugOwner(handle.db, { runId: created.detail.id, actorId: alice })).resolves.toBeUndefined()
    await expect(assertRunDebugOwner(handle.db, { runId: created.detail.id, actorId: bob })).rejects.toMatchObject({
      code: 'RUN_NOT_OWNED',
    })
    // 管理员（有 session:dispose）不受「非交互运行」之外的限制：交互运行仍只归发起人。
    await expect(assertRunDebugOwner(handle.db, { runId: created.detail.id, actorId: admin })).rejects.toMatchObject({
      code: 'RUN_NOT_OWNED',
    })
    // 不在挂起状态时不设门禁。
    await handle.db.update(runs).set({ status: 'RUNNING' }).where(eq(runs.id, created.detail.id))
    await expect(assertRunDebugOwner(handle.db, { runId: created.detail.id, actorId: bob })).resolves.toBeUndefined()
  })

  describe('P1 手动操作纳入占用判定', () => {
    async function queueRun(accountId: string, actorId: string) {
      const scenario = await createScenarioWithVersion(handle.db, {
        targetId,
        name: `mc-p1-${newId()}`,
        steps: [echoStep],
        actor: { id: actorId },
      })
      return createRunWithSnapshot(handle.db, { scenarioId: scenario.id, targetAccountId: accountId, actor: { id: actorId } })
    }

    async function claimFor(accountId: string, actorId: string, worker: { workerId: string; instanceId: string }) {
      const created = await queueRun(accountId, actorId)
      const grant = await forceGrantForRun(handle, created.detail.id, worker.workerId)
      const claimed = await claimSessionUse(handle.db, {
        key: { targetId, targetAccountId: accountId },
        owner: { kind: 'RUN', runId: grant.runId, runFencingToken: grant.fencingToken },
        purpose: 'EXECUTION',
        holderWorkerId: worker.workerId,
        holderInstanceId: worker.instanceId,
        leaseTtlSeconds: 30,
        reusePolicy: 'NEW_PAGE',
        idleTtlSeconds: 600,
        maxLifetimeSeconds: 3600,
      })
      return { created, claimed }
    }

    it('MC11 exclusive：他人手动操作时运行领不到，排位原因带持有人；释放后能领到', async () => {
      const accountId = await makeAccount('mc11')
      const worker = await seedWorker('mc11')
      const session = await openSession(accountId, worker)
      const held = await acquire(session, worker, alice)
      const blocked = await claimFor(accountId, bob, worker)
      expect(blocked.claimed.ok).toBe(false)
      if (!blocked.claimed.ok) expect(blocked.claimed.operationWait?.reason).toBe('SESSION_IN_MANUAL_CONTROL')
      const placement = await computeRunPlacement(handle.db, {
        status: blocked.created.detail.status,
        createdAt: new Date(blocked.created.detail.createdAt),
        targetId,
        targetAccountId: accountId,
        hasActiveLease: false,
      })
      expect(placement.waitReason).toBe('SESSION_IN_MANUAL_CONTROL')
      expect(placement.manualControlActor).toMatchObject({ id: alice, name: 'Alice' })
      const { releaseAuthControl } = await import('../test-entry.js')
      await releaseAuthControl(handle.db, { sessionId: session.id, runId: session.id, actor: { id: alice }, token: held.token })
      const retry = await claimFor(accountId, bob, worker)
      expect(retry.claimed.ok).toBe(true)
    })

    it('MC12 持有人本人的交互运行领到该实例：同一事务里收回操作权', async () => {
      const accountId = await makeAccount('mc12')
      const worker = await seedWorker('mc12')
      const session = await openSession(accountId, worker)
      const held = await acquire(session, worker, alice)
      const own = await claimFor(accountId, alice, worker)
      expect(own.claimed.ok).toBe(true)
      const { browserSessions } = schemaFor(handle.db)
      const [row] = await handle.db.select().from(browserSessions).where(eq(browserSessions.id, session.id))
      expect(row?.authControlActorId).toBeNull()
      expect(row?.authControlEpoch).toBe(held.epoch + 1)
    })

    it('MC13 套件等非交互运行不算「本人」，即使创建者就是持有人也领不走', async () => {
      const accountId = await makeAccount('mc13')
      const worker = await seedWorker('mc13')
      const session = await openSession(accountId, worker)
      await acquire(session, worker, alice)
      const created = await queueRun(accountId, alice)
      const { runs } = schemaFor(handle.db)
      await handle.db.update(runs).set({ executionOrigin: 'suite_member' }).where(eq(runs.id, created.detail.id))
      const grant = await forceGrantForRun(handle, created.detail.id, worker.workerId)
      const claimed = await claimSessionUse(handle.db, {
        key: { targetId, targetAccountId: accountId },
        owner: { kind: 'RUN', runId: grant.runId, runFencingToken: grant.fencingToken },
        purpose: 'EXECUTION',
        holderWorkerId: worker.workerId,
        holderInstanceId: worker.instanceId,
        leaseTtlSeconds: 30,
        reusePolicy: 'NEW_PAGE',
        idleTtlSeconds: 600,
        maxLifetimeSeconds: 3600,
      })
      expect(claimed.ok).toBe(false)
    })

    it('MC14 concurrent：一个实例被手动操作时，他人运行改用新建的实例，不等待', async () => {
      const accountId = await makeAccount('mc14', 2)
      const { targets } = schemaFor(handle.db)
      await handle.db.update(targets).set({ sessionPolicy: { accountSessionMode: 'concurrent' } }).where(eq(targets.id, targetId))
      const worker = await seedWorker('mc14')
      const session = await openSession(accountId, worker)
      await acquire(session, worker, alice)
      const other = await claimFor(accountId, bob, worker)
      expect(other.claimed.ok).toBe(true)
      if (other.claimed.ok) expect(other.claimed.session.id).not.toBe(session.id)
    })

    it('MC15 后台保活遇到手动操作：受理时不建操作', async () => {
      const accountId = await makeAccount('mc15')
      const worker = await seedWorker('mc15')
      const session = await openSession(accountId, worker)
      await acquire(session, worker, alice)
      const res = await requestMaintenanceOperation(handle.db, {
        key: { targetId, targetAccountId: accountId },
        body: {
          kind: 'VERIFY_AUTH',
          idempotencyKey: `bg-${newId()}`,
          expectedSessionId: session.id,
          expectedGeneration: session.generation,
        } as never,
        origin: 'BACKGROUND',
      })
      expect(res.created).toBe(false)
    })

    it('MC16 空闲超过上限后，纯心跳不再续期并收回；带输入的续期不受影响', async () => {
      const accountId = await makeAccount('mc16')
      const worker = await seedWorker('mc16')
      const session = await openSession(accountId, worker)
      const held = await acquire(session, worker, alice)
      const { browserSessions } = schemaFor(handle.db)
      await handle.db
        .update(browserSessions)
        .set({ authControlLastActivityAt: new Date(Date.now() - 11 * 60 * 1000) })
        .where(eq(browserSessions.id, session.id))
      const beat = (source?: 'input') =>
        heartbeatAuthControl(handle.db, {
          sessionId: session.id,
          runId: session.id,
          actorId: alice,
          token: held.token,
          workerInstanceId: worker.instanceId,
          source,
        })
      await expect(beat('input')).resolves.toMatchObject({ epoch: held.epoch })
      await handle.db
        .update(browserSessions)
        .set({ authControlLastActivityAt: new Date(Date.now() - 11 * 60 * 1000) })
        .where(eq(browserSessions.id, session.id))
      await expect(beat()).rejects.toMatchObject({ code: 'AUTH_CONTROL_IDLE' })
      const [row] = await handle.db.select().from(browserSessions).where(eq(browserSessions.id, session.id))
      expect(row?.authControlActorId).toBeNull()
      expect(row?.authControlEpoch).toBe(held.epoch + 1)
    })

    it('MC17 新开实例：不跟随他人的准备，也不超过账号并发上限', async () => {
      const accountId = await makeAccount('mc17', 2)
      const { targets } = schemaFor(handle.db)
      await handle.db.update(targets).set({ sessionPolicy: { accountSessionMode: 'concurrent' } }).where(eq(targets.id, targetId))
      const worker = await seedWorker('mc17')
      await openSession(accountId, worker)
      const first = await request(accountId, bob, { kind: 'PREPARE', newInstance: true })
      expect(first.created).toBe(true)
      expect(first.operation?.kindParams?.newInstance).toBe(true)
      await expect(request(accountId, alice, { kind: 'PREPARE', newInstance: true })).rejects.toMatchObject({
        code: 'SESSION_ACCOUNT_CAP_EXCEEDED',
      })
    })
  })
})
