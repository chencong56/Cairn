import { describe, expect, it } from 'vitest'
import { liveDurationOf } from '../runs/duration-live.js'

describe('现场耗时分段（检查 / 指标，不读事实表）', () => {
  it('单步墙钟看末次尝试；模型求和；页面无标记为 null', () => {
    const steps = [
      {
        stepId: 'step-1',
        attempts: [
          { id: 'a1', startedAt: new Date(0), finishedAt: new Date(9_000) },
          { id: 'a2', startedAt: new Date(10_000), finishedAt: new Date(10_800) },
        ],
      },
    ]
    expect(liveDurationOf(steps, [], [], { sourceStepId: 'step-1' })).toEqual({ wall: 800, model: 0, page: null })
    expect(
      liveDurationOf(
        steps,
        [{ attemptId: 'a2', durationMs: 300, startedAt: new Date(10_100), endedAt: new Date(10_400) }],
        [],
        { sourceStepId: 'step-1' },
      ),
    ).toMatchObject({ wall: 800, model: 300, page: null })
  })

  it('有 collector_ready 才把页面写成数字；未标记不能当 0', () => {
    const steps = [{ stepId: 'step-1', attempts: [{ id: 'a1', startedAt: new Date(0), finishedAt: new Date(2_000) }] }]
    const waits = [
      { attemptId: 'a1', reason: 'navigate', startedAt: new Date(200), endedAt: new Date(800) },
    ]
    expect(liveDurationOf(steps, [], waits, { sourceStepId: 'step-1' }).page).toBeNull()
    expect(
      liveDurationOf(
        steps,
        [],
        [...waits, { attemptId: 'a1', reason: 'collector_ready', startedAt: new Date(0), endedAt: new Date(0) }],
        { sourceStepId: 'step-1' },
      ).page,
    ).toBe(600)
  })

  it('全程页面：任一前序步骤未测则为 null；模型可加总', () => {
    const steps = [
      { stepId: 's1', attempts: [{ id: 'a1', startedAt: new Date(1_000), finishedAt: new Date(2_000) }] },
      { stepId: 's2', attempts: [{ id: 'a2', startedAt: new Date(2_100), finishedAt: new Date(3_500) }] },
      { stepId: 'check', attempts: [{ id: 'a3', startedAt: new Date(3_600) }] },
    ]
    const calls = [{ attemptId: 'a2', durationMs: 400, startedAt: new Date(2_200), endedAt: new Date(2_600) }]
    const unmarked = liveDurationOf(steps, calls, [], { runTotal: true, excludeStepId: 'check' })
    expect(unmarked).toMatchObject({ wall: 2_500, model: 400, page: null })

    const marked = liveDurationOf(
      steps,
      calls,
      [
        { attemptId: 'a1', reason: 'collector_ready', startedAt: new Date(1_000), endedAt: new Date(1_000) },
        { attemptId: 'a2', reason: 'collector_ready', startedAt: new Date(2_100), endedAt: new Date(2_100) },
        { attemptId: 'a2', reason: 'navigate', startedAt: new Date(2_200), endedAt: new Date(2_500) },
      ],
      { runTotal: true, excludeStepId: 'check' },
    )
    expect(marked.page).toBe(300)
  })
})
