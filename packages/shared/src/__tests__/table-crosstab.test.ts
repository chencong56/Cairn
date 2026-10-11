import { describe, expect, it } from 'vitest'
import {
  TABLE_READ_PROTOCOL_V2,
  evaluateTableExpectation,
  tableExpectRuleSchema,
  tablePlanCheckColumns,
  tableReadPlanV2Schema,
  tableSampleSchema,
  validateCrosstabPlan,
  validateTableExpectRuleAgainstPlan,
  type TableRowField,
  type TableSample,
} from '../index.js'

const plan = tableReadPlanV2Schema.parse({
  protocol: TABLE_READ_PROTOCOL_V2,
  target: { framePath: [], candidates: [{ by: 'css', value: '#grid' }] },
  columns: [
    { key: 'col_1', name: '区域', valueType: 'text' },
    { key: 'col_2', name: '城市', valueType: 'text' },
  ],
  layout: { mode: 'crosstab', columnDims: ['年', '月'] },
})

const t = (v: string): TableRowField => ({ value: v, status: 'ok' })
const n = (v: number | null): TableRowField => (v === null ? { value: null, rawText: '-', status: 'missing' } : { value: v, decimalValue: String(v), status: 'ok' })

/** 2 个区域 × 各 2 个城市，2024 年 1、2 月；华东 / 小计、合计行；2024年 / 小计 列。 */
function sample(opts: { shanghaiJan?: number; totals?: NonNullable<TableSample['crosstab']>['totals'] } = {}): TableSample {
  const cells: Array<[string, string, string, number | null]> = [
    ['华东', '上海', '1月', opts.shanghaiJan ?? 3],
    ['华东', '上海', '2月', 4],
    ['华东', '杭州', '1月', 1],
    ['华东', '杭州', '2月', null],
    ['华南', '广州', '1月', 2],
    ['华南', '广州', '2月', 5],
  ]
  const totals = opts.totals ?? [
    // 华东小计行 × 每个月
    { rowLevel: 1, colLevel: 2, dims: ['华东', '小计', '2024年', '1月'], value: n(4) },
    { rowLevel: 1, colLevel: 2, dims: ['华东', '小计', '2024年', '2月'], value: n(4) },
    // 每行 × 2024年小计列
    { rowLevel: 2, colLevel: 1, dims: ['华东', '上海', '2024年', '小计'], value: n(7) },
    // 合计行 × 合计列（全部明细）
    { rowLevel: 0, colLevel: 0, dims: ['合计', '合计', '合计', null], value: n(15) },
  ]
  return tableSampleSchema.parse({
    protocol: 'table.sample@1',
    source: { runId: '11111111-1111-4111-8111-111111111111', sampledAt: new Date().toISOString(), planDigest: 'a'.repeat(64) },
    columns: tablePlanCheckColumns(plan),
    rows: cells.map(([r, c, m, v]) => ({ col_1: t(r), col_2: t(c), dim_1: t('2024年'), dim_2: t(m), value: n(v) })),
    rowCount: cells.length,
    coverage: { status: 'complete' },
    presentation: { omitted: false, previewCount: cells.length },
    crosstab: { rowDims: ['col_1', 'col_2'], colDims: ['dim_1', 'dim_2'], valueKey: 'value', sourceRows: 3, sourceColumns: 2, totals },
  })
}

const rule = tableExpectRuleSchema.parse({ rule: 'crosstab_total_match' })

