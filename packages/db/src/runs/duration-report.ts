import { and, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm'
import {
  DURATION_FACTS_CALC_VERSION,
  DURATION_INSIGHT_LABELS,
  DURATION_PERIOD_REPORT_BLOCK,
  DURATION_REPORT_TOP_SCENARIOS,
  DURATION_REPORT_TOP_STEPS,
  DURATION_TARGET_ROW_LIMIT,
  attributeDurationDifference,
  describeDurationTag,
  durationPeriodBaseLabel,
  durationPeriodEnd,
  durationCountsQuantile,
  durationSketchQuantile,
  effectiveSuiteStages,
  shiftLocalDate,
  zonedStartOfDay,
  durationPeriodSelfLabel,
  formatDurationShort,
  summarizeDurationDifference,
  composeActiveDuration,
  type DurationComparison,
  type DurationComparisonSide,
  type DurationInsight,
  type DurationPeriodReportBlock,
  type DurationPeriodReportSubject,
  type DurationReportScenarioMover,
  type DurationReportScenarioRow,
  type DurationReportStepMover,
  type DurationResolutionLevel,
  type DurationVersionBoundary,
  type NodeDurationFacts,
  type TargetDurationScenario,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { clockNow, schemaFor } from '../native.js'
import {
  bucketKeys,
  nodeRowsOf,
  periodWindow,
  scenarioStats,
  targetAnalysisCore,
  type WindowSpec,
} from './duration-analysis.js'
import { loadNodeAggs, loadScenarioAggs, nodeTotalsOf, scenarioTotalsOf, type NodeDayAgg, type ScenarioDayAgg } from './duration-rollup.js'

/**
 * 周期耗时报告的取数与组装。统计全部复用耗时分析读模型（同一组查询），这里只做挑选、排序与成句。
 */

export interface DurationPeriodReportBuild {
  block: DurationPeriodReportBlock
  title: string
  targetName: string
  suiteName: string | null
  from: Date
  to: Date
}

function topKey(counts: ReadonlyMap<string, number> | Record<string, number>): string | null {
  let best: string | null = null
  let bestCount = 0
  for (const [key, count] of counts instanceof Map ? counts : Object.entries(counts)) {
    if (count > bestCount) {
      best = key
      bestCount = count
    }
  }
  return best
}

/** 一期的聚合一侧：运行级各分项取成功样本的中位数，节点取成功节点的中位数。 */
function periodSide(runs: readonly ScenarioDayAgg[], nodes: readonly NodeDayAgg[]): DurationComparisonSide {
  const totals = scenarioTotalsOf(runs)
  const p50 = (key: keyof typeof totals.sketches) => durationSketchQuantile(totals.sketches[key], 50)
  const versions = new Map<string, number>()
  for (const agg of runs) versions.set(agg.scenarioVersionId, (versions.get(agg.scenarioVersionId) ?? 0) + agg.samples)
  const byKey = new Map<string, NodeDayAgg[]>()
  for (const node of nodes) {
    const list = byKey.get(node.nodeKey)
    if (list) list.push(node)
    else byKey.set(node.nodeKey, [node])
  }
  return {
    facts: {
      totalMs: p50('total'),
      activeMs: p50('active'),
      authWaitMs: p50('authWait'),
      requeueMs: p50('requeue'),
      reviewMs: p50('review'),
      holdMs: null,
      unclassifiedMs: null,
      queueMs: p50('queue'),
      overheadMs: p50('overhead'),
      complete: true,
      workerLost: false,
      scenarioVersionId: totals.samples > 0 ? topKey(versions) : null,
    },
    nodes: [...byKey.values()].flatMap((list): NodeDurationFacts[] => {
      const t = nodeTotalsOf(list)
      if (t.ok === 0) return []
      const latest = list.reduce((best, node) => (node.lastFinishedAt > best.lastFinishedAt ? node : best))
      const resolution = topKey(t.resolutions)
      const activeMs = durationSketchQuantile(t.sketches.active, 50) ?? 0
      const modelMs = durationSketchQuantile(t.sketches.model, 50) ?? 0
      const pageMs = durationSketchQuantile(t.sketches.page, 50)
      return [
        {
          nodeKey: latest.nodeKey,
          parentKey: latest.parentKey,
          kind: latest.kind,
          name: latest.name,
          ordinal: latest.ordinal,
          status: 'SUCCEEDED',
          activeMs,
          windowMs: null,
          attemptCount: durationCountsQuantile(t.counts.attempt, 50) ?? 0,
          iterationCount: durationCountsQuantile(t.counts.iteration, 50) ?? 0,
          maxResolution: (resolution === null || resolution === 'none' ? null : resolution) as DurationResolutionLevel | null,
          ...composeActiveDuration({ activeMs, modelMs, pageMs, overlapMs: 0 }),
          modelCallCount: 0,
          pageWaitCount: 0,
          pagePartial: false,
          compositionComplete: true,
          compositionIncompleteReasons: [],
        },
      ]
    }),
  }
}

function signed(ms: number): string {
  return `${ms < 0 ? '−' : '+'}${formatDurationShort(ms)}`
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    const list = map.get(k) ?? []
    list.push(item)
    map.set(k, list)
  }
  return map
}

function monthDay(iso: string, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, month: 'numeric', day: 'numeric' }).formatToParts(new Date(iso))
  const get = (type: string) => parts.find((part) => part.type === type)?.value
  return `${get('month')}/${get('day')}`
}

