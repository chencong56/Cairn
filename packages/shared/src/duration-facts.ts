import { z } from 'zod'
import { runStatusSchema, stepRunStatusSchema } from './run.js'
import { entityIdSchema, utcInstantSchema } from './wire.js'

/**
 * 耗时事实契约（耗时分析基座）。
 *
 * 口径：
 * - 总耗时 = finishedAt − startedAt（与运行超时、SLA、Webhook 同口径）。
 * - 执行耗时 = 状态时间线中 RUNNING 区间之和（正向求和：新增状态默认不计入执行）。
 * - 认证等待 / 重新排队 / 待核查 / 调试挂起 = WAITING_FOR_AUTH / RECOVERING / NEEDS_REVIEW / HOLDING 区间之和。
 * - 未归类 = 总耗时 − 以上各项：时钟偏差或事件缺口，正常≈0；超过阈值判事实不完整。
 * - 开跑前排队 = startedAt − createdAt，不计入总耗时。
 * - 运行开销 = 执行耗时 − 顶层节点执行耗时之和（钳为 ≥ 0）。
 * - 节点执行耗时 = 该节点在本次运行内全部 attempt 时长之和（含重试）。
 * - 执行耗时再拆：模型 ∪ 页面 ∪ 其余；重叠单独记账，不从执行耗时里减两次。
 *   无采集标记时 pageMs = null，不把未测量写成 0。
 *   其余是余数，不是新采集维度：墙钟减去已测模型区间与已测页面区间的并集。
 *   主要包括截图、元素定位、显式休眠、点击输入动作本身，以及步骤内编排；
 *   页面未测时，其余里仍含真实页面等待。没有这些区间的单独计时，不能再拆成真列。
 *
 * 精度边界：事件时间取写入进程的本机时钟，起止时间取数据库时钟；时间线只用运行事件一个来源，
 * 负区间钳为 0。执行节点失联到被回收之前仍是 RUNNING（最长一个租约周期），以 workerLost 标记提示。
 */

/** 运行发起方：谁让这次运行发生。与 execution_origin（装在什么容器里）是两个维度。 */
export const RUN_TRIGGER_SOURCES = ['manual', 'schedule', 'service'] as const
export type RunTriggerSource = (typeof RUN_TRIGGER_SOURCES)[number]
export const runTriggerSourceSchema = z.enum(RUN_TRIGGER_SOURCES)

/** 场景集运行没有服务调用入口。 */
export const SUITE_RUN_TRIGGER_SOURCES = ['manual', 'schedule'] as const
export type SuiteRunTriggerSource = (typeof SUITE_RUN_TRIGGER_SOURCES)[number]
export const suiteRunTriggerSourceSchema = z.enum(SUITE_RUN_TRIGGER_SOURCES)

/**
 * 计算规则版本。口径变化时 +1，事实作业会重算事件仍在的运行；事件已清理的运行保留运行级事实、只刷新节点事实。
 * 2：汇总节点（模块调用、场景级检查）的尝试数改为「迭代数 + 子节点重试之和」。
 * 3：节点与运行补模型 / 页面 / 重叠 / 其余。P1 起有采集标记才写 pageMs（含 0）。
 */
export const DURATION_FACTS_CALC_VERSION = 3

/** 未归类误差超过 max(绝对值, 总耗时 × 比例) 即判事实不完整。 */
export const DURATION_UNCLASSIFIED_TOLERANCE = Object.freeze({ absoluteMs: 1_000, ratio: 0.02 })

export const DURATION_NODE_KINDS = ['step', 'module', 'module_step', 'check', 'scenario_checks'] as const
export type DurationNodeKind = (typeof DURATION_NODE_KINDS)[number]
export const durationNodeKindSchema = z.enum(DURATION_NODE_KINDS)

/** 定位层级由低到高；与 resolution_decisions.decision_kind 的成功取值一致。 */
export const DURATION_RESOLUTION_LEVELS = ['deterministic', 'map', 'ai'] as const
export type DurationResolutionLevel = (typeof DURATION_RESOLUTION_LEVELS)[number]
export const durationResolutionLevelSchema = z.enum(DURATION_RESOLUTION_LEVELS)

