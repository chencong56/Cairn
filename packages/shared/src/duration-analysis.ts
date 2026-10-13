import { z } from 'zod'
import {
  DURATION_RESOLUTION_LEVELS,
  durationNodeKindSchema,
  formatDurationShort,
  nodeDurationFactsSchema,
  runDurationFactsSchema,
  type DurationAttribution,
} from './duration-facts.js'
import { DURATION_TRIGGER_FILTERS, durationPeriodKindSchema, localDateSchema } from './duration-period.js'
import { suiteExecutionModeSchema } from './suites.js'
import { entityIdSchema, utcInstantSchema } from './wire.js'

/**
 * 耗时分析报表契约（单次对比、按目标系统筛选、场景与节点、场景集、隐藏问题）。
 * 读法：只用可比运行；运行级分位只取成功运行，节点级只取成功节点；次数含全部可比运行。
 * 分位数为最近秩法（nearest-rank），与总览统计一致。
 */

export const DURATION_ANALYSIS_DAYS = [7, 30, 90] as const
export type DurationAnalysisDays = (typeof DURATION_ANALYSIS_DAYS)[number]

/** 环比：紧邻的上一个等长周期；同比：上周 / 上月 / 去年同期。 */
export const DURATION_COMPARE_MODES = ['prev_period', 'last_week', 'last_month', 'last_year'] as const
export type DurationCompareMode = (typeof DURATION_COMPARE_MODES)[number]
export const durationCompareModeSchema = z.enum(DURATION_COMPARE_MODES)


/** 低于该样本数不给分位涨跌，界面淡化显示。 */
export const DURATION_MIN_SAMPLES = 10
/** 单次查询的运行条数上限：超过时只取最近的运行并标注。 */
export const DURATION_RUN_ROW_LIMIT = 20_000
export const DURATION_TARGET_ROW_LIMIT = 200_000

const daysSchema = z.coerce
  .number()
  .int()
  .refine((value): value is DurationAnalysisDays => (DURATION_ANALYSIS_DAYS as readonly number[]).includes(value), {
    message: '时间窗只支持 7 / 30 / 90 天',
  })

export const durationAnalysisQuerySchema = z.object({
  days: daysSchema.default(30),
  granularity: z.enum(['day', 'week']).default('day'),
  compare: durationCompareModeSchema.default('prev_period'),
  trigger: z.enum(DURATION_TRIGGER_FILTERS).default('all'),
  tz: z.string().trim().min(1).max(64).optional(),
  /**
   * 自然周期：给了就忽略 days / granularity，按天分桶；对比只支持环比（prev_period）与同比去年（last_year）。
   * periodStart 缺省为最近一个已结束的周期（「上周」「上月」），须是周一 / 每月 1 日且周期已结束。
   */
  period: durationPeriodKindSchema.optional(),
  periodStart: localDateSchema.optional(),
})
export type DurationAnalysisQuery = z.input<typeof durationAnalysisQuerySchema>
export type DurationAnalysisQueryParsed = z.infer<typeof durationAnalysisQuerySchema>

export const targetDurationAnalysisQuerySchema = durationAnalysisQuerySchema.extend({
  suiteId: entityIdSchema.optional(),
})
export type TargetDurationAnalysisQuery = z.input<typeof targetDurationAnalysisQuerySchema>
export type TargetDurationAnalysisQueryParsed = z.infer<typeof targetDurationAnalysisQuerySchema>

export const nodeDurationHistoryQuerySchema = durationAnalysisQuerySchema.extend({
  nodeKey: z.string().min(1).max(192),
})
export type NodeDurationHistoryQuery = z.input<typeof nodeDurationHistoryQuerySchema>
export type NodeDurationHistoryQueryParsed = z.infer<typeof nodeDurationHistoryQuerySchema>

export const nodeDurationChildrenQuerySchema = durationAnalysisQuerySchema.extend({
  parentKey: z.string().min(1).max(192),
})
export type NodeDurationChildrenQuery = z.input<typeof nodeDurationChildrenQuerySchema>
export type NodeDurationChildrenQueryParsed = z.infer<typeof nodeDurationChildrenQuerySchema>

