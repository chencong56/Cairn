import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm'
import {
  DEFAULT_STATISTICS_TIME_ZONE,
  DURATION_SKETCH_MERGE_EXACT_LIMIT,
  DURATION_SKETCH_STORE_EXACT_LIMIT,
  compactDurationSketch,
  durationCountsOf,
  durationSketchOf,
  emptyDurationSketch,
  mergeDurationCounts,
  localDateOf,
  mergeDurationSketches,
  shiftLocalDate,
  zonedStartOfDay,
  type DurationAnalysisQueryParsed,
  type DurationNodeKind,
  type DurationResolutionLevel,
  type DurationSketch,
  type RunTriggerSource,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { atomic, clockNow, deleteRows, insertIgnoreRows, locked, schemaFor } from '../native.js'
import { getPlatformConfig } from '../platform-config/store.js'
import type { DurationRollupBackfillState, NodeDailyCounts, ScenarioDailySketches } from '../schema/duration-rollups.js'

/**
 * 耗时分析按天汇总（方案 docs/spec/2026-10-08-duration-daily-rollups.md）。
 *
 * 汇总与明细两条读路径产出同一种「场景 / 节点 × 统计日」聚合，下游统计只认聚合：
 * - 汇总路径：按平台统计时区切天，analyst 作业按（场景、统计日）从事实表整行重算后落库；
 * - 明细路径（请求时区不是统计时区，或汇总还在重建）：现读事实明细、在内存里按同一函数聚合。
 * 分位数用可合并草图（@cairn/shared duration-sketch），样本少时精确，多时相对误差 ≤ 1%。
 */

/** 汇总口径版本：改了聚合方式就加一，作业会整体重建。 */
export const DURATION_ROLLUP_CALC_VERSION = 1
const STATE_ID = 'default'

// ---------------------------------------------------------------------------
// 明细行与聚合
// ---------------------------------------------------------------------------

/** 一条可比运行的耗时事实（明细读路径与汇总重算共用）。 */
export interface RunSample {
  runId: string
  scenarioId: string
  scenarioVersionId: string
  targetId: string
  triggerSource: RunTriggerSource
  suiteRunId: string | null
  suiteMemberId: string | null
  status: string
  createdAt: Date
  startedAt: Date | null
  finishedAt: Date
  totalMs: number | null
  activeMs: number | null
  authWaitMs: number | null
  requeueMs: number | null
  reviewMs: number | null
  queueMs: number | null
  overheadMs: number | null
  complete: boolean
}

/** 一条节点耗时事实；按所属运行的完成时刻归日，与运行级同一天。 */
export interface NodeSample {
  runId: string
  scenarioId: string
  targetId: string
  triggerSource: RunTriggerSource
  nodeKey: string
  parentKey: string | null
  kind: DurationNodeKind
  name: string
  ordinal: number
  status: string
  activeMs: number
  attemptCount: number
  iterationCount: number
  maxResolution: DurationResolutionLevel | null
  finishedAt: Date
  runFinishedAt: Date
  scenarioVersionId: string
}

/** 成功、分解完整且有执行耗时的运行：运行级分位的样本。 */
export function isDurationSample(row: RunSample): boolean {
  return row.status === 'SUCCEEDED' && row.complete && row.activeMs !== null
}

export interface ScenarioDayAgg {
  scenarioId: string
  statDay: string
  triggerSource: RunTriggerSource
  scenarioVersionId: string
  targetId: string
  runs: number
  succeeded: number
  failed: number
  cancelled: number
  samples: number
  incomplete: number
  waitSamples: number
  totalSumMs: number
  waitSumMs: number
  sketches: ScenarioDailySketches
  firstFinishedAt: Date
  lastFinishedAt: Date
}

/** 节点日聚合的草图：每次迭代的耗时只在有节点不是恰好迭代一次时另存，否则与执行耗时相同。 */
export type NodeAggSketches = { active: DurationSketch; perIteration: DurationSketch | null }

export interface NodeDayAgg {
  scenarioId: string
  nodeKey: string
  parentKey: string | null
  statDay: string
  triggerSource: RunTriggerSource
  scenarioVersionId: string
  targetId: string
  kind: DurationNodeKind
  name: string
  ordinal: number
  hasChildren: boolean
  runs: number
  ok: number
  retried: number
  assisted: number
  iterationSum: number
  sketches: NodeAggSketches
  counts: NodeDailyCounts
  /** 成功节点的最高定位层级计数；没有定位记为 none。 */
  resolutions: Record<string, number>
  lastFinishedAt: Date
}

function groupBy<T>(items: Iterable<T>, keyOf: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const key = keyOf(item)
    const list = map.get(key)
    if (list) list.push(item)
    else map.set(key, [item])
  }
  return map
}