export const DURATION_INCOMPLETE_REASONS = [
  'not_started',
  'in_progress',
  'no_events',
  'timeline_inconsistent',
  'unclassified_exceeds_tolerance',
] as const
export type DurationIncompleteReason = (typeof DURATION_INCOMPLETE_REASONS)[number]
export const durationIncompleteReasonSchema = z.enum(DURATION_INCOMPLETE_REASONS)

/** 步骤分段不完整：不影响运行级 complete，只说明模型 / 页面拆不开。 */
export const DURATION_COMPOSITION_INCOMPLETE_REASONS = [
  'model_duration_missing',
  'model_interval_missing',
  'model_unassigned',
  'page_interval_missing',
  'overlap_exceeds_active',
] as const
export type DurationCompositionIncompleteReason = (typeof DURATION_COMPOSITION_INCOMPLETE_REASONS)[number]
export const durationCompositionIncompleteReasonSchema = z.enum(DURATION_COMPOSITION_INCOMPLETE_REASONS)

/** 场景级检查合并成的顶层节点。 */
export const SCENARIO_CHECKS_NODE_KEY = 'scenario_checks'

export function stepNodeKey(stepId: string): string {
  return `step:${stepId}`
}
export function moduleNodeKey(invocationId: string): string {
  return `module:${invocationId}`
}
export function moduleStepNodeKey(invocationId: string, internalKey: string): string {
  return `module:${invocationId}/${internalKey}`
}
export function checkNodeKey(contractId: string): string {
  return `check:${contractId}`
}

const msSchema = z.number().int().nonnegative()

export const runDurationFactsSchema = z.strictObject({
  runId: entityIdSchema,
  targetId: entityIdSchema,
  scenarioId: entityIdSchema,
  scenarioVersionId: entityIdSchema,
  suiteRunId: entityIdSchema.nullable(),
  triggerSource: runTriggerSourceSchema,
  /** 可比运行：已发布版本且场景用途为 user。试跑、模块用例、修复验证、地图作业都不可比。 */
  comparable: z.boolean(),
  status: runStatusSchema,
  finishedAt: utcInstantSchema.nullable(),
  totalMs: msSchema.nullable(),
  /** 以下分解在事实不完整时为 null，不伪造。 */
  activeMs: msSchema.nullable(),
  authWaitMs: msSchema.nullable(),
  requeueMs: msSchema.nullable(),
  reviewMs: msSchema.nullable(),
  holdMs: msSchema.nullable(),
  /** 可为负（时钟偏差），绝对值在容差内。 */
  unclassifiedMs: z.number().int().nullable(),
  queueMs: msSchema.nullable(),
  overheadMs: msSchema.nullable(),
  /** 顶层节点模型耗时之和；不含运行开销。 */
  modelMs: msSchema.default(0),
  /** 顶层节点页面等待之和；无采集标记则为 null，不写成 0。 */
  pageMs: msSchema.nullable().default(null),
  overlapMs: msSchema.nullable().default(0),
  residualMs: msSchema.default(0),
  pagePartial: z.boolean().default(false),
  compositionIncompleteReasons: z.array(durationCompositionIncompleteReasonSchema).default([]),
  workerLost: z.boolean(),
  complete: z.boolean(),
  incompleteReason: durationIncompleteReasonSchema.nullable(),
  calcVersion: z.number().int().positive(),
})
export type RunDurationFacts = z.infer<typeof runDurationFactsSchema>