export const RUN_DURATION_COMPARE_MODES = ['previous', 'median10', 'none'] as const
export type RunDurationCompareMode = (typeof RUN_DURATION_COMPARE_MODES)[number]
export const runDurationQuerySchema = z.object({
  compare: z.enum(RUN_DURATION_COMPARE_MODES).default('previous'),
  baseRunId: entityIdSchema.optional(),
})
export type RunDurationQuery = z.input<typeof runDurationQuerySchema>
export type RunDurationQueryParsed = z.infer<typeof runDurationQuerySchema>

/** 最近秩分位数；输入须已升序。 */
export function durationPercentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index] ?? null
}

/** 涨跌百分比（保留 1 位小数）；任一侧样本不足或基数为 0 时为 null。 */
export function durationDeltaPct(current: number | null, base: number | null, currentSamples: number, baseSamples: number): number | null {
  if (current === null || base === null || base <= 0) return null
  if (currentSamples < DURATION_MIN_SAMPLES || baseSamples < DURATION_MIN_SAMPLES) return null
  return Math.round(((current - base) / base) * 1000) / 10
}

const nullableMs = z.number().nullable()

export const durationComparisonSchema = z.object({
  current: z.number().nullable(),
  base: z.number().nullable(),
  deltaPct: z.number().nullable(),
  currentSamples: z.number().int().nonnegative(),
  baseSamples: z.number().int().nonnegative(),
})
export type DurationComparison = z.infer<typeof durationComparisonSchema>

export const durationWindowSchema = z.object({
  from: utcInstantSchema,
  to: utcInstantSchema,
  baseFrom: utcInstantSchema,
  baseTo: utcInstantSchema,
  days: z.number().int(),
  granularity: z.enum(['day', 'week']),
  compare: durationCompareModeSchema,
  trigger: z.enum(DURATION_TRIGGER_FILTERS),
  tz: z.string(),
  minSamples: z.number().int(),
  /** 自然周期模式下的周期信息；滚动窗口时为 null。日期均为本地日期，结束日不含。 */
  period: durationPeriodKindSchema.nullable(),
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
  periodLabel: z.string().nullable(),
  baseLabel: z.string().nullable(),
})
export type DurationWindow = z.infer<typeof durationWindowSchema>

// ---------------------------------------------------------------------------
// 隐藏问题：报表侧标注，不改变任何运行结论
// ---------------------------------------------------------------------------

export const DURATION_INSIGHT_KINDS = [
  'slower',
  'faster',
  'wait_increase',
  'queue_increase',
  'overhead_increase',
  'retry_increase',
  'assist_increase',
  'volatile',
  'volume_change',
  'version_change',
  'model_increase',
  'page_increase',
] as const
export type DurationInsightKind = (typeof DURATION_INSIGHT_KINDS)[number]

/** 规则阈值：上线后按实际命中情况调整，暂不做平台配置。 */
export const DURATION_INSIGHT_RULES = Object.freeze({
  minSamples: DURATION_MIN_SAMPLES,
  slowerPct: 20,
  fasterPct: -20,
  waitRatioPoints: 10,
  queueIncreasePct: 50,
  queueIncreaseMinMs: 30_000,
  overheadIncreasePct: 50,
  overheadIncreaseMinMs: 10_000,
  retryRatePoints: 10,
  assistRatePoints: 10,
  volatileRatio: 3,
  volatileMinSamples: 20,
  volumeChangePct: 50,
  volumePerIterationStablePct: 20,
  versionChangePct: 20,
})

export const DURATION_INSIGHT_LABELS: Readonly<Record<DurationInsightKind, string>> = Object.freeze({
  slower: '明显变慢',
  faster: '明显变快',
  wait_increase: '等待变多',
  queue_increase: '排队变长',
  overhead_increase: '运行开销变大',
  retry_increase: '重试变多',
  assist_increase: '兜底变多',
  volatile: '波动大',
  volume_change: '数据量变化',
  version_change: '疑似改动导致',
  model_increase: '模型变慢',
  page_increase: '页面变慢',
})

