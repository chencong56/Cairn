import {
  DURATION_FACTS_CALC_VERSION,
  DURATION_UNCLASSIFIED_TOLERANCE,
  SCENARIO_CHECKS_NODE_KEY,
  checkNodeKey,
  composeAttemptDuration,
  defaultRunComposition,
  moduleNodeKey,
  moduleStepNodeKey,
  stepNodeKey,
  type DurationCompositionIncompleteReason,
  type DurationIncompleteReason,
  type DurationNodeKind,
  type DurationResolutionLevel,
  type NodeDurationFacts,
  type RunDurationFacts,
  type RunSnapshot,
  type RunStatus,
  type RunTriggerSource,
  type StepRunStatus,
} from '@cairn/shared'

/**
 * 耗时事实计算器：纯函数、无 IO，是耗时口径的唯一实现。
 * 事实作业、单次对比现算与测试共用；口径定义见 @cairn/shared duration-facts。
 */

export interface DurationCalculatorInput {
  run: {
    id: string
    targetId: string
    scenarioId: string
    scenarioVersionId: string
    suiteRunId: string | null
    triggerSource: RunTriggerSource
    status: RunStatus
    createdAt: Date
    startedAt: Date | null
    finishedAt: Date | null
  }
  comparable: boolean
  /** 只需状态相关事件：run.status_changed / run.auth_wait / run.auth_resumed。 */
  events: ReadonlyArray<{ type: string; occurredAt: Date; sequence: number; payload: unknown }>
  stepRuns: ReadonlyArray<{
    id: string
    stepId: string
    name: string | null
    ordinal: number
    scopePath: string
    status: StepRunStatus
  }>
  attempts: ReadonlyArray<{ stepRunId: string; id: string; startedAt: Date; finishedAt: Date | null }>
  decisions: ReadonlyArray<{ attemptId: string; decisionKind: string }>
  snapshot: Pick<RunSnapshot, 'steps' | 'moduleManifest' | 'candidateGroups' | 'outcomeManifest'> | null
  /** 已完成或失败的模型调用；attemptId 为空的不计入节点，只在运行级标 model_unassigned。 */
  aiCalls?: ReadonlyArray<DurationAiCallInput>
  /** 页面等待区间。collector_ready 只作采集标记。 */
  pageWaits?: ReadonlyArray<DurationPageWaitInput>
  /** 运行未完结时现算用的截止时刻；完结运行忽略。 */
  asOf?: Date
}

export interface DurationAiCallInput {
  attemptId: string | null
  durationMs: number | null
  startedAt: Date | null
  endedAt: Date | null
  phase: 'completed' | 'failed'
}

export interface DurationPageWaitInput {
  attemptId: string
  startedAt: Date
  endedAt: Date
  reason: string
}

export interface DurationCalculatorOutput {
  facts: RunDurationFacts
  nodes: NodeDurationFacts[]
}

const FINISHED: ReadonlySet<string> = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED'])
const LEGACY_STATUS_EVENTS: Readonly<Record<string, RunStatus>> = {
  'run.auth_wait': 'WAITING_FOR_AUTH',
  'run.auth_resumed': 'RECOVERING',
}
const STATUS_SEVERITY: Readonly<Record<StepRunStatus, number>> = {
  FAILED: 5,
  CANCELLED: 4,
  RUNNING: 3,
  PENDING: 2,
  SUCCEEDED: 1,
  SKIPPED: 0,
}
const RESOLUTION_RANK: Readonly<Record<DurationResolutionLevel, number>> = { deterministic: 1, map: 2, ai: 3 }

function ms(from: Date, to: Date): number {
  return to.getTime() - from.getTime()
}

function statusOf(payload: unknown): string | null {
  return payload && typeof payload === 'object' && typeof (payload as { status?: unknown }).status === 'string'
    ? (payload as { status: string }).status
    : null
}

function reasonOf(payload: unknown): string | null {
  return payload && typeof payload === 'object' && typeof (payload as { reason?: unknown }).reason === 'string'
    ? (payload as { reason: string }).reason
    : null
}