export const nodeDurationFactsSchema = z.strictObject({
  nodeKey: z.string().min(1).max(192),
  parentKey: z.string().min(1).max(192).nullable(),
  kind: durationNodeKindSchema,
  name: z.string(),
  ordinal: z.number().int().nonnegative(),
  status: stepRunStatusSchema,
  activeMs: msSchema,
  windowMs: msSchema.nullable(),
  attemptCount: z.number().int().nonnegative(),
  iterationCount: z.number().int().nonnegative(),
  maxResolution: durationResolutionLevelSchema.nullable(),
  modelMs: msSchema.default(0),
  pageMs: msSchema.nullable().default(null),
  overlapMs: msSchema.nullable().default(0),
  residualMs: msSchema.default(0),
  modelCallCount: z.number().int().nonnegative().default(0),
  pageWaitCount: z.number().int().nonnegative().default(0),
  pagePartial: z.boolean().default(false),
  compositionComplete: z.boolean().default(true),
  compositionIncompleteReasons: z.array(durationCompositionIncompleteReasonSchema).default([]),
})
export type NodeDurationFacts = z.infer<typeof nodeDurationFactsSchema>

export function defaultNodeComposition(activeMs = 0): Pick<
  NodeDurationFacts,
  | 'modelMs'
  | 'pageMs'
  | 'overlapMs'
  | 'residualMs'
  | 'modelCallCount'
  | 'pageWaitCount'
  | 'pagePartial'
  | 'compositionComplete'
  | 'compositionIncompleteReasons'
> {
  return {
    modelMs: 0,
    pageMs: null,
    overlapMs: 0,
    residualMs: activeMs,
    modelCallCount: 0,
    pageWaitCount: 0,
    pagePartial: false,
    compositionComplete: true,
    compositionIncompleteReasons: [],
  }
}

export function defaultRunComposition(): Pick<
  RunDurationFacts,
  'modelMs' | 'pageMs' | 'overlapMs' | 'residualMs' | 'pagePartial' | 'compositionIncompleteReasons'
> {
  return {
    modelMs: 0,
    pageMs: null,
    overlapMs: 0,
    residualMs: 0,
    pagePartial: false,
    compositionIncompleteReasons: [],
  }
}

/** 执行耗时拆成互斥切片：modelOnly + overlap + pageOnly + residual = active。无页面时 overlap = 0。 */
export function composeActiveDuration(input: {
  activeMs: number
  modelMs: number
  pageMs: number | null
  overlapMs: number | null
}): Pick<NodeDurationFacts, 'modelMs' | 'pageMs' | 'overlapMs' | 'residualMs'> {
  const modelMs = Math.max(0, Math.round(input.modelMs))
  if (input.pageMs === null) {
    return { modelMs, pageMs: null, overlapMs: 0, residualMs: Math.max(0, input.activeMs - modelMs) }
  }
  const pageMs = Math.max(0, Math.round(input.pageMs))
  if (input.overlapMs === null) {
    return { modelMs, pageMs, overlapMs: null, residualMs: Math.max(0, input.activeMs - Math.max(modelMs, pageMs)) }
  }
  const overlapMs = Math.max(0, Math.round(input.overlapMs))
  return {
    modelMs,
    pageMs,
    overlapMs,
    residualMs: Math.max(0, input.activeMs - (modelMs + pageMs - overlapMs)),
  }
}

/** 步骤表短名。 */
export const DURATION_COMPOSITION_LABELS = Object.freeze({
  active: '单步总耗时',
  model: '模型',
  page: '页面',
  residual: '其余',
})

const RESIDUAL_CONTENTS =
  '主要包括截图、元素定位、显式休眠、点击输入动作本身，以及步骤内编排。页面未测时，其余里仍含真实页面等待。'

export const DURATION_COMPOSITION_HELP = Object.freeze({
  active: '这一步从开始到结束的墙钟。',
  model: '已归到这一步的模型调用时长。没有调用时不出现这一列。',
  page: '平台为等待页面可用而阻塞的时间，不是 document.load。未采集时写 —，不写成 0。',
  residual: `单步总耗时减去已测的模型调用和页面等待。${RESIDUAL_CONTENTS}`,
})

/** 这一步（或这次运行）是否用过模型。没用不出现模型列。 */
export function usedModelDuration(input: { modelMs?: number | null; modelCallCount?: number | null }): boolean {
  return (input.modelMs ?? 0) > 0 || (input.modelCallCount ?? 0) > 0
}