function scenarioAggOf(statDay: string, list: RunSample[], exactLimit: number): ScenarioDayAgg {
  const first = list[0]!
  const samples = list.filter(isDurationSample)
  const pick = (key: 'activeMs' | 'totalMs' | 'authWaitMs' | 'requeueMs' | 'reviewMs' | 'queueMs' | 'overheadMs') =>
    durationSketchOf(
      samples.map((row) => row[key]),
      exactLimit,
    )
  const usable = samples.filter((row) => row.totalMs !== null && row.totalMs > 0)
  let firstAt = first.finishedAt
  let lastAt = first.finishedAt
  for (const row of list) {
    if (row.finishedAt < firstAt) firstAt = row.finishedAt
    if (row.finishedAt > lastAt) lastAt = row.finishedAt
  }
  return {
    scenarioId: first.scenarioId,
    statDay,
    triggerSource: first.triggerSource,
    scenarioVersionId: first.scenarioVersionId,
    targetId: first.targetId,
    runs: list.length,
    succeeded: list.filter((row) => row.status === 'SUCCEEDED').length,
    failed: list.filter((row) => row.status === 'FAILED').length,
    cancelled: list.filter((row) => row.status === 'CANCELLED').length,
    samples: samples.length,
    incomplete: list.filter((row) => row.status === 'SUCCEEDED' && !row.complete).length,
    waitSamples: usable.length,
    totalSumMs: usable.reduce((sum, row) => sum + row.totalMs!, 0),
    waitSumMs: usable.reduce((sum, row) => sum + (row.authWaitMs ?? 0) + (row.requeueMs ?? 0) + (row.reviewMs ?? 0), 0),
    sketches: {
      active: pick('activeMs'),
      total: pick('totalMs'),
      authWait: pick('authWaitMs'),
      requeue: pick('requeueMs'),
      review: pick('reviewMs'),
      queue: pick('queueMs'),
      overhead: pick('overheadMs'),
      totalOk: durationSketchOf(
        list.filter((row) => row.status === 'SUCCEEDED').map((row) => row.totalMs),
        exactLimit,
      ),
      // 场景集成员的「创建到开跑」包含等前序成员 / 阶段的时间，不是排队
      queueStandalone: durationSketchOf(
        list.filter((row) => row.suiteRunId === null).map((row) => row.queueMs),
        exactLimit,
      ),
    },
    firstFinishedAt: firstAt,
    lastFinishedAt: lastAt,
  }
}

/** 运行事实 → 场景日聚合（键：场景、统计日、发起方、场景版本）。 */
export function aggregateRunSamples(rows: Iterable<RunSample>, timeZone: string, exactLimit = DURATION_SKETCH_STORE_EXACT_LIMIT): ScenarioDayAgg[] {
  const groups = groupBy(rows, (row) => `${row.scenarioId}|${localDateOf(row.finishedAt, timeZone)}|${row.triggerSource}|${row.scenarioVersionId}`)
  return [...groups.values()].map((list) => scenarioAggOf(localDateOf(list[0]!.finishedAt, timeZone), list, exactLimit))
}

function nodeAggOf(statDay: string, list: NodeSample[], hasChildren: boolean, exactLimit: number): NodeDayAgg {
  const latest = list.reduce((best, node) => (node.finishedAt > best.finishedAt ? node : best))
  const ok = list.filter((node) => node.status === 'SUCCEEDED')
  const resolutions: Record<string, number> = {}
  for (const node of ok) {
    const key = node.maxResolution ?? 'none'
    resolutions[key] = (resolutions[key] ?? 0) + 1
  }
  return {
    scenarioId: latest.scenarioId,
    nodeKey: latest.nodeKey,
    parentKey: latest.parentKey,
    statDay,
    triggerSource: latest.triggerSource,
    scenarioVersionId: latest.scenarioVersionId,
    targetId: latest.targetId,
    kind: latest.kind,
    name: latest.name,
    ordinal: latest.ordinal,
    hasChildren,
    runs: list.length,
    ok: ok.length,
    retried: ok.filter((node) => node.attemptCount > node.iterationCount).length,
    assisted: ok.filter((node) => node.maxResolution === 'map' || node.maxResolution === 'ai').length,
    iterationSum: ok.reduce((sum, node) => sum + node.iterationCount, 0),
    sketches: {
      active: durationSketchOf(
        ok.map((node) => node.activeMs),
        exactLimit,
      ),
      perIteration: ok.some((node) => node.iterationCount !== 1)
        ? durationSketchOf(
            ok.filter((node) => node.iterationCount > 0).map((node) => node.activeMs / node.iterationCount),
            exactLimit,
          )
        : null,
    },
    counts: {
      attempt: durationCountsOf(ok.map((node) => node.attemptCount)),
      iteration: durationCountsOf(ok.map((node) => node.iterationCount)),
    },
    resolutions,
    lastFinishedAt: latest.finishedAt,
  }
}

/**
 * 节点事实 → 节点日聚合。只聚合父节点为 parentKey 的节点（null = 顶层）；
 * hasChildren 说明该节点有没有子行（展开时再按单场景读明细）。
 */