export const durationInsightSchema = z.object({
  kind: z.enum(DURATION_INSIGHT_KINDS),
  scenarioId: entityIdSchema,
  scenarioName: z.string(),
  nodeKey: z.string().nullable(),
  nodeName: z.string().nullable(),
  /** 一句话说明：数值与提示方向。 */
  message: z.string(),
})
export type DurationInsight = z.infer<typeof durationInsightSchema>

/** 比例类指标（0..1）的对比：deltaPct 为百分点差。 */
export function ratioPointsDelta(current: number | null, base: number | null, currentSamples: number, baseSamples: number): number | null {
  if (current === null || base === null) return null
  if (currentSamples < DURATION_MIN_SAMPLES || baseSamples < DURATION_MIN_SAMPLES) return null
  return Math.round((current - base) * 1000) / 10
}

export interface ScenarioInsightStats {
  activeP50: DurationComparison
  activeP95: number | null
  /** 比例对比，deltaPct 为百分点差。 */
  waitRatio: DurationComparison
  queueP50: DurationComparison
  overheadP50: DurationComparison
  /** 窗口内最近一次发布前后的执行耗时 P50。 */
  versionSplit: { before: number | null; after: number | null; beforeSamples: number; afterSamples: number; versionNo: number | null } | null
}

export interface NodeInsightStats {
  p50: DurationComparison
  retryRate: DurationComparison
  assistedRate: DurationComparison
  medianIterations: { current: number | null; base: number | null }
  perIterationP50: { current: number | null; base: number | null }
  /** 单次尝试的模型 / 页面 P50。未测为 null。 */
  modelPerAttempt?: DurationComparison
  pagePerAttempt?: DurationComparison
}

function pct(value: number): string {
  return `${value > 0 ? '+' : ''}${value}%`
}

function enoughSamples(c: DurationComparison): boolean {
  return c.currentSamples >= DURATION_INSIGHT_RULES.minSamples && c.baseSamples >= DURATION_INSIGHT_RULES.minSamples
}

/** 场景（运行级）隐藏问题。只做报表标注，不改变运行结论。 */
export function detectScenarioInsights(subject: { scenarioId: string; scenarioName: string }, stats: ScenarioInsightStats): DurationInsight[] {
  const rules = DURATION_INSIGHT_RULES
  const out: DurationInsight[] = []
  const push = (kind: DurationInsightKind, message: string) =>
    out.push({ kind, scenarioId: subject.scenarioId, scenarioName: subject.scenarioName, nodeKey: null, nodeName: null, message })
  const active = stats.activeP50
  if (active.deltaPct !== null && active.current !== null && active.base !== null) {
    if (active.deltaPct >= rules.slowerPct) {
      push('slower', `执行耗时 P50 ${formatDurationShort(active.base)} → ${formatDurationShort(active.current)}（${pct(active.deltaPct)}），执行变慢`)
    } else if (active.deltaPct <= rules.fasterPct) {
      push('faster', `执行耗时 P50 ${formatDurationShort(active.base)} → ${formatDurationShort(active.current)}（${pct(active.deltaPct)}）`)
    }
  }
  const wait = stats.waitRatio
  if (wait.deltaPct !== null && wait.deltaPct >= rules.waitRatioPoints && wait.current !== null) {
    push('wait_increase', `等待占总耗时 ${Math.round((wait.base ?? 0) * 100)}% → ${Math.round(wait.current * 100)}%，多半是账号会话、人工登录或执行节点问题，而非页面`)
  }
  const queue = stats.queueP50
  if (enoughSamples(queue) && queue.current !== null && queue.base !== null && queue.current >= queue.base * (1 + rules.queueIncreasePct / 100) && queue.current - queue.base >= rules.queueIncreaseMinMs) {
    push('queue_increase', `开跑前排队 P50 ${formatDurationShort(queue.base)} → ${formatDurationShort(queue.current)}，执行节点或账号并发可能不足`)
  }
  const overhead = stats.overheadP50
  if (enoughSamples(overhead) && overhead.current !== null && overhead.base !== null && overhead.current >= overhead.base * (1 + rules.overheadIncreasePct / 100) && overhead.current - overhead.base >= rules.overheadIncreaseMinMs) {
    push('overhead_increase', `运行开销 P50 ${formatDurationShort(overhead.base)} → ${formatDurationShort(overhead.current)}，会话获取或自动登录变慢、会话复用可能失效`)
  }
  if (active.current !== null && stats.activeP95 !== null && active.current > 0 && active.currentSamples >= rules.volatileMinSamples && stats.activeP95 / active.current >= rules.volatileRatio) {
    push('volatile', `执行耗时 P95 是 P50 的 ${(stats.activeP95 / active.current).toFixed(1)} 倍，运行不稳定，平均值不可信`)
  }
  const split = stats.versionSplit
  if (split && split.before !== null && split.after !== null && split.before > 0 && split.beforeSamples >= rules.minSamples && split.afterSamples >= rules.minSamples) {
    const diff = Math.round(((split.after - split.before) / split.before) * 1000) / 10
    if (Math.abs(diff) >= rules.versionChangePct) {
      push('version_change', `${split.versionNo ? `v${split.versionNo} ` : ''}发布前后执行耗时 P50 ${formatDurationShort(split.before)} → ${formatDurationShort(split.after)}（${pct(diff)}），疑似场景改动引起`)
    }
  }
  return out
}

