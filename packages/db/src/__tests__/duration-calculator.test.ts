import { describe, expect, it } from 'vitest'
import type { RunSnapshot } from '@cairn/shared'
import { computeRunDurationFacts, type DurationCalculatorInput } from '../runs/duration-calculator.js'

const T0 = Date.parse('2026-10-07T08:00:00.000Z')
const at = (seconds: number) => new Date(T0 + seconds * 1000)

let seq = 0
function status(seconds: number, value: string, reason?: string) {
  return { type: 'run.status_changed', occurredAt: at(seconds), sequence: ++seq, payload: reason ? { status: value, reason } : { status: value } }
}
function legacy(seconds: number, type: 'run.auth_wait' | 'run.auth_resumed') {
  return { type, occurredAt: at(seconds), sequence: ++seq, payload: {} }
}

function input(overrides: Omit<Partial<DurationCalculatorInput>, 'run'> & { run?: Partial<DurationCalculatorInput['run']> } = {}): DurationCalculatorInput {
  const { run, ...rest } = overrides
  return {
    run: {
      id: 'run-1',
      targetId: 'target-1',
      scenarioId: 'scenario-1',
      scenarioVersionId: 'version-1',
      suiteRunId: null,
      triggerSource: 'schedule',
      status: 'SUCCEEDED',
      createdAt: at(-2),
      startedAt: at(0),
      finishedAt: at(15),
      ...run,
    },
    comparable: true,
    events: [],
    stepRuns: [],
    attempts: [],
    decisions: [],
    snapshot: null,
    ...rest,
  }
}

