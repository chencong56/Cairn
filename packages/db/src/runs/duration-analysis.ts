import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, type SQL } from 'drizzle-orm'
import {
  DURATION_MIN_SAMPLES,
  DURATION_RUN_ROW_LIMIT,
  DURATION_TARGET_ROW_LIMIT,
  attributeDurationDifference,
  detectNodeInsights,
  durationPeriodBaseLabel,
  durationPeriodBaseStart,
  durationPeriodEnd,
  durationPeriodLabel,
  durationCountsQuantile,
  durationSketchQuantile,
  isDurationPeriodStart,
  lastCompleteDurationPeriodStart,
  localDateOf,
  shiftLocalDate,
  shiftLocalMonth,
  zonedStartOfDay,
  detectScenarioInsights,
  durationDeltaPct,
  durationPercentile,
  effectiveSuiteStages,
  formatDurationShort,
  ratioPointsDelta,
  summarizeDurationDifference,
  type DurationAnalysisQueryParsed,
  type DurationComparison,
  type DurationComparisonSide,
  type DurationInsight,
  type DurationNodeRow,
  type DurationPeriodCompare,
  type DurationPeriodKind,
  type DurationResolutionLevel,
  type DurationSketch,
  type DurationVersionBoundary,
  type DurationWindow,
  type NodeDurationChildren,
  type NodeDurationChildrenQueryParsed,
  type NodeDurationFacts,
  type NodeDurationHistory,
  type NodeDurationHistoryQueryParsed,
  type RunDurationQueryParsed,
  type RunDurationReadout,
  type RunDurationUnavailableReason,
  type ScenarioDurationAnalysis,
  type ScenarioDurationBucket,
  type SuiteDocument,
  type SuiteDurationSummary,
  type SuiteRunDurationReadout,
  type TargetDurationAnalysis,
  type TargetDurationAnalysisQueryParsed,
  type TargetDurationScenario,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { clockNow, schemaFor } from '../native.js'
import { readRunDurationFacts } from './duration-facts.js'
import {
  loadNodeAggs,
  loadNodeFactRows,
  loadRunFactRows,
  loadScenarioAggs,
  nodeTotalsOf,
  scenarioTotalsOf,
  statisticsTimeZone,
  type AggregateSource,
  type NodeDayAgg,
  type NodeSample,
  type RunSample,
  type ScenarioDayAgg,
} from './duration-rollup.js'
import { badRequest, notFound } from './errors.js'

export type { NodeSample, RunSample } from './duration-rollup.js'

const DAY_MS = 24 * 60 * 60 * 1000
const FINISHED = ['SUCCEEDED', 'FAILED', 'CANCELLED'] as const

// ---------------------------------------------------------------------------
// 时间窗与分桶（按本地日期切，避免 UTC 把一天切成两半）
// ---------------------------------------------------------------------------

export interface WindowSpec extends Omit<DurationWindow, 'from' | 'to' | 'baseFrom' | 'baseTo'> {
  from: Date
  to: Date
  baseFrom: Date
  baseTo: Date
}

function validTimeZone(tz: string | undefined, fallback: string): string {
  if (!tz) return fallback
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz })
    return tz
  } catch {
    return fallback
  }
}

const NO_PERIOD = { period: null, periodStart: null, periodEnd: null, periodLabel: null, baseLabel: null } as const

/** 自然周期窗口：当前周期与对比周期都按时区的本地日历切分，按天分桶。周期须已结束。 */
export function periodWindow(
  kind: DurationPeriodKind,
  start: string,
  compare: DurationPeriodCompare,
  tz: string,
  trigger: DurationAnalysisQueryParsed['trigger'],
  now: Date,
): WindowSpec {
  if (!isDurationPeriodStart(kind, start)) throw badRequest('DURATION_PERIOD_INVALID', kind === 'week' ? '周期起点须为周一' : '周期起点须为每月 1 日')
  const end = durationPeriodEnd(kind, start)
  const from = zonedStartOfDay(start, tz)
  const to = zonedStartOfDay(end, tz)
  if (to.getTime() > now.getTime()) throw badRequest('DURATION_PERIOD_NOT_ENDED', '只能查看已结束的周期')
  const baseStart = durationPeriodBaseStart(kind, start, compare)
  return {
    from,
    to,
    baseFrom: zonedStartOfDay(baseStart, tz),
    baseTo: zonedStartOfDay(durationPeriodEnd(kind, baseStart), tz),
    days: Math.round((to.getTime() - from.getTime()) / DAY_MS),
    granularity: 'day',
    compare,
    trigger,
    tz,
    minSamples: DURATION_MIN_SAMPLES,
    period: kind,
    periodStart: start,
    periodEnd: end,
    periodLabel: durationPeriodLabel(kind, start),
    baseLabel: durationPeriodBaseLabel(kind, compare),
  }
}

/**
 * 时间窗按本地日历整天切分（与按天汇总对齐）：「近 N 天」= 今天在内的 N 个本地日，到此刻为止；
 * 对比期是同样的整天区间（上一期、上周 / 上月 / 去年同期的对应日期）。不传时区时用平台统计时区。
 */
function resolveWindow(now: Date, query: DurationAnalysisQueryParsed, statisticsTz: string): WindowSpec {
  const tz = validTimeZone(query.tz, statisticsTz)
  if (query.period) {
    if (query.compare !== 'prev_period' && query.compare !== 'last_year') {
      throw badRequest('DURATION_PERIOD_COMPARE_INVALID', '自然周期只支持环比（上一周期）或去年同期')
    }
    return periodWindow(query.period, query.periodStart ?? lastCompleteDurationPeriodStart(query.period, now, tz), query.compare, tz, query.trigger, now)
  }
  const days = query.days
  const today = localDateOf(now, tz)
  const fromDay = shiftLocalDate(today, -(days - 1))
  const endDay = shiftLocalDate(today, 1)
  let baseFromDay: string
  let baseEndDay: string
  switch (query.compare) {
    case 'last_week':
      baseFromDay = shiftLocalDate(fromDay, -7)
      baseEndDay = shiftLocalDate(endDay, -7)
      break
    case 'last_month':
      baseFromDay = shiftLocalMonth(fromDay, -1)
      baseEndDay = shiftLocalMonth(endDay, -1)
      break
    case 'last_year':
      baseFromDay = shiftLocalMonth(fromDay, -12)
      baseEndDay = shiftLocalMonth(endDay, -12)
      break
    default:
      baseFromDay = shiftLocalDate(fromDay, -days)
      baseEndDay = fromDay
  }
  return {
    from: zonedStartOfDay(fromDay, tz),
    to: now,
    baseFrom: zonedStartOfDay(baseFromDay, tz),
    baseTo: zonedStartOfDay(baseEndDay, tz),
    days,
    granularity: days === 7 ? 'day' : query.granularity,
    compare: query.compare,
    trigger: query.trigger,
    tz,
    minSamples: DURATION_MIN_SAMPLES,
    ...NO_PERIOD,
  }
}

