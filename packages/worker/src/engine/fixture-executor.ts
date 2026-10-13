import {
  FIXTURE_STEP_TYPES,
  SYSTEM_STEP_TYPES,
  evaluateExpression,
  toStrictNumber,
  evaluateTableExpectation,
  TABLE_SAMPLE_PROTOCOL,
  isTablePreviewOnly,
  durationCheckComponentOf,
  type TableSample,
  type FixtureStepType,
  type JsonValue,
} from '@cairn/shared'
import { executeDelay, executeEcho, executeFail } from './executors.js'
import { loadFullTableSample, type RecordSetObjectPort } from './table-recordset.js'
import type {
  StepExecutionContext,
  StepExecutionOutcome,
  StepExecutor,
} from './step-executor.js'

function isTableSample(val: unknown): TableSample | null {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return null
  const candidate = val as { protocol?: unknown }
  return candidate.protocol === TABLE_SAMPLE_PROTOCOL ? (val as TableSample) : null
}

export class FixtureStepExecutor implements StepExecutor {
  readonly supportedTypes: readonly string[] = [...FIXTURE_STEP_TYPES, ...SYSTEM_STEP_TYPES]

  /** recordSets：读取外置的完整记录集（文件 / 接口来源的大数据量），没有时这类检查判“无法确认”。 */
  constructor(private readonly recordSets?: Pick<RecordSetObjectPort, 'getObject'>) {}