/** 节点级隐藏问题。 */
export function detectNodeInsights(
  subject: { scenarioId: string; scenarioName: string; nodeKey: string; nodeName: string },
  stats: NodeInsightStats,
): DurationInsight[] {
  const rules = DURATION_INSIGHT_RULES
  const out: DurationInsight[] = []
  const push = (kind: DurationInsightKind, message: string) =>
    out.push({ kind, scenarioId: subject.scenarioId, scenarioName: subject.scenarioName, nodeKey: subject.nodeKey, nodeName: subject.nodeName, message })
  const { current: iterNow, base: iterBase } = stats.medianIterations
  const volumeChanged =
    iterNow !== null && iterBase !== null && iterBase > 0 && Math.max(iterNow, iterBase) > 1 &&
    Math.abs((iterNow - iterBase) / iterBase) * 100 >= rules.volumeChangePct
  const perNow = stats.perIterationP50.current
  const perBase = stats.perIterationP50.base
  const perStable = perNow !== null && perBase !== null && perBase > 0 && Math.abs((perNow - perBase) / perBase) * 100 < rules.volumePerIterationStablePct
  if (volumeChanged && perStable && enoughSamples(stats.p50)) {
    push('volume_change', `迭代次数中位数 ${iterBase} → ${iterNow}，单次迭代耗时基本不变：是数据量变化，不是性能问题`)
  } else {
    const p = stats.p50
    if (p.deltaPct !== null && p.current !== null && p.base !== null) {
      if (p.deltaPct >= rules.slowerPct) push('slower', `P50 ${formatDurationShort(p.base)} → ${formatDurationShort(p.current)}（${pct(p.deltaPct)}）`)
      else if (p.deltaPct <= rules.fasterPct) push('faster', `P50 ${formatDurationShort(p.base)} → ${formatDurationShort(p.current)}（${pct(p.deltaPct)}）`)
    }
  }
  const retry = stats.retryRate
  const retryNow = retry.current
  const retryUp = retry.deltaPct !== null && retry.deltaPct >= rules.retryRatePoints && retryNow !== null
  if (retryUp && retryNow !== null) {
    push('retry_increase', `重试率 ${Math.round((retry.base ?? 0) * 100)}% → ${Math.round(retryNow * 100)}%，定位不稳或页面响应慢`)
  }
  const modelPer = stats.modelPerAttempt
  if (modelPer && enoughSamples(modelPer) && modelPer.deltaPct !== null && modelPer.deltaPct >= rules.slowerPct && !(retryUp && modelPer.deltaPct < rules.slowerPct)) {
    push('model_increase', `单次模型 P50 ${formatDurationShort(modelPer.base ?? 0)} → ${formatDurationShort(modelPer.current ?? 0)}（${pct(modelPer.deltaPct)}），模型变慢`)
  }
  const pagePer = stats.pagePerAttempt
  if (pagePer && enoughSamples(pagePer) && pagePer.deltaPct !== null && pagePer.deltaPct >= rules.slowerPct && !(retryUp && pagePer.deltaPct < rules.slowerPct)) {
    push('page_increase', `单次页面 P50 ${formatDurationShort(pagePer.base ?? 0)} → ${formatDurationShort(pagePer.current ?? 0)}（${pct(pagePer.deltaPct)}），页面变慢`)
  }
  const assisted = stats.assistedRate
  if (assisted.deltaPct !== null && assisted.deltaPct >= rules.assistRatePoints && assisted.current !== null) {
    push('assist_increase', `用到地图 / AI 定位的比例 ${Math.round((assisted.base ?? 0) * 100)}% → ${Math.round(assisted.current * 100)}%，定位漂移，建议维护`)
  }
  return out
}

