import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  durationPeriodLabel,
  durationPeriodReportOf,
  lastCompleteDurationPeriodStart,
  shiftLocalDate,
  shiftLocalMonth,
  suiteDocumentSchema,
  targetDurationAnalysisQuerySchema,
  zonedStartOfDay,
  type DurationPeriodReportSubject,
} from '@cairn/shared'
import { DRIVERS, grantAdminScope, openContractDb } from './contract-fixture.js'
import { HOUR, STEP_B, durationSeeder, nodesOf, type DurationScenario } from './duration-fixture.js'
import {
  createReport,
  createReportRevision,
  eq,
  listReports,
  loadReportRevisionDocument,
  newId,
  readTargetDurationAnalysis,
  schemaFor,
  writeRunWithSnapshot,
} from '../test-entry.js'

const TZ = 'Asia/Shanghai'

describe.each(DRIVERS)('%s 周期耗时报告', { timeout: 120_000 }, (driver) => {
  let handle: Awaited<ReturnType<typeof openContractDb>>
  let actorId: string
  let seeder: ReturnType<typeof durationSeeder>
  let targetId: string
  let slowed: DurationScenario
  let steady: DurationScenario
  let idle: DurationScenario
  // 三周前的一个已结束自然周，对比上一周
  let weekStart: string
  const at = (day: string, hour: number) => new Date(zonedStartOfDay(day, TZ).getTime() + hour * HOUR)
  const actor = () => ({ kind: 'console' as const, id: actorId })
  const subject = (overrides: Partial<DurationPeriodReportSubject> = {}): DurationPeriodReportSubject => ({
    kind: 'DURATION_PERIOD',
    targetId,
    period: 'week',
    periodStart: weekStart,
    timeZone: TZ,
    trigger: 'all',
    ...overrides,
  })
  const create = (s: DurationPeriodReportSubject) =>
    createReport(handle.db, { subject: s, scope: 'duration_period', stage: 'final', idempotencyKey: `period-${newId()}` }, actor())
  const blockOf = async (revisionId: string) => {
    const { revision } = await loadReportRevisionDocument(handle.db, revisionId, actorId)
    const block = durationPeriodReportOf(revision.document!)
    expect(block).not.toBeNull()
    return block!
  }

  beforeAll(async () => {
    handle = await openContractDb(driver, `duration_period_report_${driver}`)
    actorId = newId()
    const { consoleAccounts } = schemaFor(handle.db)
    await handle.db.insert(consoleAccounts).values({ id: actorId, displayName: '周期报告', email: `duration-period-${actorId}@example.com`, status: 'active' })
    await grantAdminScope(handle.db, actorId)
    seeder = durationSeeder(handle.db, actorId)
    weekStart = shiftLocalDate(lastCompleteDurationPeriodStart('week', new Date(), TZ), -14)
    const baseStart = shiftLocalDate(weekStart, -7)
    targetId = await seeder.newTarget('周报目标')
    slowed = await seeder.newScenario(targetId, '订单巡检')
    steady = await seeder.newScenario(targetId, '首页巡检')
    idle = await seeder.newScenario(targetId, '空闲巡检')
    for (let i = 0; i < 12; i += 1) {
      const day = (start: string) => shiftLocalDate(start, i % 7)
      // 订单巡检：查询订单 6s → 9s，本周每次重试一次；调度触发
      await seeder.seedRun({ scenario: slowed, targetId, finishedAt: at(day(baseStart), 9 + (i % 5)), activeMs: 10_000, nodes: nodesOf(4_000, 6_000) })
      await seeder.seedRun({ scenario: slowed, targetId, finishedAt: at(day(weekStart), 9 + (i % 5)), activeMs: 13_000, nodes: nodesOf(4_000, 9_000, { attemptCount: 2 }) })
      // 首页巡检：稳定 5s；手动触发
      await seeder.seedRun({ scenario: steady, targetId, finishedAt: at(day(baseStart), 15), activeMs: 5_000, trigger: 'manual', nodes: nodesOf(2_000, 3_000) })
      await seeder.seedRun({ scenario: steady, targetId, finishedAt: at(day(weekStart), 15), activeMs: 5_000, trigger: 'manual', nodes: nodesOf(2_000, 3_000) })
    }
    // 本周还有一次已完成、但耗时事实尚未写入的运行
    const { runId } = await writeRunWithSnapshot(handle.db, { scenarioId: steady.id, scenarioVersionId: steady.latestVersionId, actor: actor(), triggerSource: 'manual' })
    const { runs } = schemaFor(handle.db)
    const finishedAt = at(shiftLocalDate(weekStart, 3), 20)
    await handle.db.update(runs).set({ status: 'SUCCEEDED', startedAt: new Date(finishedAt.getTime() - 5_000), finishedAt }).where(eq(runs.id, runId))
  })

  afterAll(async () => {
    await handle?.close()
  })

  it('页面「上周」模式：按本地日历切分，按天 7 桶，对比上一周', async () => {
    const page = await readTargetDurationAnalysis(handle.db, targetId, targetDurationAnalysisQuerySchema.parse({ period: 'week', periodStart: weekStart, tz: TZ }))
    expect(page.window).toMatchObject({ period: 'week', periodStart: weekStart, periodEnd: shiftLocalDate(weekStart, 7), baseLabel: '上周', granularity: 'day', days: 7 })
    expect(page.window.from).toBe(zonedStartOfDay(weekStart, TZ).toISOString())
    expect(page.kpis.runs).toBe(24)
    expect(page.scenarios.find((s) => s.scenarioId === slowed.id)?.series).toHaveLength(7)
    await expect(readTargetDurationAnalysis(handle.db, targetId, targetDurationAnalysisQuerySchema.parse({ period: 'week', periodStart: weekStart, compare: 'last_week' }))).rejects.toMatchObject({ code: 'DURATION_PERIOD_COMPARE_INVALID' })
    await expect(readTargetDurationAnalysis(handle.db, targetId, targetDurationAnalysisQuerySchema.parse({ period: 'week', periodStart: shiftLocalDate(weekStart, 1) }))).rejects.toMatchObject({ code: 'DURATION_PERIOD_INVALID' })
  })

  it('生成周报：内容与页面同口径，变慢场景附归因原因，步骤与隐藏问题、发起方构成、缺口齐全', async () => {
    const report = await create(subject())
    expect(report.subject).toEqual(subject())
    expect(report.currentRevision).toMatchObject({ scope: 'duration_period', revisionNo: 1, contentCompleteness: 'complete' })
    expect(report.currentRevision?.sealedAt).not.toBeNull()
    expect(report.currentRevision?.title).toBe(`周报目标 耗时周报 · ${durationPeriodLabel('week', weekStart)}`)

    const block = await blockOf(report.currentRevision!.id)
    const page = await readTargetDurationAnalysis(handle.db, targetId, targetDurationAnalysisQuerySchema.parse({ period: 'week', periodStart: weekStart, tz: TZ }))
    expect(block.kpis.runs).toBe(page.kpis.runs)
    expect(block.kpis.activeP50).toEqual(page.kpis.activeP50)
    for (const row of block.scenarios) {
      expect(row.activeP50).toBe(page.scenarios.find((s) => s.scenarioId === row.scenarioId)?.activeP50.current)
    }

    expect(block.period).toMatchObject({ kind: 'week', start: weekStart, end: shiftLocalDate(weekStart, 7), timeZone: TZ })
    expect(block.comparisons.map((c) => [c.mode, c.label, c.start])).toEqual([
      ['prev_period', '上周', shiftLocalDate(weekStart, -7)],
      ['last_year', '去年同周', shiftLocalDate(weekStart, -364)],
    ])
    expect(block.kpis).toMatchObject({ runs: 24, succeeded: 24, failed: 0, slower: 1, faster: 0, triggers: { schedule: 12, manual: 12, service: 0 } })
    expect(block.kpis.activeP50Yoy).toMatchObject({ base: null, baseSamples: 0 })

    expect(block.slower).toHaveLength(1)
    const mover = block.slower[0]!
    expect(mover).toMatchObject({ scenarioId: slowed.id, current: 13_000, base: 10_000, deltaPct: 30, samples: 12, baseSamples: 12 })
    expect(mover.summary).toContain('本周比上周慢')
    expect(mover.causes[0]).toBe('『查询订单』+3.0s（重试 0→1 次）')

    expect(block.slowerSteps[0]).toMatchObject({ scenarioId: slowed.id, nodeKey: `step:${STEP_B}`, name: '查询订单', current: 9_000, base: 6_000, deltaPct: 50 })
    expect(block.slowerSteps[0]!.causes.some((c) => c.startsWith('重试变多：'))).toBe(true)
    expect(block.slowerSteps[0]!.causes).toContain('重试率 100%')
    expect(block.insights.map((i) => [i.kind, i.scenarioId, i.nodeKey])).toEqual(
      expect.arrayContaining([
        ['slower', slowed.id, null],
        ['slower', slowed.id, `step:${STEP_B}`],
        ['retry_increase', slowed.id, `step:${STEP_B}`],
      ]),
    )
    expect(block.kpis.insightCount).toBe(block.insights.length)

    expect(block.scenarios.map((row) => row.scenarioId)).toEqual([steady.id, slowed.id, idle.id].sort((a, b) => {
      const name = (id: string) => [steady, slowed, idle].find((s) => s.id === id)!.name
      const runs = (id: string) => (id === idle.id ? 0 : 1)
      return runs(b) - runs(a) || name(a).localeCompare(name(b), 'zh-CN')
    }))
    expect(block.scenarios.find((row) => row.scenarioId === idle.id)).toMatchObject({ runs: 0, activeP50: null })
    expect(block.scenarios.find((row) => row.scenarioId === slowed.id)).toMatchObject({ yoyDeltaPct: null, succeeded: 12, insightCount: 3 })
    expect(block.buckets).toHaveLength(7)
    expect(block.gaps).toContain('有 1 次运行的耗时尚未计算，未计入本报告')
    expect(block.conclusion.some((line) => line.includes('明显变慢 1 个场景'))).toBe(true)
    expect(block.consolePath).toBe(`/duration-analysis?targetId=${targetId}&period=week&periodStart=${weekStart}`)
    expect(block.suite).toBeNull()
  })

  it('发起方过滤只统计该发起方，构成仍计全部可比运行', async () => {
    const report = await create(subject({ trigger: 'schedule' }))
    const block = await blockOf(report.currentRevision!.id)
    expect(block.kpis.runs).toBe(12)
    expect(block.kpis.triggers).toEqual({ schedule: 12, manual: 12, service: 0 })
    expect(block.consolePath).toContain('trigger=schedule')
  })

  it('报告是封存快照：之后新增运行不改变已生成修订，新修订取到新数字', async () => {
    const report = await create(subject())
    await seeder.seedRun({ scenario: steady, targetId, finishedAt: at(shiftLocalDate(weekStart, 5), 11), activeMs: 5_000, trigger: 'manual' })
    expect((await blockOf(report.currentRevision!.id)).kpis.runs).toBe(24)
    const revised = await createReportRevision(handle.db, report.id, { reason: '重新取数', idempotencyKey: `rev-${newId()}` }, actor())
    expect(revised.currentRevision).toMatchObject({ revisionNo: 2, scope: 'duration_period' })
    expect((await blockOf(revised.currentRevision!.id)).kpis.runs).toBe(25)
  })

  it('报告列表可按周期报告筛选，按场景集筛选也能找到场景集周报', async () => {
    const { scenarioSuites, scenarioSuiteVersions } = schemaFor(handle.db)
    const suiteId = newId()
    await handle.db.insert(scenarioSuites).values({ id: suiteId, targetId, name: '订单集', executionMode: 'sequential', createdByConsoleAccountId: actorId })
    const document = suiteDocumentSchema.parse({ schemaVersion: 1, executionMode: 'sequential', members: [{ memberId: 'm_order', ordinal: 0, scenarioId: slowed.id, scenarioVersionId: slowed.latestVersionId }] })
    await handle.db.insert(scenarioSuiteVersions).values({ suiteId, versionNo: 1, document, digest: `d-${suiteId}`, publishedByConsoleAccountId: actorId })

    const suiteReport = await create(subject({ suiteId }))
    const block = await blockOf(suiteReport.currentRevision!.id)
    expect(block.suite).toEqual({ id: suiteId, name: '订单集' })
    expect(block.scenarios.map((row) => row.scenarioId)).toEqual([slowed.id])
    expect(block.suiteSummary).toMatchObject({ suiteId, runs: 0 })
    expect(suiteReport.currentRevision?.title).toContain('周报目标 · 订单集 耗时周报')

    const periodReports = await listReports(handle.db, { targetId, subjectKind: 'DURATION_PERIOD', limit: 100 }, actorId)
    expect(periodReports.items.length).toBeGreaterThanOrEqual(4)
    expect(periodReports.items.every((item) => item.subject.kind === 'DURATION_PERIOD')).toBe(true)
    const bySuite = await listReports(handle.db, { suiteId, limit: 100 }, actorId)
    expect(bySuite.items.map((item) => item.id)).toEqual([suiteReport.id])
    expect((await listReports(handle.db, { targetId, subjectKind: 'RUN' }, actorId)).items).toEqual([])
  })

  it('无数据的月报给出结论与同比对比周期', async () => {
    const monthStart = shiftLocalMonth(lastCompleteDurationPeriodStart('month', new Date(), TZ), -14)
    const report = await create(subject({ period: 'month', periodStart: monthStart }))
    const block = await blockOf(report.currentRevision!.id)
    expect(block.conclusion).toEqual(['本月没有可比运行。'])
    expect(block.comparisons.map((c) => c.label)).toEqual(['上月', '去年同月'])
    expect(block.kpis.runs).toBe(0)
    expect(report.currentRevision?.title).toContain('耗时月报 · ')
  })

  it('拒绝：未结束的周期、非周期起点、范围不匹配、场景集不属于该目标系统', async () => {
    const thisWeek = shiftLocalDate(lastCompleteDurationPeriodStart('week', new Date(), TZ), 7)
    await expect(create(subject({ periodStart: thisWeek }))).rejects.toMatchObject({ code: 'DURATION_PERIOD_NOT_ENDED' })
    await expect(create(subject({ periodStart: shiftLocalDate(weekStart, 2) }))).rejects.toMatchObject({ code: 'DURATION_PERIOD_INVALID' })
    await expect(
      createReport(handle.db, { subject: subject(), scope: 'run', stage: 'final', idempotencyKey: `period-${newId()}` }, actor()),
    ).rejects.toMatchObject({ code: 'REPORT_SCOPE_MISMATCH' })
    const otherTarget = await seeder.newTarget('别的目标')
    const { scenarioSuites } = schemaFor(handle.db)
    const foreignSuite = newId()
    await handle.db.insert(scenarioSuites).values({ id: foreignSuite, targetId: otherTarget, name: '别的集', createdByConsoleAccountId: actorId })
    await expect(create(subject({ suiteId: foreignSuite }))).rejects.toMatchObject({ code: 'REPORT_SOURCE_NOT_FOUND' })
  })
})