async function windowFor(db: Db, query: DurationAnalysisQueryParsed): Promise<WindowSpec> {
  const [now, statisticsTz] = await Promise.all([clockNow(db), statisticsTimeZone(db)])
  return resolveWindow(now, query, statisticsTz)
}

function windowDto(spec: WindowSpec): DurationWindow {
  return { ...spec, from: spec.from.toISOString(), to: spec.to.toISOString(), baseFrom: spec.baseFrom.toISOString(), baseTo: spec.baseTo.toISOString() }
}

function dayToUtc(day: string): number {
  const [y, m, d] = day.split('-').map(Number)
  return Date.UTC(y!, m! - 1, d!)
}

function utcToDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** 统计日所在的桶：按天就是这一天，按周是该周周一。 */
export function bucketOfDay(day: string, spec: Pick<WindowSpec, 'granularity'>): string {
  if (spec.granularity === 'day') return day
  const ms = dayToUtc(day)
  const weekday = new Date(ms).getUTCDay()
  return utcToDay(ms - ((weekday + 6) % 7) * DAY_MS)
}

export function bucketOf(date: Date, spec: WindowSpec): string {
  return bucketOfDay(localDateOf(date, spec.tz), spec)
}

export function bucketKeys(spec: WindowSpec): string[] {
  const keys: string[] = []
  const first = dayToUtc(localDateOf(spec.from, spec.tz))
  // 窗口右端不含：自然周期的结束时刻是下一天 00:00，不能多出一个空桶
  const last = dayToUtc(localDateOf(new Date(spec.to.getTime() - 1), spec.tz))
  for (let ms = first; ms <= last; ms += DAY_MS) {
    const key = bucketOf(new Date(ms + 12 * 60 * 60 * 1000), { ...spec, tz: 'UTC' })
    if (keys.at(-1) !== key) keys.push(key)
  }
  return keys
}

// ---------------------------------------------------------------------------
// 统计小工具
// ---------------------------------------------------------------------------

export function sortedOf(values: Array<number | null | undefined>): number[] {
  return values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b)
}

export function median(values: Array<number | null | undefined>): number | null {
  return durationPercentile(sortedOf(values), 50)
}

function compare(current: Array<number | null>, base: Array<number | null>, p: number): DurationComparison {
  const now = sortedOf(current)
  const before = sortedOf(base)
  const c = durationPercentile(now, p)
  const b = durationPercentile(before, p)
  return { current: c, base: b, deltaPct: durationDeltaPct(c, b, now.length, before.length), currentSamples: now.length, baseSamples: before.length }
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null
}

function ratioComparison(current: { value: number | null; samples: number }, base: { value: number | null; samples: number }): DurationComparison {
  return {
    current: current.value,
    base: base.value,
    deltaPct: ratioPointsDelta(current.value, base.value, current.samples, base.samples),
    currentSamples: current.samples,
    baseSamples: base.samples,
  }
}

// ---------------------------------------------------------------------------
// 取数
// ---------------------------------------------------------------------------

function triggerPredicate(db: Db, trigger: DurationAnalysisQueryParsed['trigger']): SQL | undefined {
  const { runDurationFacts } = schemaFor(db)
  return trigger === 'all' ? undefined : eq(runDurationFacts.triggerSource, trigger)
}

/** 运行事实明细（场景集成员、单节点历史等小范围读取用）；窗口与发起方过滤，完成时刻倒序，有上限。 */
async function loadRunSamples(
  db: Db,
  scope: SQL,
  range: { from: Date; to: Date },
  trigger: DurationAnalysisQueryParsed['trigger'],
  limit: number,
  comparableOnly = true,
): Promise<{ rows: RunSample[]; truncated: boolean }> {
  const { runDurationFacts: f } = schemaFor(db)
  return loadRunFactRows(
    db,
    and(scope, comparableOnly ? eq(f.comparable, true) : undefined, gte(f.finishedAt, range.from), lt(f.finishedAt, range.to), triggerPredicate(db, trigger)),
    limit,
  )
}

/** 运行明细上的版本分界（单节点历史用）：每个版本在窗口内首次出现的时刻，最早的版本不算发布。 */
async function versionBoundaries(db: Db, rows: RunSample[]): Promise<DurationVersionBoundary[]> {
  const firstSeen = new Map<string, Date>()
  for (const row of rows) {
    const seen = firstSeen.get(row.scenarioVersionId)
    if (!seen || row.finishedAt < seen) firstSeen.set(row.scenarioVersionId, row.finishedAt)
  }
  return (await boundariesFrom(db, new Map([['', firstSeen]]))).get('') ?? []
}

/**
 * 场景日聚合上的版本分界：每个版本在窗口内首次完成的时刻（精确到运行），最早出现的版本不算发布。
 * 旧版本偶尔再跑一次（如手动指定旧版本）不算发布，避免分界线来回跳。所有场景一次查版本号。
 */
async function versionBoundariesByScenario(db: Db, aggs: readonly ScenarioDayAgg[]): Promise<Map<string, DurationVersionBoundary[]>> {
  const firstSeen = new Map<string, Map<string, Date>>()
  for (const agg of aggs) {
    const versions = firstSeen.get(agg.scenarioId) ?? new Map<string, Date>()
    const seen = versions.get(agg.scenarioVersionId)
    if (!seen || agg.firstFinishedAt < seen) versions.set(agg.scenarioVersionId, agg.firstFinishedAt)
    firstSeen.set(agg.scenarioId, versions)
  }
  return boundariesFrom(db, firstSeen)
}

async function boundariesFrom(db: Db, firstSeen: Map<string, Map<string, Date>>): Promise<Map<string, DurationVersionBoundary[]>> {
  const pending = new Map<string, Array<{ at: Date; scenarioVersionId: string }>>()
  for (const [scenarioId, versions] of firstSeen) {
    const ordered = [...versions.entries()].sort((a, b) => a[1].getTime() - b[1].getTime())
    pending.set(
      scenarioId,
      ordered.slice(1).map(([scenarioVersionId, at]) => ({ at, scenarioVersionId })),
    )
  }
  const ids = [...new Set([...pending.values()].flatMap((list) => list.map((b) => b.scenarioVersionId)))]
  const { scenarioVersions } = schemaFor(db)
  const numbers = new Map(
    ids.length
      ? (await db.select({ id: scenarioVersions.id, versionNo: scenarioVersions.versionNo }).from(scenarioVersions).where(inArray(scenarioVersions.id, ids))).map((v) => [v.id, v.versionNo])
      : [],
  )
  return new Map(
    [...pending.entries()].map(([scenarioId, list]) => [
      scenarioId,
      list.map((b) => ({ at: b.at.toISOString(), scenarioVersionId: b.scenarioVersionId, versionNo: numbers.get(b.scenarioVersionId) ?? null })),
    ]),
  )
}

function quantile(sketch: DurationSketch, p: number): number | null {
  return durationSketchQuantile(sketch, p)
}

function sketchCompare(current: DurationSketch, base: DurationSketch, p: number): DurationComparison {
  const c = quantile(current, p)
  const b = quantile(base, p)
  return { current: c, base: b, deltaPct: durationDeltaPct(c, b, current.n, base.n), currentSamples: current.n, baseSamples: base.n }
}