/** 变慢 / 变快场景的原因：两期中位数差异归因的摘要 + 贡献最大的步骤 + 期内发布与其它线索。 */
function scenarioMover(
  scenario: TargetDurationScenario,
  runs: { current: ScenarioDayAgg[]; base: ScenarioDayAgg[] },
  nodes: { current: NodeDayAgg[]; base: NodeDayAgg[] },
  boundaries: DurationVersionBoundary[],
  labels: { target: string; base: string },
  tz: string,
): DurationReportScenarioMover {
  const attribution = attributeDurationDifference(periodSide(runs.base, nodes.base), periodSide(runs.current, nodes.current))
  const direction = Math.sign(scenario.activeP50.deltaPct ?? 0)
  const causes: string[] = attribution.nodes
    .filter((node) => node.parentKey === null && node.deltaMs !== null && Math.sign(node.deltaMs) === direction && Math.abs(node.deltaMs) >= 1_000)
    .slice(0, 2)
    .map((node) => {
      const tags = node.tags.map(describeDurationTag)
      return `『${node.name}』${signed(node.deltaMs!)}${tags.length ? `（${tags.join('，')}）` : ''}`
    })
  for (const boundary of boundaries) causes.push(`期内发布${boundary.versionNo ? ` v${boundary.versionNo}` : '新版本'}（${monthDay(boundary.at, tz)}）`)
  for (const insight of scenario.insights) {
    if (insight.kind === 'slower' || insight.kind === 'faster') continue
    causes.push(`${DURATION_INSIGHT_LABELS[insight.kind]}：${insight.message}`)
  }
  return {
    scenarioId: scenario.scenarioId,
    name: scenario.name,
    current: scenario.activeP50.current,
    base: scenario.activeP50.base,
    deltaPct: scenario.activeP50.deltaPct,
    samples: scenario.activeP50.currentSamples,
    baseSamples: scenario.activeP50.baseSamples,
    summary: summarizeDurationDifference(attribution, labels),
    causes: causes.slice(0, 5),
  }
}

async function triggerCounts(db: Db, targetId: string, scenarioIds: string[], spec: WindowSpec) {
  const counts = { manual: 0, schedule: 0, service: 0 }
  if (scenarioIds.length === 0) return counts
  const { runDurationFacts: f, runs } = schemaFor(db)
  const rows = await db
    .select({ trigger: f.triggerSource, count: sql<number | string>`count(*)` })
    .from(f)
    .innerJoin(runs, eq(runs.id, f.runId))
    .where(and(eq(f.targetId, targetId), inArray(f.scenarioId, scenarioIds), eq(f.comparable, true), isNull(runs.deletedAt), gte(f.finishedAt, spec.from), lt(f.finishedAt, spec.to)))
    .groupBy(f.triggerSource)
  for (const row of rows) counts[row.trigger] = Number(row.count)
  return counts
}