// ---------------------------------------------------------------------------
// 单次对比
// ---------------------------------------------------------------------------

const componentDeltaSchema = z.object({ base: nullableMs, target: nullableMs, delta: nullableMs })
const resolutionLevelSchema = z.enum(DURATION_RESOLUTION_LEVELS)
const attributionTagSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('retries'), from: z.number(), to: z.number() }),
  z.object({ kind: z.literal('iterations'), from: z.number(), to: z.number(), perIterationDeltaPct: z.number().nullable() }),
  z.object({ kind: z.literal('resolution'), from: resolutionLevelSchema.nullable(), to: resolutionLevelSchema.nullable() }),
  z.object({ kind: z.literal('model'), from: z.number(), to: z.number() }),
  z.object({ kind: z.literal('page'), from: z.number(), to: z.number() }),
  z.object({ kind: z.literal('added') }),
  z.object({ kind: z.literal('removed') }),
])

export const durationAttributionSchema: z.ZodType<DurationAttribution> = z.object({
  totalDeltaMs: nullableMs,
  components: z.object({
    active: componentDeltaSchema,
    authWait: componentDeltaSchema,
    requeue: componentDeltaSchema,
    review: componentDeltaSchema,
    hold: componentDeltaSchema,
    unclassified: componentDeltaSchema,
    queue: componentDeltaSchema,
    overhead: componentDeltaSchema,
  }),
  nodes: z.array(
    z.object({
      nodeKey: z.string(),
      parentKey: z.string().nullable(),
      kind: durationNodeKindSchema,
      name: z.string(),
      baseMs: nullableMs,
      targetMs: nullableMs,
      deltaMs: nullableMs,
      deltaPct: z.number().nullable(),
      tags: z.array(attributionTagSchema),
    }),
  ),
  context: z.object({
    versionChanged: z.boolean(),
    accountChanged: z.boolean(),
    workerLost: z.object({ base: z.boolean(), target: z.boolean() }),
    incomplete: z.object({ base: z.boolean(), target: z.boolean() }),
  }),
}) as z.ZodType<DurationAttribution>

export const RUN_DURATION_UNAVAILABLE_REASONS = ['first_run', 'no_successful_base', 'base_not_found', 'base_mismatch'] as const
export type RunDurationUnavailableReason = (typeof RUN_DURATION_UNAVAILABLE_REASONS)[number]

export const runDurationReadoutSchema = z.object({
  facts: runDurationFactsSchema,
  nodes: z.array(nodeDurationFactsSchema),
  source: z.enum(['stored', 'computed']),
  comparison: z
    .object({
      mode: z.enum(['previous', 'median10', 'run']),
      /** 当前是试跑时对比上一条试跑。 */
      trial: z.boolean(),
      baseRunId: entityIdSchema.nullable(),
      baseFinishedAt: utcInstantSchema.nullable(),
      baseSamples: z.number().int().nonnegative(),
      baseScenarioVersionId: entityIdSchema.nullable(),
      attribution: durationAttributionSchema,
      summary: z.string(),
    })
    .nullable(),
  comparisonUnavailable: z.enum(RUN_DURATION_UNAVAILABLE_REASONS).nullable(),
})
export type RunDurationReadout = z.infer<typeof runDurationReadoutSchema>

// ---------------------------------------------------------------------------
// 场景耗时分析
// ---------------------------------------------------------------------------

