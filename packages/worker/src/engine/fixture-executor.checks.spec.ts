import { describe, expect, it } from 'vitest'
import { resolveEvidencePolicy, type JsonValue, type Step } from '@cairn/shared'
import type { StepExecutionContext } from './step-executor.js'
import { FixtureStepExecutor } from './fixture-executor.js'
import { systemClock } from './clock.js'
import { testRunGrant, testRunSnapshot } from '../__tests__/harness.js'

const SOURCE_STEP_ID = '01912345-6789-7abc-def0-1234567890aa'

function ctxFor(
  step: Step,
  context: Record<string, JsonValue> = {},
  extra: Partial<StepExecutionContext> = {},
): StepExecutionContext {
  return {
    runId: 'run-1',
    stepRunId: 'sr-1',
    attemptId: 'att-1',
    targetId: 't-1',
    step,
    input: step.input as JsonValue,
    context,
    signal: new AbortController().signal,
    clock: systemClock,
    evidencePolicy: resolveEvidencePolicy({}),
    grant: testRunGrant(),
    snapshot: testRunSnapshot(),
    ...extra,
  }
}

function checkContext(expect: Extract<Step, { type: 'check_context' }>['input']['expect']): Step {
  return {
    id: '01912345-6789-7abc-def0-1234567890ab',
    name: '检查行数',
    type: 'check_context',
    effectType: 'READ_ONLY',
    input: { key: 'row_count', expect },
  }
}

function checkDuration(valueMs: number): Step {
  return {
    id: '01912345-6789-7abc-def0-1234567890ac',
    name: '检查耗时',
    type: 'check_duration',
    effectType: 'READ_ONLY',
    input: { sourceStepId: SOURCE_STEP_ID, op: 'lte', valueMs },
  }
}

describe('系统检查步骤 check_context / check_duration', () => {
  const executor = new FixtureStepExecutor()

  it('number_compare 支持 neq', async () => {
    const outcome = await executor.execute(ctxFor(checkContext({ kind: 'number_compare', op: 'neq', value: 0 }), { row_count: 3 }))
    expect(outcome.kind).toBe('success')
  })

  it('null、空串与数组不会被当成 0 通过数值比较', async () => {
    for (const value of [null, '', [], [5]] as JsonValue[]) {
      const outcome = await executor.execute(
        ctxFor(checkContext({ kind: 'number_compare', op: 'lte', value: 10 }), { row_count: value }),
      )
      expect(outcome.kind, JSON.stringify(value)).toBe('failed')
      if (outcome.kind === 'failed') expect(outcome.error.code).toBe('ASSERT_FAILED')
    }
  })

  it('取数得到的带千分位和货币符号的文本可读成数字', async () => {
    const outcome = await executor.execute(
      ctxFor(checkContext({ kind: 'number_compare', op: 'gte', value: 1000 }), { row_count: '¥1,234.50' }),
    )
    expect(outcome.kind).toBe('success')
  })

  it('取不到源步骤耗时返回 DURATION_UNAVAILABLE（结果无法判定），而不是 ASSERT_FAILED', async () => {
    const outcome = await executor.execute(ctxFor(checkDuration(1000), {}, { loadStepStates: async () => [] }))
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') expect(outcome.error.code).toBe('DURATION_UNAVAILABLE')
  })

  it('按源步骤最后一次尝试的起止时间判定耗时', async () => {
    const states = [
      {
        id: 'sr-src',
        stepId: SOURCE_STEP_ID,
        ordinal: 0,
        status: 'SUCCEEDED' as const,
        attempts: [
          { id: 'a1', attemptNo: 1, status: 'FAILED' as const, error: null, startedAt: new Date(0), finishedAt: new Date(9000) },
          { id: 'a2', attemptNo: 2, status: 'SUCCEEDED' as const, error: null, startedAt: new Date(10_000), finishedAt: new Date(10_800) },
        ],
      },
    ]
    const pass = await executor.execute(ctxFor(checkDuration(1000), {}, { loadStepStates: async () => states }))
    expect(pass.kind).toBe('success')
    const fail = await executor.execute(ctxFor(checkDuration(500), {}, { loadStepStates: async () => states }))
    expect(fail.kind).toBe('failed')
    if (fail.kind === 'failed') {
      expect(fail.error.code).toBe('ASSERT_FAILED')
      expect(fail.output).toMatchObject({ actual: 800 })
    }
  })

  it('check_duration 支持 runTotal: true 判定场景全程耗时', async () => {
    const checkStep: Step = {
      id: '01912345-6789-7abc-def0-1234567890ad',
      name: '检查全程耗时',
      type: 'check_duration',
      effectType: 'READ_ONLY',
      input: { runTotal: true, op: 'lte', valueMs: 3000 },
    }

    const states = [
      {
        id: 'sr-1',
        stepId: 'step-1',
        ordinal: 0,
        status: 'SUCCEEDED' as const,
        attempts: [
          { id: 'a1', attemptNo: 1, status: 'SUCCEEDED' as const, error: null, startedAt: new Date(1000), finishedAt: new Date(2000) },
        ],
      },
      {
        id: 'sr-2',
        stepId: 'step-2',
        ordinal: 1,
        status: 'SUCCEEDED' as const,
        attempts: [
          { id: 'a2', attemptNo: 1, status: 'SUCCEEDED' as const, error: null, startedAt: new Date(2100), finishedAt: new Date(3500) },
        ],
      },
      {
        id: 'sr-3',
        stepId: checkStep.id,
        ordinal: 2,
        status: 'RUNNING' as const,
        attempts: [
          { id: 'a3', attemptNo: 1, status: 'RUNNING' as const, error: null, startedAt: new Date(3600) },
        ],
      },
    ]

    // 耗时 3500 - 1000 = 2500ms <= 3000ms -> success
    const pass = await executor.execute(ctxFor(checkStep, {}, { loadStepStates: async () => states }))
    expect(pass.kind).toBe('success')
    if (pass.kind === 'success') {
      expect(pass.output).toMatchObject({ passed: true, actual: 2500 })
    }

    // 阈值 2000ms < 2500ms -> failed ASSERT_FAILED
    const failStep: Step = {
      ...checkStep,
      input: { runTotal: true, op: 'lte', valueMs: 2000 },
    }
    const fail = await executor.execute(ctxFor(failStep, {}, { loadStepStates: async () => states }))
    expect(fail.kind).toBe('failed')
    if (fail.kind === 'failed') {
      expect(fail.error.code).toBe('ASSERT_FAILED')
      expect(fail.error.safeMessage).toContain('全程耗时 2500ms 超出阈值')
      expect(fail.output).toMatchObject({ passed: false, actual: 2500 })
    }

    // 前序步骤为空 -> DURATION_UNAVAILABLE
    const emptyFail = await executor.execute(ctxFor(checkStep, {}, { loadStepStates: async () => [] }))
    expect(emptyFail.kind).toBe('failed')
    if (emptyFail.kind === 'failed') {
      expect(emptyFail.error.code).toBe('DURATION_UNAVAILABLE')
      expect(emptyFail.error.safeMessage).toContain('未能获取场景全程执行耗时记录')
    }
  })
})

