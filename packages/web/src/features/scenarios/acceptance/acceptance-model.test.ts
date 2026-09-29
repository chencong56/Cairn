import { describe, expect, it } from 'vitest'
import { deterministicStepId } from '@cairn/authoring'
import type { AcceptanceProposalCard, AssistantAuthoringProposal, RunDetailDto } from '@cairn/shared'
import {
  buildAdoptionProposal,
  cardCanAdopt,
  cardContractIds,
  cardVerification,
  composeSummaryTemplate,
  initialCardState,
  newIntentDraft,
  nextStepId,
  toIntentRequest,
  type CardUiState,
} from './acceptance-model'

const STEP = '11111111-1111-4111-8111-111111111111'
const COUNT_STEP = '22222222-2222-4222-8222-222222222222'

function card(overrides: Partial<AcceptanceProposalCard>): AcceptanceProposalCard {
  return {
    id: 'c1',
    intentKind: 'table_non_empty',
    meaning: '订单列表有数据',
    stepId: STEP,
    testResult: 'UNTESTED',
    severity: 'MUST',
    onViolation: 'continue',
    operationIds: ['op-outcome', 'op-metric'],
    provenance: 'ai_compiled',
    ...overrides,
  }
}

function proposal(cards: AcceptanceProposalCard[]): AssistantAuthoringProposal {
  return {
    kind: 'authoring_proposal',
    proposalId: '33333333-3333-4333-8333-333333333333',
    scenarioId: '44444444-4444-4444-8444-444444444444',
    base: { draftRevision: 2, documentDigest: 'a'.repeat(64), dependencyFingerprint: 't:2' },
    operations: [
      {
        kind: 'add_outcome',
        id: 'op-outcome',
        stepId: COUNT_STEP,
        meaning: '订单列表有数据',
        rule: { kind: 'context', key: 'acc_count_x', expect: { kind: 'number_compare', op: 'gt', value: 0 } },
        severity: 'MUST',
        onViolation: 'continue',
        provenance: 'ai_compiled',
      },
      { kind: 'set_outputs', id: 'op-metric', mode: 'merge', metrics: [{ key: 'acc_count_x', name: '订单数', fromContextKey: 'acc_count_x' }] },
      {
        kind: 'add_outcome',
        id: 'op-other',
        stepId: STEP,
        meaning: '其他',
        rule: { kind: 'step_duration', op: 'lte', valueMs: 3000 },
        severity: 'MUST',
        onViolation: 'continue',
      },
    ],
    candidateDigest: 'b'.repeat(64),
    intentCoverage: cards.map((item) => ({ intentId: item.id, operationIds: item.operationIds })),
    diffs: [],
    diagnostics: [],
    executable: true,
    validation: { schema: 'passed', expansion: 'passed', compiler: 'passed' },
    source: 'acceptance',
    cards,
  }
}

describe('意图草稿', () => {
  it('缺参数时给出提示，补齐后转成请求', () => {
    const draft = newIntentDraft('number_range', STEP, 'k1')
    const missing = toIntentRequest(draft)
    expect(missing.ok).toBe(false)
    const ok = toIntentRequest({ ...draft, value: '100', metricName: '库存' })
    expect(ok.ok && ok.value).toMatchObject({ kind: 'number_range', op: 'gte', value: 100, metricName: '库存' })
    expect(toIntentRequest({ ...newIntentDraft('page_duration', STEP, 'k2'), maxMs: '50' }).ok).toBe(false)
    expect(toIntentRequest(newIntentDraft('extract_to_report', STEP, 'k3')).ok).toBe(false)

    // scenario_duration
    const durDraft = newIntentDraft('scenario_duration', STEP, 'k4')
    expect(durDraft.stepId).toBeUndefined()
    expect(durDraft.severity).toBe('SHOULD')
    expect(toIntentRequest(durDraft)).toEqual({
      ok: true,
      value: { key: 'k4', kind: 'scenario_duration', maxMs: 60000, severity: 'SHOULD' },
    })
    expect(toIntentRequest({ ...durDraft, maxMs: '50' }).ok).toBe(false)

    // value_consistency
    const vcDraft = newIntentDraft('value_consistency', STEP, 'k5')
    expect(toIntentRequest(vcDraft).ok).toBe(false)
    expect(toIntentRequest({ ...vcDraft, stepIdB: STEP }).ok).toBe(false)
    const vcOk = toIntentRequest({ ...vcDraft, stepIdB: COUNT_STEP, tolerance: '0.5', metricName: '差额' })
    expect(vcOk).toEqual({
      ok: true,
      value: {
        key: 'k5',
        kind: 'value_consistency',
        stepIdA: STEP,
        stepIdB: COUNT_STEP,
        tolerance: 0.5,
        metricName: '差额',
        severity: 'MUST',
      },
    })
  })
})

