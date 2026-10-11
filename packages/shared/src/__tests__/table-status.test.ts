import { describe, expect, it } from 'vitest'
import {
  TABLE_READ_PROTOCOL_V2,
  TABLE_STATUS_TONES,
  TABLE_STATUS_TONE_LABEL,
  evaluateTableExpectation,
  tableExpectRuleSchema,
  tableReadPlanV2Schema,
  tableSampleSchema,
  validateTableExpectRuleAgainstPlan,
  type TableSample,
} from '../index.js'

const plan = tableReadPlanV2Schema.parse({
  protocol: TABLE_READ_PROTOCOL_V2,
  target: { framePath: [], candidates: [{ by: 'css', value: '#steps' }] },
  kind: 'status',
  columns: [
    { key: 'text', name: '文字', valueType: 'text' },
    { key: 'tone', name: '语义', valueType: 'text', read: 'tone' },
    { key: 'order', name: '序号', valueType: 'number', numericKind: 'integer', read: 'order' },
  ],
})

function statusSample(tones: Array<string | null>): TableSample {
  return tableSampleSchema.parse({
    protocol: 'table.sample@1',
    source: { runId: '11111111-1111-4111-8111-111111111111', sampledAt: new Date().toISOString(), planDigest: 'a'.repeat(64) },
    columns: plan.columns,
    rows: tones.map((t, i) => ({
      text: { value: `第${i + 1}项`, status: 'ok' },
      tone: t === null ? { value: null, rawText: '未识别的状态样式：绿色标签', status: 'error' } : { value: t, status: 'ok' },
      order: { value: i + 1, status: 'ok' },
    })),
    rowCount: tones.length,
    coverage: { status: 'complete' },
    presentation: { omitted: false, previewCount: tones.length },
  })
}

describe('状态信号的契约', () => {
  it('形态 status 与列的读法；旧计划不带 read 照常解析', () => {
    expect(plan.kind).toBe('status')
    expect(plan.columns.map((c) => c.read ?? 'text')).toEqual(['text', 'tone', 'order'])
    expect(tableReadPlanV2Schema.safeParse({ ...plan, columns: [{ key: 'x', name: 'x', valueType: 'text', read: 'color' }] }).success).toBe(false)
    expect(TABLE_STATUS_TONES.map((t) => TABLE_STATUS_TONE_LABEL[t])).toEqual(['成功', '警告', '错误', '信息', '进行中', '默认'])
  })

  it('语义条件只能选六种语义之一（不能写 unknown 或英文以外的值）', () => {
    const ok = tableExpectRuleSchema.parse({ rule: 'all_rows', column: 'tone', predicate: { op: 'eq', value: 'success' } })
    expect(validateTableExpectRuleAgainstPlan(ok, plan.columns)).toEqual({ valid: true })
    for (const value of ['unknown', '成功', 'green']) {
      const bad = tableExpectRuleSchema.parse({ rule: 'all_rows', column: 'tone', predicate: { op: 'eq', value } })
      expect(validateTableExpectRuleAgainstPlan(bad, plan.columns)).toMatchObject({ valid: false, code: 'TABLE_TONE_PREDICATE_INVALID' })
    }
    const contains = tableExpectRuleSchema.parse({ rule: 'any_row', column: 'tone', predicate: { op: 'contains', value: 'succ' } })
    expect(validateTableExpectRuleAgainstPlan(contains, plan.columns)).toMatchObject({ valid: false })
  })

  it('未识别的格：结论取决于它时判“无法确认”，并说清是哪种样式没认出', () => {
    const anyInfo = tableExpectRuleSchema.parse({ rule: 'any_row', column: 'tone', predicate: { op: 'eq', value: 'info' } })
    const r = evaluateTableExpectation(statusSample(['success', null]), anyInfo)
    expect(r.factsUnavailable).toBe(true)
    // 已有确定的反例：照常判不通过
    const allOk = tableExpectRuleSchema.parse({ rule: 'all_rows', column: 'tone', predicate: { op: 'eq', value: 'success' } })
    expect(evaluateTableExpectation(statusSample(['error', null]), allOk)).toMatchObject({ passed: false })
    // 全部认得：正常判定
    expect(evaluateTableExpectation(statusSample(['success', 'success']), allOk).passed).toBe(true)
  })
})