export function aggregateNodeSamples(
  nodes: Iterable<NodeSample>,
  timeZone: string,
  options: { parentKey?: string | null; hasChildren: (scenarioId: string, nodeKey: string) => boolean; exactLimit?: number },
): NodeDayAgg[] {
  const parentKey = options.parentKey ?? null
  const exactLimit = options.exactLimit ?? DURATION_SKETCH_STORE_EXACT_LIMIT
  const level = [...nodes].filter((node) => node.parentKey === parentKey)
  const groups = groupBy(level, (node) => `${node.scenarioId}|${node.nodeKey}|${localDateOf(node.runFinishedAt, timeZone)}|${node.triggerSource}|${node.scenarioVersionId}`)
  return [...groups.values()].map((list) =>
    nodeAggOf(localDateOf(list[0]!.runFinishedAt, timeZone), list, options.hasChildren(list[0]!.scenarioId, list[0]!.nodeKey), exactLimit),
  )
}

/** 一组场景日聚合合并后的总量。 */
export interface ScenarioTotals {
  runs: number
  succeeded: number
  failed: number
  cancelled: number
  samples: number
  incomplete: number
  waitSamples: number
  totalSumMs: number
  waitSumMs: number
  sketches: ScenarioDailySketches
}

const SCENARIO_SKETCH_KEYS = ['active', 'total', 'authWait', 'requeue', 'review', 'queue', 'overhead', 'totalOk', 'queueStandalone'] as const

function mergeSketchFields<K extends string>(keys: readonly K[], items: readonly Record<K, DurationSketch>[], exactLimit: number): Record<K, DurationSketch> {
  return Object.fromEntries(keys.map((key) => [key, mergeDurationSketches(items.map((item) => item[key]), exactLimit)])) as Record<K, DurationSketch>
}

export function scenarioTotalsOf(aggs: readonly ScenarioDayAgg[], exactLimit = DURATION_SKETCH_MERGE_EXACT_LIMIT): ScenarioTotals {
  const sum = (key: 'runs' | 'succeeded' | 'failed' | 'cancelled' | 'samples' | 'incomplete' | 'waitSamples' | 'totalSumMs' | 'waitSumMs') =>
    aggs.reduce((total, agg) => total + agg[key], 0)
  return {
    runs: sum('runs'),
    succeeded: sum('succeeded'),
    failed: sum('failed'),
    cancelled: sum('cancelled'),
    samples: sum('samples'),
    incomplete: sum('incomplete'),
    waitSamples: sum('waitSamples'),
    totalSumMs: sum('totalSumMs'),
    waitSumMs: sum('waitSumMs'),
    sketches: mergeSketchFields(
      SCENARIO_SKETCH_KEYS,
      aggs.map((agg) => agg.sketches),
      exactLimit,
    ),
  }
}

export interface NodeTotals {
  runs: number
  ok: number
  retried: number
  assisted: number
  iterationSum: number
  sketches: { active: DurationSketch; perIteration: DurationSketch }
  counts: NodeDailyCounts
  resolutions: Record<string, number>
}

export function nodeTotalsOf(aggs: readonly NodeDayAgg[], exactLimit = DURATION_SKETCH_MERGE_EXACT_LIMIT): NodeTotals {
  const resolutions: Record<string, number> = {}
  for (const agg of aggs) for (const [key, count] of Object.entries(agg.resolutions)) resolutions[key] = (resolutions[key] ?? 0) + count
  const active = mergeDurationSketches(
    aggs.map((agg) => agg.sketches.active),
    exactLimit,
  )
  // 当天节点都恰好迭代一次时没有另存，每次迭代的耗时就是执行耗时
  const perIteration = aggs.some((agg) => agg.sketches.perIteration)
    ? mergeDurationSketches(
        aggs.map((agg) => agg.sketches.perIteration ?? agg.sketches.active),
        exactLimit,
      )
    : active
  return {
    runs: aggs.reduce((total, agg) => total + agg.runs, 0),
    ok: aggs.reduce((total, agg) => total + agg.ok, 0),
    retried: aggs.reduce((total, agg) => total + agg.retried, 0),
    assisted: aggs.reduce((total, agg) => total + agg.assisted, 0),
    iterationSum: aggs.reduce((total, agg) => total + agg.iterationSum, 0),
    sketches: { active, perIteration },
    counts: {
      attempt: mergeDurationCounts(aggs.map((agg) => agg.counts.attempt)),
      iteration: mergeDurationCounts(aggs.map((agg) => agg.counts.iteration)),
    },
    resolutions,
  }
}

// ---------------------------------------------------------------------------
// 事实明细取数（汇总重算与明细读路径共用）
// ---------------------------------------------------------------------------

function triggerPredicate(db: Db, trigger: DurationAnalysisQueryParsed['trigger']): SQL | undefined {
  const { runDurationFacts } = schemaFor(db)
  return trigger === 'all' ? undefined : eq(runDurationFacts.triggerSource, trigger)
}

