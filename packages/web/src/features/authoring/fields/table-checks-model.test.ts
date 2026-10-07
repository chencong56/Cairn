import { describe, expect, it } from 'vitest'
import { outcomeContractSchema } from '@cairn/shared'
import {
  buildTableCheck,
  defaultRule,
  sentenceOf,
  splitTableChecks,
  templatesFor,
  withRule,
  withSeverity,
  type CheckColumn,
} from './table-checks-model'

const columns: CheckColumn[] = [
  { key: 'name', label: '区域', numeric: false },
  { key: 'amount', label: '收入', numeric: true },
]
const labelOf = (k: string) => columns.find((c) => c.key === k)?.label ?? k

describe('表格数据检查模型', () => {
  it('每个模板都能生成合法的业务结果合约', () => {
    for (const t of ['row_count', 'all_rows', 'any_row', 'column_stat', 'total_row_match', 'column_unique'] as const) {
      const rule = defaultRule(t, columns)!
      const c = buildTableCheck('report', rule, labelOf)
      expect(outcomeContractSchema.safeParse(c).success, t).toBe(true)
      expect(c.onViolation).toBe('continue')
      expect(c.meaning).toBe(sentenceOf(rule, labelOf))
    }
  })

  it('没有数字列时聚合模板不可用', () => {
    expect(defaultRule('column_stat', [columns[0]!])).toBeNull()
    expect(defaultRule('total_row_match', [])).toBeNull()
  })

  it('句子完整可读', () => {
    expect(sentenceOf({ rule: 'column_stat', column: 'amount', stat: 'sum', op: 'gt', value: 0, ignoreEmpty: true }, labelOf)).toBe(
      '「收入」的合计大于 0（忽略空值）',
    )
    expect(sentenceOf({ rule: 'total_row_match', column: 'amount', precision: 'display' }, labelOf)).toBe('「收入」各行相加等于合计行')
    expect(sentenceOf({ rule: 'column_unique', column: 'name' }, labelOf)).toBe('「区域」没有重复值')
  })

  it('改规则保留 id，meaning 随句子刷新；只提醒改为 SHOULD 且合法', () => {
    const c = buildTableCheck('report', { rule: 'column_unique', column: 'name' }, labelOf)
    const next = withRule(c, { rule: 'column_unique', column: 'amount' }, labelOf)
    expect(next.id).toBe(c.id)
    expect(next.meaning).toContain('收入')
    const soft = withSeverity(next, 'SHOULD', labelOf)
    expect(soft.severity).toBe('SHOULD')
    expect(outcomeContractSchema.safeParse(soft).success).toBe(true)
  })

  it('拆分表格检查与其它成功条件', () => {
    const check = buildTableCheck('report', { rule: 'row_count', op: 'gte', value: 1 }, labelOf)
    const other = {
      id: '22222222-2222-4222-8222-222222222222',
      scope: 'step' as const,
      meaning: '按钮已点击',
      severity: 'MUST' as const,
      onViolation: 'halt' as const,
      provenance: 'manual' as const,
      rule: { kind: 'deterministic' as const, expect: { kind: 'exists' as const } },
    }
    const { checks, others } = splitTableChecks([other as never, check])
    expect(checks).toHaveLength(1)
    expect(others).toHaveLength(1)
  })

  it('卡片与键值信息有自己的叫法和可用模板', () => {
    expect(templatesFor('keyvalue').map((t) => t.value)).toEqual(['all_rows'])
    expect(templatesFor('cards').map((t) => t.value)).not.toContain('total_row_match')
    expect(templatesFor('table').map((t) => t.value)).toContain('total_row_match')
    const eq = { rule: 'all_rows', column: 'name', predicate: { op: 'eq', value: '运行中' }, allowEmpty: false } as const
    expect(sentenceOf(eq, labelOf, 'keyvalue')).toBe('「区域」等于 「运行中」')
    expect(sentenceOf(eq, labelOf, 'cards')).toBe('每张卡片的「区域」都等于 「运行中」')
    expect(sentenceOf({ rule: 'row_count', op: 'gte', value: 3 }, labelOf, 'cards')).toBe('卡片共有大于等于 3 张')
    const c = buildTableCheck('card', eq, labelOf, 'MUST', undefined, 'keyvalue')
    expect(c.meaning).toBe('「区域」等于 「运行中」')
    expect(outcomeContractSchema.safeParse(c).success).toBe(true)
  })
})