interface Timeline {
  segments: Record<'active' | 'authWait' | 'requeue' | 'review' | 'hold' | 'unknown', number>
  covered: number
  workerLost: boolean
  /** 不能重建时给出原因。 */
  problem: DurationIncompleteReason | null
}

/**
 * 从运行事件重建状态时间线。
 * 新运行只认 run.status_changed；补齐事件前的历史运行没有 WAITING_FOR_AUTH 状态事件时，
 * 用 run.auth_wait / run.auth_resumed 兜底（经认证控制恢复的历史运行，重新排队会并入认证等待）。
 */
function rebuildTimeline(events: DurationCalculatorInput['events'], end: Date | null, finished: boolean): Timeline {
  const segments = { active: 0, authWait: 0, requeue: 0, review: 0, hold: 0, unknown: 0 }
  // 顺序以运行内单调的 sequence 为准；跨进程写入的事件时间可能因时钟偏差不单调。
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence)
  const hasModernAuthStatus = ordered.some(
    (event) => event.type === 'run.status_changed' && statusOf(event.payload) === 'WAITING_FOR_AUTH',
  )
  const transitions: Array<{ at: Date; status: string }> = []
  let workerLost = false
  for (const event of ordered) {
    let status: string | null = null
    if (event.type === 'run.status_changed') {
      status = statusOf(event.payload)
      // 失联回收：无 reason 的 RECOVERING 来自租约过期结算（settleLeaselessRun）；auth_wait_holder_lost 来自认证等待持有者失联。
      // 认证恢复（auth_resumed）与主动让出都带 reason，不算失联。
      const reason = reasonOf(event.payload)
      if (status === 'RECOVERING' && (reason === null || reason === 'auth_wait_holder_lost')) workerLost = true
    } else if (!hasModernAuthStatus && event.type in LEGACY_STATUS_EVENTS) {
      status = LEGACY_STATUS_EVENTS[event.type]!
    }
    if (status) transitions.push({ at: event.occurredAt, status })
  }

  const startIndex = transitions.findIndex((t) => t.status === 'RUNNING')
  if (startIndex < 0) return { segments, covered: 0, workerLost, problem: 'no_events' }

  let current = 'RUNNING'
  let cursor = transitions[startIndex]!.at
  let terminated = false
  const add = (status: string, duration: number) => {
    const value = Math.max(0, duration)
    switch (status) {
      case 'RUNNING':
        segments.active += value
        break
      case 'WAITING_FOR_AUTH':
        segments.authWait += value
        break
      case 'RECOVERING':
      case 'QUEUED':
        segments.requeue += value
        break
      case 'NEEDS_REVIEW':
        segments.review += value
        break
      case 'HOLDING':
        segments.hold += value
        break
      default:
        segments.unknown += value
    }
  }
  for (const transition of transitions.slice(startIndex + 1)) {
    if (transition.status === current) continue
    add(current, ms(cursor, transition.at))
    cursor = transition.at > cursor ? transition.at : cursor
    current = transition.status
    if (FINISHED.has(current)) {
      terminated = true
      break
    }
  }
  if (!terminated) {
    if (finished) return { segments, covered: 0, workerLost, problem: 'timeline_inconsistent' }
    if (end) add(current, ms(cursor, end))
  }
  const covered = segments.active + segments.authWait + segments.requeue + segments.review + segments.hold + segments.unknown
  return { segments, covered, workerLost, problem: null }
}

interface ModuleStepRef {
  invocationId: string
  internalKey: string
}