describe('耗时事实计算器：运行级分解', () => {
  it('认证等待与重新排队分开计入，执行耗时按 RUNNING 区间正向求和', () => {
    const { facts } = computeRunDurationFacts(input({
      events: [
        status(0, 'RUNNING'),
        status(3, 'WAITING_FOR_AUTH'),
        legacy(3, 'run.auth_wait'),
        status(10, 'RECOVERING', 'auth_resumed'),
        legacy(10, 'run.auth_resumed'),
        status(12, 'RUNNING'),
        status(15, 'SUCCEEDED'),
      ],
    }))
    expect(facts).toMatchObject({
      complete: true,
      totalMs: 15_000,
      activeMs: 6_000,
      authWaitMs: 7_000,
      requeueMs: 2_000,
      reviewMs: 0,
      holdMs: 0,
      unclassifiedMs: 0,
      queueMs: 2_000,
      workerLost: false,
      triggerSource: 'schedule',
      comparable: true,
    })
  })

  it('补齐事件前的历史运行用 auth_wait / auth_resumed 兜底', () => {
    const { facts } = computeRunDurationFacts(input({
      events: [status(0, 'RUNNING'), legacy(3, 'run.auth_wait'), legacy(10, 'run.auth_resumed'), status(12, 'RUNNING'), status(15, 'SUCCEEDED')],
    }))
    expect(facts).toMatchObject({ complete: true, activeMs: 6_000, authWaitMs: 7_000, requeueMs: 2_000 })
  })

  it('历史上经认证控制恢复（只有 auth_recovered）的运行，重新排队并入认证等待，总耗时不变', () => {
    const { facts } = computeRunDurationFacts(input({
      events: [
        status(0, 'RUNNING'),
        legacy(3, 'run.auth_wait'),
        { type: 'run.auth_recovered', occurredAt: at(10), sequence: ++seq, payload: { status: 'recovered' } },
        status(12, 'RUNNING'),
        status(15, 'SUCCEEDED'),
      ],
    }))
    expect(facts).toMatchObject({ complete: true, activeMs: 6_000, authWaitMs: 9_000, requeueMs: 0 })
  })

  it('待核查到人工核查为止计入待核查，调试挂起计入挂起', () => {
    const review = computeRunDurationFacts(input({
      run: { finishedAt: at(100) },
      events: [status(0, 'RUNNING'), status(5, 'NEEDS_REVIEW'), status(100, 'SUCCEEDED')],
    })).facts
    expect(review).toMatchObject({ complete: true, totalMs: 100_000, activeMs: 5_000, reviewMs: 95_000 })

    const hold = computeRunDurationFacts(input({
      run: { finishedAt: at(25) },
      events: [status(0, 'RUNNING'), status(2, 'HOLDING'), status(20, 'RUNNING'), status(25, 'SUCCEEDED')],
    })).facts
    expect(hold).toMatchObject({ complete: true, activeMs: 7_000, holdMs: 18_000 })
  })

  it('租约过期结算（无 reason 的 RECOVERING）记为失联；主动让出不算', () => {
    const lost = computeRunDurationFacts(input({
      run: { finishedAt: at(10) },
      events: [status(0, 'RUNNING'), status(5, 'RECOVERING'), status(8, 'RUNNING'), status(10, 'SUCCEEDED')],
    })).facts
    expect(lost).toMatchObject({ workerLost: true, requeueMs: 3_000, activeMs: 7_000 })

    const yielded = computeRunDurationFacts(input({
      run: { finishedAt: at(10) },
      events: [status(0, 'RUNNING'), status(5, 'RECOVERING', 'placement_yield'), status(8, 'RUNNING'), status(10, 'SUCCEEDED')],
    })).facts
    expect(yielded.workerLost).toBe(false)
  })

  it('事件已被清理时只保留总耗时与开跑前排队，不伪造分解', () => {
    const { facts } = computeRunDurationFacts(input({ events: [] }))
    expect(facts).toMatchObject({
      complete: false,
      incompleteReason: 'no_events',
      totalMs: 15_000,
      queueMs: 2_000,
      activeMs: null,
      authWaitMs: null,
      overheadMs: null,
    })
  })

  it('完结运行缺终态事件判时间线不自洽', () => {
    const { facts } = computeRunDurationFacts(input({ events: [status(0, 'RUNNING')] }))
    expect(facts).toMatchObject({ complete: false, incompleteReason: 'timeline_inconsistent', activeMs: null })
  })

  it('未归类误差在容差内保留数值，超过容差判不完整', () => {
    const small = computeRunDurationFacts(input({
      run: { finishedAt: at(10) },
      events: [status(0.2, 'RUNNING'), status(10, 'SUCCEEDED')],
    })).facts
    expect(small).toMatchObject({ complete: true, activeMs: 9_800, unclassifiedMs: 200 })

    const large = computeRunDurationFacts(input({
      run: { finishedAt: at(10) },
      events: [status(3, 'RUNNING'), status(10, 'SUCCEEDED')],
    })).facts
    expect(large).toMatchObject({ complete: false, incompleteReason: 'unclassified_exceeds_tolerance', activeMs: null, totalMs: 10_000 })
  })

  it('按 sequence 排序，跨进程时钟回拨不产生负区间', () => {
    const { facts } = computeRunDurationFacts(input({
      run: { finishedAt: at(10) },
      events: [
        { type: 'run.status_changed', occurredAt: at(0), sequence: 1, payload: { status: 'RUNNING' } },
        { type: 'run.status_changed', occurredAt: at(4), sequence: 2, payload: { status: 'WAITING_FOR_AUTH' } },
        // 另一进程时钟慢 0.5s：恢复事件时间早于上一事件
        { type: 'run.status_changed', occurredAt: at(3.5), sequence: 3, payload: { status: 'RUNNING' } },
        { type: 'run.status_changed', occurredAt: at(10), sequence: 4, payload: { status: 'SUCCEEDED' } },
      ],
    }))
    expect(facts.authWaitMs).toBe(0)
    expect(facts.activeMs).toBe(10_000)
  })

  it('未开跑就取消：总耗时为空，只计次数', () => {
    const { facts } = computeRunDurationFacts(input({ run: { status: 'CANCELLED', startedAt: null, finishedAt: at(5) } }))
    expect(facts).toMatchObject({ complete: false, incompleteReason: 'not_started', totalMs: null, queueMs: null })
  })

  it('运行中按截止时刻现算分解，标为进行中', () => {
    const { facts } = computeRunDurationFacts(input({
      run: { status: 'RUNNING', finishedAt: null },
      events: [status(0, 'RUNNING'), status(2, 'WAITING_FOR_AUTH'), status(5, 'RECOVERING', 'auth_resumed'), status(6, 'RUNNING')],
      asOf: at(9),
    }))
    expect(facts).toMatchObject({ complete: false, incompleteReason: 'in_progress', totalMs: 9_000, activeMs: 5_000, authWaitMs: 3_000, requeueMs: 1_000, finishedAt: null, workerLost: false })
  })
})