export function durationResidualHelp(showModel: boolean): string {
  return showModel
    ? DURATION_COMPOSITION_HELP.residual
    : `单步总耗时减去已测的页面等待。${RESIDUAL_CONTENTS}`
}

/** 表下口径，别人问「其余是什么」时用这一句。 */
export function durationCompositionNote(showModel: boolean): string {
  return showModel
    ? `其余 = 单步总耗时 − 已测模型 − 已测页面。${RESIDUAL_CONTENTS}`
    : `其余 = 单步总耗时 − 已测页面。${RESIDUAL_CONTENTS}`
}

/** 展示用其余：执行 − 模型 − 页面（页面未测则只减模型）。分析行没有重叠分位时用这个扫列。 */
export function remainderMs(
  activeMs: number | null | undefined,
  modelMs: number | null | undefined,
  pageMs: number | null | undefined,
): number | null {
  if (activeMs == null || !Number.isFinite(activeMs)) return null
  return composeActiveDuration({
    activeMs,
    modelMs: modelMs ?? 0,
    pageMs: pageMs ?? null,
    overlapMs: 0,
  }).residualMs
}

export type ExclusiveDurationSlices = {
  mode: 'two' | 'four' | 'undetermined'
  modelOnly: number
  overlap: number
  pageOnly: number
  residual: number
}

/** 条上的互斥切片。无页面时只有模型 | 其余；重叠未测时不画条。 */
export function exclusiveSlicesOf(input: {
  modelMs: number
  pageMs: number | null
  overlapMs: number | null
  residualMs: number
}): ExclusiveDurationSlices {
  if (input.pageMs === null) {
    return { mode: 'two', modelOnly: input.modelMs, overlap: 0, pageOnly: 0, residual: input.residualMs }
  }
  if (input.overlapMs === null) {
    return { mode: 'undetermined', modelOnly: input.modelMs, overlap: 0, pageOnly: input.pageMs, residual: input.residualMs }
  }
  return {
    mode: 'four',
    modelOnly: Math.max(0, input.modelMs - input.overlapMs),
    overlap: input.overlapMs,
    pageOnly: Math.max(0, input.pageMs - input.overlapMs),
    residual: input.residualMs,
  }
}

export interface DurationInterval {
  start: number
  end: number
}

function normalizedIntervals(intervals: readonly DurationInterval[]): DurationInterval[] {
  return intervals
    .map((item) => ({ start: item.start, end: item.end }))
    .filter((item) => item.end > item.start)
    .sort((a, b) => a.start - b.start || a.end - b.end)
}

/** 区间并集时长（毫秒）。 */
export function unionIntervalMs(intervals: readonly DurationInterval[]): number {
  const ordered = normalizedIntervals(intervals)
  if (ordered.length === 0) return 0
  let total = 0
  let start = ordered[0]!.start
  let end = ordered[0]!.end
  for (const next of ordered.slice(1)) {
    if (next.start > end) {
      total += end - start
      start = next.start
      end = next.end
    } else if (next.end > end) {
      end = next.end
    }
  }
  return total + (end - start)
}

/** 两组区间交集时长（毫秒）。 */
export function intersectIntervalMs(left: readonly DurationInterval[], right: readonly DurationInterval[]): number {
  const a = normalizedIntervals(left)
  const b = normalizedIntervals(right)
  let i = 0
  let j = 0
  let total = 0
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i]!.start, b[j]!.start)
    const end = Math.min(a[i]!.end, b[j]!.end)
    if (end > start) total += end - start
    if (a[i]!.end < b[j]!.end) i += 1
    else j += 1
  }
  return total
}

export interface AttemptCompositionInput {
  activeMs: number
  modelCalls: ReadonlyArray<{ durationMs: number | null; startedAt: number | null; endedAt: number | null }>
  /** 该 attempt 是否写过采集标记。未标记不得把页面写成 0。 */
  pageMarked: boolean
  pageIntervals: readonly DurationInterval[]
}

export interface AttemptComposition {
  modelMs: number
  pageMs: number | null
  overlapMs: number | null
  residualMs: number
  modelCallCount: number
  pageWaitCount: number
  reasons: DurationCompositionIncompleteReason[]
}