function waitRatioOfTotals(totals: { waitSumMs: number; totalSumMs: number; waitSamples: number }): { value: number | null; samples: number } {
  return { value: rate(totals.waitSumMs, totals.totalSumMs), samples: totals.waitSamples }
}

/** 最近一次发布前后的执行耗时中位数：发布后 = 该版本的样本，发布前 = 其它版本的样本。 */
function versionSplitOf(aggs: readonly ScenarioDayAgg[], boundaries: DurationVersionBoundary[]): ScenarioInsightSplit {
  const last = boundaries.at(-1)
  if (!last) return null
  const after = scenarioTotalsOf(aggs.filter((agg) => agg.scenarioVersionId === last.scenarioVersionId)).sketches.active
  const before = scenarioTotalsOf(aggs.filter((agg) => agg.scenarioVersionId !== last.scenarioVersionId)).sketches.active
  return { before: quantile(before, 50), after: quantile(after, 50), beforeSamples: before.n, afterSamples: after.n, versionNo: last.versionNo }
}
type ScenarioInsightSplit = Parameters<typeof detectScenarioInsights>[1]['versionSplit']

/** 场景（或一组场景）两期的统计：分位数来自草图，等待占比来自分项求和。 */
export function scenarioStats(current: readonly ScenarioDayAgg[], base: readonly ScenarioDayAgg[], boundaries: DurationVersionBoundary[]) {
  const now = scenarioTotalsOf(current)
  const before = scenarioTotalsOf(base)
  return {
    activeP50: sketchCompare(now.sketches.active, before.sketches.active, 50),
    activeP95: sketchCompare(now.sketches.active, before.sketches.active, 95),
    totalP50: sketchCompare(now.sketches.totalOk, before.sketches.totalOk, 50),
    waitRatio: ratioComparison(waitRatioOfTotals(now), waitRatioOfTotals(before)),
    // 场景集成员的「创建到开跑」包含等前序成员 / 阶段的时间，不是排队；成员排队在场景集视图按编排推算
    queueP50: sketchCompare(now.sketches.queueStandalone, before.sketches.queueStandalone, 50),
    overheadP50: sketchCompare(now.sketches.overhead, before.sketches.overhead, 50),
    versionSplit: versionSplitOf(current, boundaries),
    totals: now,
  }
}

/** 按桶合并聚合。 */
function byBucketOf<T extends { statDay: string }>(aggs: readonly T[], spec: Pick<WindowSpec, 'granularity'>): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const agg of aggs) {
    const bucket = bucketOfDay(agg.statDay, spec)
    const list = map.get(bucket)
    if (list) list.push(agg)
    else map.set(bucket, [agg])
  }
  return map
}

function aggregationOf(...loads: AggregateSource[]): { source: 'rollup' | 'raw'; settling: boolean } {
  return { source: loads.some((load) => load.source === 'raw') ? 'raw' : 'rollup', settling: loads.some((load) => load.settling) }
}

// ---------------------------------------------------------------------------
// 单次对比
// ---------------------------------------------------------------------------

function sideOf(readout: { facts: RunDurationReadout['facts']; nodes: NodeDurationFacts[] }, targetAccountId: string | null): DurationComparisonSide {
  return { facts: { ...readout.facts, targetAccountId }, nodes: readout.nodes }
}

function mostCommon<T>(values: T[]): T | null {
  const counts = new Map<T, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  let best: T | null = null
  let bestCount = 0
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value
      bestCount = count
    }
  }
  return best
}

/** 近 N 次的中位数一侧：各分项取中位数，节点按键取中位数。 */
function medianSide(readouts: Array<{ facts: RunDurationReadout['facts']; nodes: NodeDurationFacts[] }>): DurationComparisonSide {
  const pick = (key: keyof RunDurationReadout['facts']) => median(readouts.map((r) => r.facts[key] as number | null))
  const nodes = new Map<string, NodeDurationFacts[]>()
  for (const readout of readouts) {
    for (const node of readout.nodes) {
      const list = nodes.get(node.nodeKey) ?? []
      list.push(node)
      nodes.set(node.nodeKey, list)
    }
  }
  return {
    facts: {
      totalMs: pick('totalMs'),
      activeMs: pick('activeMs'),
      authWaitMs: pick('authWaitMs'),
      requeueMs: pick('requeueMs'),
      reviewMs: pick('reviewMs'),
      holdMs: pick('holdMs'),
      unclassifiedMs: pick('unclassifiedMs'),
      queueMs: pick('queueMs'),
      overheadMs: pick('overheadMs'),
      complete: readouts.every((r) => r.facts.complete),
      workerLost: false,
      scenarioVersionId: mostCommon(readouts.map((r) => r.facts.scenarioVersionId)),
      targetAccountId: null,
    },
    nodes: [...nodes.values()].map((list) => {
      const latest = list[0]!
      return {
        ...latest,
        activeMs: median(list.map((n) => n.activeMs)) ?? 0,
        attemptCount: Math.round(median(list.map((n) => n.attemptCount)) ?? 0),
        iterationCount: Math.round(median(list.map((n) => n.iterationCount)) ?? 0),
        windowMs: median(list.map((n) => n.windowMs)),
        maxResolution: mostCommon(list.map((n) => n.maxResolution)) as DurationResolutionLevel | null,
      }
    }),
  }
}

/**
 * 单次运行的耗时分解与对比。可比运行默认对比同场景上一条可比且成功的运行；
 * 当前是试跑时对比同场景上一条成功的试跑。事实未生成时现算。
 */