/** 展开步骤 → 所属模块调用；覆盖 resolveStepModuleIdentity 的全部分支与前置 / 后置 / 输出校验步骤。 */
function buildModuleIndex(snapshot: DurationCalculatorInput['snapshot']): {
  steps: Map<string, ModuleStepRef>
  names: Map<string, { name: string; ordinal: number }>
} {
  const steps = new Map<string, ModuleStepRef>()
  const names = new Map<string, { name: string; ordinal: number }>()
  for (const entry of snapshot?.moduleManifest?.entries ?? []) {
    names.set(entry.invocationId, { name: entry.name, ordinal: entry.ordinal })
    const put = (stepId: string, internalKey: string) => {
      if (!steps.has(stepId)) steps.set(stepId, { invocationId: entry.invocationId, internalKey })
    }
    for (const [key, expandedId] of Object.entries(entry.internalToExpanded ?? {})) {
      const colon = key.indexOf(':')
      put(expandedId, colon >= 0 ? key.slice(colon + 1) || expandedId : key)
    }
    for (const group of snapshot?.candidateGroups?.groups ?? []) {
      if (group.invocationId !== entry.invocationId) continue
      for (const alternative of group.alternatives) {
        for (const id of [...alternative.stepIds, ...(alternative.postconditionStepIds ?? []), ...(alternative.outputVerificationStepIds ?? [])]) {
          put(id, id)
        }
      }
    }
    for (const id of [
      ...(entry.expandedStepIds ?? []),
      ...(entry.preconditionStepIds ?? []),
      ...(entry.postconditionStepIds ?? []),
      ...(entry.outputVerificationStepIds ?? []),
    ]) {
      put(id, id)
    }
  }
  return { steps, names }
}

/** 合约派生的检查步骤 → 所属节点。宿主步骤自评与旧断言步骤本身就是可见步骤，不在此列。 */
function buildCheckIndex(snapshot: DurationCalculatorInput['snapshot']): Map<string, { contractId: string; sourceStepId: string | null; meaning: string }> {
  const checks = new Map<string, { contractId: string; sourceStepId: string | null; meaning: string }>()
  for (const entry of snapshot?.outcomeManifest?.entries ?? []) {
    if (entry.sourceStepId) {
      checks.set(entry.stepId, { contractId: entry.contractId, sourceStepId: entry.sourceStepId, meaning: entry.meaning })
    } else if (entry.scope === 'scenario') {
      checks.set(entry.stepId, { contractId: entry.contractId, sourceStepId: null, meaning: entry.meaning })
    }
  }
  return checks
}

interface NodeAccumulator {
  nodeKey: string
  parentKey: string | null
  kind: DurationNodeKind
  name: string
  ordinal: number
  /** 节点自身（非子节点）的步骤记录。 */
  own: {
    activeMs: number
    attemptCount: number
    iterationCount: number
    status: StepRunStatus | null
    windowStart: number | null
    windowEnd: number | null
    maxResolution: DurationResolutionLevel | null
    modelMs: number
    modelCallCount: number
    pageMs: number | null
    overlapMs: number | null
    residualMs: number
    pageWaitCount: number
    pagePartial: boolean
    reasons: DurationCompositionIncompleteReason[]
  }
}

function worseStatus(a: StepRunStatus | null, b: StepRunStatus): StepRunStatus {
  return a === null || STATUS_SEVERITY[b] > STATUS_SEVERITY[a] ? b : a
}

function higherResolution(a: DurationResolutionLevel | null, b: DurationResolutionLevel | null): DurationResolutionLevel | null {
  if (!a) return b
  if (!b) return a
  return RESOLUTION_RANK[b] > RESOLUTION_RANK[a] ? b : a
}