/** 读运行事实明细：完成时刻倒序，给了上限就多取一条判截断。 */
export async function loadRunFactRows(db: Db, where: SQL | undefined, limit?: number): Promise<{ rows: RunSample[]; truncated: boolean }> {
  const { runDurationFacts: f, runs } = schemaFor(db)
  const query = db
    .select({
      runId: f.runId,
      scenarioId: f.scenarioId,
      scenarioVersionId: f.scenarioVersionId,
      targetId: f.targetId,
      triggerSource: f.triggerSource,
      suiteRunId: f.suiteRunId,
      suiteMemberId: runs.suiteMemberId,
      status: f.status,
      createdAt: runs.createdAt,
      startedAt: runs.startedAt,
      finishedAt: f.finishedAt,
      totalMs: f.totalMs,
      activeMs: f.activeMs,
      authWaitMs: f.authWaitMs,
      requeueMs: f.requeueMs,
      reviewMs: f.reviewMs,
      queueMs: f.queueMs,
      overheadMs: f.overheadMs,
      complete: f.complete,
    })
    .from(f)
    .innerJoin(runs, eq(runs.id, f.runId))
    .where(and(where, isNull(runs.deletedAt), isNotNull(f.finishedAt)))
    .orderBy(desc(f.finishedAt), desc(f.runId))
  const rows = limit === undefined ? await query : await query.limit(limit + 1)
  const truncated = limit !== undefined && rows.length > limit
  return {
    rows: (truncated ? rows.slice(0, limit) : rows).map((row) => ({ ...row, finishedAt: row.finishedAt! })),
    truncated,
  }
}

/** 读节点事实明细（只读可比运行）；按所属运行的完成时刻过滤与归日。 */
export async function loadNodeFactRows(db: Db, where: SQL | undefined, limit?: number): Promise<NodeSample[]> {
  const { runNodeDurationFacts: n, runDurationFacts: f, runs } = schemaFor(db)
  const query = db
    .select({
      runId: n.runId,
      scenarioId: n.scenarioId,
      targetId: f.targetId,
      triggerSource: f.triggerSource,
      nodeKey: n.nodeKey,
      parentKey: n.parentKey,
      kind: n.kind,
      name: n.name,
      ordinal: n.ordinal,
      status: n.status,
      activeMs: n.activeMs,
      attemptCount: n.attemptCount,
      iterationCount: n.iterationCount,
      maxResolution: n.maxResolution,
      finishedAt: n.finishedAt,
      runFinishedAt: f.finishedAt,
      scenarioVersionId: f.scenarioVersionId,
    })
    .from(n)
    .innerJoin(f, eq(f.runId, n.runId))
    .innerJoin(runs, eq(runs.id, n.runId))
    .where(and(where, eq(f.comparable, true), isNull(runs.deletedAt), isNotNull(f.finishedAt)))
  const rows = limit === undefined ? await query : await query.limit(limit)
  return rows.map((row) => ({ ...row, finishedAt: row.finishedAt ?? row.runFinishedAt!, runFinishedAt: row.runFinishedAt! }))
}

/** 有子节点的（场景、父节点）集合：明细路径给节点行标「可展开」。 */
async function parentKeysWithChildren(db: Db, where: SQL | undefined): Promise<Set<string>> {
  const { runNodeDurationFacts: n, runDurationFacts: f, runs } = schemaFor(db)
  const rows = await db
    .selectDistinct({ scenarioId: n.scenarioId, parentKey: n.parentKey })
    .from(n)
    .innerJoin(f, eq(f.runId, n.runId))
    .innerJoin(runs, eq(runs.id, n.runId))
    .where(and(where, isNotNull(n.parentKey), eq(f.comparable, true), isNull(runs.deletedAt)))
  return new Set(rows.map((row) => `${row.scenarioId}|${row.parentKey}`))
}

// ---------------------------------------------------------------------------
// 统计时区、脏键与整行重算
// ---------------------------------------------------------------------------

/** 平台统计时区；只读，配置还没初始化时用出厂值（不在业务事务里顺手建配置）。 */
export async function statisticsTimeZone(db: Db): Promise<string> {
  return (await getPlatformConfig(db))?.document.statistics.timeZone ?? DEFAULT_STATISTICS_TIME_ZONE
}

/**
 * 登记需要重算的（场景、统计日）。必须与改变事实的写入同一事务：事实写入 / 重算、运行删除。
 * 重复登记忽略；作业先取走脏键再重算，重算期间的新写入会重新登记，不会漏。
 */