function step(id: string, name: string) {
  return { id, name, type: 'echo', effectType: 'READ_ONLY', input: { value: 'x' } } as unknown as RunSnapshot['steps'][number]
}

describe('耗时事实计算器：编排节点汇总', () => {
  it('循环体步骤跨迭代合并并记迭代次数与重试；运行开销 = 执行 − 顶层节点之和', () => {
    const output = computeRunDurationFacts(input({
      run: { finishedAt: at(10) },
      events: [status(0, 'RUNNING'), status(10, 'SUCCEEDED')],
      snapshot: { steps: [step('s-open', '打开页面'), step('s-row', '处理一行')], moduleManifest: undefined, candidateGroups: undefined, outcomeManifest: undefined },
      stepRuns: [
        { id: 'sr-open', stepId: 's-open', name: '打开页面', ordinal: 0, scopePath: '', status: 'SUCCEEDED' },
        { id: 'sr-row-0', stepId: 's-row', name: '处理一行', ordinal: 1, scopePath: 'loop/0', status: 'SUCCEEDED' },
        { id: 'sr-row-1', stepId: 's-row', name: '处理一行', ordinal: 1, scopePath: 'loop/1', status: 'SUCCEEDED' },
        { id: 'sr-row-2', stepId: 's-row', name: '处理一行', ordinal: 1, scopePath: 'loop/2', status: 'SUCCEEDED' },
      ],
      attempts: [
        { id: 'a-open', stepRunId: 'sr-open', startedAt: at(0.5), finishedAt: at(2.5) },
        { id: 'a-row-0', stepRunId: 'sr-row-0', startedAt: at(3), finishedAt: at(4) },
        { id: 'a-row-1a', stepRunId: 'sr-row-1', startedAt: at(4), finishedAt: at(5) },
        { id: 'a-row-1b', stepRunId: 'sr-row-1', startedAt: at(5), finishedAt: at(6) },
        { id: 'a-row-2', stepRunId: 'sr-row-2', startedAt: at(6), finishedAt: at(7) },
      ],
    }))
    const row = output.nodes.find((node) => node.nodeKey === 'step:s-row')!
    expect(row).toMatchObject({ kind: 'step', parentKey: null, activeMs: 4_000, iterationCount: 3, attemptCount: 4, windowMs: 4_000, status: 'SUCCEEDED' })
    expect(output.facts.overheadMs).toBe(10_000 - 2_000 - 4_000)
  })

  it('模块按调用汇总：同一模块调用两次不撞键，备选实现与前置步骤归到所属调用', () => {
    const entry = (invocationId: string, ordinal: number, map: Record<string, string>, extra: Partial<Record<string, string[]>> = {}) => ({
      invocationId,
      ordinal,
      name: `登录模块#${ordinal}`,
      moduleId: 'module-login',
      moduleKey: 'login',
      contentDigest: 'c',
      contractDigest: 'c',
      implementationDigest: 'i',
      implementationKey: 'impl1',
      executionMode: 'inline',
      effectCeiling: 'READ_ONLY',
      expandedStepIds: Object.values(map),
      internalToExpanded: map,
      preconditionStepIds: extra.pre ?? [],
      postconditionStepIds: [],
      outputVerificationStepIds: [],
      frozenOutputs: {},
      outputRequired: [],
      inputBindingsDigest: 'b',
    })
    const snapshot = {
      steps: [step('e1', '输入账号'), step('e2', '点击登录'), step('e3', '输入账号'), step('e4', '点击登录'), step('e5', '备选登录'), step('p1', '前置检查')],
      moduleManifest: {
        entries: [entry('inv-a', 0, { 'impl1:s1': 'e1', 'impl1:s2': 'e2' }, { pre: ['p1'] }), entry('inv-b', 1, { 'impl1:s1': 'e3', 'impl1:s2': 'e4' })],
      },
      candidateGroups: {
        groups: [{ groupId: 'g', invocationId: 'inv-a', alternatives: [
          { implementationKey: 'impl1', implementationDigest: 'i', stepIds: ['e1', 'e2'], postconditionStepIds: [], outputVerificationStepIds: [], frozenOutputs: {}, outputStaging: {} },
          { implementationKey: 'impl2', implementationDigest: 'j', stepIds: ['e5'], postconditionStepIds: [], outputVerificationStepIds: [], frozenOutputs: {}, outputStaging: {} },
        ] }],
      },
      outcomeManifest: undefined,
    } as unknown as DurationCalculatorInput['snapshot']
    const stepRuns = ['e1', 'e2', 'e3', 'e4', 'e5', 'p1'].map((id, index) => ({ id: `sr-${id}`, stepId: id, name: null, ordinal: index, scopePath: '', status: 'SUCCEEDED' as const }))
    const attempts = stepRuns.map((sr, index) => ({ id: `a-${sr.stepId}`, stepRunId: sr.id, startedAt: at(index), finishedAt: at(index + 1) }))
    // inv-b 的第二个内部步骤重试了一次
    attempts.push({ id: 'a-e4-retry', stepRunId: 'sr-e4', startedAt: at(6), finishedAt: at(6.5) })
    const { nodes } = computeRunDurationFacts(input({ run: { finishedAt: at(10) }, events: [status(0, 'RUNNING'), status(10, 'SUCCEEDED')], snapshot, stepRuns, attempts }))
    const keys = nodes.map((node) => node.nodeKey)
    expect(keys).toEqual(expect.arrayContaining(['module:inv-a', 'module:inv-b', 'module:inv-a/s1', 'module:inv-a/s2', 'module:inv-b/s1', 'module:inv-a/e5', 'module:inv-a/p1']))
    // 四个内部步骤各跑一次：模块本身没有重试（尝试数 − 迭代数 = 0），而不是把子步骤尝试数累加成 4
    expect(nodes.find((node) => node.nodeKey === 'module:inv-a')).toMatchObject({ kind: 'module', parentKey: null, name: '登录模块#0', activeMs: 4_000, attemptCount: 1, iterationCount: 1 })
    expect(nodes.find((node) => node.nodeKey === 'module:inv-b')).toMatchObject({ activeMs: 2_500, attemptCount: 2, iterationCount: 1 })
    expect(nodes.find((node) => node.nodeKey === 'module:inv-a/s1')).toMatchObject({ kind: 'module_step', parentKey: 'module:inv-a', name: '输入账号' })
    expect(nodes.filter((node) => node.parentKey === null).map((node) => node.nodeKey).sort()).toEqual(['module:inv-a', 'module:inv-b'])
  })

  it('步骤级检查计入所属节点并保留子行；场景级检查归入场景级检查节点；定位层级取最高', () => {
    const snapshot = {
      steps: [step('s-query', '查询报表'), step('d-check', '派生检查'), step('d-scenario', '场景检查')],
      moduleManifest: undefined,
      candidateGroups: undefined,
      outcomeManifest: {
        entries: [
          { contractId: 'c-ai', scope: 'step', meaning: '报表有数据', severity: 'MUST', onViolation: 'continue', provenance: 'authored', stepId: 'd-check', sourceStepId: 's-query', rule: { kind: 'ai', instruction: 'x' } },
          { contractId: 'c-total', scope: 'scenario', meaning: '全程不超过 60s', severity: 'SHOULD', onViolation: 'continue', provenance: 'authored', stepId: 'd-scenario', rule: { kind: 'run_duration', op: 'lte', valueMs: 60000 } },
        ],
      },
    } as unknown as DurationCalculatorInput['snapshot']
    const { nodes } = computeRunDurationFacts(input({
      run: { finishedAt: at(12) },
      events: [status(0, 'RUNNING'), status(12, 'SUCCEEDED')],
      snapshot,
      stepRuns: [
        { id: 'sr-q', stepId: 's-query', name: '查询报表', ordinal: 0, scopePath: '', status: 'SUCCEEDED' },
        { id: 'sr-c', stepId: 'd-check', name: '派生检查', ordinal: 1, scopePath: '', status: 'FAILED' },
        { id: 'sr-s', stepId: 'd-scenario', name: '场景检查', ordinal: 2, scopePath: '', status: 'SUCCEEDED' },
      ],
      attempts: [
        { id: 'a-q1', stepRunId: 'sr-q', startedAt: at(0), finishedAt: at(2) },
        { id: 'a-q2', stepRunId: 'sr-q', startedAt: at(2), finishedAt: at(3) },
        { id: 'a-c', stepRunId: 'sr-c', startedAt: at(3), finishedAt: at(8) },
        { id: 'a-s', stepRunId: 'sr-s', startedAt: at(8), finishedAt: at(8.1) },
      ],
      decisions: [
        { attemptId: 'a-q1', decisionKind: 'deterministic' },
        { attemptId: 'a-q2', decisionKind: 'ai' },
      ],
    }))
    expect(nodes.find((node) => node.nodeKey === 'step:s-query')).toMatchObject({
      activeMs: 8_000,
      attemptCount: 2,
      status: 'SUCCEEDED',
      maxResolution: 'ai',
      windowMs: 8_000,
    })
    expect(nodes.find((node) => node.nodeKey === 'check:c-ai')).toMatchObject({ kind: 'check', parentKey: 'step:s-query', name: '报表有数据', activeMs: 5_000, status: 'FAILED' })
    expect(nodes.find((node) => node.nodeKey === 'scenario_checks')).toMatchObject({ kind: 'scenario_checks', parentKey: null, activeMs: 100 })
    expect(nodes.find((node) => node.nodeKey === 'check:c-total')).toMatchObject({ parentKey: 'scenario_checks' })
  })

  it('模型调用按 attempt 计入所属节点，父节点累加；无页面时其余 = 执行 − 模型', () => {
    const { facts, nodes } = computeRunDurationFacts(input({
      run: { finishedAt: at(10) },
      events: [status(0, 'RUNNING'), status(10, 'SUCCEEDED')],
      snapshot: { steps: [step('s-open', '打开页面'), step('s-row', '处理一行')], moduleManifest: undefined, candidateGroups: undefined, outcomeManifest: undefined },
      stepRuns: [
        { id: 'sr-open', stepId: 's-open', name: '打开页面', ordinal: 0, scopePath: '', status: 'SUCCEEDED' },
        { id: 'sr-row', stepId: 's-row', name: '处理一行', ordinal: 1, scopePath: '', status: 'SUCCEEDED' },
      ],
      attempts: [
        { id: 'a-open', stepRunId: 'sr-open', startedAt: at(0.5), finishedAt: at(2.5) },
        { id: 'a-row', stepRunId: 'sr-row', startedAt: at(3), finishedAt: at(8) },
      ],
      aiCalls: [
        { attemptId: 'a-row', durationMs: 3_000, startedAt: at(3.2), endedAt: at(6.2), phase: 'completed' },
        { attemptId: 'a-row', durationMs: 500, startedAt: at(6.3), endedAt: at(6.8), phase: 'failed' },
      ],
    }))
    expect(nodes.find((node) => node.nodeKey === 'step:s-row')).toMatchObject({
      activeMs: 5_000,
      modelMs: 3_500,
      pageMs: null,
      overlapMs: 0,
      residualMs: 1_500,
      modelCallCount: 2,
      compositionComplete: true,
    })
    expect(nodes.find((node) => node.nodeKey === 'step:s-open')).toMatchObject({ modelMs: 0, residualMs: 2_000 })
    expect(facts).toMatchObject({ modelMs: 3_500, pageMs: null, residualMs: 3_500, compositionIncompleteReasons: [] })
  })

  it('没有 attempt 的模型调用不计入节点，运行级标 model_unassigned；缺 duration 标 model_duration_missing', () => {
    const { facts, nodes } = computeRunDurationFacts(input({
      run: { finishedAt: at(10) },
      events: [status(0, 'RUNNING'), status(10, 'SUCCEEDED')],
      snapshot: { steps: [step('s-open', '打开页面')], moduleManifest: undefined, candidateGroups: undefined, outcomeManifest: undefined },
      stepRuns: [{ id: 'sr-open', stepId: 's-open', name: '打开页面', ordinal: 0, scopePath: '', status: 'SUCCEEDED' }],
      attempts: [{ id: 'a-open', stepRunId: 'sr-open', startedAt: at(1), finishedAt: at(4) }],
      aiCalls: [
        { attemptId: null, durationMs: 2_000, startedAt: at(1), endedAt: at(3), phase: 'completed' },
        { attemptId: 'a-open', durationMs: null, startedAt: at(2), endedAt: at(3), phase: 'completed' },
      ],
    }))
    expect(nodes.find((node) => node.nodeKey === 'step:s-open')).toMatchObject({
      modelMs: 0,
      residualMs: 3_000,
      compositionComplete: false,
      compositionIncompleteReasons: ['model_duration_missing'],
    })
    expect(facts.modelMs).toBe(0)
    expect(facts.compositionIncompleteReasons).toEqual(expect.arrayContaining(['model_unassigned', 'model_duration_missing']))
    expect(facts.compositionIncompleteReasons).not.toContain('model_interval_missing')
  })

  it('有采集标记才写 pageMs（含 0）；无标记保持 null；混合 attempt 标 pagePartial', () => {
    const snapshot = { steps: [step('s-open', '打开页面')], moduleManifest: undefined, candidateGroups: undefined, outcomeManifest: undefined }
    const unmarked = computeRunDurationFacts(input({
      run: { finishedAt: at(10) },
      events: [status(0, 'RUNNING'), status(10, 'SUCCEEDED')],
      snapshot,
      stepRuns: [{ id: 'sr-open', stepId: 's-open', name: '打开页面', ordinal: 0, scopePath: '', status: 'SUCCEEDED' }],
      attempts: [{ id: 'a-open', stepRunId: 'sr-open', startedAt: at(1), finishedAt: at(4) }],
      pageWaits: [{ attemptId: 'a-open', startedAt: at(1.2), endedAt: at(2), reason: 'navigate' }],
    }))
    expect(unmarked.nodes[0]).toMatchObject({ pageMs: null, pagePartial: false, overlapMs: 0 })

    const markedZero = computeRunDurationFacts(input({
      run: { finishedAt: at(10) },
      events: [status(0, 'RUNNING'), status(10, 'SUCCEEDED')],
      snapshot,
      stepRuns: [{ id: 'sr-open', stepId: 's-open', name: '打开页面', ordinal: 0, scopePath: '', status: 'SUCCEEDED' }],
      attempts: [{ id: 'a-open', stepRunId: 'sr-open', startedAt: at(1), finishedAt: at(4) }],
      pageWaits: [{ attemptId: 'a-open', startedAt: at(1), endedAt: at(1), reason: 'collector_ready' }],
    }))
    expect(markedZero.nodes[0]).toMatchObject({ pageMs: 0, pageWaitCount: 0, pagePartial: false })
    expect(markedZero.facts.pageMs).toBe(0)

    const mixed = computeRunDurationFacts(input({
      run: { finishedAt: at(10) },
      events: [status(0, 'RUNNING'), status(10, 'SUCCEEDED')],
      snapshot,
      stepRuns: [{ id: 'sr-open', stepId: 's-open', name: '打开页面', ordinal: 0, scopePath: '', status: 'SUCCEEDED' }],
      attempts: [
        { id: 'a-1', stepRunId: 'sr-open', startedAt: at(1), finishedAt: at(3) },
        { id: 'a-2', stepRunId: 'sr-open', startedAt: at(3), finishedAt: at(6) },
      ],
      pageWaits: [
        { attemptId: 'a-2', startedAt: at(3), endedAt: at(3), reason: 'collector_ready' },
        { attemptId: 'a-2', startedAt: at(3.2), endedAt: at(4.2), reason: 'navigate' },
      ],
    }))
    expect(mixed.nodes[0]).toMatchObject({ pageMs: 1_000, pagePartial: true, pageWaitCount: 1 })
  })
})