describe('交叉表的契约', () => {
  it('读法 crosstab：长表的列 = 行维度 + 每层列维度 + 数值；数值缺省叫“值”、按小数读', () => {
    expect(plan.layout).toEqual({ mode: 'crosstab', columnDims: ['年', '月'], value: { name: '值', numericKind: 'decimal' } })
    expect(tablePlanCheckColumns(plan).map((c) => [c.key, c.name, c.valueType])).toEqual([
      ['col_1', '区域', 'text'],
      ['col_2', '城市', 'text'],
      ['dim_1', '年', 'text'],
      ['dim_2', '月', 'text'],
      ['value', '值', 'number'],
    ])
    expect(tableReadPlanV2Schema.safeParse({ ...plan, layout: { mode: 'crosstab', columnDims: [] } }).success).toBe(false)
    expect(tableReadPlanV2Schema.safeParse({ ...plan, layout: { mode: 'crosstab', columnDims: ['a', 'b', 'c', 'd', 'e'] } }).success).toBe(false)
  })

  it('计划自检：名字不能重、行维度不能占用长表的 key、只有表格能按交叉表读', () => {
    expect(validateCrosstabPlan(plan)).toEqual({ valid: true })
    expect(validateCrosstabPlan({ ...plan, layout: { ...plan.layout!, mode: 'crosstab', columnDims: ['区域'], value: { name: '值', numericKind: 'decimal' } } })).toMatchObject({ code: 'TABLE_CROSSTAB_NAME_DUPLICATE' })
    expect(validateCrosstabPlan({ ...plan, columns: [{ key: 'value', name: 'x', valueType: 'text' }] })).toMatchObject({ code: 'TABLE_CROSSTAB_KEY_RESERVED' })
    expect(validateCrosstabPlan({ ...plan, kind: 'cards' })).toMatchObject({ code: 'TABLE_CROSSTAB_KIND' })
  })

  it('长表上的条件可以引用列维度与数值', () => {
    const lookup = tableExpectRuleSchema.parse({
      rule: 'row_lookup',
      where: [
        { column: 'col_2', predicate: { op: 'eq', value: '上海' } },
        { column: 'dim_2', predicate: { op: 'eq', value: '2月' } },
      ],
      expect: [{ column: 'value', predicate: { op: 'eq', value: 4, numericPolicy: { mode: 'fixed', scale: 0, rounding: 'half_away_from_zero' } } }],
    })
    expect(validateTableExpectRuleAgainstPlan(lookup, tablePlanCheckColumns(plan))).toEqual({ valid: true })
    expect(evaluateTableExpectation(sample(), lookup).passed).toBe(true)
  })
})

describe('合计与明细一致（crosstab_total_match）', () => {
  it('小计行、小计列、总合计都等于它覆盖的明细之和（空格当 0）', () => {
    const r = evaluateTableExpectation(sample(), rule)
    expect(r).toMatchObject({ passed: true })
    expect(r.details.matchedRows).toBe(4)
  })

  it('上海 1 月改了：只报覆盖到它的合计格', () => {
    const r = evaluateTableExpectation(sample({ shanghaiJan: 5 }), rule)
    expect(r.passed).toBe(false)
    expect(r.factsUnavailable).toBeFalsy()
    expect(r.details.violatingRows.map((v) => v.reasonSummary)).toEqual([
      '「华东 / 小计」×「2024年 / 1月」：明细相加 6，合计格 4',
      '「华东 / 上海」×「2024年 / 小计」：明细相加 9，合计格 7',
      '「合计 / 合计」×「合计」：明细相加 17，合计格 15',
    ])
  })

  it('不是交叉表、没有合计格、合计格找不到明细：如实说无法确认', () => {
    const { crosstab: _x, ...flat } = sample()
    expect(evaluateTableExpectation(flat, rule).reasonCode).toBe('TABLE_CROSSTAB_MISSING')
    expect(evaluateTableExpectation(sample({ totals: [] }), rule).reasonCode).toBe('TABLE_CROSSTAB_NO_TOTALS')
    const orphan = evaluateTableExpectation(sample({ totals: [{ rowLevel: 1, colLevel: 2, dims: ['华北', '小计', '2024年', '1月'], value: n(1) }] }), rule)
    expect(orphan).toMatchObject({ factsUnavailable: true })
    expect(orphan.reasonMessage).toContain('「华北 / 小计」×「2024年 / 1月」找不到它汇总的明细格')
    const truncated = sample()
    truncated.crosstab!.totalsTruncated = true
    expect(evaluateTableExpectation(truncated, rule).reasonCode).toBe('TABLE_CROSSTAB_TOTALS_TRUNCATED')
  })

  it('display 精度：按合计格显示的小数位比较', () => {
    const s = sample({ totals: [{ rowLevel: 2, colLevel: 1, dims: ['华东', '上海', '2024年', '小计'], value: { value: 7, decimalValue: '7.0', status: 'ok' } }] })
    s.rows[0]!.value = { value: 3.04, decimalValue: '3.04', status: 'ok' }
    expect(evaluateTableExpectation(s, rule).passed).toBe(true)
    expect(evaluateTableExpectation(s, tableExpectRuleSchema.parse({ rule: 'crosstab_total_match', precision: 'exact' })).passed).toBe(false)
  })
})