/** 单次 attempt 的模型 / 页面互斥切片。节点对多次 attempt 求和。 */
export function composeAttemptDuration(input: AttemptCompositionInput): AttemptComposition {
  const reasons: DurationCompositionIncompleteReason[] = []
  const modelIntervals: DurationInterval[] = []
  let modelMs = 0
  let modelCallCount = 0
  let modelIntervalMissing = false
  for (const call of input.modelCalls) {
    if (call.durationMs == null) {
      reasons.push('model_duration_missing')
      continue
    }
    const duration = Math.max(0, Math.round(call.durationMs))
    modelMs += duration
    modelCallCount += 1
    if (call.startedAt != null && call.endedAt != null && call.endedAt > call.startedAt) {
      modelIntervals.push({ start: call.startedAt, end: call.endedAt })
    } else if (input.pageMarked && input.pageIntervals.length > 0) {
      modelIntervalMissing = true
    }
  }
  if (modelIntervalMissing) reasons.push('model_interval_missing')

  if (!input.pageMarked) {
    return {
      modelMs,
      pageMs: null,
      overlapMs: 0,
      residualMs: Math.max(0, input.activeMs - modelMs),
      modelCallCount,
      pageWaitCount: 0,
      reasons,
    }
  }

  const pageIntervals = normalizedIntervals(input.pageIntervals)
  const pageMs = unionIntervalMs(pageIntervals)
  const pageWaitCount = pageIntervals.length
  if (modelIntervalMissing) {
    return {
      modelMs,
      pageMs,
      overlapMs: null,
      residualMs: Math.max(0, input.activeMs - Math.max(modelMs, pageMs)),
      modelCallCount,
      pageWaitCount,
      reasons,
    }
  }
  const modelUnion = modelIntervals.length > 0 ? unionIntervalMs(modelIntervals) : modelMs
  const overlapMs = intersectIntervalMs(modelIntervals, pageIntervals)
  const covered = unionIntervalMs([...modelIntervals, ...pageIntervals])
  const tolerance = Math.max(1_000, input.activeMs * 0.02)
  if (covered > input.activeMs + tolerance) reasons.push('overlap_exceeds_active')
  return {
    modelMs: modelUnion,
    pageMs,
    overlapMs,
    residualMs: Math.max(0, input.activeMs - covered),
    modelCallCount,
    pageWaitCount,
    reasons,
  }
}

// ---------------------------------------------------------------------------
// 差异归因：单次对比、趋势、报告、助手共用同一份计算
// ---------------------------------------------------------------------------

export type DurationComponentKey =
  | 'active'
  | 'authWait'
  | 'requeue'
  | 'review'
  | 'hold'
  | 'unclassified'
  | 'queue'
  | 'overhead'

export const DURATION_COMPONENT_LABELS: Readonly<Record<DurationComponentKey, string>> = Object.freeze({
  active: '执行',
  authWait: '认证等待',
  requeue: '重新排队',
  review: '待核查',
  hold: '调试挂起',
  unclassified: '未归类',
  queue: '开跑前排队',
  overhead: '运行开销',
})

/** 等待类分项：计入总耗时但不反映页面性能。 */
export const DURATION_WAIT_COMPONENTS = ['authWait', 'requeue', 'review', 'hold'] as const

/** 一侧的输入：一次运行的事实，或一个时间窗的聚合（各分项取中位数）。 */
export interface DurationComparisonSide {
  facts: Pick<
    RunDurationFacts,
    | 'totalMs'
    | 'activeMs'
    | 'authWaitMs'
    | 'requeueMs'
    | 'reviewMs'
    | 'holdMs'
    | 'unclassifiedMs'
    | 'queueMs'
    | 'overheadMs'
    | 'complete'
    | 'workerLost'
  > & {
    scenarioVersionId?: string | null
    targetAccountId?: string | null
  }
  nodes: readonly NodeDurationFacts[]
}