  async execute(ctx: StepExecutionContext): Promise<StepExecutionOutcome> {
    const { step, input, signal, clock, context } = ctx

    if (step.type === 'verify_context') {
      const keys =
        input && typeof input === 'object' && !Array.isArray(input) && Array.isArray((input as any).keys)
          ? ((input as any).keys as string[])
          : step.input.keys
      const missing: string[] = []
      for (const key of keys) {
        const val = context[key]
        if (val === undefined || val === null) {
          missing.push(key)
        }
      }
      if (missing.length > 0) {
        return {
          kind: 'failed',
          error: {
            code: 'FAILED_VERIFICATION',
            category: 'VALIDATION',
            retryable: false,
            safeMessage: `模块声明的契约输出「${missing.join('、')}」未在上下文中产出`,
          },
          timedOut: false,
          aborted: false,
        }
      }
      return { kind: 'success', output: { verified: true, keys } }
    }

    if (step.type === 'echo') {
      return { kind: 'success', output: executeEcho(input) }
    }

    if (step.type === 'delay') {
      const result = await executeDelay(step.input.durationMs, signal, clock)
      return { kind: 'success', output: result }
    }

    if (step.type === 'fail') {
      return {
        kind: 'failed',
        error: executeFail(step.input),
        timedOut: false,
        aborted: false,
      }
    }

    if (step.type === 'decide') {
      const condition = step.input.condition
      const evalRes = evaluateExpression(condition, context)
      if (!evalRes.ok) {
        return {
          kind: 'failed',
          error: {
            code: 'EXPRESSION_EVALUATION_FAILED',
            category: 'VALIDATION',
            retryable: false,
            safeMessage: `条件表达式计算失败: ${evalRes.message}`,
          },
          timedOut: false,
          aborted: false,
        }
      }
      if (typeof evalRes.value !== 'boolean') {
        return {
          kind: 'failed',
          error: {
            code: 'EXPRESSION_EVALUATION_FAILED',
            category: 'VALIDATION',
            retryable: false,
            safeMessage: '条件表达式的结果不是布尔值',
          },
          timedOut: false,
          aborted: false,
        }
      }
      const blockId = step.input.blockId
      const block = ctx.snapshot.controlFlow?.blocks?.find((b) => b.blockId === blockId)
      const hasElse = Boolean(block && block.kind === 'if' && block.branches.some((b) => b.key === 'else' && b.stepIds.length > 0))
      const branch: 'then' | 'else' | 'none' = evalRes.value ? 'then' : (hasElse ? 'else' : 'none')
      return {
        kind: 'success',
        output: {
          branch,
          value: evalRes.value,
          operands: evalRes.operands,
        },
      }
    }

    if (step.type === 'compute') {
      const expr = step.input.expression
      const evalRes = evaluateExpression(expr, context)
      if (!evalRes.ok) {
        return {
          kind: 'failed',
          error: {
            code: 'EXPRESSION_EVALUATION_FAILED',
            category: 'VALIDATION',
            retryable: false,
            safeMessage: `计算表达式执行失败: ${evalRes.message}`,
          },
          timedOut: false,
          aborted: false,
        }
      }
      return {
        kind: 'success',
        output: evalRes.value,
      }
    }

    if (step.type === 'check_context') {
      const { key, field, expect } = step.input
      let val = context[key]
      if (field && val && typeof val === 'object' && !Array.isArray(val)) {
        val = (val as Record<string, JsonValue>)[field]
      }

      let passed = false
      if (expect.kind === 'non_empty') {
        // 表格样本不是普通数组，不能以整个对象"非空"代表表格有数据
        const tableSample = isTableSample(val)
        if (tableSample) {
          if (tableSample.coverage.status !== 'complete') {
            return {
              kind: 'failed',
              output: {
                passed: false,
                actual: (val ?? null) as JsonValue,
                expected: expect as unknown as JsonValue,
                details: {
                  code: 'TABLE_FACTS_UNAVAILABLE',
                  safeMessage: '表格采样覆盖不完整，无法确认表格是否有数据',
                } as unknown as JsonValue,
              },
              error: {
                code: 'TABLE_FACTS_UNAVAILABLE',
                category: 'EXECUTOR',
                retryable: false,
                safeMessage: '表格采样覆盖不完整，无法确认表格是否有数据',
              },
              timedOut: false,
              aborted: false,
            }
          }
          passed = tableSample.rows.length > 0
        } else {
          passed = val !== undefined && val !== null && val !== '' && !(Array.isArray(val) && val.length === 0)
        }
      } else if (expect.kind === 'text_contains') {
        const strVal = typeof val === 'string' ? val : (val === null || val === undefined ? '' : String(val))
        passed = strVal.includes(expect.value)
      } else if (expect.kind === 'number_compare') {
        const numVal = toStrictNumber(val)
        if (numVal !== null) {
          if (expect.op === 'eq') passed = numVal === expect.value
          else if (expect.op === 'neq') passed = numVal !== expect.value
          else if (expect.op === 'gt') passed = numVal > expect.value
          else if (expect.op === 'gte') passed = numVal >= expect.value
          else if (expect.op === 'lt') passed = numVal < expect.value
          else if (expect.op === 'lte') passed = numVal <= expect.value
        }
      } else if (expect.kind === 'table') {
        // 外置记录集：上下文里只有预览，按句柄加载全量后再检查；加载不了就是“无法确认”，绝不拿预览下结论
        let subject = val as TableSample
        const tableVal = isTableSample(val)
        if (tableVal && isTablePreviewOnly(tableVal)) {
          const loaded = await loadFullTableSample(tableVal, this.recordSets)
          if (!loaded.ok) {
            return {
              kind: 'failed',
              output: { passed: false, actual: (val ?? null) as JsonValue, expected: expect as unknown as JsonValue },
              error: { code: 'TABLE_FACTS_UNAVAILABLE', category: 'EXECUTOR', retryable: false, safeMessage: loaded.message },
              timedOut: false,
              aborted: false,
            }
          }
          subject = loaded.sample
        }
        // 与另一份数据一致：另一份按 otherKey 从上下文取，同样先加载全量；取不到交给求值判“无法确认”
        let other: TableSample | undefined
        if (expect.rule.rule === 'record_sets_match') {
          const otherVal = isTableSample(context[expect.rule.otherKey])
          if (otherVal && isTablePreviewOnly(otherVal)) {
            const loaded = await loadFullTableSample(otherVal, this.recordSets)
            if (!loaded.ok) {
              return {
                kind: 'failed',
                output: { passed: false, actual: (val ?? null) as JsonValue, expected: expect as unknown as JsonValue },
                error: { code: 'TABLE_FACTS_UNAVAILABLE', category: 'EXECUTOR', retryable: false, safeMessage: `另一份数据「${expect.rule.otherKey}」：${loaded.message}` },
                timedOut: false,
                aborted: false,
              }
            }
            other = loaded.sample
          } else if (otherVal) other = otherVal
        }
        const evalRes = evaluateTableExpectation(subject, expect.rule, other ? { other } : {})
        const output = {
          passed: evalRes.passed,
          actual: (val ?? null) as JsonValue,
          expected: expect as unknown as JsonValue,
          details: evalRes.details as unknown as JsonValue,
        }
        if (evalRes.factsUnavailable) {
          return {
            kind: 'failed',
            output,
            error: {
              code: 'TABLE_FACTS_UNAVAILABLE',
              category: 'EXECUTOR',
              retryable: false,
              safeMessage: evalRes.reasonMessage ?? '表格事实不可得',
            },
            timedOut: false,
            aborted: false,
          }
        }
        if (evalRes.passed) {
          return { kind: 'success', output }
        }
        return {
          kind: 'failed',
          output,
          error: {
            code: 'ASSERT_FAILED',
            category: 'EXECUTOR',
            retryable: false,
            safeMessage: evalRes.reasonMessage ?? `表格变量「${key}」断言不成立`,
          },
          timedOut: false,
          aborted: false,
        }
      }

      const output = {
        passed,
        actual: (val ?? null) as JsonValue,
        expected: expect as unknown as JsonValue,
      }
      if (passed) {
        return { kind: 'success', output }
      }
      return {
        kind: 'failed',
        output,
        error: {
          code: 'ASSERT_FAILED',
          category: 'EXECUTOR',
          retryable: false,
          safeMessage: `上下文变量「${key}${field ? `.${field}` : ''}」断言不成立`,
        },
        timedOut: false,
        aborted: false,
      }
    }

    if (step.type === 'check_duration') {
      const { sourceStepId, op, valueMs, runTotal, component: componentRaw } = step.input as {
        sourceStepId?: string
        op: 'lte' | 'lt'
        valueMs: number
        runTotal?: boolean
        component?: 'wall' | 'model' | 'page'
      }
      const component = durationCheckComponentOf(componentRaw)
      if (component !== 'wall') {
        if (!ctx.loadDurationComponents) {
          return durationUnavailable(sourceStepId, op, valueMs, Boolean(runTotal), component)
        }
        const loaded = await ctx.loadDurationComponents({
          sourceStepId,
          runTotal: Boolean(runTotal),
          scopePath: runTotal ? null : ctx.scopePath,
          excludeStepId: step.id,
        })
        const actualDurationMs = loaded[component]
        if (actualDurationMs === null || !Number.isFinite(actualDurationMs)) {
          return durationUnavailable(sourceStepId, op, valueMs, Boolean(runTotal), component)
        }
        const passed = op === 'lte' ? actualDurationMs <= valueMs : actualDurationMs < valueMs
        const output = { passed, actual: actualDurationMs, expected: { op, valueMs, component } }
        if (passed) return { kind: 'success', output }
        return {
          kind: 'failed',
          output,
          error: {
            code: 'ASSERT_FAILED',
            category: 'EXECUTOR',
            retryable: false,
            safeMessage: runTotal
              ? `全程${component === 'model' ? '模型' : '页面'}耗时 ${actualDurationMs}ms 超出阈值 (${op} ${valueMs}ms)`
              : `步骤${component === 'model' ? '模型' : '页面'}耗时 ${actualDurationMs}ms 超出阈值 (${op} ${valueMs}ms)`,
          },
          timedOut: false,
          aborted: false,
        }
      }
      if (!ctx.loadStepStates) {
        return durationUnavailable(sourceStepId, op, valueMs, Boolean(runTotal))
      }
      const stepStates = await ctx.loadStepStates(runTotal ? null : ctx.scopePath)

      let actualDurationMs: number | null = null

      if (runTotal) {
        const priorSteps = stepStates.filter((s) => s.stepId !== step.id)
        if (priorSteps.length > 0) {
          let earliestStart: number | undefined
          let latestEnd: number | undefined
          for (const s of priorSteps) {
            const firstAttempt = s.attempts && s.attempts.length > 0 ? s.attempts[0] : undefined
            const lastAttempt = s.attempts && s.attempts.length > 0 ? s.attempts[s.attempts.length - 1] : undefined
            const start = firstAttempt?.startedAt ?? s.startedAt
            const end = lastAttempt?.startedAt ? lastAttempt.finishedAt : s.finishedAt
            if (start) {
              const startMs = new Date(start).getTime()
              if (Number.isFinite(startMs)) {
                earliestStart = earliestStart === undefined ? startMs : Math.min(earliestStart, startMs)
              }
            }
            if (end) {
              const endMs = new Date(end).getTime()
              if (Number.isFinite(endMs)) {
                latestEnd = latestEnd === undefined ? endMs : Math.max(latestEnd, endMs)
              }
            }
          }
          if (earliestStart !== undefined && latestEnd !== undefined) {
            actualDurationMs = Math.max(0, latestEnd - earliestStart)
          }
        }
      } else {
        if (!sourceStepId) {
          return durationUnavailable(sourceStepId, op, valueMs, false)
        }
        const sourceStep = stepStates.find((s) => s.stepId === sourceStepId)
        const lastAttempt = sourceStep?.attempts[sourceStep.attempts.length - 1]
        const startedAt = lastAttempt?.startedAt ?? sourceStep?.startedAt
        const finishedAt = lastAttempt?.startedAt ? lastAttempt.finishedAt : sourceStep?.finishedAt
        actualDurationMs =
          startedAt && finishedAt
            ? Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime())
            : null
      }

      // 取不到耗时是度量缺失，不是业务不达标：不能用 ASSERT_FAILED 判成 FAIL。
      if (actualDurationMs === null || !Number.isFinite(actualDurationMs)) {
        return durationUnavailable(sourceStepId, op, valueMs, Boolean(runTotal))
      }
      const passed = op === 'lte' ? actualDurationMs <= valueMs : actualDurationMs < valueMs

      const output = {
        passed,
        actual: actualDurationMs,
        expected: { op, valueMs },
      }

      if (passed) {
        return { kind: 'success', output }
      }
      return {
        kind: 'failed',
        output,
        error: {
          code: 'ASSERT_FAILED',
          category: 'EXECUTOR',
          retryable: false,
          safeMessage: runTotal
            ? `全程耗时 ${actualDurationMs}ms 超出阈值 (${op} ${valueMs}ms)`
            : `步骤耗时 ${actualDurationMs}ms 超出阈值 (${op} ${valueMs}ms)`,
        },
        timedOut: false,
        aborted: false,
      }
    }

    return {
      kind: 'failed',
      error: {
        code: 'EXECUTOR_UNSUPPORTED_TYPE',
        category: 'EXECUTOR',
        retryable: false,
        safeMessage: `FixtureStepExecutor 不支持步骤类型：${step.type}`,
      },
      timedOut: false,
      aborted: false,
    }
  }
}

function durationUnavailable(
  sourceStepId: string | undefined,
  op: 'lte' | 'lt',
  valueMs: number,
  runTotal?: boolean,
  component?: 'wall' | 'model' | 'page',
): StepExecutionOutcome {
  const axis = component === 'model' ? '模型' : component === 'page' ? '页面等待' : ''
  return {
    kind: 'failed',
    output: { passed: false, actual: null, expected: { op, valueMs, ...(component && component !== 'wall' ? { component } : {}) } },
    error: {
      code: 'DURATION_UNAVAILABLE',
      category: 'EXECUTOR',
      retryable: false,
      safeMessage: runTotal
        ? `未能获取场景全程${axis || '执行'}耗时记录，结果无法判定`
        : `未能获取步骤「${sourceStepId}」的${axis || '执行'}耗时记录，结果无法判定`,
    },
    timedOut: false,
    aborted: false,
  }
}