export async function readRunDuration(db: Db, runId: string, query: RunDurationQueryParsed): Promise<RunDurationReadout> {
  const current = await readRunDurationFacts(db, runId)
  if (!current) throw notFound('RUN_NOT_FOUND', '运行不存在')
  const { runs, runDurationFacts: f, scenarioVersions } = schemaFor(db)
  const [runRow] = await db
    .select({ targetAccountId: runs.targetAccountId, createdAt: runs.createdAt, finishedAt: runs.finishedAt, versionKind: scenarioVersions.kind })
    .from(runs)
    .leftJoin(scenarioVersions, eq(scenarioVersions.id, runs.scenarioVersionId))
    .where(eq(runs.id, runId))
    .limit(1)
  const base = { facts: current.facts, nodes: current.nodes, source: current.source }
  if (query.compare === 'none' && !query.baseRunId) return { ...base, comparison: null, comparisonUnavailable: null }

  const trial = runRow?.versionKind === 'trial'
  const cutoff = runRow?.finishedAt ?? runRow?.createdAt ?? new Date()
  const unavailable = (reason: RunDurationUnavailableReason): RunDurationReadout => ({ ...base, comparison: null, comparisonUnavailable: reason })
  const targetSide = sideOf(current, runRow?.targetAccountId ?? null)

  if (query.baseRunId) {
    const other = await readRunDurationFacts(db, query.baseRunId)
    if (!other) return unavailable('base_not_found')
    if (other.facts.scenarioId !== current.facts.scenarioId) return unavailable('base_mismatch')
    const [otherRow] = await db.select({ targetAccountId: runs.targetAccountId }).from(runs).where(eq(runs.id, query.baseRunId)).limit(1)
    const attribution = attributeDurationDifference(sideOf(other, otherRow?.targetAccountId ?? null), targetSide)
    return {
      ...base,
      comparison: {
        mode: 'run',
        trial,
        baseRunId: query.baseRunId,
        baseFinishedAt: other.facts.finishedAt,
        baseSamples: 1,
        baseScenarioVersionId: other.facts.scenarioVersionId,
        attribution,
        summary: summarizeDurationDifference(attribution, { target: '本次', base: '所选运行' }),
      },
      comparisonUnavailable: null,
    }
  }

  // 候选：同场景、更早完成、成功；可比运行只找可比运行，试跑只找试跑
  const candidates = await db
    .select({ runId: f.runId, targetAccountId: runs.targetAccountId })
    .from(f)
    .innerJoin(runs, eq(runs.id, f.runId))
    .leftJoin(scenarioVersions, eq(scenarioVersions.id, f.scenarioVersionId))
    .where(
      and(
        eq(f.scenarioId, current.facts.scenarioId),
        lt(f.finishedAt, cutoff),
        eq(f.status, 'SUCCEEDED'),
        isNull(runs.deletedAt),
        trial ? eq(scenarioVersions.kind, 'trial') : eq(f.comparable, true),
      ),
    )
    .orderBy(desc(f.finishedAt), desc(f.runId))
    .limit(query.compare === 'median10' ? 10 : 1)
  if (candidates.length === 0) {
    const [earlier] = await db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.scenarioId, current.facts.scenarioId), lt(runs.createdAt, runRow?.createdAt ?? new Date()), isNull(runs.deletedAt)))
      .limit(1)
    return unavailable(earlier ? 'no_successful_base' : 'first_run')
  }
  const readouts = (await Promise.all(candidates.map((c) => readRunDurationFacts(db, c.runId)))).filter((r): r is NonNullable<typeof r> => r !== null)
  if (readouts.length === 0) return unavailable('no_successful_base')
  const baseSide = query.compare === 'median10' ? medianSide(readouts) : sideOf(readouts[0]!, candidates[0]!.targetAccountId)
  const attribution = attributeDurationDifference(baseSide, targetSide)
  const label = query.compare === 'median10' ? `近 ${readouts.length} 次中位数` : trial ? '上次试跑' : '上次'
  return {
    ...base,
    comparison: {
      mode: query.compare === 'median10' ? 'median10' : 'previous',
      trial,
      baseRunId: query.compare === 'median10' ? null : readouts[0]!.facts.runId,
      baseFinishedAt: query.compare === 'median10' ? null : readouts[0]!.facts.finishedAt,
      baseSamples: readouts.length,
      baseScenarioVersionId: baseSide.facts.scenarioVersionId ?? null,
      attribution,
      summary: summarizeDurationDifference(attribution, { target: '本次', base: label }),
    },
    comparisonUnavailable: null,
  }
}

// ---------------------------------------------------------------------------
// 场景耗时分析
// ---------------------------------------------------------------------------

/** 单个节点的明细（节点历史看每次运行的点）。 */
async function loadNodeSamples(
  db: Db,
  scenarioId: string,
  range: { from: Date; to: Date },
  trigger: DurationAnalysisQueryParsed['trigger'],
  nodeKey: string,
): Promise<NodeSample[]> {
  const { runNodeDurationFacts: n, runDurationFacts: f } = schemaFor(db)
  return loadNodeFactRows(
    db,
    and(eq(n.scenarioId, scenarioId), eq(n.nodeKey, nodeKey), gte(f.finishedAt, range.from), lt(f.finishedAt, range.to), triggerPredicate(db, trigger)),
  )
}

function latestOf(aggs: readonly NodeDayAgg[]): NodeDayAgg | undefined {
  let best: NodeDayAgg | undefined
  for (const agg of aggs) if (!best || agg.lastFinishedAt > best.lastFinishedAt) best = agg
  return best
}

/** 节点表的行：同一层级（顶层，或某个父节点下）的节点按键合并两期聚合。 */
export function nodeRowsOf(
  scenario: { id: string; name: string },
  current: readonly NodeDayAgg[],
  base: readonly NodeDayAgg[],
  baseHadRuns: boolean,
  keys: string[],
  spec: WindowSpec,
): { rows: DurationNodeRow[]; insights: DurationInsight[] } {
  const group = (aggs: readonly NodeDayAgg[]) => {
    const map = new Map<string, NodeDayAgg[]>()
    for (const agg of aggs) {
      const list = map.get(agg.nodeKey)
      if (list) list.push(agg)
      else map.set(agg.nodeKey, [agg])
    }
    return map
  }
  const now = group(current)
  const before = group(base)
  const insights: DurationInsight[] = []
  const rows: DurationNodeRow[] = []
  for (const key of new Set([...now.keys(), ...before.keys()])) {
    const all = now.get(key) ?? []
    const prior = before.get(key) ?? []
    const meta = latestOf(all) ?? latestOf(prior)!
    const t = nodeTotalsOf(all)
    const tb = nodeTotalsOf(prior)
    const p50 = sketchCompare(t.sketches.active, tb.sketches.active, 50)
    const retryRate = ratioComparison({ value: rate(t.retried, t.ok), samples: t.ok }, { value: rate(tb.retried, tb.ok), samples: tb.ok })
    const assistedRate = ratioComparison({ value: rate(t.assisted, t.ok), samples: t.ok }, { value: rate(tb.assisted, tb.ok), samples: tb.ok })
    const buckets = byBucketOf(all, spec)
    const nodeInsights =
      meta.parentKey === null
        ? detectNodeInsights(
            { scenarioId: scenario.id, scenarioName: scenario.name, nodeKey: key, nodeName: meta.name },
            {
              p50,
              retryRate,
              assistedRate,
              medianIterations: { current: durationCountsQuantile(t.counts.iteration, 50), base: durationCountsQuantile(tb.counts.iteration, 50) },
              perIterationP50: { current: quantile(t.sketches.perIteration, 50), base: quantile(tb.sketches.perIteration, 50) },
            },
          )
        : []
    insights.push(...nodeInsights)
    rows.push({
      nodeKey: key,
      parentKey: meta.parentKey,
      kind: meta.kind,
      name: meta.name,
      ordinal: meta.ordinal,
      hasChildren: [...all, ...prior].some((agg) => agg.hasChildren),
      samples: t.ok,
      baseSamples: tb.ok,
      activeP50: p50.current,
      activeP95: quantile(t.sketches.active, 95),
      baseP50: p50.base,
      deltaPct: p50.deltaPct,
      retryRate: retryRate.current,
      avgIterations: t.ok ? Math.round((t.iterationSum / t.ok) * 10) / 10 : null,
      assistedRate: assistedRate.current,
      sparkline: keys.map((bucket) => quantile(nodeTotalsOf(buckets.get(bucket) ?? []).sketches.active, 50)),
      tags: t.runs === 0 ? ['removed'] : tb.runs === 0 && baseHadRuns ? ['new'] : [],
      insights: nodeInsights,
    })
  }
  rows.sort((a, b) => a.ordinal - b.ordinal || a.nodeKey.localeCompare(b.nodeKey))
  return { rows, insights }
}

