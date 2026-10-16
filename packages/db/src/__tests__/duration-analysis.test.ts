import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  durationAnalysisQuerySchema,
  runDurationQuerySchema,
  suiteDocumentSchema,
  targetDurationAnalysisQuerySchema,
} from '@cairn/shared'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import { DAY, HOUR, STEP_A, STEP_B, durationSeeder, nodesOf as seedNodesOf, type DurationScenario as Scenario, type SeedRun } from './duration-fixture.js'
import {
  listRuns,
  readRunDuration,
  readScenarioDurationAnalysis,
  readScenarioNodeHistory,
  readSuiteRunDuration,
  readTargetDurationAnalysis,
  schemaFor,
  newId,
  eq,
} from '../test-entry.js'

const day = (offsetDays: number, hourUtc = 4) => {
  const date = new Date(Date.now() - offsetDays * DAY)
  date.setUTCHours(hourUtc, 0, 0, 0)
  return date
}

describe.each(DRIVERS)('%s 耗时分析读模型', { timeout: 120_000 }, (driver) => {
  let handle: Awaited<ReturnType<typeof openContractDb>>
  let actorId: string
  let seeder: ReturnType<typeof durationSeeder>
  const newTarget = (name: string) => seeder.newTarget(name)
  const newScenario = (targetId: string, name: string) => seeder.newScenario(targetId, name)
  const seedRun = (o: SeedRun) => seeder.seedRun(o)
  const copyVersion = (scenario: Scenario, kind: 'published' | 'trial', versionNo: number | null) => seeder.copyVersion(scenario, kind, versionNo)

  beforeAll(async () => {
    handle = await openContractDb(driver, `duration_analysis_${driver}`)
    actorId = newId()
    const { consoleAccounts } = schemaFor(handle.db)
    await handle.db.insert(consoleAccounts).values({ id: actorId, displayName: '耗时分析', email: `duration-analysis-${actorId}@example.com`, status: 'active' })
    seeder = durationSeeder(handle.db, actorId)
  })

  afterAll(async () => {
    await handle?.close()
  })

  const nodesOf = seedNodesOf

  describe('场景与目标系统', () => {
    let targetId: string
    let slowed: Scenario
    let idle: Scenario

    beforeAll(async () => {
      targetId = await newTarget('分析目标')
      slowed = await newScenario(targetId, '订单巡检')
      idle = await newScenario(targetId, '空闲巡检')
      const v2 = await copyVersion(slowed, 'published', 2)
      // 上一周期 12 次：执行 10s（查询 6s）
      for (let i = 0; i < 12; i += 1) {
        await seedRun({ scenario: slowed, targetId, finishedAt: day(40 + i), activeMs: 10_000, nodes: nodesOf(4_000, 6_000) })
      }
      // 本周期 12 次：执行 13s（查询 9s），后 6 次换了新版本
      for (let i = 0; i < 12; i += 1) {
        await seedRun({
          scenario: slowed,
          targetId,
          finishedAt: day(12 - i),
          activeMs: 13_000,
          nodes: nodesOf(4_000, 9_000),
          versionId: i >= 6 ? v2 : undefined,
        })
      }
      // 失败运行计入次数不计入分位；不可比、已删除的运行完全不计
      await seedRun({ scenario: slowed, targetId, finishedAt: day(2, 6), activeMs: 2_000, status: 'FAILED', trigger: 'manual', nodes: [[`step:${STEP_A}`, 2_000]] })
      await seedRun({ scenario: slowed, targetId, finishedAt: day(3, 6), activeMs: 99_000, comparable: false, nodes: nodesOf(50_000, 49_000) })
      await seedRun({ scenario: slowed, targetId, finishedAt: day(4, 6), activeMs: 99_000, deleted: true, nodes: nodesOf(50_000, 49_000) })
    })

    it('场景分析：只用可比运行，分位取成功运行，按节点给出涨跌与隐藏问题', async () => {
      const result = await readScenarioDurationAnalysis(handle.db, slowed.id, durationAnalysisQuerySchema.parse({ tz: 'Asia/Shanghai' }))
      expect(result.scenario).toMatchObject({ id: slowed.id, targetId, targetName: '分析目标' })
      expect(result.kpis.runs).toBe(13)
      expect(result.kpis.samples).toBe(12)
      expect(result.kpis.activeP50).toMatchObject({ current: 13_000, base: 10_000, deltaPct: 30, currentSamples: 12, baseSamples: 12 })
      expect(result.buckets.reduce((sum, b) => sum + b.runs, 0)).toBe(13)
      expect(result.buckets.reduce((sum, b) => sum + b.failed, 0)).toBe(1)

      const byKey = new Map(result.nodes.map((n) => [n.nodeKey, n]))
      expect(result.kpis.overheadP50.current).toEqual(expect.any(Number))
      expect(byKey.get(`step:${STEP_A}`)).toMatchObject({ activeP50: 4_000, residualP50: 4_000, baseP50: 4_000, deltaPct: 0, samples: 12 })
      expect(byKey.get(`step:${STEP_B}`)).toMatchObject({ activeP50: 9_000, residualP50: 9_000, baseP50: 6_000, deltaPct: 50 })
      expect(byKey.get(`step:${STEP_B}`)?.sparkline).toHaveLength(result.buckets.length)

      expect(result.insights.map((i) => [i.kind, i.nodeKey])).toEqual(
        expect.arrayContaining([
          ['slower', null],
          ['slower', `step:${STEP_B}`],
        ]),
      )
      expect(result.insights.some((i) => i.nodeKey === `step:${STEP_A}`)).toBe(false)
      expect(result.versionBoundaries).toHaveLength(1)
      expect(result.versionBoundaries[0]?.versionNo).toBe(2)
    })

    it('按发起方筛选；同比基准窗口内没有运行时不给涨跌', async () => {
      const manual = await readScenarioDurationAnalysis(handle.db, slowed.id, durationAnalysisQuerySchema.parse({ trigger: 'manual' }))
      expect(manual.kpis).toMatchObject({ runs: 1, samples: 0 })
      const lastYear = await readScenarioDurationAnalysis(handle.db, slowed.id, durationAnalysisQuerySchema.parse({ compare: 'last_year' }))
      expect(lastYear.kpis.activeP50).toMatchObject({ current: 13_000, base: null, deltaPct: null, baseSamples: 0 })
      expect(lastYear.insights.some((i) => i.kind === 'slower' && i.nodeKey === null)).toBe(false)
    })

    it('节点历史：逐次运行的点与按天中位数', async () => {
      const history = await readScenarioNodeHistory(handle.db, slowed.id, { ...durationAnalysisQuerySchema.parse({}), nodeKey: `step:${STEP_B}` })
      expect(history.node).toMatchObject({ nodeKey: `step:${STEP_B}`, name: '查询订单' })
      expect(history.points).toHaveLength(12)
      expect(new Set(history.points.map((p) => p.activeMs))).toEqual(new Set([9_000]))
      expect(history.buckets.filter((b) => b.samples > 0).every((b) => b.p50 === 9_000)).toBe(true)

      const missing = await readScenarioNodeHistory(handle.db, slowed.id, { ...durationAnalysisQuerySchema.parse({}), nodeKey: 'step:nope' })
      expect(missing.points).toEqual([])
    })

    it('目标系统：列出全部场景（含无运行的），汇总变慢场景', async () => {
      const result = await readTargetDurationAnalysis(handle.db, targetId, targetDurationAnalysisQuerySchema.parse({}))
      expect(result.target).toEqual({ id: targetId, name: '分析目标' })
      expect(result.kpis).toMatchObject({ runs: 13, slower: 1, faster: 0 })
      const byId = new Map(result.scenarios.map((s) => [s.scenarioId, s]))
      expect(byId.get(slowed.id)).toMatchObject({ runs: 13, samples: 12, activeP95: 13_000 })
      expect(byId.get(slowed.id)?.insights.map((i) => i.kind)).toContain('slower')
      expect(byId.get(idle.id)).toMatchObject({ runs: 0, samples: 0, insights: [] })
      expect(result.suite).toBeNull()
    })

    it('本地日期分桶：UTC 16:30 完成的运行在上海时区落到次日', async () => {
      const finishedAt = day(3, 16)
      finishedAt.setUTCMinutes(30)
      const local = await newScenario(targetId, '时区巡检')
      await seedRun({ scenario: local, targetId, finishedAt, activeMs: 5_000 })
      const utcDay = finishedAt.toISOString().slice(0, 10)
      const nextDay = new Date(finishedAt.getTime() + DAY).toISOString().slice(0, 10)
      const shanghai = await readScenarioDurationAnalysis(handle.db, local.id, durationAnalysisQuerySchema.parse({ days: 7, tz: 'Asia/Shanghai' }))
      expect(shanghai.buckets.find((b) => b.runs > 0)?.bucket).toBe(nextDay)
      const utc = await readScenarioDurationAnalysis(handle.db, local.id, durationAnalysisQuerySchema.parse({ days: 7, tz: 'UTC' }))
      expect(utc.buckets.find((b) => b.runs > 0)?.bucket).toBe(utcDay)
    })
  })

  describe('单次运行对比', () => {
    let targetId: string
    let scenario: Scenario
    let other: Scenario
    const ids: Record<string, string> = {}

    beforeAll(async () => {
      targetId = await newTarget('对比目标')
      scenario = await newScenario(targetId, '对比巡检')
      other = await newScenario(targetId, '别的巡检')
      const trialVersion = await copyVersion(scenario, 'trial', null)
      const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * HOUR)
      ids.c1 = await seedRun({ scenario, targetId, finishedAt: at(10), activeMs: 9_000, status: 'FAILED', nodes: nodesOf(3_000, 6_000) })
      ids.c2 = await seedRun({ scenario, targetId, finishedAt: at(9), activeMs: 10_000, nodes: nodesOf(4_000, 6_000) })
      ids.c3 = await seedRun({ scenario, targetId, finishedAt: at(8), activeMs: 12_000, nodes: nodesOf(4_000, 8_000) })
      ids.c4 = await seedRun({ scenario, targetId, finishedAt: at(7), activeMs: 30_000, deleted: true, nodes: nodesOf(4_000, 26_000) })
      ids.t1 = await seedRun({ scenario, targetId, finishedAt: at(6), activeMs: 50_000, comparable: false, versionId: trialVersion, nodes: nodesOf(10_000, 40_000) })
      ids.c5 = await seedRun({ scenario, targetId, finishedAt: at(5), activeMs: 20_000, authWaitMs: 15_000, nodes: nodesOf(4_000, 16_000, { attemptCount: 3 }) })
      ids.t2 = await seedRun({ scenario, targetId, finishedAt: at(4), activeMs: 45_000, comparable: false, versionId: trialVersion, nodes: nodesOf(10_000, 35_000) })
      ids.other = await seedRun({ scenario: other, targetId, finishedAt: at(3), activeMs: 1_000 })
    })

    const query = (input: Record<string, unknown> = {}) => runDurationQuerySchema.parse(input)

    it('没有更早运行时为 first_run，只有失败的更早运行时为 no_successful_base', async () => {
      expect((await readRunDuration(handle.db, ids.c1!, query())).comparisonUnavailable).toBe('first_run')
      expect((await readRunDuration(handle.db, ids.c2!, query())).comparisonUnavailable).toBe('no_successful_base')
    })

    it('默认对比上一次可比且成功的运行，跳过已删除与试跑；归因到分项与节点', async () => {
      const readout = await readRunDuration(handle.db, ids.c5!, query())
      expect(readout.facts).toMatchObject({ runId: ids.c5, activeMs: 20_000, authWaitMs: 15_000 })
      expect(readout.comparison).toMatchObject({ mode: 'previous', trial: false, baseRunId: ids.c3, baseSamples: 1 })
      const attribution = readout.comparison!.attribution
      expect(attribution.totalDeltaMs).toBe(35_000 - 12_000)
      expect(attribution.components.authWait.delta).toBe(15_000)
      expect(attribution.components.active.delta).toBe(8_000)
      const queryNode = attribution.nodes.find((n) => n.nodeKey === `step:${STEP_B}`)
      expect(queryNode).toMatchObject({ baseMs: 8_000, targetMs: 16_000, deltaMs: 8_000, deltaPct: 100 })
      expect(queryNode?.tags).toContainEqual({ kind: 'retries', from: 0, to: 2 })
      expect(readout.comparison!.summary).toContain('认证等待')
    })

    it('近 10 次中位数、关闭对比与指定对比运行', async () => {
      const median = await readRunDuration(handle.db, ids.c5!, query({ compare: 'median10' }))
      expect(median.comparison).toMatchObject({ mode: 'median10', baseRunId: null, baseSamples: 2 })
      expect(median.comparison!.summary).toContain('近 2 次中位数')

      const none = await readRunDuration(handle.db, ids.c5!, query({ compare: 'none' }))
      expect(none).toMatchObject({ comparison: null, comparisonUnavailable: null })

      const picked = await readRunDuration(handle.db, ids.c5!, query({ baseRunId: ids.c2 }))
      expect(picked.comparison).toMatchObject({ mode: 'run', baseRunId: ids.c2 })
      expect((await readRunDuration(handle.db, ids.c5!, query({ baseRunId: ids.other }))).comparisonUnavailable).toBe('base_mismatch')
      expect((await readRunDuration(handle.db, ids.c5!, query({ baseRunId: newId() }))).comparisonUnavailable).toBe('base_not_found')
      await expect(readRunDuration(handle.db, newId(), query())).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' })
    })

    it('试跑对比上一次试跑', async () => {
      const readout = await readRunDuration(handle.db, ids.t2!, query())
      expect(readout.comparison).toMatchObject({ trial: true, baseRunId: ids.t1 })
      expect(readout.comparison!.summary).toContain('上次试跑')
    })

    it('运行列表带上耗时分解', async () => {
      const list = await listRuns(handle.db, { scenarioId: scenario.id, limit: 100 })
      const row = list.items.find((item) => item.id === ids.c5)
      expect(row?.duration).toEqual({ totalMs: 35_000, activeMs: 20_000, authWaitMs: 15_000, requeueMs: 0, reviewMs: 0, holdMs: 0, queueMs: 1_000, complete: true })
    })
  })

  describe('场景集', () => {
    let targetId: string
    let login: Scenario
    let query: Scenario
    let suiteId: string
    let baseRun: string
    let currentRun: string
    let deletedMemberRun: string

    beforeAll(async () => {
      targetId = await newTarget('场景集目标')
      login = await newScenario(targetId, '登录')
      query = await newScenario(targetId, '查询')
      const document = suiteDocumentSchema.parse({
        schemaVersion: 1,
        stages: [
          {
            id: 'stage-login',
            name: '登录阶段',
            ordinal: 0,
            executionMode: 'sequential',
            maxConcurrency: 1,
            failurePolicy: 'stop',
            members: [{ memberId: 'm_login', ordinal: 0, scenarioId: login.id, scenarioVersionId: login.latestVersionId }],
          },
          {
            id: 'stage-query',
            name: '查询阶段',
            ordinal: 1,
            executionMode: 'parallel',
            maxConcurrency: 2,
            failurePolicy: 'continue',
            members: [
              { memberId: 'm_q1', ordinal: 0, scenarioId: query.id, scenarioVersionId: query.latestVersionId },
              { memberId: 'm_q2', ordinal: 1, scenarioId: query.id, scenarioVersionId: query.latestVersionId, displayName: '查询复核' },
            ],
          },
        ],
      })
      const { scenarioSuites, scenarioSuiteVersions, suiteRuns } = schemaFor(handle.db)
      suiteId = newId()
      await handle.db.insert(scenarioSuites).values({ id: suiteId, targetId, name: '日常巡检集', executionMode: 'parallel', createdByConsoleAccountId: actorId })
      const suiteVersionId = newId()
      await handle.db.insert(scenarioSuiteVersions).values({ id: suiteVersionId, suiteId, versionNo: 1, document, digest: `d-${suiteVersionId}`, publishedByConsoleAccountId: actorId })

      const suiteRun = async (finishedAt: Date, wallMs: number, members: Array<[string, Scenario, number, boolean?]>) => {
        const id = newId()
        await handle.db.insert(suiteRuns).values({
          id,
          suiteId,
          suiteVersionId,
          targetId,
          createdByConsoleAccountId: actorId,
          status: 'COMPLETED',
          failurePolicy: 'continue',
          deadlineAt: new Date(finishedAt.getTime() + DAY),
          startedAt: new Date(finishedAt.getTime() - wallMs),
          finishedAt,
          snapshot: { document } as never,
          snapshotDigest: `s-${id}`,
        })
        const runIds: Record<string, string> = {}
        for (const [memberId, scenario, activeMs, deleted] of members) {
          runIds[memberId] = await seedRun({ scenario, targetId, finishedAt, activeMs, deleted, suite: { suiteRunId: id, memberId } })
        }
        return { id, runIds }
      }
      const base = await suiteRun(day(10), 60_000, [['m_login', login, 20_000], ['m_q1', query, 30_000], ['m_q2', query, 25_000]])
      const current = await suiteRun(day(1), 90_000, [['m_login', login, 22_000], ['m_q1', query, 50_000, true], ['m_q2', query, 25_000]])
      baseRun = base.id
      currentRun = current.id
      deletedMemberRun = current.runIds.m_q1!
    })

    it('按场景集筛选：只列成员场景，整组墙钟与关键路径近似', async () => {
      const result = await readTargetDurationAnalysis(handle.db, targetId, targetDurationAnalysisQuerySchema.parse({ suiteId }))
      expect(result.scenarios.map((s) => s.scenarioId).sort()).toEqual([login.id, query.id].sort())
      expect(result.suite).toMatchObject({ suiteId, name: '日常巡检集', staged: true, runs: 2, wallP95: 90_000 })
      expect(result.suite!.wallP50).toMatchObject({ current: 60_000, base: null })
      // 已删除的成员运行不进入统计：m_q1 只剩 30s，仍比 m_q2 的 25s 慢
      expect(result.suite!.criticalPath.map((m) => [m.memberId, m.p50])).toEqual([
        ['m_login', 20_000],
        ['m_q1', 30_000],
      ])
      expect(result.suite!.criticalPathP50).toBe(50_000)
    })

    it('场景集不属于该目标系统时拒绝', async () => {
      const elsewhere = await newTarget('别的目标')
      await expect(readTargetDurationAnalysis(handle.db, elsewhere, targetDurationAnalysisQuerySchema.parse({ suiteId }))).rejects.toMatchObject({ code: 'SUITE_NOT_FOUND' })
    })

    it('场景集运行对比上一次：成员运行事后被删除也计入当次耗时，只是不给跳转', async () => {
      const readout = await readSuiteRunDuration(handle.db, currentRun)
      expect(readout.base?.id).toBe(baseRun)
      expect(readout.wallDeltaMs).toBe(30_000)
      expect(readout.criticalPathDeltaMs).toBe(22_000 + 50_000 - (20_000 + 30_000))
      const q1 = readout.members.find((m) => m.memberId === 'm_q1')
      expect(q1).toMatchObject({ runId: null, totalMs: 50_000, baseTotalMs: 30_000, deltaMs: 20_000, onCriticalPath: true })
      expect(q1?.baseRunId).not.toBeNull()
      expect(readout.members.find((m) => m.memberId === 'm_q2')).toMatchObject({ name: '查询复核', onCriticalPath: false })
      expect(readout.members.some((m) => m.runId === deletedMemberRun)).toBe(false)
      expect(readout.summary).toContain('本次比上次慢 30s')
      expect(readout.summary).toContain(`『${query.name}』+20s`)

      const first = await readSuiteRunDuration(handle.db, baseRun)
      expect(first).toMatchObject({ base: null, wallDeltaMs: null, summary: '没有更早完成的场景集运行可对比' })
    })
    it('顺序执行的成员排队从前一个成员结束起算，不把等前一个成员的时间算成排队', async () => {
      const { scenarioSuites, scenarioSuiteVersions, suiteRuns } = schemaFor(handle.db)
      const document = suiteDocumentSchema.parse({
        schemaVersion: 1,
        executionMode: 'sequential',
        members: [
          { memberId: 'm_a', ordinal: 0, scenarioId: login.id, scenarioVersionId: login.latestVersionId },
          { memberId: 'm_b', ordinal: 1, scenarioId: query.id, scenarioVersionId: query.latestVersionId },
        ],
      })
      const serialSuite = newId()
      await handle.db.insert(scenarioSuites).values({ id: serialSuite, targetId, name: '顺序巡检集', executionMode: 'sequential', createdByConsoleAccountId: actorId })
      const versionId = newId()
      await handle.db.insert(scenarioSuiteVersions).values({ id: versionId, suiteId: serialSuite, versionNo: 1, document, digest: `d-${versionId}`, publishedByConsoleAccountId: actorId })
      // 两个子运行都在 T0 创建：m_a 1s 后开跑跑 20s；m_b 在 m_a 结束 3s 后开跑跑 30s
      const t0 = day(2).getTime()
      // 更早一次只跑了 m_a（m_b 是后来加进来的成员）
      const earlier = newId()
      await handle.db.insert(suiteRuns).values({
        id: earlier,
        suiteId: serialSuite,
        suiteVersionId: versionId,
        targetId,
        createdByConsoleAccountId: actorId,
        status: 'COMPLETED',
        failurePolicy: 'continue',
        executionMode: 'sequential',
        deadlineAt: new Date(t0),
        startedAt: new Date(t0 - HOUR),
        finishedAt: new Date(t0 - HOUR + 21_000),
        snapshot: { document } as never,
        snapshotDigest: `s-${earlier}`,
      })
      await seedRun({ scenario: login, targetId, createdAt: new Date(t0 - HOUR), finishedAt: new Date(t0 - HOUR + 21_000), activeMs: 20_000, suite: { suiteRunId: earlier, memberId: 'm_a' } })
      const id = newId()
      await handle.db.insert(suiteRuns).values({
        id,
        suiteId: serialSuite,
        suiteVersionId: versionId,
        targetId,
        createdByConsoleAccountId: actorId,
        status: 'COMPLETED',
        failurePolicy: 'continue',
        executionMode: 'sequential',
        deadlineAt: new Date(t0 + DAY),
        startedAt: new Date(t0),
        finishedAt: new Date(t0 + 54_000),
        snapshot: { document } as never,
        snapshotDigest: `s-${id}`,
      })
      await seedRun({ scenario: login, targetId, createdAt: new Date(t0), finishedAt: new Date(t0 + 21_000), activeMs: 20_000, suite: { suiteRunId: id, memberId: 'm_a' } })
      await seedRun({ scenario: query, targetId, createdAt: new Date(t0), finishedAt: new Date(t0 + 54_000), activeMs: 30_000, suite: { suiteRunId: id, memberId: 'm_b' } })

      const readout = await readSuiteRunDuration(handle.db, id)
      expect(readout.members.map((m) => [m.memberId, m.queueMs])).toEqual([
        ['m_a', 1_000],
        ['m_b', 3_000],
      ])
      expect(readout.base?.id).toBe(earlier)
      expect(readout.criticalPathDeltaMs).toBe(30_000)
      // 上次没有的成员整段计入关键路径差值，摘要要点名
      expect(readout.summary).toContain(`新增『${query.name}』30s`)
      const summary = await readTargetDurationAnalysis(handle.db, targetId, targetDurationAnalysisQuerySchema.parse({ suiteId: serialSuite }))
      // 成员排队中位数（最近秩）取 1s 与 3s 中的 1s，而不是把 m_b 等 m_a 的 24s 算进去
      expect(summary.suite?.memberQueueP50).toBe(1_000)
      expect(summary.suite?.criticalPathP50).toBe(50_000)
    })

    it('场景的开跑前排队只统计非场景集运行', async () => {
      const result = await readScenarioDurationAnalysis(handle.db, query.id, durationAnalysisQuerySchema.parse({}))
      expect(result.kpis.queueP50).toMatchObject({ current: null, currentSamples: 0 })
      await seedRun({ scenario: query, targetId, finishedAt: day(1, 8), activeMs: 30_000, queueMs: 5_000 })
      const withStandalone = await readScenarioDurationAnalysis(handle.db, query.id, durationAnalysisQuerySchema.parse({}))
      expect(withStandalone.kpis.queueP50).toMatchObject({ current: 5_000, currentSamples: 1 })
    })
  })
})
