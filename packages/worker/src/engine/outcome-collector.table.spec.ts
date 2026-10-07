import { describe, expect, it } from 'vitest'
import type { OutcomeManifestEntry, RunSnapshot, Step } from '@cairn/shared'
import { collectAttemptOutcomeResults } from './outcome-collector.js'
import type { ExecutorOutcome } from './engine-types.js'

const stepId = '00000000-0000-4000-8000-000000000001'
const entry = {
  contractId: '00000000-0000-4000-8000-000000000002',
  scope: 'step',
  meaning: '「收入」各行相加等于合计行',
  severity: 'MUST',
  onViolation: 'continue',
  provenance: 'manual',
  stepId,
  rule: { kind: 'context', key: 'report', expect: { kind: 'table', rule: { rule: 'total_row_match', column: 'amount', precision: 'display' } } },
} as OutcomeManifestEntry
const snapshot = { outcomeManifest: { entries: [entry] } } as RunSnapshot
const step = { id: stepId, name: '核对', type: 'check_context', effectType: 'READ_ONLY', input: { key: 'report', expect: entry.rule } } as unknown as Step

const tableDetails = {
  protocol: 'table.outcome@1',
  totalRowsChecked: 3,
  matchedRows: 0,
  violatingRowsCount: 1,
  violatingRows: [{ rowIndex: 0, reasonSummary: '各行相加 1，合计行 2' }],
  coverage: { status: 'complete' },
}

function collect(outcome: ExecutorOutcome) {
  return collectAttemptOutcomeResults({ snapshot, step, outcome, attemptId: 'a', now: new Date('2026-10-07T00:00:00Z') }).outcomeResults[0]!
}

describe('表格数据检查的业务结果', () => {
  it('不通过：判 FAIL，保留原因与反例行，actual 只存摘要', () => {
    const r = collect({
      kind: 'failed',
      output: { passed: false, actual: { rows: [{ big: 'table' }] }, expected: {}, details: tableDetails },
      error: { code: 'ASSERT_FAILED', category: 'EXECUTOR', retryable: false, safeMessage: '各行相加是 1，合计行显示 2' },
      timedOut: false,
      aborted: false,
    } as ExecutorOutcome)
    expect(r.verdict).toBe('FAIL')
    expect(r.actual).toEqual({ rowsChecked: 3, coverage: 'complete' })
    expect(r.details?.safeMessage).toBe('各行相加是 1，合计行显示 2')
    expect((r.details?.table as { violatingRows: unknown[] }).violatingRows).toHaveLength(1)
  })

  it('无法确认：判 UNKNOWN 并带原因', () => {
    const r = collect({
      kind: 'failed',
      output: { passed: false, actual: null, expected: {}, details: { ...tableDetails, violatingRowsCount: null, violatingRows: [] } },
      error: { code: 'TABLE_FACTS_UNAVAILABLE', category: 'EXECUTOR', retryable: false, safeMessage: '没有读到合计行' },
      timedOut: false,
      aborted: false,
    } as ExecutorOutcome)
    expect(r.verdict).toBe('UNKNOWN')
    expect(r.details?.safeMessage).toBe('没有读到合计行')
  })

  it('条件行检查：命中行与最接近名称随业务结果一起保留', () => {
    const lookup = { summary: '没有找到…', matched: [], closest: ['需求订单统计报表'] }
    const r = collect({
      kind: 'failed',
      output: { passed: false, actual: null, expected: {}, details: { ...tableDetails, lookup } },
      error: { code: 'ASSERT_FAILED', category: 'EXECUTOR', retryable: false, safeMessage: '没有找到…' },
      timedOut: false,
      aborted: false,
    } as ExecutorOutcome)
    expect(r.verdict).toBe('FAIL')
    expect((r.details?.table as { lookup: typeof lookup }).lookup).toEqual(lookup)
  })
})