async function loadScenarioMeta(db: Db, scenarioId: string) {
  const { scenarios, targets } = schemaFor(db)
  const [row] = await db
    .select({ id: scenarios.id, name: scenarios.name, targetId: scenarios.targetId, targetName: targets.name })
    .from(scenarios)
    .innerJoin(targets, eq(targets.id, scenarios.targetId))
    .where(eq(scenarios.id, scenarioId))
    .limit(1)
  if (!row) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
  return row
}

export async function readScenarioDurationAnalysis(db: Db, scenarioId: string, query: DurationAnalysisQueryParsed): Promise<ScenarioDurationAnalysis> {
  const scenario = await loadScenarioMeta(db, scenarioId)
  const spec = await windowFor(db, query)
  const scope = { scenarioIds: [scenarioId], trigger: spec.trigger, timeZone: spec.tz, rawLimit: DURATION_RUN_ROW_LIMIT }
  const [currentLoad, baseLoad] = await Promise.all([
    loadScenarioAggs(db, { ...scope, range: spec }),
    loadScenarioAggs(db, { ...scope, range: { from: spec.baseFrom, to: spec.baseTo } }),
  ])
  // 只取顶层节点；明细路径下运行被截断时，节点按同一截止时刻取，口径一致
  const [nodeCurrent, nodeBase] = await Promise.all([
    loadNodeAggs(db, { ...scope, range: spec, rawFrom: currentLoad.rawFrom }),
    loadNodeAggs(db, { ...scope, range: { from: spec.baseFrom, to: spec.baseTo }, rawFrom: baseLoad.rawFrom }),
  ])

  const keys = bucketKeys(spec)
  const byBucket = byBucketOf(currentLoad.aggs, spec)
  const buckets: ScenarioDurationBucket[] = keys.map((bucket) => {
    const totals = scenarioTotalsOf(byBucket.get(bucket) ?? [])
    return {
      bucket,
      runs: totals.runs,
      succeeded: totals.succeeded,
      failed: totals.failed,
      samples: totals.samples,
      activeP50: quantile(totals.sketches.active, 50),
      activeP95: quantile(totals.sketches.active, 95),
      totalP50: quantile(totals.sketches.totalOk, 50),
      waitRatio: rate(totals.waitSumMs, totals.totalSumMs),
    }
  })
  const boundaries = (await versionBoundariesByScenario(db, currentLoad.aggs)).get(scenarioId) ?? []
  const stats = scenarioStats(currentLoad.aggs, baseLoad.aggs, boundaries)
  const scenarioInsights = detectScenarioInsights({ scenarioId, scenarioName: scenario.name }, { ...stats, activeP95: stats.activeP95.current })
  const nodes = nodeRowsOf({ id: scenarioId, name: scenario.name }, nodeCurrent, nodeBase, baseLoad.aggs.length > 0, keys, spec)
  return {
    scenario,
    window: windowDto(spec),
    kpis: {
      runs: stats.totals.runs,
      samples: stats.totals.samples,
      activeP50: stats.activeP50,
      activeP95: stats.activeP95,
      totalP50: stats.totalP50,
      waitRatio: stats.waitRatio,
      queueP50: stats.queueP50,
    },
    buckets,
    nodes: nodes.rows,
    versionBoundaries: boundaries,
    incompleteRuns: stats.totals.incomplete,
    truncated: currentLoad.truncated || baseLoad.truncated,
    aggregation: aggregationOf(currentLoad, baseLoad),
    insights: [...scenarioInsights, ...nodes.insights],
  }
}

/** 节点表展开某个节点时读它的子节点（单场景明细，与顶层同一窗口与对比）。 */
export async function readScenarioNodeChildren(db: Db, scenarioId: string, query: NodeDurationChildrenQueryParsed): Promise<NodeDurationChildren> {
  const scenario = await loadScenarioMeta(db, scenarioId)
  const spec = await windowFor(db, query)
  const scope = { scenarioIds: [scenarioId], trigger: spec.trigger, timeZone: spec.tz, parentKey: query.parentKey }
  const [current, base] = await Promise.all([
    loadNodeAggs(db, { ...scope, range: spec }),
    loadNodeAggs(db, { ...scope, range: { from: spec.baseFrom, to: spec.baseTo } }),
  ])
  const { rows } = nodeRowsOf({ id: scenarioId, name: scenario.name }, current, base, base.length > 0, bucketKeys(spec), spec)
  return { parentKey: query.parentKey, window: windowDto(spec), nodes: rows }
}

export async function readScenarioNodeHistory(db: Db, scenarioId: string, query: NodeDurationHistoryQueryParsed): Promise<NodeDurationHistory> {
  await loadScenarioMeta(db, scenarioId)
  const spec = await windowFor(db, query)
  const { runDurationFacts: f } = schemaFor(db)
  const runLoad = await loadRunSamples(db, eq(f.scenarioId, scenarioId), spec, spec.trigger, DURATION_RUN_ROW_LIMIT)
  const from = runLoad.truncated ? runLoad.rows.at(-1)!.finishedAt : spec.from
  const samples = await loadNodeSamples(db, scenarioId, { from, to: spec.to }, spec.trigger, query.nodeKey)
  if (samples.length === 0) {
    return {
      node: { nodeKey: query.nodeKey, name: query.nodeKey, kind: 'step' },
      window: windowDto(spec),
      points: [],
      buckets: bucketKeys(spec).map((bucket) => ({ bucket, p50: null, samples: 0 })),
      versionBoundaries: await versionBoundaries(db, runLoad.rows),
      truncated: runLoad.truncated,
    }
  }
  const ordered = [...samples].sort((a, b) => a.runFinishedAt.getTime() - b.runFinishedAt.getTime())
  const latest = ordered.at(-1)!
  const byBucket = new Map<string, number[]>()
  for (const sample of ordered) {
    if (sample.status !== 'SUCCEEDED') continue
    const bucket = bucketOf(sample.runFinishedAt, spec)
    const list = byBucket.get(bucket) ?? []
    list.push(sample.activeMs)
    byBucket.set(bucket, list)
  }
  return {
    node: { nodeKey: latest.nodeKey, name: latest.name, kind: latest.kind },
    window: windowDto(spec),
    points: ordered.map((s) => ({
      runId: s.runId,
      finishedAt: s.finishedAt.toISOString(),
      activeMs: s.activeMs,
      attemptCount: s.attemptCount,
      iterationCount: s.iterationCount,
      status: s.status,
      scenarioVersionId: s.scenarioVersionId,
      maxResolution: s.maxResolution,
    })),
    buckets: bucketKeys(spec).map((bucket) => {
      const values = sortedOf(byBucket.get(bucket) ?? [])
      return { bucket, p50: durationPercentile(values, 50), samples: values.length }
    }),
    versionBoundaries: await versionBoundaries(db, runLoad.rows),
    truncated: runLoad.truncated,
  }
}