export async function markDurationRollupDirty(
  tx: Db,
  items: ReadonlyArray<{ scenarioId: string | null; finishedAt: Date | null }>,
  timeZone?: string,
): Promise<void> {
  const valid = items.filter((item): item is { scenarioId: string; finishedAt: Date } => Boolean(item.scenarioId && item.finishedAt))
  if (valid.length === 0) return
  const tz = timeZone ?? (await statisticsTimeZone(tx))
  const now = await clockNow(tx)
  const keys = new Map<string, { scenarioId: string; statDay: string; createdAt: Date }>()
  for (const item of valid) {
    const statDay = localDateOf(item.finishedAt, tz)
    keys.set(`${item.scenarioId}|${statDay}`, { scenarioId: item.scenarioId, statDay, createdAt: now })
  }
  const { durationRollupDirty } = schemaFor(tx)
  const rows = [...keys.values()]
  for (let i = 0; i < rows.length; i += 500) await insertIgnoreRows(tx, durationRollupDirty, rows.slice(i, i + 500))
}

/** 按（场景、统计日）从事实表整行重算汇总（覆盖写，重复执行结果一致）。 */
export async function recomputeDurationRollupDay(db: Db, scenarioId: string, statDay: string, timeZone: string): Promise<void> {
  const from = zonedStartOfDay(statDay, timeZone)
  const to = zonedStartOfDay(shiftLocalDate(statDay, 1), timeZone)
  await atomic(db, async (tx) => {
    const { durationScenarioDaily: s, durationNodeDaily: nd, runDurationFacts: f, scenarios } = schemaFor(tx)
    await tx.delete(s).where(and(eq(s.scenarioId, scenarioId), eq(s.statDay, statDay)))
    await tx.delete(nd).where(and(eq(nd.scenarioId, scenarioId), eq(nd.statDay, statDay)))
    const [scenario] = await tx.select({ id: scenarios.id }).from(scenarios).where(eq(scenarios.id, scenarioId)).limit(1)
    if (!scenario) return
    const range = and(eq(f.scenarioId, scenarioId), eq(f.comparable, true), gte(f.finishedAt, from), lt(f.finishedAt, to))
    const { rows } = await loadRunFactRows(tx, range)
    if (rows.length === 0) return
    const now = await clockNow(tx)
    const aggs = aggregateRunSamples(rows, timeZone)
    await tx.insert(s).values(
      aggs.map((agg) => ({
        scenarioId: agg.scenarioId,
        statDay: agg.statDay,
        triggerSource: agg.triggerSource,
        scenarioVersionId: agg.scenarioVersionId,
        targetId: agg.targetId,
        runs: agg.runs,
        succeeded: agg.succeeded,
        failed: agg.failed,
        cancelled: agg.cancelled,
        samples: agg.samples,
        incomplete: agg.incomplete,
        waitSamples: agg.waitSamples,
        totalSumMs: agg.totalSumMs,
        waitSumMs: agg.waitSumMs,
        activeSketch: compactDurationSketch(agg.sketches.active),
        overheadSketch: compactDurationSketch(agg.sketches.overhead),
        queueStandaloneSketch: compactDurationSketch(agg.sketches.queueStandalone),
        totalOkSketch: compactDurationSketch(agg.sketches.totalOk),
        detailSketches: {
          total: compactDurationSketch(agg.sketches.total),
          authWait: compactDurationSketch(agg.sketches.authWait),
          requeue: compactDurationSketch(agg.sketches.requeue),
          review: compactDurationSketch(agg.sketches.review),
          queue: compactDurationSketch(agg.sketches.queue),
        },
        firstFinishedAt: agg.firstFinishedAt,
        lastFinishedAt: agg.lastFinishedAt,
        updatedAt: now,
      })),
    )
    const nodes = await loadNodeFactRows(tx, range)
    const parents = new Set(nodes.filter((node) => node.parentKey !== null).map((node) => `${node.scenarioId}|${node.parentKey}`))
    const nodeAggs = aggregateNodeSamples(nodes, timeZone, { hasChildren: (sid, key) => parents.has(`${sid}|${key}`) })
    for (let i = 0; i < nodeAggs.length; i += 200) {
      await tx.insert(nd).values(
        nodeAggs.slice(i, i + 200).map((agg) => ({
          scenarioId: agg.scenarioId,
          nodeKey: agg.nodeKey,
          statDay: agg.statDay,
          triggerSource: agg.triggerSource,
          scenarioVersionId: agg.scenarioVersionId,
          targetId: agg.targetId,
          kind: agg.kind,
          name: agg.name.slice(0, 512),
          ordinal: agg.ordinal,
          hasChildren: agg.hasChildren,
          runs: agg.runs,
          ok: agg.ok,
          retried: agg.retried,
          assisted: agg.assisted,
          iterationSum: agg.iterationSum,
          activeSketch: compactDurationSketch(agg.sketches.active),
          perIterationSketch: agg.sketches.perIteration ? compactDurationSketch(agg.sketches.perIteration) : null,
          counts: agg.counts,
          resolutions: agg.resolutions,
          lastFinishedAt: agg.lastFinishedAt,
          updatedAt: now,
        })),
      )
    }
  })
}

// ---------------------------------------------------------------------------
// 汇总状态与后台作业
// ---------------------------------------------------------------------------

