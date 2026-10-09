import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTargetBodySchema, type Step } from '@cairn/shared'
import { TargetsStore } from '../console/targets.js'
import { expose } from '../database.js'
import { newId } from '../id.js'
import { schemaFor } from '../native.js'
import { getOrCreatePlatformConfig, updatePlatformConfig } from '../platform-config/store.js'
import {
  createRunWithSnapshot,
  createScenarioWithVersion,
  getRun,
  setScheduleEnabled,
  updateScenarioMeta,
  writeSchedule,
  type NativeHandle as DbHandle,
} from '../test-entry.js'
import { DRIVERS, openContractDb, grantAdminScope } from './contract-fixture.js'

const echo: Step = {
  id: '00000000-0000-4000-8000-000000000071',
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'hello' },
}

// 运行账号只对要开浏览器的场景生效，取值用例都带一步导航。
const open: Step = {
  id: '00000000-0000-4000-8000-000000000072',
  name: '打开首页',
  type: 'navigate',
  effectType: 'READ_ONLY',
  input: { url: 'https://shop.example/home' },
}

describe.each(DRIVERS)('%s 访客身份与运行账号', { timeout: 90_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `visitor_${Date.now().toString(36)}`)
    const { consoleAccounts } = schemaFor(handle.db)
    actorId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'visitor',
      email: `visitor-${actorId}@example.com`,
      status: 'active',
    })
    await grantAdminScope(handle.db, actorId)
  })

  afterAll(async () => {
    await handle?.close()
  })

  function actor() {
    return {
      id: actorId,
      displayName: 'visitor',
      email: `visitor-${actorId}@example.com`,
      status: 'active' as const,
      roles: [],
      permissions: [],
    }
  }

  function store() {
    return new TargetsStore(expose(handle), () => Buffer.from('fixture'))
  }

  async function createTarget(extra: Record<string, unknown> = {}) {
    return store().createTarget(
      createTargetBodySchema.parse({
        code: `vis-${newId().slice(-12)}`,
        name: `访客夹具 ${newId().slice(-8)}`,
        entryUrl: 'https://shop.example/home',
        ...extra,
      }),
      actor(),
    )
  }

  async function scenario(targetId: string, runAccountId?: string | null) {
    return createScenarioWithVersion(handle.db, {
      targetId,
      name: `场景-${newId().slice(-12)}`,
      steps: [open],
      runAccountId,
      actor: { kind: 'console', id: actorId },
    })
  }

  async function runSnapshot(scenarioId: string, targetAccountId?: string) {
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId,
      ...(targetAccountId ? { targetAccountId } : {}),
      actor: { kind: 'console', id: actorId },
    })
    const run = await getRun(handle.db, created.detail.id)
    return run!.snapshot
  }

  it('无需登录：自动维护唯一的访客，不能登记登录账号，访客运行不带凭据', async () => {
    const target = await createTarget({ authMethod: 'none' })
    expect(target.authMethod).toBe('none')
    expect(target.visitorAccountId).toBeTruthy()
    expect(target.usableIdentityCount).toBe(1)
    expect(target.defaultAccountId).toBeNull()
    const accounts = await store().listAccounts(target.id)
    expect(accounts.items).toHaveLength(1)
    expect(accounts.items[0]).toMatchObject({ identityKind: 'visitor', username: null, hasPassword: false })

    await expect(
      store().createAccount(target.id, { displayName: '登录号', username: 'alice', status: 'active' }, actor()),
    ).rejects.toMatchObject({ code: 'TARGET_AUTH_METHOD_HAS_ACCOUNTS' })

    const s = await scenario(target.id)
    const snapshot = await runSnapshot(s.id)
    expect(snapshot).toMatchObject({
      targetAccountId: target.visitorAccountId,
      runAs: 'visitor',
      accountSource: 'only',
    })
    expect(snapshot.secretRef).toBeUndefined()
    expect(snapshot.credentialBinding).toBeUndefined()
    expect(snapshot.authVerification).toBeUndefined()
    expect(snapshot.sessionPolicy?.accountSessionMode).toBe('concurrent')
    expect(snapshot.sessionPolicy?.reclaim).not.toBe('AUTH_DRIVEN')
  })

  it('访客只读：不能写凭据字段、不能单独删除；无需登录目标不能停用访客', async () => {
    const target = await createTarget({ authMethod: 'none' })
    const visitorId = target.visitorAccountId!
    await expect(
      store().updateAccount(target.id, visitorId, { username: 'visitor' }, actor()),
    ).rejects.toMatchObject({ code: 'TARGET_ACCOUNT_VISITOR_READONLY' })
    await expect(store().deleteAccount(target.id, visitorId, actor())).rejects.toMatchObject({
      code: 'TARGET_ACCOUNT_VISITOR_READONLY',
    })
    await expect(
      store().updateAccount(target.id, visitorId, { status: 'disabled' }, actor()),
    ).rejects.toMatchObject({ code: 'TARGET_VISITOR_IN_USE' })
    const renamed = await store().updateAccount(
      target.id,
      visitorId,
      { displayName: '游客', maxConcurrentSessions: 3 },
      actor(),
    )
    expect(renamed).toMatchObject({ displayName: '游客', maxConcurrentSessions: 3, effectiveMaxConcurrentSessions: 3 })
  })

  it('混合目标：开启访客时原账号自动成为默认；场景可指定访客，开跑时也能临时换回登录账号', async () => {
    const target = await createTarget()
    const alice = await store().createAccount(
      target.id,
      { displayName: '登录号', username: `alice-${newId().slice(-6)}`, status: 'active' },
      actor(),
    )
    const mixed = await store().updateTarget(target.id, { visitorEnabled: true }, actor())
    expect(mixed.visitorAccountId).toBeTruthy()
    expect(mixed.usableIdentityCount).toBe(2)
    expect(mixed.defaultAccountId).toBe(alice.id)

    const loginScenario = await scenario(target.id)
    expect(await runSnapshot(loginScenario.id)).toMatchObject({
      targetAccountId: alice.id,
      runAs: 'login',
      accountSource: 'target_default',
    })

    const visitorScenario = await scenario(target.id, mixed.visitorAccountId)
    expect(visitorScenario.runAccountId).toBe(mixed.visitorAccountId)
    expect(await runSnapshot(visitorScenario.id)).toMatchObject({
      targetAccountId: mixed.visitorAccountId,
      runAs: 'visitor',
      accountSource: 'scenario',
    })
    expect(await runSnapshot(visitorScenario.id, alice.id)).toMatchObject({
      targetAccountId: alice.id,
      runAs: 'login',
      accountSource: 'explicit',
    })

    // 改回跟随目标默认后立即生效，不用发布。
    await updateScenarioMeta(handle.db, visitorScenario.id, { runAccountId: null, actor: { kind: 'console', id: actorId } })
    expect(await runSnapshot(visitorScenario.id)).toMatchObject({ targetAccountId: alice.id, accountSource: 'target_default' })
  })

  it('有登录账号时不能改为无需登录；从无需登录改回后访客保留', async () => {
    const target = await createTarget()
    await store().createAccount(target.id, { displayName: '登录号', username: 'bob', status: 'active' }, actor())
    await expect(store().updateTarget(target.id, { authMethod: 'none' }, actor())).rejects.toMatchObject({
      code: 'TARGET_AUTH_METHOD_HAS_ACCOUNTS',
    })

    const open = await createTarget({ authMethod: 'none' })
    const back = await store().updateTarget(open.id, { authMethod: 'password' }, actor())
    expect(back.authMethod).toBe('password')
    expect(back.visitorAccountId).toBe(open.visitorAccountId)
  })

  it('默认账号：剩余两个及以上可用身份时不能停用默认；只剩一个时清空默认', async () => {
    const target = await createTarget({ visitorEnabled: true })
    const a = await store().createAccount(target.id, { displayName: 'A', username: 'a', status: 'active' }, actor())
    const b = await store().createAccount(target.id, { displayName: 'B', username: 'b', status: 'active' }, actor())
    const withDefault = await store().getTarget(target.id)
    // 访客先存在，加入 A 时可用身份 1 → 2，访客自动成为默认。
    expect(withDefault.defaultAccountId).toBe(withDefault.visitorAccountId)
    await store().updateTarget(target.id, { defaultAccountId: a.id }, actor())
    await expect(store().updateAccount(target.id, a.id, { status: 'disabled' }, actor())).rejects.toMatchObject({
      code: 'TARGET_DEFAULT_ACCOUNT_IN_USE',
    })
    await store().updateAccount(target.id, b.id, { status: 'disabled' }, actor())
    await store().updateTarget(target.id, { visitorEnabled: false }, actor())
    // 现在只剩 A 一个可用身份：默认清空，由「唯一可用」接手。
    const single = await store().getTarget(target.id)
    expect(single.usableIdentityCount).toBe(1)
    expect(single.defaultAccountId).toBeNull()
    await expect(store().updateTarget(target.id, { defaultAccountId: b.id }, actor())).rejects.toMatchObject({
      code: 'TARGET_DEFAULT_ACCOUNT_INVALID',
    })
  })

  it('场景指定的账号停用后开跑按来源报错，不偷偷换账号；账号删除后场景改回跟随目标默认', async () => {
    const target = await createTarget({ visitorEnabled: true })
    const a = await store().createAccount(target.id, { displayName: 'A', username: 'a1', status: 'active' }, actor())
    const s = await scenario(target.id, a.id)
    await store().updateTarget(target.id, { defaultAccountId: target.visitorAccountId ?? (await store().getTarget(target.id)).visitorAccountId }, actor())
    await store().updateAccount(target.id, a.id, { status: 'disabled' }, actor())
    await expect(runSnapshot(s.id)).rejects.toMatchObject({ code: 'RUN_ACCOUNT_DISABLED', message: expect.stringContaining('场景指定') })

    await store().updateAccount(target.id, a.id, { status: 'active' }, actor())
    await store().deleteAccount(target.id, a.id, actor())
    const { scenarios } = schemaFor(handle.db)
    const rows = await handle.db.select({ id: scenarios.id, runAccountId: scenarios.runAccountId }).from(scenarios)
    expect(rows.find((row) => row.id === s.id)?.runAccountId).toBeNull()
  })

  it('不开浏览器的场景只认本次指定，不套各层默认', async () => {
    const target = await createTarget({ authMethod: 'none' })
    const s = await createScenarioWithVersion(handle.db, {
      targetId: target.id,
      name: `回显-${newId().slice(-12)}`,
      steps: [echo],
      actor: { kind: 'console', id: actorId },
    })
    const snapshot = await runSnapshot(s.id)
    expect(snapshot.targetAccountId).toBeUndefined()
    expect(snapshot.runAs).toBeUndefined()
  })

  it('仍有启用中的调度冻结访客时不能停用访客', async () => {
    const current = await getOrCreatePlatformConfig(handle.db)
    await updatePlatformConfig(handle.db, {
      expectedRevision: current.revision,
      reason: '夹具：允许场景调度',
      document: { ...current.document, scenarioScheduledRunEnabled: true },
      actor: { id: actorId },
    })
    const base = await createTarget()
    await store().createAccount(base.id, { displayName: 'A', username: 'a2', status: 'active' }, actor())
    const target = await store().updateTarget(base.id, { visitorEnabled: true }, actor())
    const s = await scenario(target.id, target.visitorAccountId)
    const plan = await writeSchedule(
      handle.db,
      {
        expectedRevision: 0,
        idempotencyKey: newId(),
        definition: {
          name: '访客巡检',
          timeRule: { kind: 'interval', intervalMs: 300_000, anchorUtc: new Date().toISOString(), misfire: 'skip' },
          consumer: {
            type: 'scenario_run',
            targetId: target.id,
            scenarioId: s.id,
            scenarioVersionId: s.latestVersionId!,
          },
        },
      },
      { kind: 'console', id: actorId },
    )
    // 保存时按场景运行账号冻结为访客。
    expect(plan.schedule.targetAccountId).toBe(target.visitorAccountId)
    await setScheduleEnabled(
      handle.db,
      plan.schedule.scheduleId,
      { expectedRevision: plan.schedule.revision, idempotencyKey: newId(), enabled: true },
      { kind: 'console', id: actorId },
    )
    await expect(store().updateTarget(target.id, { visitorEnabled: false }, actor())).rejects.toMatchObject({
      code: 'TARGET_VISITOR_IN_USE',
    })
  })
})