// ---------------------------------------------------------------------------
// 按目标系统筛选（可再按场景集）
// ---------------------------------------------------------------------------

async function latestSuiteDocument(db: Db, suiteId: string) {
  const { scenarioSuites, scenarioSuiteVersions } = schemaFor(db)
  const [suite] = await db
    .select({ id: scenarioSuites.id, name: scenarioSuites.name, targetId: scenarioSuites.targetId, executionMode: scenarioSuites.executionMode })
    .from(scenarioSuites)
    .where(and(eq(scenarioSuites.id, suiteId), isNull(scenarioSuites.deletedAt)))
    .limit(1)
  if (!suite) throw notFound('SUITE_NOT_FOUND', '场景集不存在')
  const [version] = await db
    .select({ document: scenarioSuiteVersions.document })
    .from(scenarioSuiteVersions)
    .where(eq(scenarioSuiteVersions.suiteId, suiteId))
    .orderBy(desc(scenarioSuiteVersions.versionNo))
    .limit(1)
  return { suite, document: (version?.document ?? null) as SuiteDocument | null }
}

interface CriticalMember {
  memberId: string
  scenarioId: string
  name: string
  stage: string
  value: number | null
}

/** 关键路径近似：阶段间串行；阶段内顺序执行取全部成员、并行取最慢成员。 */
function criticalPathOf(document: SuiteDocument, valueOf: (memberId: string) => number | null, nameOf: (scenarioId: string, displayName?: string) => string): CriticalMember[] {
  const path: CriticalMember[] = []
  for (const stage of effectiveSuiteStages(document)) {
    const members = stage.members.map((m) => ({ memberId: m.memberId, scenarioId: m.scenarioId, name: nameOf(m.scenarioId, m.displayName), stage: stage.name, value: valueOf(m.memberId) }))
    if (members.length === 0) continue
    if (stage.executionMode === 'sequential') path.push(...members)
    else path.push(members.reduce((best, m) => ((m.value ?? -1) > (best.value ?? -1) ? m : best)))
  }
  return path
}

function sumOf(values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => v !== null)
  return present.length ? present.reduce((a, b) => a + b, 0) : null
}

interface MemberTiming {
  createdAt: Date
  startedAt: Date | null
  finishedAt: Date | null
}

/**
 * 成员开跑前排队：从成员「可以开跑」起算，而不是从子运行创建起算。顺序执行时后一个成员要等前一个结束，
 * 有阶段时要等上一阶段结束——这段等待属于关键路径，不是排队；之后仍未开跑的时间才是排队（执行节点或账号并发不足）。
 */
function memberQueues(document: SuiteDocument, timingOf: (memberId: string) => MemberTiming | undefined): Map<string, number> {
  const out = new Map<string, number>()
  let stageReady: number | null = null
  for (const stage of effectiveSuiteStages(document)) {
    let previousEnd: number | null = stageReady
    let stageEnd: number | null = stageReady
    for (const member of [...stage.members].sort((a, b) => a.ordinal - b.ordinal)) {
      const timing = timingOf(member.memberId)
      if (!timing) continue
      const ready = Math.max(timing.createdAt.getTime(), (stage.executionMode === 'sequential' ? previousEnd : stageReady) ?? 0)
      if (timing.startedAt) out.set(member.memberId, Math.max(0, timing.startedAt.getTime() - ready))
      if (timing.finishedAt) {
        previousEnd = timing.finishedAt.getTime()
        stageEnd = Math.max(stageEnd ?? 0, previousEnd)
      }
    }
    stageReady = stageEnd
  }
  return out
}

async function suiteSummary(db: Db, suiteId: string, spec: WindowSpec, scenarioNames: Map<string, string>): Promise<SuiteDurationSummary> {
  const { suite, document } = await latestSuiteDocument(db, suiteId)
  const { suiteRuns } = schemaFor(db)
  const loadSuiteRuns = async (from: Date, to: Date) => {
    if (spec.trigger === 'service') return []
    return db
      .select({ id: suiteRuns.id, startedAt: suiteRuns.startedAt, finishedAt: suiteRuns.finishedAt })
      .from(suiteRuns)
      .where(
        and(
          eq(suiteRuns.suiteId, suiteId),
          isNull(suiteRuns.deletedAt),
          isNotNull(suiteRuns.startedAt),
          gte(suiteRuns.finishedAt, from),
          lt(suiteRuns.finishedAt, to),
          spec.trigger === 'all' ? undefined : eq(suiteRuns.triggerSource, spec.trigger as 'manual' | 'schedule'),
        ),
      )
      .orderBy(asc(suiteRuns.finishedAt))
      .limit(DURATION_RUN_ROW_LIMIT)
  }
  const [current, base] = await Promise.all([loadSuiteRuns(spec.from, spec.to), loadSuiteRuns(spec.baseFrom, spec.baseTo)])
  const wall = (row: { startedAt: Date | null; finishedAt: Date | null }) => (row.startedAt && row.finishedAt ? row.finishedAt.getTime() - row.startedAt.getTime() : null)
  const byBucket = new Map<string, number[]>()
  for (const row of current) {
    const value = wall(row)
    if (value === null || !row.finishedAt) continue
    const bucket = bucketOf(row.finishedAt, spec)
    const list = byBucket.get(bucket) ?? []
    list.push(value)
    byBucket.set(bucket, list)
  }
  const { runDurationFacts: f } = schemaFor(db)
  const memberRows = current.length
    ? (await loadRunSamples(db, inArray(f.suiteRunId, current.map((r) => r.id)), spec, 'all', DURATION_RUN_ROW_LIMIT, false)).rows
    : []
  const memberValues = new Map<string, number[]>()
  for (const row of memberRows) {
    if (!row.suiteMemberId || row.totalMs === null) continue
    const list = memberValues.get(row.suiteMemberId) ?? []
    list.push(row.totalMs)
    memberValues.set(row.suiteMemberId, list)
  }
  // 成员排队按当前发布版本的编排结构推算可开跑时刻；没有发布版本时退回子运行创建起算
  const memberQueueValues: number[] = []
  const bySuiteRun = new Map<string, Map<string, RunSample>>()
  for (const row of memberRows) {
    if (!row.suiteRunId || !row.suiteMemberId) continue
    const members = bySuiteRun.get(row.suiteRunId) ?? new Map<string, RunSample>()
    members.set(row.suiteMemberId, row)
    bySuiteRun.set(row.suiteRunId, members)
  }
  for (const members of bySuiteRun.values()) {
    if (document) memberQueueValues.push(...memberQueues(document, (memberId) => members.get(memberId)).values())
    else for (const row of members.values()) if (row.queueMs !== null) memberQueueValues.push(row.queueMs)
  }
  const nameOf = (scenarioId: string, displayName?: string) => displayName ?? scenarioNames.get(scenarioId) ?? scenarioId
  const path = document ? criticalPathOf(document, (memberId) => median(memberValues.get(memberId) ?? []), nameOf) : []
  return {
    suiteId,
    name: suite.name,
    executionMode: document?.executionMode ?? suite.executionMode,
    staged: Boolean(document?.stages?.length),
    runs: current.length,
    wallP50: compare(current.map(wall), base.map(wall), 50),
    wallP95: durationPercentile(sortedOf(current.map(wall)), 95),
    memberQueueP50: median(memberQueueValues),
    buckets: bucketKeys(spec).map((bucket) => {
      const values = sortedOf(byBucket.get(bucket) ?? [])
      return { bucket, runs: values.length, p50: durationPercentile(values, 50), p95: durationPercentile(values, 95) }
    }),
    criticalPath: path.map((m) => ({ memberId: m.memberId, scenarioId: m.scenarioId, name: m.name, stage: m.stage, p50: m.value })),
    criticalPathP50: sumOf(path.map((m) => m.value)),
  }
}