describe('采纳门禁', () => {
  it('需要定位的卡必须实测命中；列表类允许多项匹配；拦下的卡不能采纳', () => {
    expect(cardCanAdopt(card({}), { testResult: 'UNTESTED' })).toBe(false)
    expect(cardCanAdopt(card({}), { testResult: 'FOUND' })).toBe(true)
    expect(cardCanAdopt(card({}), { testResult: 'AMBIGUOUS' })).toBe(false)
    expect(cardCanAdopt(card({ expectsMany: true }), { testResult: 'AMBIGUOUS' })).toBe(true)
    expect(cardCanAdopt(card({ testResult: 'NOT_REQUIRED' }), { testResult: 'NOT_REQUIRED' })).toBe(true)
    expect(cardCanAdopt(card({ blockedReason: 'NEEDS_MANUAL_PICK', operationIds: [] }), { testResult: 'NOT_REQUIRED' })).toBe(false)
    expect(initialCardState(card({ testResult: 'NOT_REQUIRED' })).selected).toBe(true)
    expect(initialCardState(card({})).selected).toBe(false)
  })
})

describe('组装采纳提案', () => {
  it('只带勾选卡的操作、套用改过的严重度，并追加一条结论模板', () => {
    const c1 = card({ summarySnippet: '订单数 ${acc_count_x} 条' })
    const c2 = card({ id: 'c2', operationIds: ['op-other'], testResult: 'NOT_REQUIRED' })
    const states: Record<string, CardUiState> = {
      c1: { testResult: 'FOUND', severity: 'SHOULD', selected: true },
      c2: { testResult: 'NOT_REQUIRED', severity: 'MUST', selected: false },
    }
    const next = buildAdoptionProposal({
      proposal: proposal([c1, c2]),
      states,
      existingSummaryTemplate: '巡检完成',
      summaryOperationId: 'op-summary',
    })!
    expect(next.operations.map((op) => op.id)).toEqual(['op-outcome', 'op-metric', 'op-summary'])
    const outcome = next.operations[0]
    expect(outcome?.kind === 'add_outcome' && outcome.severity).toBe('SHOULD')
    const summary = next.operations[2]
    expect(summary?.kind === 'set_outputs' && summary.summaryTemplate).toBe('巡检完成；订单数 ${acc_count_x} 条')
    expect(next.cards?.map((item) => item.id)).toEqual(['c1'])
  })

  it('没有可采纳的勾选时返回空', () => {
    expect(
      buildAdoptionProposal({
        proposal: proposal([card({})]),
        states: { c1: { testResult: 'UNTESTED', severity: 'MUST', selected: true } },
        summaryOperationId: 'x',
      }),
    ).toBeNull()
  })

  it('结论模板不重复追加已有片段', () => {
    expect(composeSummaryTemplate('订单数 ${a} 条', ['订单数 ${a} 条'])).toBeUndefined()
    expect(composeSummaryTemplate(undefined, ['A', 'B'])).toBe('A；B')
  })
})

describe('复跑结果对回卡片', () => {
  it('按成功条件 id 取结论；运行未结束为等待；没有结果为未求值', () => {
    const c1 = card({ config: { ruleKind: 'context', metric: { key: 'acc_count_x', name: '订单数', fromContextKey: 'acc_count_x' } } })
    const p = proposal([c1])
    const contractId = deterministicStepId(COUNT_STEP, 'op-outcome', 'outcome')
    const running = { status: 'RUNNING', outcomeResults: [] } as unknown as RunDetailDto
    expect(cardVerification(c1, p, running).status).toBe('pending')
    const done = {
      status: 'SUCCEEDED',
      outcomeResults: [{ contractId, verdict: 'FAIL', actual: 0 }],
    } as unknown as RunDetailDto
    expect(cardVerification(c1, p, done)).toEqual({ status: 'evaluated', verdict: 'FAIL', actual: 0 })
    const missing = { status: 'SUCCEEDED', outcomeResults: [] } as unknown as RunDetailDto
    expect(cardVerification(c1, p, missing).status).toBe('not_evaluated')
  })

  it('只进报告的卡看指标取值', () => {
    const report = card({
      id: 'r1',
      intentKind: 'extract_to_report',
      operationIds: ['op-metric'],
      config: { ruleKind: 'context', metric: { key: 'acc_count_x', name: '订单数', fromContextKey: 'acc_count_x' } },
    })
    const run = { status: 'SUCCEEDED', outcomeResults: [], output: { metrics: { acc_count_x: 12 } } } as unknown as RunDetailDto
    expect(cardVerification(report, proposal([report]), run)).toEqual({ status: 'report_only', value: 12 })
  })
})

describe('步骤顺序', () => {
  it('取下一步', () => {
    expect(nextStepId(['a', 'b', 'c'], 'b')).toBe('c')
    expect(nextStepId(['a', 'b'], 'b')).toBeUndefined()
  })
})

describe('卡片对应成功条件 ID', () => {
  it('步骤级与场景级成功条件都能生成稳定 contractId', () => {
    const scCard = card({
      id: 'sc1',
      intentKind: 'scenario_duration',
      stepId: undefined,
      operationIds: ['op-sc-outcome'],
    })
    const scProposal: AssistantAuthoringProposal = {
      ...proposal([scCard]),
      operations: [
        {
          kind: 'add_outcome',
          id: 'op-sc-outcome',
          meaning: '全程耗时',
          rule: { kind: 'run_duration', op: 'lte', valueMs: 60000 },
          severity: 'SHOULD',
          onViolation: 'continue',
        },
      ],
    }
    expect(cardContractIds(scCard, scProposal)).toEqual([
      deterministicStepId('scenario', 'op-sc-outcome', 'outcome'),
    ])
  })
})