describe('check_duration runTotal 的账本口径（二期复查）', () => {
  it('runTotal 向 loadStepStates 请求全 scope 账本（null），单步口径仍按当前 scope', async () => {
    const executor = new FixtureStepExecutor(ports)
    const runTotalStep: Step = {
      id: '01912345-6789-7abc-def0-1234567890b1',
      name: '检查全程耗时',
      type: 'check_duration',
      effectType: 'READ_ONLY',
      input: { runTotal: true, op: 'lte', valueMs: 3000 },
    }
    const states = [
      {
        id: 'sr-1',
        stepId: 'step-1',
        ordinal: 0,
        status: 'SUCCEEDED' as const,
        attempts: [
          { id: 'a1', attemptNo: 1, status: 'SUCCEEDED' as const, error: null, startedAt: new Date(1000), finishedAt: new Date(2000) },
        ],
      },
    ]
    const requestedScopes: Array<string | null | undefined> = []
    await executor.execute(
      ctxFor(runTotalStep, {}, {
        loadStepStates: async (scope?: string | null) => {
          requestedScopes.push(scope)
          return states
        },
      }),
    )
    expect(requestedScopes).toEqual([null])

    const singleStep: Step = {
      id: '01912345-6789-7abc-def0-1234567890b2',
      name: '检查单步耗时',
      type: 'check_duration',
      effectType: 'READ_ONLY',
      input: { sourceStepId: 'step-1', op: 'lte', valueMs: 3000 },
    }
    requestedScopes.length = 0
    await executor.execute(
      ctxFor(singleStep, {}, {
        loadStepStates: async (scope?: string | null) => {
          requestedScopes.push(scope)
          return states
        },
      }),
    )
    expect(requestedScopes).toEqual([''])
  })

  it('重试尝试下全程耗时从首次尝试起算（含被丢弃的早期失败尝试）', async () => {
    const executor = new FixtureStepExecutor(ports)
    const checkStep: Step = {
      id: '01912345-6789-7abc-def0-1234567890b3',
      name: '检查全程耗时',
      type: 'check_duration',
      effectType: 'READ_ONLY',
      input: { runTotal: true, op: 'lte', valueMs: 5000 },
    }
    const states = [
      {
        id: 'sr-1',
        stepId: 'step-1',
        ordinal: 0,
        status: 'SUCCEEDED' as const,
        attempts: [
          { id: 'a1', attemptNo: 1, status: 'FAILED' as const, error: { code: 'X' }, startedAt: new Date(1000), finishedAt: new Date(1500) },
          { id: 'a2', attemptNo: 2, status: 'SUCCEEDED' as const, error: null, startedAt: new Date(2000), finishedAt: new Date(3000) },
        ],
      },
      {
        id: 'sr-2',
        stepId: checkStep.id,
        ordinal: 1,
        status: 'RUNNING' as const,
        attempts: [{ id: 'a3', attemptNo: 1, status: 'RUNNING' as const, error: null, startedAt: new Date(3100) }],
      },
    ]
    // 起点取首次尝试 1000，终点取末次尝试完成 3000 -> 2000ms
    const res = await executor.execute(ctxFor(checkStep, {}, { loadStepStates: async () => states }))
    expect(res.kind).toBe('success')
    if (res.kind === 'success') {
      expect(res.output).toMatchObject({ passed: true, actual: 2000 })
    }
  })
})