export interface DurationRollupState {
  timeZone: string
  ready: boolean
}

/** 汇总状态；时区或口径变了就清空重建（重建完成前读路径退回明细）。 */
async function ensureRollupState(db: Db, timeZone: string): Promise<{ ready: boolean; backfill: DurationRollupBackfillState; reset: boolean }> {
  return atomic(db, async (tx) => {
    const { durationRollupState: st, durationScenarioDaily, durationNodeDaily, durationRollupDirty } = schemaFor(tx)
    const now = await clockNow(tx)
    const [state] = await locked(tx, tx.select().from(st).where(eq(st.key, STATE_ID)))
    if (state && state.timeZone === timeZone && state.calcVersion === DURATION_ROLLUP_CALC_VERSION) {
      return { ready: state.ready, backfill: state.backfillCursor ?? null, reset: false }
    }
    await tx.delete(durationScenarioDaily)
    await tx.delete(durationNodeDaily)
    await tx.delete(durationRollupDirty)
    const fresh = { timeZone, calcVersion: DURATION_ROLLUP_CALC_VERSION, ready: false, backfillCursor: null, updatedAt: now }
    if (state) await tx.update(st).set(fresh).where(eq(st.key, STATE_ID))
    else await insertIgnoreRows(tx, st, { key: STATE_ID, ...fresh })
    return { ready: false, backfill: null, reset: true }
  })
}

export async function readDurationRollupState(db: Db): Promise<DurationRollupState | null> {
  const { durationRollupState: st } = schemaFor(db)
  const [state] = await db.select({ timeZone: st.timeZone, ready: st.ready, calcVersion: st.calcVersion }).from(st).where(eq(st.key, STATE_ID)).limit(1)
  if (!state || state.calcVersion !== DURATION_ROLLUP_CALC_VERSION) return null
  return { timeZone: state.timeZone, ready: state.ready }
}

/** 重建时把全部可比事实的（场景、统计日）分页登记为脏键。 */
async function backfillStep(db: Db, timeZone: string, cursor: DurationRollupBackfillState, pageSize: number): Promise<{ next: DurationRollupBackfillState; marked: number }> {
  if (cursor && 'done' in cursor) return { next: cursor, marked: 0 }
  const { runDurationFacts: f, durationRollupState: st } = schemaFor(db)
  const after = cursor
    ? or(gt(f.finishedAt, new Date(cursor.finishedAt)), and(eq(f.finishedAt, new Date(cursor.finishedAt)), gt(f.runId, cursor.runId)))
    : undefined
  const page = await db
    .select({ runId: f.runId, scenarioId: f.scenarioId, finishedAt: f.finishedAt })
    .from(f)
    .where(and(isNotNull(f.finishedAt), eq(f.comparable, true), after))
    .orderBy(asc(f.finishedAt), asc(f.runId))
    .limit(pageSize)
  const last = page.at(-1)
  const next: DurationRollupBackfillState = page.length < pageSize || !last ? { done: true } : { finishedAt: last.finishedAt!.toISOString(), runId: last.runId }
  await atomic(db, async (tx) => {
    await markDurationRollupDirty(tx, page, timeZone)
    await tx.update(st).set({ backfillCursor: next, updatedAt: await clockNow(tx) }).where(eq(st.key, STATE_ID))
  })
  return { next, marked: page.length }
}

export interface DurationRollupTickResult {
  recomputed: number
  backfilled: number
  failed: number
  ready: boolean
  reset: boolean
  lastError?: string
}

/**
 * analyst 作业一轮：确认状态（必要时清空重建）→ 重建中则分页登记脏键 → 分批消费脏键整行重算 →
 * 回扫完成且脏键清空时标记就绪。每轮有时间预算（缺省 5 秒），重建大量历史时一轮多做几批，不拖住作业循环。
 * 脏键先取走再重算：多实例只有取走的那个算，重算期间的新写入会重新登记，不会漏。
 */