/** 期内已完成、但耗时事实还没写入（或规则版本落后）的运行数：报告附录如实写明。 */
async function pendingFactRuns(db: Db, targetId: string, scenarioIds: string[], spec: { from: Date; to: Date }): Promise<number> {
  if (scenarioIds.length === 0) return 0
  const { runDurationFacts: f, runs } = schemaFor(db)
  const [row] = await db
    .select({ count: sql<number | string>`count(*)` })
    .from(runs)
    .leftJoin(f, eq(f.runId, runs.id))
    .where(
      and(
        eq(runs.targetId, targetId),
        inArray(runs.scenarioId, scenarioIds),
        isNull(runs.deletedAt),
        inArray(runs.status, ['SUCCEEDED', 'FAILED', 'CANCELLED']),
        gte(runs.finishedAt, spec.from),
        lt(runs.finishedAt, spec.to),
        or(isNull(f.runId), lt(f.calcVersion, DURATION_FACTS_CALC_VERSION)),
      ),
    )
  return Number(row?.count ?? 0)
}

function pct(value: number): string {
  return `${Math.abs(value)}%`
}

function conclusionOf(input: {
  self: string
  baseLabel: string
  runs: number
  activeP50: DurationComparison
  activeP50Yoy: DurationComparison | null
  yoyLabel: string | null
  waitRatio: DurationComparison
  slower: DurationReportScenarioMover[]
  faster: DurationReportScenarioMover[]
  slowerCount: number
  fasterCount: number
  insightCount: number
}): string[] {
  const lines: string[] = []
  const { activeP50 } = input
  if (input.runs === 0) return [`${input.self}没有可比运行。`]
  if (activeP50.current === null) {
    lines.push(`${input.self}共 ${input.runs} 次可比运行，没有成功运行可统计执行耗时。`)
  } else if (activeP50.deltaPct === null) {
    lines.push(`${input.self}整体执行耗时 P50 为 ${formatDurationShort(activeP50.current)}（样本不足或${input.baseLabel}无数据，不做对比）。`)
  } else if (Math.abs(activeP50.deltaPct) < 5) {
    lines.push(`${input.self}整体执行耗时 P50 为 ${formatDurationShort(activeP50.current)}，与${input.baseLabel}基本持平（${activeP50.deltaPct > 0 ? '+' : ''}${activeP50.deltaPct}%）。`)
  } else {
    lines.push(`${input.self}整体执行耗时 P50 为 ${formatDurationShort(activeP50.current)}，比${input.baseLabel}${activeP50.deltaPct > 0 ? '慢' : '快'} ${pct(activeP50.deltaPct)}。`)
  }
  const yoy = input.activeP50Yoy
  if (yoy && yoy.deltaPct !== null && input.yoyLabel) {
    lines.push(`与${input.yoyLabel}相比${yoy.deltaPct > 0 ? '慢' : '快'} ${pct(yoy.deltaPct)}。`)
  }
  const names = (list: DurationReportScenarioMover[]) =>
    list.slice(0, 2).map((m) => `『${m.name}』（${m.deltaPct! > 0 ? '+' : ''}${m.deltaPct}%）`).join('、')
  if (input.slowerCount > 0) lines.push(`明显变慢 ${input.slowerCount} 个场景，最突出的是${names(input.slower)}。`)
  if (input.fasterCount > 0) lines.push(`明显变快 ${input.fasterCount} 个场景：${names(input.faster)}。`)
  if (input.waitRatio.deltaPct !== null && input.waitRatio.deltaPct >= 10) {
    lines.push(`等待占比上升 ${input.waitRatio.deltaPct} 个百分点，多半与账号会话、人工登录或执行节点有关，而非页面。`)
  }
  if (input.insightCount > 0) lines.push(`共标注 ${input.insightCount} 项隐藏问题，见下文清单。`)
  return lines.slice(0, 6)
}

