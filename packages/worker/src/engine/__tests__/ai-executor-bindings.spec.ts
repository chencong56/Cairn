import { describe, expect, it, vi } from 'vitest'
import {
  type Step,
  type RunSnapshot,
  type ContextBinding,
} from '@cairn/shared'
import { AiStepExecutor, resolveBindingValue } from '../ai-executor.js'
import type { StepExecutionContext } from '../step-executor.js'

describe('AI Step Executor Context Bindings (B2)', () => {
  it('resolves valid binding values from context', () => {
    const context = {
      orderId: 'ORD-12345',
      input: {
        userId: 'U-999',
      },
      steps: {
        step1: {
          invoice: {
            amount: 500,
            currency: 'CNY',
          },
        },
      } as any,
    }

    const b1: ContextBinding = {
      name: 'order',
      source: 'input.orderId',
      path: 'orderId',
      required: true,
    }
    expect(resolveBindingValue(context, b1)).toBe('ORD-12345')

    const b2: ContextBinding = {
      name: 'user',
      source: 'input.userId',
      path: 'userId',
      required: true,
    }
    expect(resolveBindingValue(context, b2)).toBe('U-999')

    const b3: ContextBinding = {
      name: 'amount',
      source: 'steps.step1.invoice',
      path: 'amount',
      required: true,
    }
    expect(resolveBindingValue(context, b3)).toBe(500)
  })

  it('resolves steps.<id> via snapshot outputKey when context.steps is empty', () => {
    const context = {
      currentExtract: { reductionRate: 12.5 },
    }
    const steps = [{ id: 'c7000007-0000-4000-8000-000000000012', outputKey: 'currentExtract' }]
    const binding: ContextBinding = {
      name: 'currentRate',
      source: 'steps.c7000007-0000-4000-8000-000000000012',
      path: 'reductionRate',
      required: true,
    }
    expect(resolveBindingValue(context, binding, steps)).toBe(12.5)
  })

  it('interpolates bound values into the model instruction', async () => {
    const mockAiPort = {
      execute: vi.fn().mockResolvedValue({
        ok: true,
        output: { passed: true, reason: '未超过 ±10 个百分点' },
      }),
    }
    const executor = new AiStepExecutor(mockAiPort as any)
    const extractId = 'c7000007-0000-4000-8000-000000000012'
    const step: Step = {
      id: 'step_assert',
      name: '环比断言',
      type: 'ai_assert',
      input: {
        instruction: '比较本期与上期压降率。不要用页面表格替代已提取数值。',
      },
      contextBindings: [
        {
          name: 'currentRate',
          source: `steps.${extractId}`,
          path: 'reductionRate',
          required: true,
        },
      ],
    } as any
    const ctx: StepExecutionContext = {
      runId: '00000000-0000-0000-0000-000000000001',
      stepRunId: '00000000-0000-0000-0000-000000000002',
      attemptId: '00000000-0000-0000-0000-000000000003',
      targetId: '00000000-0000-0000-0000-000000000004',
      step,
      input: {},
      context: { currentExtract: { reductionRate: 18.2 } },
      signal: new AbortController().signal,
      clock: { now: () => new Date() } as any,
      sessionGrant: { id: 'grant-1' } as any,
      evidencePolicy: { screenshot: 'none', trace: 'none' } as any,
      grant: {} as any,
      snapshot: {
        allowedOrigins: ['https://example.com'],
        steps: [{ id: extractId, outputKey: 'currentExtract' }],
        aiExecution: {
          maxCalls: 3,
          maxOutputTokens: 1000,
          requestTimeoutMs: 30000,
          hangWaitMs: 10000,
        },
      } as any,
    }

    const outcome = await executor.execute(ctx)
    expect(outcome.kind).toBe('success')
    expect(mockAiPort.execute).toHaveBeenCalled()
    const command = mockAiPort.execute.mock.calls[0][1]
    expect(command.contextValues).toEqual({ currentRate: 18.2 })
    expect(command.instruction).toContain('currentRate=18.2')
    expect(command.instruction).toContain('已绑定上下文')
  })

  it('rejects prototype access attempts in source or path', () => {
    const context = {
      orderId: '123',
    }

    const polluted1: ContextBinding = {
      name: 'proto',
      source: 'steps.__proto__.id',
      path: 'id',
      required: false,
    }
    expect(resolveBindingValue(context, polluted1)).toBeUndefined()

    const polluted2: ContextBinding = {
      name: 'proto2',
      source: 'input.orderId',
      path: '__proto__.polluted',
      required: false,
    }
    expect(resolveBindingValue(context, polluted2)).toBeUndefined()
  })

  it('blocks step execution with AI_REQUIRED_CONTEXT_MISSING when required binding is missing', async () => {
    const mockAiPort = {
      execute: vi.fn(),
    }
    const executor = new AiStepExecutor(mockAiPort as any)

    const step: Step = {
      id: 'step_ai',
      name: 'AI Action',
      type: 'ai_action',
      input: {
        instruction: 'Process order',
      },
      contextBindings: [
        {
          name: 'missingOrderId',
          source: 'input.not_existing_order',
          path: 'not_existing_order',
          required: true,
        },
      ],
    } as any

    const ctx: StepExecutionContext = {
      runId: '00000000-0000-0000-0000-000000000001',
      stepRunId: '00000000-0000-0000-0000-000000000002',
      attemptId: '00000000-0000-0000-0000-000000000003',
      targetId: '00000000-0000-0000-0000-000000000004',
      step,
      input: {},
      context: {},
      signal: new AbortController().signal,
      clock: { now: () => new Date() } as any,
      sessionGrant: { id: 'grant-1' } as any,
      evidencePolicy: { screenshot: 'none', trace: 'none' } as any,
      grant: {} as any,
      snapshot: {
        allowedOrigins: ['https://example.com'],
        aiExecution: {
          maxCalls: 3,
          maxOutputTokens: 1000,
          requestTimeoutMs: 30000,
          hangWaitMs: 10000,
        },
      } as any,
    }

    const outcome = await executor.execute(ctx)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.error.code).toBe('AI_REQUIRED_CONTEXT_MISSING')
      expect(outcome.error.safeMessage).toContain('missingOrderId')
    }
    expect(mockAiPort.execute).not.toHaveBeenCalled()
  })
})