export async function readTargetDurationAnalysis(db: Db, targetId: string, query: TargetDurationAnalysisQueryParsed): Promise<TargetDurationAnalysis> {
  const spec = await windowFor(db, query)
  return (await targetAnalysisCore(db, targetId, spec, query.suiteId)).dto
}

/** 按目标系统分析的完整中间结果：页面只用 dto，周期报告还要各场景的两期聚合与版本分界。 */
export interface TargetAnalysisCore {
  dto: TargetDurationAnalysis
  current: ScenarioDayAgg[]
  base: ScenarioDayAgg[]
  scenarioIds: string[]
  scenarioNames: Map<string, string>
  boundaries: Map<string, DurationVersionBoundary[]>
  suiteName: string | null
}

export async function targetAnalysisCore(db: Db, targetId: string, spec: WindowSpec, suiteId?: string): Promise<TargetAnalysisCore> {
  const { targets, scenarios } = schemaFor(db)
  const [target] = await db.select({ id: targets.id, name: targets.name }).from(targets).where(eq(targets.id, targetId)).limit(1)
  if (!target) throw notFound('TARGET_NOT_FOUND', '目标系统不存在')
  const scenarioRows = await db
    .select({ id: scenarios.id, name: scenarios.name })
    .from(scenarios)
    .where(and(eq(scenarios.targetId, targetId), isNull(scenarios.deletedAt), eq(scenarios.purpose, 'user')))
    .orderBy(asc(scenarios.name))
  const scenarioNames = new Map(scenarioRows.map((s) => [s.id, s.name]))
  let scenarioIds = scenarioRows.map((s) => s.id)
  let suite: SuiteDurationSummary | null = null
  if (suiteId) {
    const { suite: suiteRow, document } = await latestSuiteDocument(db, suiteId)
    if (suiteRow.targetId !== targetId) throw notFound('SUITE_NOT_FOUND', '场景集不属于该目标系统')
    const members = new Set((document ? effectiveSuiteStages(document).flatMap((s) => s.members) : []).map((m) => m.scenarioId))
    scenarioIds = scenarioIds.filter((id) => members.has(id))
    suite = await suiteSummary(db, suiteId, spec, scenarioNames)
  }
  const scope = { scenarioIds, trigger: spec.trigger, timeZone: spec.tz, rawLimit: DURATION_TARGET_ROW_LIMIT }
  const [currentLoad, baseLoad] = await Promise.all([
    loadScenarioAggs(db, { ...scope, range: spec }),
    loadScenarioAggs(db, { ...scope, range: { from: spec.baseFrom, to: spec.baseTo } }),
  ])
  const group = (aggs: readonly ScenarioDayAgg[]) => {
    const map = new Map<string, ScenarioDayAgg[]>()
    for (const agg of aggs) {
      const list = map.get(agg.scenarioId)
      if (list) list.push(agg)
      else map.set(agg.scenarioId, [agg])
    }
    return map
  }
  const now = group(currentLoad.aggs)
  const before = group(baseLoad.aggs)
  const keys = bucketKeys(spec)
  const boundaryMap = await versionBoundariesByScenario(db, currentLoad.aggs)
  const scenariosOut: TargetDurationScenario[] = []
  let slower = 0
  let faster = 0
  let insightCount = 0
  for (const id of scenarioIds) {
    const current = now.get(id) ?? []
    const base = before.get(id) ?? []
    const boundaries = boundaryMap.get(id) ?? []
    const stats = scenarioStats(current, base, boundaries)
    const insights = detectScenarioInsights({ scenarioId: id, scenarioName: scenarioNames.get(id) ?? id }, { ...stats, activeP95: stats.activeP95.current })
    if (insights.some((i) => i.kind === 'slower')) slower += 1
    if (insights.some((i) => i.kind === 'faster')) faster += 1
    insightCount += insights.length
    const buckets = byBucketOf(current, spec)
    scenariosOut.push({
      scenarioId: id,
      name: scenarioNames.get(id) ?? id,
      runs: stats.totals.runs,
      samples: stats.totals.samples,
      activeP50: stats.activeP50,
      activeP95: stats.activeP95.current,
      series: keys.map((bucket) => {
        const totals = scenarioTotalsOf(buckets.get(bucket) ?? [])
        return { bucket, p50: quantile(totals.sketches.active, 50), p95: quantile(totals.sketches.active, 95), runs: totals.runs }
      }),
      insights,
    })
  }
  const all = scenarioStats(currentLoad.aggs, baseLoad.aggs, [])
  return {
    dto: {
      target,
      window: windowDto(spec),
      kpis: {
        runs: all.totals.runs,
        activeP50: all.activeP50,
        waitRatio: all.waitRatio,
        queueP50: all.queueP50,
        slower,
        faster,
        insightCount,
      },
      scenarios: scenariosOut,
      suite,
      truncated: currentLoad.truncated || baseLoad.truncated,
      aggregation: aggregationOf(currentLoad, baseLoad),
    },
    current: currentLoad.aggs,
    base: baseLoad.aggs,
    scenarioIds,
    scenarioNames,
    boundaries: boundaryMap,
    suiteName: suite?.name ?? null,
  }
}

// ---------------------------------------------------------------------------
// 场景集运行对比
// ---------------------------------------------------------------------------

