import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_ACCOUNT_SESSION_MODE,
  DEFAULT_BROWSER_ISOLATION,
  FACTORY_PLATFORM_CONFIG,
  SESSION_ACCOUNT_CONCURRENCY_PROTOCOL,
  SESSION_OCCUPANCY_PROTOCOL,
  type Step,
  LOCATOR_RESOLUTION_PROTOCOL,
} from '@cairn/shared'
import { DRIVERS, openContractDb, grantAdminScope } from './contract-fixture.js'
import { schemaFor } from '../native.js'
import { newId } from '../id.js'
import { TargetsStore } from '../console/targets.js'
import { getOrCreatePlatformConfig, updatePlatformConfig } from '../platform-config/store.js'
import {
  claimSessionUse,
  createRunWithSnapshot,
  createScenarioWithVersion,
  createSession,
  expose,
  findLiveSessions,
  listAccountSessionOverview,
  listSessionSystemOverview,
  readAccountSessionCap,
  registerWorker,
  releaseSessionUse,
  setSessionStatus,
  type NativeHandle as DbHandle,
} from '../test-entry.js'

const echoStep: Step = {
  id: '00000000-0000-4000-8000-0000000000c1',
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'hello' },
}

describe.each(DRIVERS)('%s P1: 配置一致性与排空收敛规范', { timeout: 60_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string
  let targetId: string
  let targetsStore: TargetsStore

  const actor = {
    id: '',
    displayName: 'concurrency-p1-tester',
    email: 'p1@example.com',
    status: 'active' as const,
    roles: [],
    permissions: [],
  }

  beforeAll(async () => {
    handle = await openContractDb(driver, `p1_${Date.now().toString(36)}`)
    const { consoleAccounts, targets } = schemaFor(handle.db)
    actorId = newId()
    actor.id = actorId
    targetId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'concurrency-p1-tester',
      email: `p1-${actorId}@example.com`,
      status: 'active',
    })
    await grantAdminScope(handle.db, actorId)
    await handle.db.insert(targets).values({
      id: targetId,
      code: `p1-${targetId.slice(0, 8)}`,
      name: 'P1测试目标',
      entryUrl: 'https://example.com',
    })
    targetsStore = new TargetsStore(expose(handle), () => Buffer.from('secret'))
  })

  afterAll(async () => {
    await handle.close()
  })

  afterEach(async () => {
    const { runs, browserSessions, sessionLeases, targets } = schemaFor(handle.db)
    await handle.db.update(sessionLeases).set({ status: 'RELEASED', releasedAt: new Date() })
    await handle.db.update(browserSessions).set({ status: 'CLOSED', closedAt: new Date(), closeReason: 'cleanup' })
    await handle.db.update(runs).set({ status: 'CANCELLED', finishedAt: new Date() })
    await handle.db.update(targets).set({ sessionPolicy: null }).where(eq(targets.id, targetId))
    // Reset platform config to default
    const platform = await getOrCreatePlatformConfig(handle.db)
    await updatePlatformConfig(handle.db, {
      expectedRevision: platform.revision,
      document: FACTORY_PLATFORM_CONFIG,
      reason: 'reset to factory',
      actor: { id: actorId },
    })
  })

  async function queueRun(accountId: string) {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `p1-scenario-${newId()}`,
      steps: [echoStep],
      actor: { id: actorId },
    })
    const res = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: accountId,
      actor: { id: actorId },
    })
    return res.detail
  }

  async function setPlatformSessionMode(mode: 'exclusive' | 'concurrent', isolation = DEFAULT_BROWSER_ISOLATION) {
    const platform = await getOrCreatePlatformConfig(handle.db)
    return updatePlatformConfig(handle.db, {
      expectedRevision: platform.revision,
      document: {
        ...platform.document,
        fixtureStepsEnabled: true,
        session: {
          ...platform.document.session,
          accountSessionMode: mode,
          browserIsolation: isolation,
        },
      },
      reason: `set platform session mode to ${mode}`,
      actor: { id: actorId },
    })
  }

  it('A01: 平台 concurrent、目标继承、账号 cap=3，保存成功且列表/详情/总览一致', async () => {
    await setPlatformSessionMode('concurrent')

    // Create account with cap=3, inheriting platform concurrent mode
    const account = await targetsStore.createAccount(
      targetId,
      { displayName: '并发账号A01', username: 'u-a01', maxConcurrentSessions: 3 },
      actor,
    )
    expect(account.maxConcurrentSessions).toBe(3)
    expect(account.effectiveMaxConcurrentSessions).toBe(3)

    // Verify getAccount
    const detail = await targetsStore.getAccount(targetId, account.id)
    expect(detail.maxConcurrentSessions).toBe(3)
    expect(detail.effectiveMaxConcurrentSessions).toBe(3)

    // Verify listAccounts
    const list = await targetsStore.listAccounts(targetId)
    const item = list.items.find((a) => a.id === account.id)
    expect(item).toBeDefined()
    expect(item?.maxConcurrentSessions).toBe(3)
    expect(item?.effectiveMaxConcurrentSessions).toBe(3)

    // Verify readAccountSessionCap
    const cap = await readAccountSessionCap(handle.db, { targetId, targetAccountId: account.id })
    expect(cap.mode).toBe('concurrent')
    expect(cap.effectiveCap).toBe(3)

    // Verify session overview displays effectiveCap = 3
    const overview = await listAccountSessionOverview(handle.db, { targetId })
    const overviewItem = overview.items.find((i) => i.targetAccountId === account.id)
    expect(overviewItem).toBeDefined()
    expect(overviewItem?.effectiveCap).toBe(3)
  })

  it('A02: 目标覆盖 exclusive 时不可保存大于 1，清除覆盖恢复平台继承', async () => {
    await setPlatformSessionMode('concurrent')

    // Override target to exclusive
    await targetsStore.updateSessionPolicy(
      targetId,
      { accountSessionMode: 'exclusive' },
      actor,
    )

    // Try creating cap=3 under target with exclusive override -> should be rejected
    await expect(
      targetsStore.createAccount(
        targetId,
        { displayName: '超限账号A02', username: 'u-a02', maxConcurrentSessions: 3 },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'SESSION_CONCURRENCY_UNSUPPORTED' })

    // Create valid cap=1 account
    const account = await targetsStore.createAccount(
      targetId,
      { displayName: '单账号A02', username: 'u-a02-ok', maxConcurrentSessions: 1 },
      actor,
    )
    expect(account.effectiveMaxConcurrentSessions).toBe(1)

    // Clear override (set to null) -> should recover platform concurrent mode
    await targetsStore.updateSessionPolicy(
      targetId,
      { accountSessionMode: null },
      actor,
    )

    // Now update account cap to 3 -> should succeed
    const updated = await targetsStore.updateAccount(
      targetId,
      account.id,
      { maxConcurrentSessions: 3 },
      actor,
    )
    expect(updated.maxConcurrentSessions).toBe(3)
    expect(updated.effectiveMaxConcurrentSessions).toBe(3)
  })

  it('A03: 降低账号上限/目标模式与存量活会话冲突时拒绝，未超限时不误拒绝', async () => {
    await setPlatformSessionMode('concurrent')
    const account = await targetsStore.createAccount(
      targetId,
      { displayName: '并发账号A03', username: 'u-a03', maxConcurrentSessions: 3 },
      actor,
    )

    const workerId = `w-p1-${newId().slice(0, 8)}`
    const instanceId = newId()
    await registerWorker(handle.db, {
      workerId,
      instanceId,
      capacity: 4,
      maxSessions: 4,
      lostAfterSeconds: 60,
      protocolCapabilities: [LOCATOR_RESOLUTION_PROTOCOL, SESSION_OCCUPANCY_PROTOCOL, SESSION_ACCOUNT_CONCURRENCY_PROTOCOL],
    })

    // Create 2 live OPEN sessions
    const s1 = await createSession(handle.db, {
      key: { targetId, targetAccountId: account.id },
      ownerWorkerId: workerId,
      ownerWorkerInstanceId: instanceId,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 300,
      maxLifetimeSeconds: 3600,
      accountSlot: 1,
    })
    const s2 = await createSession(handle.db, {
      key: { targetId, targetAccountId: account.id },
      ownerWorkerId: workerId,
      ownerWorkerInstanceId: instanceId,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 300,
      maxLifetimeSeconds: 3600,
      accountSlot: 2,
    })
    expect(s1.ok && s2.ok).toBe(true)
    if (!s1.ok || !s2.ok) return
    await setSessionStatus(handle.db, {
      sessionId: s1.session.id,
      expectedVersion: s1.session.version,
      status: 'OPEN',
      ownerWorkerId: workerId,
      ownerWorkerInstanceId: instanceId,
    })
    await setSessionStatus(handle.db, {
      sessionId: s2.session.id,
      expectedVersion: s2.session.version,
      status: 'OPEN',
      ownerWorkerId: workerId,
      ownerWorkerInstanceId: instanceId,
    })

    // Try lowering cap to 1 (when 2 active sessions exist) -> should reject
    await expect(
      targetsStore.updateAccount(targetId, account.id, { maxConcurrentSessions: 1 }, actor),
    ).rejects.toMatchObject({ code: 'ACCOUNT_CAP_REDUCTION_BLOCKED' })

    // Try updating target policy to exclusive -> should also reject
    await expect(
      targetsStore.updateSessionPolicy(targetId, { accountSessionMode: 'exclusive' }, actor),
    ).rejects.toMatchObject({ code: 'ACCOUNT_CAP_REDUCTION_BLOCKED' })

    // Lowering cap to 2 (equal to live count) -> should SUCCEED
    const updated = await targetsStore.updateAccount(targetId, account.id, { maxConcurrentSessions: 2 }, actor)
    expect(updated.maxConcurrentSessions).toBe(2)

    // Close one session
    await setSessionStatus(handle.db, {
      sessionId: s2.session.id,
      expectedVersion: 1,
      status: 'CLOSED',
      ownerWorkerId: workerId,
      ownerWorkerInstanceId: instanceId,
    })

    // Now lowering cap to 1 -> should SUCCEED
    const finalUpdated = await targetsStore.updateAccount(targetId, account.id, { maxConcurrentSessions: 1 }, actor)
    expect(finalUpdated.maxConcurrentSessions).toBe(1)
  })

  it('A04: 复用不改写隔离模式——请求模式与既有会话不同时返回可解释不匹配', async () => {
    await setPlatformSessionMode('concurrent')
    const account = await targetsStore.createAccount(
      targetId,
      { displayName: '隔离账号A04', username: 'u-a04', maxConcurrentSessions: 2 },
      actor,
    )
    const a04Worker = `w-a04-${newId().slice(0, 8)}`
    const a04Instance = newId()
    await registerWorker(handle.db, {
      workerId: a04Worker,
      instanceId: a04Instance,
      capacity: 2,
      maxSessions: 2,
      lostAfterSeconds: 60,
      protocolCapabilities: [LOCATOR_RESOLUTION_PROTOCOL, SESSION_OCCUPANCY_PROTOCOL, SESSION_ACCOUNT_CONCURRENCY_PROTOCOL],
    })
    const created = await createSession(handle.db, {
      key: { targetId, targetAccountId: account.id },
      ownerWorkerId: a04Worker,
      ownerWorkerInstanceId: a04Instance,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 300,
      maxLifetimeSeconds: 3600,
      accountSlot: 1,
      // 历史 null 由 worker 物化为 DEDICATED；这里直接造一条 DEDICATED 会话
      isolation: 'DEDICATED',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    await setSessionStatus(handle.db, {
      sessionId: created.session.id,
      expectedVersion: created.session.version,
      status: 'OPEN',
      ownerWorkerId: a04Worker,
      ownerWorkerInstanceId: a04Instance,
    })
    const run = await queueRun(account.id)

    // 请求 SHARED：与既有 DEDICATED 会话不同 → 可解释拒绝，不改写、不静默混用
    const mismatch = await claimSessionUse(handle.db, {
      key: { targetId, targetAccountId: account.id },
      owner: { kind: 'RUN', runId: run.id, runFencingToken: 1 },
      purpose: 'EXECUTION',
      holderWorkerId: a04Worker,
      holderInstanceId: a04Instance,
      leaseTtlSeconds: 60,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 300,
      maxLifetimeSeconds: 3600,
      isolation: 'SHARED',
    })
    expect(mismatch.ok).toBe(false)
    if (!mismatch.ok) {
      expect(mismatch.code).toBe('SESSION_ISOLATION_MISMATCH')
      expect(mismatch.message).toContain('DEDICATED')
    }
    // 不匹配的拒绝不产生租约，会话保持原隔离模式
    const lives = await findLiveSessions(handle.db, { targetId, targetAccountId: account.id })
    expect(lives).toHaveLength(1)
    expect(lives[0]!.isolation).toBe('DEDICATED')

    // 请求与既有会话一致的 DEDICATED：正常复用
    const match = await claimSessionUse(handle.db, {
      key: { targetId, targetAccountId: account.id },
      owner: { kind: 'RUN', runId: run.id, runFencingToken: 1 },
      purpose: 'EXECUTION',
      holderWorkerId: a04Worker,
      holderInstanceId: a04Instance,
      leaseTtlSeconds: 60,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 300,
      maxLifetimeSeconds: 3600,
      isolation: 'DEDICATED',
    })
    expect(match.ok).toBe(true)
    if (match.ok) {
      expect(match.created).toBe(false)
      expect(match.session.id).toBe(created.session.id)
      await releaseSessionUse(handle.db, {
        leaseId: match.grant.leaseId,
        holderWorkerId: a04Worker,
        reason: 'test',
      })
    }
  })

  it('A22: 平台降至 exclusive 时保存成功，继承账号进入排空且收敛空闲实例', async () => {
    await setPlatformSessionMode('concurrent')
    const account = await targetsStore.createAccount(
      targetId,
      { displayName: '排空账号A22', username: 'u-a22', maxConcurrentSessions: 3 },
      actor,
    )

    const workerId = `w-a22-${newId().slice(0, 8)}`
    const instanceId = newId()
    await registerWorker(handle.db, {
      workerId,
      instanceId,
      capacity: 4,
      maxSessions: 4,
      lostAfterSeconds: 60,
      protocolCapabilities: [LOCATOR_RESOLUTION_PROTOCOL, SESSION_OCCUPANCY_PROTOCOL, SESSION_ACCOUNT_CONCURRENCY_PROTOCOL],
    })

    // Create 2 open sessions: session 1 is in-use, session 2 is idle
    const s1 = await createSession(handle.db, {
      key: { targetId, targetAccountId: account.id },
      ownerWorkerId: workerId,
      ownerWorkerInstanceId: instanceId,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 300,
      maxLifetimeSeconds: 3600,
      accountSlot: 1,
    })
    const s2 = await createSession(handle.db, {
      key: { targetId, targetAccountId: account.id },
      ownerWorkerId: workerId,
      ownerWorkerInstanceId: instanceId,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 300,
      maxLifetimeSeconds: 3600,
      accountSlot: 2,
    })
    expect(s1.ok && s2.ok).toBe(true)
    if (!s1.ok || !s2.ok) return

    await setSessionStatus(handle.db, {
      sessionId: s1.session.id,
      expectedVersion: s1.session.version,
      status: 'OPEN',
      ownerWorkerId: workerId,
      ownerWorkerInstanceId: instanceId,
    })
    await setSessionStatus(handle.db, {
      sessionId: s2.session.id,
      expectedVersion: s2.session.version,
      status: 'OPEN',
      ownerWorkerId: workerId,
      ownerWorkerInstanceId: instanceId,
    })

    // Session 1 is active (claim lease)
    const run1 = await queueRun(account.id)
    const activeClaim = await claimSessionUse(handle.db, {
      key: { targetId, targetAccountId: account.id },
      owner: { kind: 'RUN', runId: run1.id, runFencingToken: 1 },
      purpose: 'EXECUTION',
      holderWorkerId: workerId,
      holderInstanceId: instanceId,
      leaseTtlSeconds: 60,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 300,
      maxLifetimeSeconds: 3600,
      sessionId: s1.session.id,
    })
    expect(activeClaim.ok).toBe(true)

    // Platform default is lowered to exclusive -> Platform save MUST succeed (not blocked by live sessions)
    await setPlatformSessionMode('exclusive')

    // Existing active claim re-entry by same owner still succeeds (idempotent / continuation)
    const sameOwnerReentry = await claimSessionUse(handle.db, {
      key: { targetId, targetAccountId: account.id },
      owner: { kind: 'RUN', runId: run1.id, runFencingToken: 1 },
      purpose: 'EXECUTION',
      holderWorkerId: workerId,
      holderInstanceId: instanceId,
      leaseTtlSeconds: 60,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 300,
      maxLifetimeSeconds: 3600,
    })
    expect(sameOwnerReentry.ok).toBe(true)

    // NEW claim by a different Run is rejected due to draining (live count 2 > effective cap 1)
    const run2 = await queueRun(account.id)
    const newClaim = await claimSessionUse(handle.db, {
      key: { targetId, targetAccountId: account.id },
      owner: { kind: 'RUN', runId: run2.id, runFencingToken: 1 },
      purpose: 'EXECUTION',
      holderWorkerId: workerId,
      holderInstanceId: instanceId,
      leaseTtlSeconds: 60,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 300,
      maxLifetimeSeconds: 3600,
    })
    expect(newClaim.ok).toBe(false)
    if (!newClaim.ok) {
      expect(newClaim.code).toBe('SESSION_BUSY')
    }

    // Notice: newClaim attempt triggered retireSurplusIdleSessions, which marked idle session 2 as CLOSING!
    const livesAfter = await findLiveSessions(handle.db, { targetId, targetAccountId: account.id })
    const closingSession = livesAfter.find((s) => s.id === s2.session.id)
    expect(closingSession?.status).toBe('CLOSING')
    expect(closingSession?.closeReason).toBe('draining_concurrency_cap')

    // Close the retired session (simulate worker reaper closing the browser)
    await setSessionStatus(handle.db, {
      sessionId: s2.session.id,
      expectedVersion: closingSession!.version,
      status: 'CLOSED',
      ownerWorkerId: workerId,
      ownerWorkerInstanceId: instanceId,
      closeReason: 'draining_concurrency_cap',
    })

    // Now live count is 1 (= effective cap 1)
    const finalLives = await findLiveSessions(handle.db, { targetId, targetAccountId: account.id })
    expect(finalLives).toHaveLength(1)
    expect(finalLives[0]!.id).toBe(s1.session.id)

    // Release session 1 lease
    if (activeClaim.ok) {
      await releaseSessionUse(handle.db, {
        leaseId: activeClaim.grant.leaseId,
        holderWorkerId: workerId,
        reason: 'finished',
      })
    }

    // Now a new Run can reuse the remaining session 1 under exclusive mode
    const thirdRunClaim = await claimSessionUse(handle.db, {
      key: { targetId, targetAccountId: account.id },
      owner: { kind: 'RUN', runId: run2.id, runFencingToken: 1 },
      purpose: 'EXECUTION',
      holderWorkerId: workerId,
      holderInstanceId: instanceId,
      leaseTtlSeconds: 60,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 300,
      maxLifetimeSeconds: 3600,
    })
    expect(thirdRunClaim.ok).toBe(true)
    if (thirdRunClaim.ok) {
      expect(thirdRunClaim.session.id).toBe(s1.session.id)
      expect(thirdRunClaim.created).toBe(false)
    }
  })
})