export async function buildDurationPeriodReport(db: Db, subject: DurationPeriodReportSubject): Promise<DurationPeriodReportBuild> {
  const now = await clockNow(db)
  const spec = periodWindow(subject.period, subject.periodStart, 'prev_period', subject.timeZone, subject.trigger, now)
  const yoySpec = periodWindow(subject.period, subject.periodStart, 'last_year', subject.timeZone, subject.trigger, now)
  const core = await targetAnalysisCore(db, subject.targetId, spec, subject.suiteId)
  // 同比只需要去年同期这一侧：本期沿用 core，不再整套重算
  const aggScope = { scenarioIds: core.scenarioIds, trigger: spec.trigger, timeZone: spec.tz, rawLimit: DURATION_TARGET_ROW_LIMIT }
  const yoyBase = await loadScenarioAggs(db, { ...aggScope, range: { from: yoySpec.baseFrom, to: yoySpec.baseTo }, fields: ['active'] })
  const self = durationPeriodSelfLabel(subject.period)
  const baseLabel = spec.baseLabel ?? durationPeriodBaseLabel(subject.period, 'prev_period')
  const yoyLabel = yoySpec.baseLabel
  const keys = bucketKeys(spec)

  // 节点：跨场景取顶层节点，按场景分组后复用节点表的统计（P50、涨跌、重试率、隐藏问题）
  const nodeScope = { scenarioIds: core.scenarioIds, trigger: spec.trigger, timeZone: spec.tz }
  const [nodeCurrent, nodeBase] = await Promise.all([
    loadNodeAggs(db, { ...nodeScope, range: { from: spec.from, to: spec.to } }),
    loadNodeAggs(db, { ...nodeScope, range: { from: spec.baseFrom, to: spec.baseTo } }),
  ])
  const nodesNow = groupBy(nodeCurrent, (n) => n.scenarioId)
  const nodesBefore = groupBy(nodeBase, (n) => n.scenarioId)
  const runsNow = groupBy(core.current, (r) => r.scenarioId)
  const runsBefore = groupBy(core.base, (r) => r.scenarioId)

  const stepMovers: DurationReportStepMover[] = []
  const nodeInsights: DurationInsight[] = []
  for (const scenarioId of core.scenarioIds) {
    const name = core.scenarioNames.get(scenarioId) ?? scenarioId
    const { rows, insights } = nodeRowsOf(
      { id: scenarioId, name },
      nodesNow.get(scenarioId) ?? [],
      nodesBefore.get(scenarioId) ?? [],
      (runsBefore.get(scenarioId) ?? []).length > 0,
      keys,
      spec,
    )
    nodeInsights.push(...insights)
    for (const row of rows) {
      if (row.parentKey !== null || row.deltaPct === null || row.deltaPct < 20) continue
      const causes = row.insights
        .filter((insight) => insight.kind !== 'slower' && insight.kind !== 'faster')
        .map((insight) => `${DURATION_INSIGHT_LABELS[insight.kind]}：${insight.message}`)
      if (row.retryRate !== null && row.retryRate >= 0.1) causes.push(`重试率 ${Math.round(row.retryRate * 100)}%`)
      if (row.avgIterations !== null && row.avgIterations > 1) causes.push(`平均迭代 ${row.avgIterations} 次`)
      stepMovers.push({
        scenarioId,
        scenarioName: name,
        nodeKey: row.nodeKey,
        name: row.name,
        kind: row.kind,
        current: row.activeP50,
        base: row.baseP50,
        deltaPct: row.deltaPct,
        samples: row.samples,
        baseSamples: row.baseSamples,
        causes: causes.slice(0, 4),
      })
    }
  }
  stepMovers.sort((a, b) => (b.deltaPct ?? 0) - (a.deltaPct ?? 0))

  // 场景：与页面同一判定（隐藏问题里的「明显变慢 / 变快」）
  const scenarios = core.dto.scenarios
  const slowerAll = scenarios.filter((s) => s.insights.some((i) => i.kind === 'slower')).sort((a, b) => (b.activeP50.deltaPct ?? 0) - (a.activeP50.deltaPct ?? 0))
  const fasterAll = scenarios.filter((s) => s.insights.some((i) => i.kind === 'faster')).sort((a, b) => (a.activeP50.deltaPct ?? 0) - (b.activeP50.deltaPct ?? 0))
  const top = [...slowerAll.slice(0, DURATION_REPORT_TOP_SCENARIOS), ...fasterAll.slice(0, DURATION_REPORT_TOP_SCENARIOS)]
  // 归因要用总耗时与各项等待的草图：只为上榜场景另读这几列
  const moverScope = { ...aggScope, scenarioIds: [...new Set(top.map((s) => s.scenarioId))], fields: ['active', 'overhead', 'detail'] as const }
  const [moverNow, moverBefore] = await Promise.all([
    loadScenarioAggs(db, { ...moverScope, range: { from: spec.from, to: spec.to } }),
    loadScenarioAggs(db, { ...moverScope, range: { from: spec.baseFrom, to: spec.baseTo } }),
  ])
  const moverRunsNow = groupBy(moverNow.aggs, (r) => r.scenarioId)
  const moverRunsBefore = groupBy(moverBefore.aggs, (r) => r.scenarioId)
  const moverOf = (scenario: TargetDurationScenario) =>
    scenarioMover(
      scenario,
      { current: moverRunsNow.get(scenario.scenarioId) ?? [], base: moverRunsBefore.get(scenario.scenarioId) ?? [] },
      { current: nodesNow.get(scenario.scenarioId) ?? [], base: nodesBefore.get(scenario.scenarioId) ?? [] },
      core.boundaries.get(scenario.scenarioId) ?? [],
      { target: self, base: baseLabel },
      subject.timeZone,
    )
  const slower = slowerAll.slice(0, DURATION_REPORT_TOP_SCENARIOS).map(moverOf)
  const faster = fasterAll.slice(0, DURATION_REPORT_TOP_SCENARIOS).map(moverOf)

  const insights = [...scenarios.flatMap((s) => s.insights), ...nodeInsights].sort((a, b) => a.scenarioName.localeCompare(b.scenarioName, 'zh-CN'))
  const yoyBefore = groupBy(yoyBase.aggs, (r) => r.scenarioId)
  const yoyDeltaOf = (scenarioId: string) => scenarioStats(runsNow.get(scenarioId) ?? [], yoyBefore.get(scenarioId) ?? [], []).activeP50.deltaPct
  const rows: DurationReportScenarioRow[] = scenarios
    .map((scenario) => {
      const current = scenarioTotalsOf(runsNow.get(scenario.scenarioId) ?? [])
      return {
        scenarioId: scenario.scenarioId,
        name: scenario.name,
        runs: scenario.runs,
        succeeded: current.succeeded,
        samples: scenario.samples,
        activeP50: scenario.activeP50.current,
        activeP95: scenario.activeP95,
        deltaPct: scenario.activeP50.deltaPct,
        yoyDeltaPct: subject.period === 'month' ? yoyDeltaOf(scenario.scenarioId) : null,
        waitRatio: current.totalSumMs > 0 ? current.waitSumMs / current.totalSumMs : null,
        series: scenario.series.map((point) => point.p50),
        insightCount: scenario.insights.length + nodeInsights.filter((i) => i.scenarioId === scenario.scenarioId).length,
      }
    })
    .sort((a, b) => Number(b.runs > 0) - Number(a.runs > 0) || a.name.localeCompare(b.name, 'zh-CN'))

  const all = scenarioStats(core.current, core.base, [])
  const allYoy = scenarioStats(core.current, yoyBase.aggs, [])
  const activeP50Yoy = allYoy.activeP50
  const triggers = await triggerCounts(db, subject.targetId, core.scenarioIds, spec)
  const pending = await pendingFactRuns(db, subject.targetId, core.scenarioIds, spec)

  const gaps: string[] = []
  if (pending > 0) gaps.push(`有 ${pending} 次运行的耗时尚未计算，未计入本报告`)
  if (core.dto.truncated) gaps.push('运行过多，统计只取了最近的运行')
  if (core.dto.aggregation.settling) gaps.push('有运行的耗时汇总仍在整理，本报告可能少计最近完成的运行')
  if (core.base.length === 0 && core.current.length > 0) gaps.push(`${baseLabel}没有可比运行，不做对比`)
  if (all.activeP50.currentSamples > 0 && all.activeP50.currentSamples < spec.minSamples) gaps.push(`${self}成功样本少于 ${spec.minSamples} 次，不给涨跌`)

  const kpis: DurationPeriodReportBlock['kpis'] = {
    runs: all.totals.runs,
    succeeded: all.totals.succeeded,
    failed: all.totals.failed,
    activeP50: all.activeP50,
    activeP50Yoy,
    activeP95: all.activeP95,
    waitRatio: all.waitRatio,
    queueP50: all.queueP50,
    slower: slowerAll.length,
    faster: fasterAll.length,
    insightCount: insights.length,
    triggers,
  }

  const targetName = core.dto.target.name
  const suiteName = core.suiteName
  const params = new URLSearchParams({ targetId: subject.targetId, ...(subject.suiteId ? { suiteId: subject.suiteId } : {}), period: subject.period, periodStart: subject.periodStart, ...(subject.trigger !== 'all' ? { trigger: subject.trigger } : {}) })
  const block: DurationPeriodReportBlock = {
    type: DURATION_PERIOD_REPORT_BLOCK,
    version: 1,
    target: { id: subject.targetId, name: targetName },
    suite: subject.suiteId && suiteName ? { id: subject.suiteId, name: suiteName } : null,
    period: { kind: subject.period, start: spec.periodStart!, end: spec.periodEnd!, label: spec.periodLabel!, timeZone: subject.timeZone },
    trigger: subject.trigger,
    comparisons: [
      { mode: 'prev_period', label: baseLabel, start: localStart(spec.baseFrom, subject.timeZone), end: localStart(spec.baseTo, subject.timeZone) },
      ...(yoyLabel ? [{ mode: 'last_year' as const, label: yoyLabel, start: localStart(yoySpec.baseFrom, subject.timeZone), end: localStart(yoySpec.baseTo, subject.timeZone) }] : []),
    ],
    kpis,
    conclusion: conclusionOf({
      self,
      baseLabel,
      runs: kpis.runs,
      activeP50: kpis.activeP50,
      activeP50Yoy: subject.period === 'month' ? activeP50Yoy : null,
      yoyLabel,
      waitRatio: kpis.waitRatio,
      slower,
      faster,
      slowerCount: kpis.slower,
      fasterCount: kpis.faster,
      insightCount: kpis.insightCount,
    }),
    slower,
    faster,
    slowerSteps: stepMovers.slice(0, DURATION_REPORT_TOP_STEPS),
    insights,
    buckets: keys,
    scenarios: rows,
    suiteSummary: core.dto.suite,
    gaps,
    consolePath: `/duration-analysis?${params.toString()}`,
  }
  const title = `${targetName}${suiteName ? ` · ${suiteName}` : ''} 耗时${subject.period === 'week' ? '周报' : '月报'} · ${spec.periodLabel}`
  return { block, title, targetName, suiteName, from: spec.from, to: spec.to }
}