export async function readSuiteRunDuration(db: Db, suiteRunId: string): Promise<SuiteRunDurationReadout> {
  const { suiteRuns, scenarios, runs, runDurationFacts: f } = schemaFor(db)
  const [current] = await db
    .select({ id: suiteRuns.id, suiteId: suiteRuns.suiteId, createdAt: suiteRuns.createdAt, startedAt: suiteRuns.startedAt, finishedAt: suiteRuns.finishedAt, snapshot: suiteRuns.snapshot })
    .from(suiteRuns)
    .where(eq(suiteRuns.id, suiteRunId))
    .limit(1)
  if (!current) throw notFound('SUITE_RUN_NOT_FOUND', '场景集运行不存在')
  const [base] = await db
    .select({ id: suiteRuns.id, startedAt: suiteRuns.startedAt, finishedAt: suiteRuns.finishedAt, snapshot: suiteRuns.snapshot })
    .from(suiteRuns)
    .where(
      and(
        eq(suiteRuns.suiteId, current.suiteId),
        isNull(suiteRuns.deletedAt),
        isNotNull(suiteRuns.startedAt),
        isNotNull(suiteRuns.finishedAt),
        inArray(suiteRuns.status, ['COMPLETED', 'FAILED']),
        lt(suiteRuns.finishedAt, current.finishedAt ?? current.createdAt),
      ),
    )
    .orderBy(desc(suiteRuns.finishedAt))
    .limit(1)
  const ids = [current.id, ...(base ? [base.id] : [])]
  const memberRows = await db
    .select({ runId: runs.id, suiteRunId: runs.suiteRunId, memberId: runs.suiteMemberId, createdAt: runs.createdAt, startedAt: runs.startedAt, finishedAt: runs.finishedAt, deletedAt: runs.deletedAt, totalMs: f.totalMs, queueMs: f.queueMs })
    .from(runs)
    .leftJoin(f, eq(f.runId, runs.id))
    // 成员运行即使事后被删除也计入当次耗时（反映当时实际发生的情况），只是不再提供跳转
    .where(inArray(runs.suiteRunId, ids))
    .orderBy(asc(runs.createdAt))
  // 同一成员重跑多次时取最后一次
  const latestBy = (suiteRun: string) => {
    const map = new Map<string, (typeof memberRows)[number]>()
    for (const row of memberRows) if (row.suiteRunId === suiteRun && row.memberId) map.set(row.memberId, row)
    return map
  }
  const now = latestBy(current.id)
  const before = base ? latestBy(base.id) : new Map<string, (typeof memberRows)[number]>()
  const totalOf = (row: (typeof memberRows)[number] | undefined) =>
    row ? row.totalMs ?? (row.startedAt && row.finishedAt ? row.finishedAt.getTime() - row.startedAt.getTime() : null) : null
  const document = ((current.snapshot as { document?: SuiteDocument } | null)?.document ?? (current.snapshot as unknown as SuiteDocument | null)) as SuiteDocument | null
  const baseDocument = base ? (((base.snapshot as { document?: SuiteDocument } | null)?.document ?? (base.snapshot as unknown as SuiteDocument)) as SuiteDocument) : null
  const scenarioIds = document ? effectiveSuiteStages(document).flatMap((s) => s.members.map((m) => m.scenarioId)) : []
  const names = new Map(
    scenarioIds.length ? (await db.select({ id: scenarios.id, name: scenarios.name }).from(scenarios).where(inArray(scenarios.id, scenarioIds))).map((s) => [s.id, s.name]) : [],
  )
  const nameOf = (scenarioId: string, displayName?: string) => displayName ?? names.get(scenarioId) ?? scenarioId
  const queueNowBy = document ? memberQueues(document, (memberId) => now.get(memberId)) : new Map<string, number>()
  const queueBaseBy = baseDocument ? memberQueues(baseDocument, (memberId) => before.get(memberId)) : new Map<string, number>()
  const path = document ? criticalPathOf(document, (memberId) => totalOf(now.get(memberId)), nameOf) : []
  const basePath = baseDocument && base ? criticalPathOf(baseDocument, (memberId) => totalOf(before.get(memberId)), nameOf) : []
  const onPath = new Set(path.map((m) => m.memberId))
  const members = document
    ? effectiveSuiteStages(document).flatMap((stage) =>
        stage.members.map((m) => {
          const row = now.get(m.memberId)
          const prior = before.get(m.memberId)
          const total = totalOf(row)
          const baseTotal = totalOf(prior)
          return {
            memberId: m.memberId,
            scenarioId: m.scenarioId,
            name: nameOf(m.scenarioId, m.displayName),
            stage: stage.name,
            runId: row && !row.deletedAt ? row.runId : null,
            baseRunId: prior && !prior.deletedAt ? prior.runId : null,
            totalMs: total,
            baseTotalMs: baseTotal,
            deltaMs: total !== null && baseTotal !== null ? total - baseTotal : null,
            queueMs: queueNowBy.get(m.memberId) ?? null,
            baseQueueMs: queueBaseBy.get(m.memberId) ?? null,
            onCriticalPath: onPath.has(m.memberId),
          }
        }),
      )
    : []
  const wall = (row: { startedAt: Date | null; finishedAt: Date | null } | undefined) =>
    row?.startedAt && row.finishedAt ? row.finishedAt.getTime() - row.startedAt.getTime() : null
  const currentWall = wall(current)
  const baseWall = wall(base)
  const cpNow = sumOf(path.map((m) => m.value))
  const cpBase = sumOf(basePath.map((m) => m.value))
  const queueNow = sumOf(path.map((m) => queueNowBy.get(m.memberId) ?? null))
  const queueBase = sumOf(basePath.map((m) => queueBaseBy.get(m.memberId) ?? null))
  const wallDeltaMs = currentWall !== null && baseWall !== null ? currentWall - baseWall : null
  const criticalPathDeltaMs = cpNow !== null && cpBase !== null ? cpNow - cpBase : null
  const queueDeltaMs = queueNow !== null && queueBase !== null ? queueNow - queueBase : null
  const signed = (ms: number) => `${ms < 0 ? '−' : '+'}${formatDurationShort(ms)}`
  let summary: string
  if (!base) summary = '没有更早完成的场景集运行可对比'
  else if (wallDeltaMs === null) summary = '本次或上次缺少起止时间，无法对比'
  else if (Math.abs(wallDeltaMs) < 1_000) summary = `本次与上次总耗时基本持平（${signed(wallDeltaMs)}）`
  else {
    const top = members
      .filter((m) => m.onCriticalPath && m.deltaMs !== null)
      .sort((a, b) => Math.abs(b.deltaMs!) - Math.abs(a.deltaMs!))[0]
    // 上次没有的成员整段计入关键路径差值，要点名，否则差值看起来对不上
    const added = members.filter((m) => m.onCriticalPath && m.baseTotalMs === null && m.totalMs !== null && base)
    const causes = [
      ...added.map((m) => `新增『${m.name}』${formatDurationShort(m.totalMs!)}`),
      top && Math.abs(top.deltaMs!) >= 1_000 ? `『${top.name}』${signed(top.deltaMs!)}` : null,
    ].filter(Boolean)
    const parts = [
      criticalPathDeltaMs !== null ? `关键路径 ${signed(criticalPathDeltaMs)}${causes.length ? `，其中${causes.join('、')}` : ''}` : null,
      queueDeltaMs !== null && Math.abs(queueDeltaMs) >= 1_000 ? `成员排队 ${signed(queueDeltaMs)}` : null,
    ].filter(Boolean)
    summary = `本次比上次${wallDeltaMs > 0 ? '慢' : '快'} ${formatDurationShort(wallDeltaMs)}${parts.length ? `：${parts.join('；')}` : ''}`
  }
  return {
    suiteRun: { id: current.id, startedAt: current.startedAt?.toISOString() ?? null, finishedAt: current.finishedAt?.toISOString() ?? null, wallMs: currentWall },
    base: base ? { id: base.id, startedAt: base.startedAt?.toISOString() ?? null, finishedAt: base.finishedAt?.toISOString() ?? null, wallMs: baseWall } : null,
    wallDeltaMs,
    criticalPathDeltaMs,
    queueDeltaMs,
    members,
    summary,
  }
}