function computeNodes(input: DurationCalculatorInput, end: Date | null): NodeDurationFacts[] {
  const modules = buildModuleIndex(input.snapshot)
  const checks = buildCheckIndex(input.snapshot)
  const stepNames = new Map((input.snapshot?.steps ?? []).map((step, index) => [step.id, { name: step.name, ordinal: index }]))
  const resolutionByAttempt = new Map<string, DurationResolutionLevel>()
  for (const decision of input.decisions) {
    if (decision.decisionKind === 'deterministic' || decision.decisionKind === 'map' || decision.decisionKind === 'ai') {
      resolutionByAttempt.set(decision.attemptId, higherResolution(resolutionByAttempt.get(decision.attemptId) ?? null, decision.decisionKind)!)
    }
  }
  const attemptsByStepRun = new Map<string, DurationCalculatorInput['attempts'][number][]>()
  for (const attempt of input.attempts) {
    const list = attemptsByStepRun.get(attempt.stepRunId) ?? []
    list.push(attempt)
    attemptsByStepRun.set(attempt.stepRunId, list)
  }

  const nodes = new Map<string, NodeAccumulator>()
  const ensure = (nodeKey: string, parentKey: string | null, kind: DurationNodeKind, name: string, ordinal: number) => {
    let node = nodes.get(nodeKey)
    if (!node) {
      node = {
        nodeKey,
        parentKey,
        kind,
        name,
        ordinal,
        own: {
          activeMs: 0,
          attemptCount: 0,
          iterationCount: 0,
          status: null,
          windowStart: null,
          windowEnd: null,
          maxResolution: null,
          modelMs: 0,
          modelCallCount: 0,
          pageMs: null,
          overlapMs: 0,
          residualMs: 0,
          pageWaitCount: 0,
          pagePartial: false,
          reasons: [],
        },
      }
      nodes.set(nodeKey, node)
    } else if (ordinal < node.ordinal) {
      node.ordinal = ordinal
    }
    return node
  }
  const nameOf = (stepId: string, fallback: string | null) => fallback ?? stepNames.get(stepId)?.name ?? stepId
  const callsByAttempt = new Map<string, DurationAiCallInput[]>()
  for (const call of input.aiCalls ?? []) {
    if (call.phase !== 'completed' && call.phase !== 'failed') continue
    if (!call.attemptId) continue
    const list = callsByAttempt.get(call.attemptId) ?? []
    list.push(call)
    callsByAttempt.set(call.attemptId, list)
  }
  const waitsByAttempt = new Map<string, DurationPageWaitInput[]>()
  const markedAttempts = new Set<string>()
  for (const wait of input.pageWaits ?? []) {
    if (wait.reason === 'collector_ready') {
      markedAttempts.add(wait.attemptId)
      continue
    }
    const list = waitsByAttempt.get(wait.attemptId) ?? []
    list.push(wait)
    waitsByAttempt.set(wait.attemptId, list)
  }

  /** 普通步骤或模块内部步骤的节点（必要时一并建立模块调用父节点）。 */
  const baseNode = (stepId: string, name: string, ordinal: number): NodeAccumulator => {
    const moduleRef = modules.steps.get(stepId)
    if (!moduleRef) return ensure(stepNodeKey(stepId), null, 'step', name, ordinal)
    const parentKey = moduleNodeKey(moduleRef.invocationId)
    const meta = modules.names.get(moduleRef.invocationId)
    ensure(parentKey, null, 'module', meta?.name ?? moduleRef.invocationId, ordinal)
    return ensure(moduleStepNodeKey(moduleRef.invocationId, moduleRef.internalKey), parentKey, 'module_step', name, ordinal)
  }

  for (const stepRun of input.stepRuns) {
    const name = nameOf(stepRun.stepId, stepRun.name)
    let node: NodeAccumulator
    const check = checks.get(stepRun.stepId)
    if (check) {
      let parentKey: string
      if (check.sourceStepId) {
        const parent = baseNode(check.sourceStepId, nameOf(check.sourceStepId, null), stepNames.get(check.sourceStepId)?.ordinal ?? stepRun.ordinal)
        parentKey = parent.nodeKey
      } else {
        ensure(SCENARIO_CHECKS_NODE_KEY, null, 'scenario_checks', '场景级检查', stepRun.ordinal)
        parentKey = SCENARIO_CHECKS_NODE_KEY
      }
      node = ensure(checkNodeKey(check.contractId), parentKey, 'check', check.meaning, stepRun.ordinal)
    } else {
      node = baseNode(stepRun.stepId, name, stepRun.ordinal)
    }
    node.own.status = worseStatus(node.own.status, stepRun.status)
    const attempts = attemptsByStepRun.get(stepRun.id) ?? []
    if (attempts.length > 0) node.own.iterationCount += 1
    let marked = 0
    let unmarked = 0
    let measuredPage = 0
    let overlapSum = 0
    let overlapNull = false
    for (const attempt of attempts) {
      const finishedAt = attempt.finishedAt ?? end
      node.own.attemptCount += 1
      const activeMs = finishedAt ? Math.max(0, ms(attempt.startedAt, finishedAt)) : 0
      node.own.activeMs += activeMs
      const start = attempt.startedAt.getTime()
      node.own.windowStart = node.own.windowStart === null ? start : Math.min(node.own.windowStart, start)
      if (finishedAt) {
        const finish = finishedAt.getTime()
        node.own.windowEnd = node.own.windowEnd === null ? finish : Math.max(node.own.windowEnd, finish)
      }
      node.own.maxResolution = higherResolution(node.own.maxResolution, resolutionByAttempt.get(attempt.id) ?? null)
      const pageMarked = markedAttempts.has(attempt.id)
      const slices = composeAttemptDuration({
        activeMs,
        modelCalls: (callsByAttempt.get(attempt.id) ?? []).map((call) => ({
          durationMs: call.durationMs,
          startedAt: call.startedAt ? call.startedAt.getTime() : null,
          endedAt: call.endedAt ? call.endedAt.getTime() : null,
        })),
        pageMarked,
        pageIntervals: (waitsByAttempt.get(attempt.id) ?? []).map((wait) => ({
          start: wait.startedAt.getTime(),
          end: wait.endedAt.getTime(),
        })),
      })
      node.own.modelMs += slices.modelMs
      node.own.modelCallCount += slices.modelCallCount
      node.own.pageWaitCount += slices.pageWaitCount
      node.own.residualMs += slices.residualMs
      node.own.reasons.push(...slices.reasons)
      if (pageMarked) {
        marked += 1
        measuredPage += slices.pageMs ?? 0
        if (slices.overlapMs === null) overlapNull = true
        else overlapSum += slices.overlapMs
      } else {
        unmarked += 1
      }
    }
    if (marked === 0) {
      node.own.pageMs = null
      node.own.overlapMs = 0
      node.own.pagePartial = false
    } else {
      node.own.pageMs = measuredPage
      node.own.overlapMs = overlapNull ? null : overlapSum
      node.own.pagePartial = unmarked > 0
    }
  }

  // 自底向上汇总：父节点执行耗时含子节点；合成节点（模块调用、场景级检查）的其余指标取自子节点。
  const children = new Map<string, NodeAccumulator[]>()
  for (const node of nodes.values()) {
    if (!node.parentKey) continue
    const list = children.get(node.parentKey) ?? []
    list.push(node)
    children.set(node.parentKey, list)
  }
  const result = new Map<string, NodeDurationFacts>()
  const spans = new Map<string, { start: number | null; end: number | null }>()
  const finalize = (node: NodeAccumulator): NodeDurationFacts => {
    const cached = result.get(node.nodeKey)
    if (cached) return cached
    const kids = (children.get(node.nodeKey) ?? []).map(finalize)
    const synthetic = node.kind === 'module' || node.kind === 'scenario_checks'
    let windowStart = node.own.windowStart
    let windowEnd = node.own.windowEnd
    for (const kid of kids) {
      const span = spans.get(kid.nodeKey)
      if (span?.start != null) windowStart = windowStart === null ? span.start : Math.min(windowStart, span.start)
      if (span?.end != null) windowEnd = windowEnd === null ? span.end : Math.max(windowEnd, span.end)
    }
    spans.set(node.nodeKey, { start: windowStart, end: windowEnd })
    const activeMs = node.own.activeMs + kids.reduce((sum, kid) => sum + kid.activeMs, 0)
    const reasons = uniqueReasons([...node.own.reasons, ...kids.flatMap((kid) => kid.compositionIncompleteReasons)])
    const pageAgg = aggregatePageMs([node.own.pageMs, ...kids.map((kid) => kid.pageMs)])
    const overlapParts = [node.own.overlapMs, ...kids.map((kid) => kid.overlapMs)]
    const facts: NodeDurationFacts = {
      nodeKey: node.nodeKey,
      parentKey: node.parentKey,
      kind: node.kind,
      name: node.name,
      ordinal: node.ordinal,
      status: synthetic
        ? kids.reduce<StepRunStatus | null>((acc, kid) => worseStatus(acc, kid.status), null) ?? 'PENDING'
        : node.own.status ?? 'PENDING',
      activeMs,
      windowMs: windowStart !== null && windowEnd !== null ? Math.max(0, windowEnd - windowStart) : null,
      // 汇总节点（模块调用、场景级检查）：次数 = 迭代数 + 各子节点重试之和，保证任何节点都满足「尝试数 − 迭代数 = 重试数」。
      // 不能直接累加子节点尝试数，否则三个各跑一次的内部步骤会被读成「重试 2 次」。
      attemptCount: synthetic ? syntheticIterations(kids) + kids.reduce((sum, kid) => sum + Math.max(0, kid.attemptCount - kid.iterationCount), 0) : node.own.attemptCount,
      iterationCount: synthetic ? syntheticIterations(kids) : node.own.iterationCount,
      maxResolution: synthetic
        ? kids.reduce<DurationResolutionLevel | null>((acc, kid) => higherResolution(acc, kid.maxResolution), null)
        : node.own.maxResolution,
      modelMs: node.own.modelMs + kids.reduce((sum, kid) => sum + kid.modelMs, 0),
      pageMs: pageAgg.pageMs,
      overlapMs: overlapParts.some((value) => value === null) ? null : overlapParts.reduce<number>((sum, value) => sum + (value ?? 0), 0),
      residualMs: node.own.residualMs + kids.reduce((sum, kid) => sum + kid.residualMs, 0),
      modelCallCount: node.own.modelCallCount + kids.reduce((sum, kid) => sum + kid.modelCallCount, 0),
      pageWaitCount: node.own.pageWaitCount + kids.reduce((sum, kid) => sum + kid.pageWaitCount, 0),
      pagePartial: node.own.pagePartial || kids.some((kid) => kid.pagePartial) || pageAgg.partial,
      compositionComplete: reasons.length === 0,
      compositionIncompleteReasons: reasons,
    }
    result.set(node.nodeKey, facts)
    return facts
  }
  for (const node of nodes.values()) finalize(node)
  return [...result.values()].sort((a, b) => a.ordinal - b.ordinal || a.nodeKey.localeCompare(b.nodeKey))
}