function localStart(instant: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant)
}

/** 某期内已完成但耗时事实未写入的运行数（订阅生成前据此等待事实追平）。 */
export async function pendingFactRunsInPeriod(db: Db, subject: DurationPeriodReportSubject): Promise<number> {
  const { scenarios, scenarioSuiteVersions } = schemaFor(db)
  let ids = (await db.select({ id: scenarios.id }).from(scenarios).where(and(eq(scenarios.targetId, subject.targetId), isNull(scenarios.deletedAt)))).map((row) => row.id)
  if (subject.suiteId) {
    const [version] = await db
      .select({ document: scenarioSuiteVersions.document })
      .from(scenarioSuiteVersions)
      .where(eq(scenarioSuiteVersions.suiteId, subject.suiteId))
      .orderBy(desc(scenarioSuiteVersions.versionNo))
      .limit(1)
    const members = new Set(version ? effectiveSuiteStages(version.document).flatMap((stage) => stage.members.map((m) => m.scenarioId)) : [])
    ids = ids.filter((id) => members.has(id))
  }
  const end = durationPeriodEnd(subject.period, subject.periodStart)
  const from = zonedStartOfDay(subject.periodStart, subject.timeZone)
  const to = zonedStartOfDay(end, subject.timeZone)
  const pendingFacts = await pendingFactRuns(db, subject.targetId, ids, { from, to })
  if (ids.length === 0) return pendingFacts
  // 事实已写入、但按天汇总还没重算的天也要等：否则报告会按旧汇总生成
  const { durationRollupDirty: d } = schemaFor(db)
  const [dirty] = await db
    .select({ count: sql<number | string>`count(*)` })
    .from(d)
    .where(and(inArray(d.scenarioId, ids), gte(d.statDay, subject.periodStart), lte(d.statDay, shiftLocalDate(end, -1))))
  return pendingFacts + Number(dirty?.count ?? 0)
}