export async function processDurationRollups(
  db: Db,
  options: { limit?: number; backfillPageSize?: number; timeBudgetMs?: number } = {},
): Promise<DurationRollupTickResult> {
  const limit = options.limit ?? 200
  const deadline = Date.now() + (options.timeBudgetMs ?? 5_000)
  const timeZone = await statisticsTimeZone(db)
  const state = await ensureRollupState(db, timeZone)
  const result: DurationRollupTickResult = { recomputed: 0, backfilled: 0, failed: 0, ready: state.ready, reset: state.reset }
  let backfill = state.backfill
  if (!state.ready) {
    do {
      const step = await backfillStep(db, timeZone, backfill, options.backfillPageSize ?? 2000)
      backfill = step.next
      result.backfilled += step.marked
    } while (!(backfill && 'done' in backfill) && Date.now() < deadline)
  }
  const { durationRollupDirty: d, durationRollupState: st } = schemaFor(db)
  while (Date.now() < deadline) {
    const keys = await db.select().from(d).orderBy(asc(d.createdAt), asc(d.scenarioId), asc(d.statDay)).limit(limit)
    if (keys.length === 0) break
    for (const key of keys) {
      const claimed = await deleteRows(db, d, and(eq(d.scenarioId, key.scenarioId), eq(d.statDay, key.statDay)), { scenarioId: d.scenarioId })
      if (claimed.length === 0) continue
      try {
        await recomputeDurationRollupDay(db, key.scenarioId, key.statDay, timeZone)
        result.recomputed += 1
      } catch (error) {
        result.failed += 1
        result.lastError = `${key.scenarioId} ${key.statDay}: ${error instanceof Error ? error.message : String(error)}`
        await insertIgnoreRows(db, d, { scenarioId: key.scenarioId, statDay: key.statDay, createdAt: await clockNow(db) })
      }
    }
    if (keys.length < limit || result.failed > 0) break
  }
  if (!state.ready && backfill && 'done' in backfill) {
    const [left] = await db.select({ n: sql<number | string>`count(*)` }).from(d)
    if (Number(left?.n ?? 0) === 0) {
      await db.update(st).set({ ready: true, updatedAt: await clockNow(db) }).where(and(eq(st.key, STATE_ID), eq(st.timeZone, timeZone)))
      result.ready = true
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// 读：汇总优先，不满足条件时退回明细
// ---------------------------------------------------------------------------

export interface AggregateSource {
  source: 'rollup' | 'raw'
  /** 汇总路径下，窗口内仍有待重算的天（「最近数据整理中」）。 */
  settling: boolean
  /** 明细路径下运行过多、只取了最近的运行。 */
  truncated: boolean
}

export interface ScenarioAggLoad extends AggregateSource {
  aggs: ScenarioDayAgg[]
  /** 明细路径被截断时，实际取到的最早完成时刻（节点按同一截止时刻取）。 */
  rawFrom: Date | null
}

function dayRange(range: { from: Date; to: Date }, timeZone: string): { fromDay: string; toDay: string } {
  return { fromDay: localDateOf(range.from, timeZone), toDay: localDateOf(new Date(range.to.getTime() - 1), timeZone) }
}

async function rollupUsable(db: Db, timeZone: string): Promise<boolean> {
  const state = await readDurationRollupState(db)
  return Boolean(state?.ready && state.timeZone === timeZone)
}

async function hasDirtyDays(db: Db, scenarioIds: string[], fromDay: string, toDay: string): Promise<boolean> {
  const { durationRollupDirty: d } = schemaFor(db)
  const [row] = await db
    .select({ scenarioId: d.scenarioId })
    .from(d)
    .where(and(inArray(d.scenarioId, scenarioIds), gte(d.statDay, fromDay), lte(d.statDay, toDay)))
    .limit(1)
  return Boolean(row)
}

/** 汇总里的草图分列：页面只读前四项，分项（detail）只在周期报告给变慢 / 变快场景归因时读。 */
export type ScenarioSketchField = 'active' | 'overhead' | 'queueStandalone' | 'totalOk' | 'detail'
export const PAGE_SKETCH_FIELDS: readonly ScenarioSketchField[] = ['active', 'overhead', 'queueStandalone', 'totalOk']

/** 场景日聚合：统计时区且汇总就绪时读汇总（只读需要的草图列），否则现读明细（有上限）在内存里聚合。 */
export async function loadScenarioAggs(
  db: Db,
  input: {
    scenarioIds: string[]
    range: { from: Date; to: Date }
    trigger: DurationAnalysisQueryParsed['trigger']
    timeZone: string
    rawLimit: number
    fields?: readonly ScenarioSketchField[]
  },
): Promise<ScenarioAggLoad> {
  if (input.scenarioIds.length === 0) return { aggs: [], source: 'rollup', settling: false, truncated: false, rawFrom: null }
  if (await rollupUsable(db, input.timeZone)) {
    const fields = new Set(input.fields ?? PAGE_SKETCH_FIELDS)
    const { fromDay, toDay } = dayRange(input.range, input.timeZone)
    const { durationScenarioDaily: s } = schemaFor(db)
    const empty = emptyDurationSketch()
    const rows = await db
      .select({
        scenarioId: s.scenarioId,
        statDay: s.statDay,
        triggerSource: s.triggerSource,
        scenarioVersionId: s.scenarioVersionId,
        targetId: s.targetId,
        runs: s.runs,
        succeeded: s.succeeded,
        failed: s.failed,
        cancelled: s.cancelled,
        samples: s.samples,
        incomplete: s.incomplete,
        waitSamples: s.waitSamples,
        totalSumMs: s.totalSumMs,
        waitSumMs: s.waitSumMs,
        firstFinishedAt: s.firstFinishedAt,
        lastFinishedAt: s.lastFinishedAt,
        ...(fields.has('active') ? { activeSketch: s.activeSketch } : {}),
        ...(fields.has('overhead') ? { overheadSketch: s.overheadSketch } : {}),
        ...(fields.has('queueStandalone') ? { queueStandaloneSketch: s.queueStandaloneSketch } : {}),
        ...(fields.has('totalOk') ? { totalOkSketch: s.totalOkSketch } : {}),
        ...(fields.has('detail') ? { detailSketches: s.detailSketches } : {}),
      })
      .from(s)
      .where(
        and(
          inArray(s.scenarioId, input.scenarioIds),
          gte(s.statDay, fromDay),
          lte(s.statDay, toDay),
          input.trigger === 'all' ? undefined : eq(s.triggerSource, input.trigger),
        ),
      )
    const aggs: ScenarioDayAgg[] = rows.map((row) => {
      const { activeSketch, overheadSketch, queueStandaloneSketch, totalOkSketch, detailSketches, ...rest } = row as typeof row & {
        activeSketch?: DurationSketch
        overheadSketch?: DurationSketch
        queueStandaloneSketch?: DurationSketch
        totalOkSketch?: DurationSketch
        detailSketches?: { total: DurationSketch; authWait: DurationSketch; requeue: DurationSketch; review: DurationSketch; queue: DurationSketch }
      }
      return {
        ...rest,
        sketches: {
          active: activeSketch ?? empty,
          overhead: overheadSketch ?? empty,
          queueStandalone: queueStandaloneSketch ?? empty,
          totalOk: totalOkSketch ?? empty,
          total: detailSketches?.total ?? empty,
          authWait: detailSketches?.authWait ?? empty,
          requeue: detailSketches?.requeue ?? empty,
          review: detailSketches?.review ?? empty,
          queue: detailSketches?.queue ?? empty,
        },
      }
    })
    return { aggs, source: 'rollup', settling: await hasDirtyDays(db, input.scenarioIds, fromDay, toDay), truncated: false, rawFrom: null }
  }
  const { runDurationFacts: f } = schemaFor(db)
  const { rows, truncated } = await loadRunFactRows(
    db,
    and(inArray(f.scenarioId, input.scenarioIds), eq(f.comparable, true), gte(f.finishedAt, input.range.from), lt(f.finishedAt, input.range.to), triggerPredicate(db, input.trigger)),
    input.rawLimit,
  )
  return {
    aggs: aggregateRunSamples(rows, input.timeZone, DURATION_SKETCH_MERGE_EXACT_LIMIT),
    source: 'raw',
    settling: false,
    truncated,
    rawFrom: truncated ? (rows.at(-1)?.finishedAt ?? null) : null,
  }
}

/**
 * 节点日聚合。顶层节点（parentKey 为 null）在汇总就绪时读汇总；子节点只在展开时按单场景读明细。
 * rawFrom：明细路径下运行被截断时，节点按同一截止时刻取，口径一致。
 */
export async function loadNodeAggs(
  db: Db,
  input: {
    scenarioIds: string[]
    range: { from: Date; to: Date }
    trigger: DurationAnalysisQueryParsed['trigger']
    timeZone: string
    parentKey?: string | null
    rawFrom?: Date | null
  },
): Promise<NodeDayAgg[]> {
  if (input.scenarioIds.length === 0) return []
  const parentKey = input.parentKey ?? null
  if (parentKey === null && (await rollupUsable(db, input.timeZone))) {
    const { fromDay, toDay } = dayRange(input.range, input.timeZone)
    const { durationNodeDaily: nd } = schemaFor(db)
    const rows = await db
      .select()
      .from(nd)
      .where(
        and(
          inArray(nd.scenarioId, input.scenarioIds),
          gte(nd.statDay, fromDay),
          lte(nd.statDay, toDay),
          input.trigger === 'all' ? undefined : eq(nd.triggerSource, input.trigger),
        ),
      )
    return rows.map(({ updatedAt: _updatedAt, activeSketch, perIterationSketch, ...row }) => ({
      ...row,
      parentKey: null,
      sketches: { active: activeSketch, perIteration: perIterationSketch ?? null },
    }))
  }
  const { runNodeDurationFacts: n, runDurationFacts: f } = schemaFor(db)
  const from = input.rawFrom && input.rawFrom > input.range.from ? input.rawFrom : input.range.from
  const scope = and(inArray(n.scenarioId, input.scenarioIds), gte(f.finishedAt, from), lt(f.finishedAt, input.range.to), triggerPredicate(db, input.trigger))
  const [nodes, parents] = await Promise.all([
    loadNodeFactRows(db, and(scope, parentKey === null ? isNull(n.parentKey) : eq(n.parentKey, parentKey))),
    parentKeysWithChildren(db, scope),
  ])
  return aggregateNodeSamples(nodes, input.timeZone, {
    parentKey,
    hasChildren: (scenarioId, nodeKey) => parents.has(`${scenarioId}|${nodeKey}`),
    exactLimit: DURATION_SKETCH_MERGE_EXACT_LIMIT,
  })
}