function syntheticIterations(kids: readonly NodeDurationFacts[]): number {
  return kids.reduce((max, kid) => Math.max(max, kid.iterationCount), 0)
}

function uniqueReasons(items: readonly DurationCompositionIncompleteReason[]): DurationCompositionIncompleteReason[] {
  return [...new Set(items)]
}

function unassignedModelReasons(input: DurationCalculatorInput): DurationCompositionIncompleteReason[] {
  return (input.aiCalls ?? []).some((call) => (call.phase === 'completed' || call.phase === 'failed') && !call.attemptId)
    ? ['model_unassigned']
    : []
}

function aggregatePageMs(values: readonly (number | null)[]): { pageMs: number | null; partial: boolean } {
  const measured = values.filter((value): value is number => value !== null)
  if (measured.length === 0) return { pageMs: null, partial: false }
  return { pageMs: measured.reduce((sum, value) => sum + value, 0), partial: measured.length !== values.length }
}

function runCompositionOf(nodes: readonly NodeDurationFacts[], extra: readonly DurationCompositionIncompleteReason[]) {
  const top = nodes.filter((node) => node.parentKey === null)
  const pageAgg = aggregatePageMs(top.map((node) => node.pageMs))
  const overlaps = top.map((node) => node.overlapMs)
  return {
    modelMs: top.reduce((sum, node) => sum + node.modelMs, 0),
    pageMs: pageAgg.pageMs,
    overlapMs: overlaps.some((value) => value === null) ? null : overlaps.reduce<number>((sum, value) => sum + (value ?? 0), 0),
    residualMs: top.reduce((sum, node) => sum + node.residualMs, 0),
    pagePartial: pageAgg.partial || top.some((node) => node.pagePartial),
    compositionIncompleteReasons: uniqueReasons([...extra, ...top.flatMap((node) => node.compositionIncompleteReasons)]),
  }
}

