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
 */
export const DURATION_FACTS_CALC_VERSION = 2

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
})
export type NodeDurationFacts = z.infer<typeof nodeDurationFactsSchema>

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
  return tags
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