export const scenarioDurationBucketSchema = z.object({
  /** 本地日期（YYYY-MM-DD）；周粒度为该周周一。 */
  bucket: z.string(),
  runs: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  samples: z.number().int().nonnegative(),
  activeP50: nullableMs,
  activeP95: nullableMs,
  totalP50: nullableMs,
  /** 等待（认证 + 重新排队 + 待核查）占总耗时之比。 */
  waitRatio: z.number().nullable(),
})
export type ScenarioDurationBucket = z.infer<typeof scenarioDurationBucketSchema>

export const durationNodeRowSchema = z.object({
  nodeKey: z.string(),
  parentKey: z.string().nullable(),
  kind: durationNodeKindSchema,
  name: z.string(),
  ordinal: z.number().int(),
  /** 有子节点（模块内部步骤、检查等），展开时按单场景另读。 */
  hasChildren: z.boolean(),
  samples: z.number().int().nonnegative(),
  baseSamples: z.number().int().nonnegative(),
  activeP50: nullableMs,
  modelP50: nullableMs.default(null),
  pageP50: nullableMs.default(null),
  activeP95: nullableMs,
  baseP50: nullableMs,
  deltaPct: z.number().nullable(),
  retryRate: z.number().nullable(),
  avgIterations: z.number().nullable(),
  /** 用到地图 / AI 定位的比例。 */
  assistedRate: z.number().nullable(),
  sparkline: z.array(z.number().nullable()),
  tags: z.array(z.enum(['new', 'removed'])),
  insights: z.array(durationInsightSchema),
})
export type DurationNodeRow = z.infer<typeof durationNodeRowSchema>

/**
 * 本次统计用的数据：rollup = 按天汇总（统计时区），raw = 现读明细（其它时区或汇总重建中）。
 * settling：窗口内还有天的汇总在整理（新完成的运行稍后计入）。
 */
export const durationAggregationSchema = z.object({
  source: z.enum(['rollup', 'raw']),
  settling: z.boolean(),
})
export type DurationAggregation = z.infer<typeof durationAggregationSchema>

export const durationVersionBoundarySchema = z.object({
  at: utcInstantSchema,
  scenarioVersionId: entityIdSchema,
  versionNo: z.number().int().nullable(),
})
export type DurationVersionBoundary = z.infer<typeof durationVersionBoundarySchema>

export const scenarioDurationAnalysisSchema = z.object({
  scenario: z.object({ id: entityIdSchema, name: z.string(), targetId: entityIdSchema, targetName: z.string() }),
  window: durationWindowSchema,
  kpis: z.object({
    runs: z.number().int().nonnegative(),
    samples: z.number().int().nonnegative(),
    activeP50: durationComparisonSchema,
    activeP95: durationComparisonSchema,
    totalP50: durationComparisonSchema,
    waitRatio: durationComparisonSchema,
    queueP50: durationComparisonSchema,
  }),
  buckets: z.array(scenarioDurationBucketSchema),
  nodes: z.array(durationNodeRowSchema),
  versionBoundaries: z.array(durationVersionBoundarySchema),
  incompleteRuns: z.number().int().nonnegative(),
  truncated: z.boolean(),
  aggregation: durationAggregationSchema,
  insights: z.array(durationInsightSchema),
})
export type ScenarioDurationAnalysis = z.infer<typeof scenarioDurationAnalysisSchema>

/** 展开节点表某一行时读它的子节点。 */
export const nodeDurationChildrenSchema = z.object({
  parentKey: z.string(),
  window: durationWindowSchema,
  nodes: z.array(durationNodeRowSchema),
})
export type NodeDurationChildren = z.infer<typeof nodeDurationChildrenSchema>