export function computeRunDurationFacts(input: DurationCalculatorInput): DurationCalculatorOutput {
  const { run } = input
  const finished = FINISHED.has(run.status) && run.finishedAt !== null
  const end = finished ? run.finishedAt : (input.asOf ?? null)
  const nodes = computeNodes(input, end)
  const composition = runCompositionOf(nodes, unassignedModelReasons(input))
  const base: Omit<RunDurationFacts, 'totalMs' | 'activeMs' | 'authWaitMs' | 'requeueMs' | 'reviewMs' | 'holdMs' | 'unclassifiedMs' | 'queueMs' | 'overheadMs' | 'workerLost' | 'complete' | 'incompleteReason'> = {
    runId: run.id,
    targetId: run.targetId,
    scenarioId: run.scenarioId,
    scenarioVersionId: run.scenarioVersionId,
    suiteRunId: run.suiteRunId,
    triggerSource: run.triggerSource,
    comparable: input.comparable,
    status: run.status,
    finishedAt: finished ? run.finishedAt!.toISOString() : null,
    calcVersion: DURATION_FACTS_CALC_VERSION,
    ...composition,
  }
  const empty = { activeMs: null, authWaitMs: null, requeueMs: null, reviewMs: null, holdMs: null, unclassifiedMs: null, overheadMs: null }

  if (!run.startedAt) {
    return {
      facts: { ...base, ...empty, ...defaultRunComposition(), ...composition, totalMs: null, queueMs: null, workerLost: false, complete: false, incompleteReason: 'not_started' },
      nodes,
    }
  }
  const queueMs = Math.max(0, ms(run.createdAt, run.startedAt))
  const totalMs = end ? Math.max(0, ms(run.startedAt, end)) : null
  const timeline = rebuildTimeline(input.events, end, finished)
  const incomplete = (reason: DurationIncompleteReason): DurationCalculatorOutput => ({
    facts: { ...base, ...empty, totalMs: finished ? totalMs : null, queueMs, workerLost: timeline.workerLost, complete: false, incompleteReason: reason },
    nodes,
  })
  if (timeline.problem) return incomplete(timeline.problem)
  if (totalMs === null) return incomplete('in_progress')

  const unclassifiedMs = totalMs - timeline.covered + timeline.segments.unknown
  const tolerance = Math.max(DURATION_UNCLASSIFIED_TOLERANCE.absoluteMs, totalMs * DURATION_UNCLASSIFIED_TOLERANCE.ratio)
  if (Math.abs(unclassifiedMs) > tolerance) return incomplete('unclassified_exceeds_tolerance')

  const topLevelActive = nodes.filter((node) => node.parentKey === null).reduce((sum, node) => sum + node.activeMs, 0)
  const activeMs = Math.round(timeline.segments.active)
  const breakdown = {
    totalMs,
    activeMs,
    authWaitMs: Math.round(timeline.segments.authWait),
    requeueMs: Math.round(timeline.segments.requeue),
    reviewMs: Math.round(timeline.segments.review),
    holdMs: Math.round(timeline.segments.hold),
    unclassifiedMs: Math.round(unclassifiedMs),
    queueMs,
    overheadMs: Math.max(0, activeMs - topLevelActive),
    workerLost: timeline.workerLost,
  }
  if (!finished) {
    return { facts: { ...base, ...breakdown, complete: false, incompleteReason: 'in_progress' }, nodes }
  }
  return { facts: { ...base, ...breakdown, complete: true, incompleteReason: null }, nodes }
}
