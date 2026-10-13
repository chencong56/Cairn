import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_STATISTICS_TIME_ZONE, DURATION_FACTS_CALC_VERSION, localDateOf, type Step } from '@cairn/shared'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import {
  createRunWithSnapshot,
  createScenarioWithVersion,
  readRunDurationFacts,
  schemaFor,
  syncRunDurationFacts,
  writeRunWithSnapshot,
  newId,
  eq,
} from '../test-entry.js'

const steps: Step[] = [
  { id: '00000000-0000-4000-8000-0000000000a1', name: '打开报表', type: 'echo', effectType: 'READ_ONLY', outputKey: 'a', input: { value: 'a' } },
  { id: '00000000-0000-4000-8000-0000000000a2', name: '导出数据', type: 'echo', effectType: 'READ_ONLY', outputKey: 'b', input: { value: 'b' } },
]

describe.each(DRIVERS)('%s 耗时事实作业', { timeout: 60_000 }, (driver) => {
  let handle: Awaited<ReturnType<typeof openContractDb>>
  let actorId: string
  let targetId: string
  let scenario: { id: string; latestVersionId: string }

  beforeAll(async () => {
    handle = await openContractDb(driver, `duration_facts_${driver}`)
    actorId = newId()
    targetId = newId()
    const { consoleAccounts, targets } = schemaFor(handle.db)
    await handle.db.insert(consoleAccounts).values({ id: actorId, displayName: '耗时测试', email: `duration-${actorId}@example.com`, status: 'active' })
    await handle.db.insert(targets).values({ id: targetId, code: `duration-${actorId.slice(0, 8)}`, name: '耗时目标', entryUrl: 'https://example.com' })
    scenario = await createScenarioWithVersion(handle.db, { targetId, name: `耗时场景-${newId().slice(0, 6)}`, steps, actor: { id: actorId } })
  })

  afterAll(async () => {
    await handle?.close()
  })

  /** 造一条按给定时间线完结的运行：创建 → 认领 → 等待认证 → 恢复 → 再认领 → 成功。 */
  async function finishedRun(options: { finishedAt: Date; triggerSource?: 'manual' | 'schedule' }) {
    const { runId } = await writeRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      scenarioVersionId: scenario.latestVersionId,
      actor: { kind: 'console', id: actorId },
      triggerSource: options.triggerSource ?? 'schedule',
    })
    const { runs, runEvents, stepRuns, attempts } = schemaFor(handle.db)
    const end = options.finishedAt.getTime()
    const at = (offsetSeconds: number) => new Date(end - 20_000 + offsetSeconds * 1000)
    await handle.db
      .update(runs)
      .set({ status: 'SUCCEEDED', createdAt: at(-3), startedAt: at(0), finishedAt: at(20) })
      .where(eq(runs.id, runId))
    const timeline: Array<[number, string, Record<string, string>]> = [
      [0, 'run.status_changed', { status: 'RUNNING' }],
      [4, 'run.status_changed', { status: 'WAITING_FOR_AUTH' }],
      [4, 'run.auth_wait', { status: 'WAITING_FOR_AUTH' }],
      [12, 'run.status_changed', { status: 'RECOVERING', reason: 'auth_resumed' }],
      [14, 'run.status_changed', { status: 'RUNNING' }],
      [20, 'run.status_changed', { status: 'SUCCEEDED' }],
    ]
    await handle.db.insert(runEvents).values(
      timeline.map(([offset, type, payload], index) => ({
        eventId: newId(),
        runId,
        sequence: 100 + index,
        type: type as 'run.status_changed',
        occurredAt: at(offset),
        payload,
      })),
    )
    const rows = await handle.db.select({ id: stepRuns.id, stepId: stepRuns.stepId }).from(stepRuns).where(eq(stepRuns.runId, runId))
    for (const row of rows) {
      const first = row.stepId === steps[0]!.id
      await handle.db.update(stepRuns).set({ status: 'SUCCEEDED' }).where(eq(stepRuns.id, row.id))
      await handle.db.insert(attempts).values({
        id: newId(),
        stepRunId: row.id,
        attemptNo: 1,
        status: 'SUCCEEDED',
        startedAt: first ? at(1) : at(15),
        finishedAt: first ? at(3) : at(19),
      })
    }
    return runId
  }

  it('近期完结的运行被写入事实：总耗时可分解，节点按编排步骤汇总，重复同步幂等', async () => {
    const runId = await finishedRun({ finishedAt: new Date() })
    const first = await syncRunDurationFacts(handle.db, { recentWindowMs: 60 * 60 * 1000 })
    expect(first.written).toBeGreaterThanOrEqual(1)
    expect(first.failed).toBe(0)

    const readout = await readRunDurationFacts(handle.db, runId)
    expect(readout?.source).toBe('stored')
    expect(readout?.facts).toMatchObject({
      triggerSource: 'schedule',
      comparable: true,
      complete: true,
      totalMs: 20_000,
      activeMs: 10_000,
      authWaitMs: 8_000,
      requeueMs: 2_000,
      queueMs: 3_000,
      overheadMs: 10_000 - 2_000 - 4_000,
      workerLost: false,
      calcVersion: DURATION_FACTS_CALC_VERSION,
    })
    expect(readout?.nodes.map((node) => [node.nodeKey, node.activeMs])).toEqual([
      [`step:${steps[0]!.id}`, 2_000],
      [`step:${steps[1]!.id}`, 4_000],
    ])
    // 事实写入与按天汇总的脏键同事务登记（场景 + 统计时区下的本地日期）
    const { durationRollupDirty } = schemaFor(handle.db)
    const dirty = await handle.db.select().from(durationRollupDirty).where(eq(durationRollupDirty.scenarioId, readout!.facts.scenarioId))
    expect(dirty.map((row) => row.statDay)).toContain(localDateOf(new Date(readout!.facts.finishedAt!), DEFAULT_STATISTICS_TIME_ZONE))

    const second = await syncRunDurationFacts(handle.db, { recentWindowMs: 60 * 60 * 1000 })
    expect(second.written).toBe(0)
  })

  it('近期窗口之外的历史运行由分页回扫补上，游标走到最早时返回 null', async () => {
    const older = await finishedRun({ finishedAt: new Date(Date.now() - 3 * 24 * 3600 * 1000) })
    const oldest = await finishedRun({ finishedAt: new Date(Date.now() - 5 * 24 * 3600 * 1000) })
    const recentOnly = await syncRunDurationFacts(handle.db, { recentWindowMs: 60 * 1000 })
    expect(recentOnly.written).toBe(0)
    expect((await readRunDurationFacts(handle.db, older))?.source).toBe('computed')

    let cursor: Awaited<ReturnType<typeof syncRunDurationFacts>>['catchUpNext'] = null
    let pages = 0
    do {
      const page = await syncRunDurationFacts(handle.db, { recentWindowMs: 60 * 1000, catchUp: { before: cursor, pageSize: 1 } })
      cursor = page.catchUpNext
      pages += 1
    } while (cursor && pages < 20)
    expect(cursor).toBeNull()
    expect((await readRunDurationFacts(handle.db, older))?.source).toBe('stored')
    expect((await readRunDurationFacts(handle.db, oldest))?.facts.complete).toBe(true)
  })

  it('规则版本落后时重算；事件已被清理的运行保留运行级事实、推进版本号并刷新节点事实', async () => {
    const runId = await finishedRun({ finishedAt: new Date() })
    await syncRunDurationFacts(handle.db)
    const { runDurationFacts, runEvents, runNodeDurationFacts } = schemaFor(handle.db)

    await handle.db.update(runDurationFacts).set({ calcVersion: 0, activeMs: 1 }).where(eq(runDurationFacts.runId, runId))
    const recomputed = await syncRunDurationFacts(handle.db)
    expect(recomputed.recomputed).toBeGreaterThanOrEqual(1)
    expect((await readRunDurationFacts(handle.db, runId))?.facts.activeMs).toBe(10_000)

    await handle.db.delete(runEvents).where(eq(runEvents.runId, runId))
    await handle.db.update(runDurationFacts).set({ calcVersion: 0 }).where(eq(runDurationFacts.runId, runId))
    // 旧规则写下的节点事实（这里用错误的尝试数模拟）在事件清理后仍会按新规则刷新
    await handle.db.update(runNodeDurationFacts).set({ attemptCount: 9 }).where(eq(runNodeDurationFacts.runId, runId))
    const kept = await syncRunDurationFacts(handle.db)
    expect(kept.kept).toBeGreaterThanOrEqual(1)
    const readout = await readRunDurationFacts(handle.db, runId)
    expect(readout?.facts).toMatchObject({ complete: true, activeMs: 10_000, calcVersion: DURATION_FACTS_CALC_VERSION })
    expect(readout?.nodes.map((node) => node.attemptCount)).toEqual([1, 1])
  })

  it('运行中不进入事实表，读取时按当前时刻现算并标进行中', async () => {
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      scenarioVersionId: scenario.latestVersionId,
      actor: { id: actorId },
    })
    const { runs, runEvents, runDurationFacts } = schemaFor(handle.db)
    const startedAt = new Date(Date.now() - 5_000)
    await handle.db.update(runs).set({ status: 'RUNNING', startedAt }).where(eq(runs.id, created.detail.id))
    await handle.db.insert(runEvents).values({ eventId: newId(), runId: created.detail.id, sequence: 100, type: 'run.status_changed', occurredAt: startedAt, payload: { status: 'RUNNING' } })
    await syncRunDurationFacts(handle.db, { catchUp: { before: null } })
    expect(await handle.db.select().from(runDurationFacts).where(eq(runDurationFacts.runId, created.detail.id))).toHaveLength(0)

    const readout = await readRunDurationFacts(handle.db, created.detail.id)
    expect(readout?.source).toBe('computed')
    expect(readout?.facts).toMatchObject({ complete: false, incompleteReason: 'in_progress', triggerSource: 'manual' })
    expect(readout?.facts.activeMs).toBeGreaterThanOrEqual(4_000)
  })

  it('账本模型调用写入节点分段；事件清理后 kept 路径仍补上模型列', async () => {
    const runId = await finishedRun({ finishedAt: new Date() })
    const { stepRuns, attempts, scenarioAiCalls, runDurationFacts, runEvents } = schemaFor(handle.db)
    const [step] = await handle.db.select({ id: stepRuns.id, stepId: stepRuns.stepId }).from(stepRuns).where(eq(stepRuns.runId, runId))
    const [attempt] = await handle.db.select({ id: attempts.id }).from(attempts).where(eq(attempts.stepRunId, step!.id))
    await handle.db.insert(scenarioAiCalls).values({
      evidenceId: newId(),
      runId,
      stepRunId: step!.id,
      attemptId: attempt!.id,
      purpose: 'scenario_step',
      phase: 'completed',
      durationMs: 1_200,
      startedAt: new Date(),
      endedAt: new Date(),
    })
    await syncRunDurationFacts(handle.db)
    const first = await readRunDurationFacts(handle.db, runId)
    expect(first?.facts.modelMs).toBe(1_200)
    expect(first?.nodes.find((node) => node.nodeKey === `step:${step!.stepId}`)).toMatchObject({
      modelMs: 1_200,
      residualMs: first!.nodes.find((node) => node.nodeKey === `step:${step!.stepId}`)!.activeMs - 1_200,
    })

    await handle.db.delete(runEvents).where(eq(runEvents.runId, runId))
    await handle.db.update(runDurationFacts).set({ calcVersion: 0, modelMs: 0, residualMs: 0 }).where(eq(runDurationFacts.runId, runId))
    const kept = await syncRunDurationFacts(handle.db)
    expect(kept.kept).toBeGreaterThanOrEqual(1)
    const after = await readRunDurationFacts(handle.db, runId)
    expect(after?.facts).toMatchObject({ complete: true, activeMs: 10_000, modelMs: 1_200, calcVersion: DURATION_FACTS_CALC_VERSION })
  })

  it('非已发布版本或非 user 用途的场景运行标为不可比', async () => {
    const mapScenario = await createScenarioWithVersion(handle.db, { targetId, name: `地图作业-${newId().slice(0, 6)}`, steps, actor: { id: actorId } })
    const { scenarios } = schemaFor(handle.db)
    await handle.db.update(scenarios).set({ purpose: 'map_job' }).where(eq(scenarios.id, mapScenario.id))
    const saved = scenario
    scenario = mapScenario
    try {
      const runId = await finishedRun({ finishedAt: new Date() })
      await syncRunDurationFacts(handle.db)
      expect((await readRunDurationFacts(handle.db, runId))?.facts.comparable).toBe(false)
    } finally {
      scenario = saved
    }
  })
})