export interface DurationComponentDelta {
  base: number | null
  target: number | null
  delta: number | null
}

export type DurationAttributionTag =
  | { kind: 'retries'; from: number; to: number }
  | { kind: 'iterations'; from: number; to: number; perIterationDeltaPct: number | null }
  | { kind: 'resolution'; from: DurationResolutionLevel | null; to: DurationResolutionLevel | null }
  | { kind: 'model'; from: number; to: number }
  | { kind: 'page'; from: number; to: number }
  | { kind: 'added' }
  | { kind: 'removed' }

export interface DurationNodeDelta {
  nodeKey: string
  parentKey: string | null
  kind: DurationNodeKind
  name: string
  baseMs: number | null
  targetMs: number | null
  deltaMs: number | null
  deltaPct: number | null
  tags: DurationAttributionTag[]
}

export interface DurationAttribution {
  totalDeltaMs: number | null
  components: Record<DurationComponentKey, DurationComponentDelta>
  /** 按差值绝对值降序；含子节点（parentKey 非空），展示方自行按层级组织。 */
  nodes: DurationNodeDelta[]
  context: {
    versionChanged: boolean
    accountChanged: boolean
    workerLost: { base: boolean; target: boolean }
    incomplete: { base: boolean; target: boolean }
  }
}

const COMPONENT_FIELDS: Readonly<Record<DurationComponentKey, keyof DurationComparisonSide['facts']>> = {
  active: 'activeMs',
  authWait: 'authWaitMs',
  requeue: 'requeueMs',
  review: 'reviewMs',
  hold: 'holdMs',
  unclassified: 'unclassifiedMs',
  queue: 'queueMs',
  overhead: 'overheadMs',
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function deltaOf(base: number | null, target: number | null): number | null {
  return base === null || target === null ? null : target - base
}

function retriesOf(node: NodeDurationFacts): number {
  return Math.max(0, node.attemptCount - node.iterationCount)
}

function tagsFor(base: NodeDurationFacts | undefined, target: NodeDurationFacts | undefined): DurationAttributionTag[] {
  if (!base) return [{ kind: 'added' }]
  if (!target) return [{ kind: 'removed' }]
  const tags: DurationAttributionTag[] = []
  const baseRetries = retriesOf(base)
  const targetRetries = retriesOf(target)
  if (baseRetries !== targetRetries) tags.push({ kind: 'retries', from: baseRetries, to: targetRetries })
  if (base.iterationCount !== target.iterationCount) {
    const basePer = base.iterationCount > 0 ? base.activeMs / base.iterationCount : null
    const targetPer = target.iterationCount > 0 ? target.activeMs / target.iterationCount : null
    const perIterationDeltaPct =
      basePer !== null && targetPer !== null && basePer > 0
        ? Math.round(((targetPer - basePer) / basePer) * 1000) / 10
        : null
    tags.push({ kind: 'iterations', from: base.iterationCount, to: target.iterationCount, perIterationDeltaPct })
  }
  if (base.maxResolution !== target.maxResolution) {
    tags.push({ kind: 'resolution', from: base.maxResolution, to: target.maxResolution })
  }
  const modelTag = perAttemptCompositionTag('model', base, target)
  if (modelTag) tags.push(modelTag)
  const pageTag = perAttemptCompositionTag('page', base, target)
  if (pageTag) tags.push(pageTag)
  return tags
}

/** 单次尝试的模型 / 页面变化才标分段标签，避免重试把累计模型耗时误判成变慢。 */
function perAttemptCompositionTag(
  kind: 'model' | 'page',
  base: NodeDurationFacts,
  target: NodeDurationFacts,
): DurationAttributionTag | null {
  const baseValue = kind === 'model' ? base.modelMs : base.pageMs
  const targetValue = kind === 'model' ? target.modelMs : target.pageMs
  if (baseValue === null || targetValue === null) return null
  const basePer = base.attemptCount > 0 ? baseValue / base.attemptCount : 0
  const targetPer = target.attemptCount > 0 ? targetValue / target.attemptCount : 0
  const perDelta = targetPer - basePer
  const totalDelta = targetValue - baseValue
  if (Math.abs(perDelta) < Math.max(500, Math.abs(totalDelta) * 0.3)) return null
  return { kind, from: Math.round(basePer), to: Math.round(targetPer) }
}

/** 对比两侧耗时事实，给出总差值分解与逐节点差值、归因标签。 */
export function attributeDurationDifference(
  base: DurationComparisonSide,
  target: DurationComparisonSide,
): DurationAttribution {
  const components = {} as Record<DurationComponentKey, DurationComponentDelta>
  for (const [key, field] of Object.entries(COMPONENT_FIELDS) as Array<[DurationComponentKey, keyof DurationComparisonSide['facts']]>) {
    const b = numberOrNull(base.facts[field])
    const t = numberOrNull(target.facts[field])
    components[key] = { base: b, target: t, delta: deltaOf(b, t) }
  }

  const baseNodes = new Map(base.nodes.map((node) => [node.nodeKey, node]))
  const targetNodes = new Map(target.nodes.map((node) => [node.nodeKey, node]))
  const keys = new Set([...baseNodes.keys(), ...targetNodes.keys()])
  const nodes: DurationNodeDelta[] = []
  for (const key of keys) {
    const b = baseNodes.get(key)
    const t = targetNodes.get(key)
    const ref = (t ?? b)!
    const baseMs = b ? b.activeMs : null
    const targetMs = t ? t.activeMs : null
    const deltaMs = deltaOf(baseMs, targetMs)
    nodes.push({
      nodeKey: key,
      parentKey: ref.parentKey,
      kind: ref.kind,
      name: ref.name,
      baseMs,
      targetMs,
      deltaMs,
      deltaPct: deltaMs !== null && baseMs ? Math.round((deltaMs / baseMs) * 1000) / 10 : null,
      tags: tagsFor(b, t),
    })
  }
  nodes.sort((a, b) => Math.abs(b.deltaMs ?? b.targetMs ?? b.baseMs ?? 0) - Math.abs(a.deltaMs ?? a.targetMs ?? a.baseMs ?? 0))

  const baseVersion = base.facts.scenarioVersionId ?? null
  const targetVersion = target.facts.scenarioVersionId ?? null
  const baseAccount = base.facts.targetAccountId ?? null
  const targetAccount = target.facts.targetAccountId ?? null
  return {
    totalDeltaMs: deltaOf(numberOrNull(base.facts.totalMs), numberOrNull(target.facts.totalMs)),
    components,
    nodes,
    context: {
      versionChanged: baseVersion !== null && targetVersion !== null && baseVersion !== targetVersion,
      accountChanged: baseAccount !== null && targetAccount !== null && baseAccount !== targetAccount,
      workerLost: { base: base.facts.workerLost, target: target.facts.workerLost },
      incomplete: { base: !base.facts.complete, target: !target.facts.complete },
    },
  }
}

/** 时长短文案：850ms / 4.2s / 42s / 3m12s / 1h05m。 */
export function formatDurationShort(ms: number): string {
  const abs = Math.abs(Math.round(ms))
  if (abs < 1_000) return `${abs}ms`
  if (abs < 10_000) return `${(abs / 1_000).toFixed(1)}s`
  if (abs < 60_000) return `${Math.round(abs / 1_000)}s`
  if (abs < 3_600_000) {
    const minutes = Math.floor(abs / 60_000)
    const seconds = Math.round((abs % 60_000) / 1_000)
    return seconds === 60 ? `${minutes + 1}m` : seconds ? `${minutes}m${seconds}s` : `${minutes}m`
  }
  const hours = Math.floor(abs / 3_600_000)
  const minutes = Math.round((abs % 3_600_000) / 60_000)
  return minutes ? `${hours}h${String(minutes).padStart(2, '0')}m` : `${hours}h`
}

function signed(ms: number): string {
  return `${ms < 0 ? '−' : '+'}${formatDurationShort(ms)}`
}

const RESOLUTION_LABELS: Readonly<Record<DurationResolutionLevel, string>> = {
  deterministic: '确定性定位',
  map: '地图定位',
  ai: 'AI 定位',
}

export function describeDurationTag(tag: DurationAttributionTag): string {
  switch (tag.kind) {
    case 'retries':
      return `重试 ${tag.from}→${tag.to} 次`
    case 'iterations':
      return tag.perIterationDeltaPct === null
        ? `迭代 ${tag.from}→${tag.to} 次`
        : `迭代 ${tag.from}→${tag.to} 次，单次 ${tag.perIterationDeltaPct >= 0 ? '+' : ''}${tag.perIterationDeltaPct}%`
    case 'resolution':
      return `${tag.from ? RESOLUTION_LABELS[tag.from] : '未定位'}→${tag.to ? RESOLUTION_LABELS[tag.to] : '未定位'}`
    case 'model':
      return `单次模型 ${formatDurationShort(tag.from)}→${formatDurationShort(tag.to)}`
    case 'page':
      return `单次页面 ${formatDurationShort(tag.from)}→${formatDurationShort(tag.to)}`
    case 'added':
      return '新增节点'
    case 'removed':
      return '已删除节点'
  }
}

/** 差值是否值得一提：≥ 1s 且 ≥ 总差值的 10%。 */
function notable(delta: number | null, total: number): delta is number {
  return delta !== null && Math.abs(delta) >= Math.max(1_000, Math.abs(total) * 0.1)
}

/**
 * 一句话摘要（固定模板，供页面、报告、助手复用）。
 * 例：「本次比上次慢 42s：等待 +35s（认证等待），执行 +7s，其中『查询报表』+6s（重试 1→3 次）」。
 */
export function summarizeDurationDifference(
  attribution: DurationAttribution,
  labels: { target: string; base: string } = { target: '本次', base: '上次' },
): string {
  const total = attribution.totalDeltaMs
  if (total === null) return `${labels.target}或${labels.base}缺少总耗时，无法对比`
  if (Math.abs(total) < 1_000) return `${labels.target}与${labels.base}耗时基本持平（${signed(total)}）`

  const parts: string[] = []
  const waitDeltas = DURATION_WAIT_COMPONENTS.map((key) => ({ key, delta: attribution.components[key].delta }))
  const waitTotal = waitDeltas.reduce((sum, item) => sum + (item.delta ?? 0), 0)
  if (notable(waitTotal, total)) {
    const main = [...waitDeltas]
      .filter((item) => item.delta !== null && Math.sign(item.delta) === Math.sign(waitTotal))
      .sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0))[0]
    parts.push(`等待 ${signed(waitTotal)}${main ? `（${DURATION_COMPONENT_LABELS[main.key]}）` : ''}`)
  }
  const active = attribution.components.active.delta
  if (notable(active, total)) {
    let text = `执行 ${signed(active)}`
    const top = attribution.nodes.find(
      (node) => node.parentKey === null && node.deltaMs !== null && Math.sign(node.deltaMs) === Math.sign(active) && Math.abs(node.deltaMs) >= 1_000,
    )
    if (top && top.deltaMs !== null) {
      const tags = top.tags.map(describeDurationTag)
      text += `，其中『${top.name}』${signed(top.deltaMs)}${tags.length ? `（${tags.join('，')}）` : ''}`
    }
    parts.push(text)
  }
  const queue = attribution.components.queue.delta
  if (queue !== null && Math.abs(queue) >= Math.max(1_000, Math.abs(total) * 0.1)) {
    parts.push(`开跑前排队 ${signed(queue)}`)
  }
  const head = `${labels.target}比${labels.base}${total > 0 ? '慢' : '快'} ${formatDurationShort(total)}`
  const notes: string[] = []
  if (attribution.context.versionChanged) notes.push('场景版本不同')
  if (attribution.context.incomplete.base || attribution.context.incomplete.target) notes.push('部分耗时无分解')
  const body = parts.length ? `：${parts.join('，')}` : ''
  return `${head}${body}${notes.length ? `（${notes.join('；')}）` : ''}`
}
