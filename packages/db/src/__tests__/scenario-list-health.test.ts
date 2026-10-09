import { DRIVERS, openContractDb } from './contract-fixture.js'
import { schemaFor } from '../native.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { runHealthBucket, type ScenarioDto, type Step } from '@cairn/shared'
import {
  createRunWithSnapshot,
  createScenarioWithVersion,
  createTrialRunFromDraft,
  listScenarios,
  saveScenarioDraft,
  summarizeScenarios,
  type NativeHandle as DbHandle,
} from '../test-entry.js'
import { newId } from '../id.js'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_list_health`

const echoStep = (value: string): Step => ({
  id: newId(),
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value },
})

describe.each(DRIVERS)('%s 场景列表健康度、调度与排序（集成）', { timeout: 60_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string
  let targetId: string
  const ids: Record<string, string> = {}
  let minute = 0

  /** 运行时间严格递增，避免同一毫秒的排序歧义。 */
  const nextTime = () => new Date(Date.UTC(2026, 8, 1, 0, minute++))

  async function formalRun(scenarioId: string, status: string, outcomeStatus = 'NOT_EVALUATED', extra: { deleted?: boolean; evidenceStatus?: string } = {}) {
    const { runs } = schemaFor(handle.db)
    const run = await createRunWithSnapshot(handle.db, { scenarioId, actor: { id: actorId } })
    await handle.db
      .update(runs)
      .set({
        status: status as never,
        outcomeStatus: outcomeStatus as never,
        evidenceStatus: (extra.evidenceStatus ?? 'COMPLETE') as never,
        createdAt: nextTime(),
        deletedAt: extra.deleted ? new Date() : null,
        deletedBy: extra.deleted ? { id: actorId, displayName: 'tester', kind: 'console' } : null,
      })
      .where(eq(runs.id, run.detail.id))
    return run.detail.id
  }

  async function trialRun(scenarioId: string, status: string, outcomeStatus = 'NOT_EVALUATED') {
    const { runs } = schemaFor(handle.db)
    const run = await createTrialRunFromDraft(handle.db, scenarioId, { revision: 1, actor: { id: actorId } })
    await handle.db
      .update(runs)
      .set({ status: status as never, outcomeStatus: outcomeStatus as never, createdAt: nextTime() })
      .where(eq(runs.id, run.detail.id))
  }

  async function scenario(key: string, steps: Step[] = [echoStep(key)], inputs?: { key: string; label: string }[]) {
    const created = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `健康度-${key}`,
      steps,
      ...(inputs ? { inputs } : {}),
      actor: { id: actorId },
    })
    ids[key] = created.id
    return created.id
  }

  async function schedule(scenarioId: string, deleted = false) {
    const { schedules, scheduleVersions } = schemaFor(handle.db)
    const scheduleId = newId()
    const versionId = newId()
    await handle.db.insert(schedules).values({
      id: scheduleId,
      name: '夜间巡检',
      targetId,
      consumerKey: 'scenario_run',
      enabled: 1,
      revision: 1,
      currentVersionId: versionId,
      createdBy: actorId,
      deletedAt: deleted ? new Date() : null,
      deletedBy: deleted ? { id: actorId, displayName: 'tester', kind: 'console' } : null,
    })
    await handle.db.insert(scheduleVersions).values({
      id: versionId,
      scheduleId,
      revision: 1,
      timezone: 'Asia/Shanghai',
      weekdays: [1, 2, 3, 4, 5] as never,
      windowStart: '08:00',
      windowEnd: '09:00',
      misfire: 'skip',
      consumer: { type: 'scenario_run', scenarioId } as never,
      authorizedActorId: actorId,
      contentDigest: newId(),
    })
  }

  const names = (items: ScenarioDto[]) => items.map((item) => item.name.replace('健康度-', '')).sort()

  beforeAll(async () => {
    handle = await openContractDb(driver, SCHEMA)
    const { consoleAccounts, targets } = schemaFor(handle.db)
    actorId = newId()
    targetId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'tester',
      email: `list-health-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `lh-${SCHEMA.slice(-6)}`,
      name: '健康度夹具',
      entryUrl: 'https://example.com',
    })

    // 正常：较新的试跑失败不影响健康度。
    await formalRun(await scenario('passing'), 'SUCCEEDED', 'PASS')
    await trialRun(ids.passing!, 'FAILED')
    // 异常：业务结论不通过；执行失败（较新的正式运行已删除，不计入）。
    await formalRun(await scenario('outcomeFail'), 'SUCCEEDED', 'FAIL')
    await formalRun(await scenario('execFail'), 'FAILED')
    await formalRun(ids.execFail!, 'SUCCEEDED', 'PASS', { deleted: true })
    // 运行中：等待登录也算运行中。
    await formalRun(await scenario('waitingAuth'), 'WAITING_FOR_AUTH')
    // 需关注、已取消。
    await formalRun(await scenario('warning'), 'SUCCEEDED', 'WARN')
    await formalRun(await scenario('cancelled'), 'CANCELLED')
    // 从未运行：没有运行；只有试跑。
    await scenario('neverRun')
    await scenario('trialOnly')
    await trialRun(ids.trialOnly!, 'SUCCEEDED', 'PASS')
    // 历史较长：6 次正式运行只回最近 5 次，最近一次证据不全。
    await scenario('longHistory')
    for (let index = 0; index < 5; index++) await formalRun(ids.longHistory!, 'SUCCEEDED', 'PASS')
    await formalRun(ids.longHistory!, 'SUCCEEDED', 'PASS', { evidenceStatus: 'INCOMPLETE' })

    await schedule(ids.passing!)
    await schedule(ids.warning!, true)
  })

  afterAll(async () => {
    await handle?.close()
  })

  it('健康度按最近一次正式运行归组，试跑与已删除的运行不计入', async () => {
    const failing = await listScenarios(handle.db, { targetId, health: ['failing'] })
    expect(names(failing.items)).toEqual(['execFail', 'outcomeFail'])

    const never = await listScenarios(handle.db, { targetId, health: ['never'] })
    expect(names(never.items)).toEqual(['neverRun', 'trialOnly'])

    const mixed = await listScenarios(handle.db, { targetId, health: 'running,warning' as never })
    expect(names(mixed.items)).toEqual(['waitingAuth', 'warning'])

    const passing = await listScenarios(handle.db, { targetId, health: ['passing'] })
    expect(names(passing.items)).toEqual(['longHistory', 'passing'])
  })

  it('最近正式运行旧 → 新至多 5 次，分组与 shared 判定一致，并带证据与触发方式', async () => {
    const all = await listScenarios(handle.db, { targetId, limit: 50 })
    const byName = new Map(all.items.map((item) => [item.name.replace('健康度-', ''), item]))

    const passing = byName.get('passing')!
    expect(passing.recentRuns).toHaveLength(1)
    expect(passing.latestRun?.status).toBe('FAILED')
    expect(runHealthBucket(passing.recentRuns!.at(-1))).toBe('passing')

    expect(byName.get('execFail')!.recentRuns!.map((run) => run.status)).toEqual(['FAILED'])
    expect(byName.get('trialOnly')!.recentRuns).toEqual([])

    const long = byName.get('longHistory')!.recentRuns!
    expect(long).toHaveLength(5)
    expect(long.map((run) => run.createdAt)).toEqual([...long.map((run) => run.createdAt)].sort())
    expect(long.at(-1)?.evidenceStatus).toBe('INCOMPLETE')
    expect(long.at(-1)?.triggerSource).toBe('manual')
  })

  it('搜索里的 % 与 _ 按字面匹配', async () => {
    await scenario('通过率100%核对')
    await scenario('通过率1000核对')
    const percent = await listScenarios(handle.db, { targetId, search: '100%' })
    expect(percent.items.map((item) => item.name)).toEqual(['健康度-通过率100%核对'])
    const underscore = await listScenarios(handle.db, { targetId, search: '_' })
    expect(underscore.items).toEqual([])
  })

  it('运行前提取自最新发布版本', async () => {
    const id = await scenario('withInput', [{ ...echoStep('x'), input: { from: 'title' } } as Step], [{ key: 'title', label: '工单标题' }])
    const listed = await listScenarios(handle.db, { targetId, search: '健康度-withInput' })
    expect(listed.items[0]?.id).toBe(id)
    expect(listed.items[0]?.runRequirements).toEqual({
      inputs: [{ key: 'title', label: '工单标题' }],
      needsAccount: false,
    })
  })

  it('调度筛选只看未删除的直属定时调度，摘要也不再挂已删除的调度', async () => {
    const scheduled = await listScenarios(handle.db, { targetId, schedule: 'scheduled' })
    expect(names(scheduled.items)).toEqual(['passing'])
    expect(scheduled.items[0]?.schedule?.summary).toBe('定时调度')

    const unscheduled = await listScenarios(handle.db, { targetId, schedule: 'unscheduled', limit: 50 })
    expect(names(unscheduled.items)).not.toContain('passing')
    const warning = unscheduled.items.find((item) => item.name === '健康度-warning')
    expect(warning?.schedule).toBeNull()
  })

  it('按最近更新排序的游标带前缀，与创建时间游标不能混用', async () => {
    const { scenarios } = schemaFor(handle.db)
    await handle.db.update(scenarios).set({ updatedAt: new Date(Date.UTC(2030, 0, 1)) }).where(eq(scenarios.id, ids.neverRun!))

    const first = await listScenarios(handle.db, { targetId, sort: 'updated', limit: 2 })
    expect(first.items[0]?.id).toBe(ids.neverRun)
    expect(first.nextCursor?.startsWith('u.')).toBe(true)

    const second = await listScenarios(handle.db, { targetId, sort: 'updated', limit: 2, cursor: first.nextCursor })
    expect(second.items.map((item) => item.id)).not.toContain(ids.neverRun)

    await expect(listScenarios(handle.db, { targetId, limit: 2, cursor: first.nextCursor })).rejects.toMatchObject({
      code: 'INVALID_CURSOR',
    })
  })

  it('「有未发布修改」与卡片上的 draftDirty 同一判定：新建即发布的场景不算，保存过草稿的才算', async () => {
    const clean = await scenario('draftClean')
    const dirty = await scenario('draftDirty')
    const reverted = await scenario('draftReverted')
    const document = (value: string) => ({ schemaVersion: 1 as const, inputs: [], steps: [echoStep(value)] })
    await saveScenarioDraft(handle.db, dirty, { revision: 1, document: document('改过'), actor: { id: actorId } })
    // 复制场景时草稿与版本同一时刻写入，草稿却带着来源未发布的修改：边界取「不早于」才不会漏。
    const sameInstant = await scenario('draftSameInstant')
    await saveScenarioDraft(handle.db, sameInstant, { revision: 1, document: document('副本带来的修改'), actor: { id: actorId } })
    const { scenarioDrafts, scenarioVersions } = schemaFor(handle.db)
    const [version] = await handle.db.select().from(scenarioVersions).where(eq(scenarioVersions.scenarioId, sameInstant))
    await handle.db.update(scenarioDrafts).set({ updatedAt: version!.createdAt }).where(eq(scenarioDrafts.scenarioId, sameInstant))
    const listed = await listScenarios(handle.db, { targetId, hasDraft: true, search: '健康度-draft', limit: 50 })
    expect(listed.items.map((item) => item.id).sort()).toEqual([dirty, sameInstant].sort())
    expect(listed.items.every((item) => item.draftDirty)).toBe(true)
    const cleanOnes = await listScenarios(handle.db, { targetId, hasDraft: false, search: '健康度-draft', limit: 50 })
    expect(cleanOnes.items.map((item) => item.id).sort()).toEqual([clean, reverted].sort())
    // 列表上的徽标与筛选一致。
    expect(listed.items.every((item) => item.draftDirty)).toBe(true)
    expect(cleanOnes.items.some((item) => item.draftDirty)).toBe(false)
  })

  it('按创建人与创建时间范围筛选，计数给出创建人可选项（不受创建人筛选本身影响）', async () => {
    const { consoleAccounts, scenarios } = schemaFor(handle.db)
    const otherId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: otherId,
      displayName: '另一位编排人',
      email: `list-health-other-${otherId}@example.com`,
      status: 'active',
    })
    const created = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '健康度-byOther',
      steps: [echoStep('other')],
      actor: { id: otherId },
    })
    await handle.db.update(scenarios).set({ createdAt: new Date(Date.UTC(2026, 0, 15)) }).where(eq(scenarios.id, created.id))

    const byOther = await listScenarios(handle.db, { targetId, createdBy: otherId })
    expect(byOther.items.map((item) => item.id)).toEqual([created.id])
    expect(byOther.items[0]?.createdBy).toMatchObject({ id: otherId, displayName: '另一位编排人' })

    const january = await listScenarios(handle.db, {
      targetId,
      createdFrom: '2026-01-01T00:00:00.000Z',
      createdTo: '2026-02-01T00:00:00.000Z',
    })
    expect(january.items.map((item) => item.id)).toEqual([created.id])
    const beforeJanuary = await listScenarios(handle.db, { targetId, createdTo: '2026-01-15T00:00:00.000Z' })
    expect(beforeJanuary.items).toEqual([])

    const summary = await summarizeScenarios(handle.db, { targetId, createdBy: otherId })
    expect(summary.total).toBe(1)
    const creatorIds = summary.creators!.map((creator) => creator.id)
    expect(creatorIds).toContain(otherId)
    expect(creatorIds).toContain(actorId)
    expect(summary.creators!.find((creator) => creator.id === otherId)?.count).toBe(1)
  })

  it('计数按健康度归组，筛选与列表一致', async () => {
    const summary = await summarizeScenarios(handle.db, { targetId, search: '健康度-' })
    expect(summary.byHealth).toEqual({
      failing: 2,
      warning: 1,
      running: 1,
      passing: 2,
      cancelled: 1,
      never: summary.total - 7,
    })
    const scheduledOnly = await summarizeScenarios(handle.db, { targetId, schedule: 'scheduled' })
    expect(scheduledOnly).toMatchObject({
      total: 1,
      byHealth: { failing: 0, warning: 0, running: 0, passing: 1, cancelled: 0, never: 0 },
    })
  })
})