export const nodeDurationHistorySchema = z.object({
  node: z.object({ nodeKey: z.string(), name: z.string(), kind: durationNodeKindSchema }),
  window: durationWindowSchema,
  points: z.array(
    z.object({
      runId: entityIdSchema,
      finishedAt: utcInstantSchema,
      activeMs: z.number(),
      attemptCount: z.number().int(),
      iterationCount: z.number().int(),
      status: z.string(),
      scenarioVersionId: entityIdSchema,
      maxResolution: resolutionLevelSchema.nullable(),
    }),
  ),
  buckets: z.array(z.object({ bucket: z.string(), p50: nullableMs, samples: z.number().int() })),
  versionBoundaries: z.array(durationVersionBoundarySchema),
  truncated: z.boolean(),
})
export type NodeDurationHistory = z.infer<typeof nodeDurationHistorySchema>

// ---------------------------------------------------------------------------
// 按目标系统筛选（可再按场景集）
// ---------------------------------------------------------------------------

export const targetDurationScenarioSchema = z.object({
  scenarioId: entityIdSchema,
  name: z.string(),
  runs: z.number().int().nonnegative(),
  samples: z.number().int().nonnegative(),
  activeP50: durationComparisonSchema,
  activeP95: nullableMs,
  series: z.array(z.object({ bucket: z.string(), p50: nullableMs, p95: nullableMs, runs: z.number().int() })),
  insights: z.array(durationInsightSchema),
})
export type TargetDurationScenario = z.infer<typeof targetDurationScenarioSchema>

export const suiteDurationSummarySchema = z.object({
  suiteId: entityIdSchema,
  name: z.string(),
  executionMode: suiteExecutionModeSchema,
  staged: z.boolean(),
  runs: z.number().int().nonnegative(),
  wallP50: durationComparisonSchema,
  wallP95: nullableMs,
  memberQueueP50: nullableMs,
  buckets: z.array(z.object({ bucket: z.string(), runs: z.number().int(), p50: nullableMs, p95: nullableMs })),
  /** 关键路径近似：阶段间串行；阶段内顺序执行取全部成员、并行取最慢成员。 */
  criticalPath: z.array(
    z.object({ memberId: z.string(), scenarioId: entityIdSchema, name: z.string(), stage: z.string(), p50: nullableMs }),
  ),
  criticalPathP50: nullableMs,
})
export type SuiteDurationSummary = z.infer<typeof suiteDurationSummarySchema>

export const targetDurationAnalysisSchema = z.object({
  target: z.object({ id: entityIdSchema, name: z.string() }),
  window: durationWindowSchema,
  kpis: z.object({
    runs: z.number().int().nonnegative(),
    activeP50: durationComparisonSchema,
    waitRatio: durationComparisonSchema,
    queueP50: durationComparisonSchema,
    slower: z.number().int().nonnegative(),
    faster: z.number().int().nonnegative(),
    insightCount: z.number().int().nonnegative(),
  }),
  scenarios: z.array(targetDurationScenarioSchema),
  suite: suiteDurationSummarySchema.nullable(),
  truncated: z.boolean(),
  aggregation: durationAggregationSchema,
})
export type TargetDurationAnalysis = z.infer<typeof targetDurationAnalysisSchema>

// ---------------------------------------------------------------------------
// 场景集运行对比
// ---------------------------------------------------------------------------

export const suiteRunDurationReadoutSchema = z.object({
  suiteRun: z.object({ id: entityIdSchema, startedAt: utcInstantSchema.nullable(), finishedAt: utcInstantSchema.nullable(), wallMs: nullableMs }),
  base: z.object({ id: entityIdSchema, startedAt: utcInstantSchema.nullable(), finishedAt: utcInstantSchema.nullable(), wallMs: nullableMs }).nullable(),
  wallDeltaMs: nullableMs,
  criticalPathDeltaMs: nullableMs,
  queueDeltaMs: nullableMs,
  members: z.array(
    z.object({
      memberId: z.string(),
      scenarioId: entityIdSchema,
      name: z.string(),
      stage: z.string(),
      runId: entityIdSchema.nullable(),
      baseRunId: entityIdSchema.nullable(),
      totalMs: nullableMs,
      baseTotalMs: nullableMs,
      deltaMs: nullableMs,
      queueMs: nullableMs,
      baseQueueMs: nullableMs,
      onCriticalPath: z.boolean(),
    }),
  ),
  summary: z.string(),
})
export type SuiteRunDurationReadout = z.infer<typeof suiteRunDurationReadoutSchema>
