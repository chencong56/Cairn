import { describe, expect, it } from 'vitest'
import {
  TABLE_NETWORK_PROTOCOL,
  evaluateTableExpectation,
  extractInputSchema,
  tableExpectRuleSchema,
  tableNetworkPlanSchema,
  tableSampleSchema,
  validateTableExpectRuleAgainstPlan,
  type TableExpectRule,
  type TableSample,
} from '../index.js'

type Cell = string | number | null
function sample(columns: Array<{ key: string; name: string; number?: boolean }>, rows: Cell[][], extra: Partial<TableSample> = {}): TableSample {
  return tableSampleSchema.parse({
    protocol: 'table.sample@1',
    source: { runId: '11111111-1111-4111-8111-111111111111', sampledAt: new Date().toISOString(), planDigest: 'a'.repeat(64) },
    columns: columns.map((c) => (c.number ? { key: c.key, name: c.name, valueType: 'number', numericKind: 'decimal' } : { key: c.key, name: c.name, valueType: 'text' })),
    rows: rows.map((r) =>
      Object.fromEntries(
        columns.map((c, i) => {
          const v = r[i]
          if (v === null || v === undefined) return [c.key, { value: null, status: 'missing' }]
          return [c.key, typeof v === 'number' ? { value: v, decimalValue: String(v), status: 'ok' } : { value: v, status: 'ok' }]
        }),
      ),
    ),
    rowCount: rows.length,
    coverage: { status: 'complete' },
    presentation: { omitted: false, previewCount: rows.length },
    ...extra,
  })
}

// 页面：编号是文字列、金额显示两位小数；接口：id 是数字、amount 精度更高
const page = (rows: Cell[][]) => sample([{ key: 'no', name: '编号' }, { key: 'qty', name: '数量', number: true }, { key: 'amt', name: '金额', number: true }], rows)
const api = (rows: Cell[][]) => sample([{ key: 'id', name: 'id', number: true }, { key: 'qty', name: 'qty', number: true }, { key: 'amount', name: 'amount', number: true }], rows)
const rule = tableExpectRuleSchema.parse({
  rule: 'record_sets_match',
  otherKey: 'apiRows',
  key: { column: 'no', otherColumn: 'id' },
  columns: [
    { column: 'qty', otherColumn: 'qty' },
    { column: 'amt', otherColumn: 'amount' },
  ],
}) as Extract<TableExpectRule, { rule: 'record_sets_match' }>

describe('与另一份数据一致（record_sets_match）', () => {
  it('按键逐行一致：文字键对数字键、金额按显示精度比较', () => {
    const r = evaluateTableExpectation(page([['1000', 1, 1234.56], ['1001', 2, 6172.8]]), rule, { other: api([[1000, 1, 1234.5600001], [1001, 2, 6172.8]]) })
    expect(r.passed).toBe(true)
    expect(r.details.compare).toMatchObject({ missing: 0, extra: 0, mismatched: 0, otherRowCount: 2 })
  })

  it('值不一致、缺行、多行：不通过并逐项说明', () => {
    const r = evaluateTableExpectation(page([['1000', 1, 1234.56], ['1002', 3, 1]]), rule, { other: api([[1000, 101, 1234.56], [1001, 2, 6172.8]]) })
    expect(r.passed).toBe(false)
    expect(r.factsUnavailable).toBeFalsy()
    expect(r.details.compare).toMatchObject({ missing: 1, extra: 1, mismatched: 1 })
    expect(r.reasonMessage).toContain('缺 1 行、多 1 行、1 行值不一致')
    const summaries = r.details.violatingRows.map((v) => v.reasonSummary)
    expect(summaries).toContain('编号 1000：数量 本表 1，另一份 101')
    expect(summaries).toContain('编号 1002：本表有，另一份没有')
    expect(summaries).toContain('编号 1001：另一份有，本表没有')
  })

  it('exact 精度：小数位不同也要相等', () => {
    const exact = tableExpectRuleSchema.parse({ ...rule, columns: [{ column: 'amt', otherColumn: 'amount', precision: 'exact' }] })
    expect(evaluateTableExpectation(page([['1000', 1, 1234.56]]), exact, { other: api([[1000, 1, 1234.5600001]]) }).passed).toBe(false)
  })

  it('无法确认：另一份没读到 / 只有预览 / 没读全 / 键重复 / 键为空', () => {
    const mine = page([['1000', 1, 1]])
    expect(evaluateTableExpectation(mine, rule).reasonCode).toBe('TABLE_COMPARE_OTHER_MISSING')
    const preview = api([[1000, 1, 1]])
    const previewOnly = { ...preview, storage: { protocol: 'table.recordset@1' as const, objectKey: 'k', digest: 'd', rowCount: 500, byteSize: 1 } }
    expect(evaluateTableExpectation(mine, rule, { other: previewOnly }).reasonCode).toBe('TABLE_FULLSET_NOT_LOADED')
    expect(evaluateTableExpectation(mine, rule, { other: { ...preview, coverage: { ...preview.coverage, status: 'partial' } } }).reasonCode).toBe('TABLE_FACTS_UNAVAILABLE')
    expect(evaluateTableExpectation(mine, rule, { other: api([[1000, 1, 1], [1000, 2, 2]]) }).reasonCode).toBe('TABLE_COMPARE_KEY_NOT_UNIQUE')
    expect(evaluateTableExpectation(page([[null, 1, 1]]), rule, { other: preview }).reasonCode).toBe('TABLE_COMPARE_KEY_MISSING')
    expect(evaluateTableExpectation(mine, rule).factsUnavailable).toBe(true)
  })

  it('计划校验：本表的键列与比对列必须在读取计划里', () => {
    const cols = page([]).columns
    expect(validateTableExpectRuleAgainstPlan(rule, cols)).toEqual({ valid: true })
    expect(validateTableExpectRuleAgainstPlan({ ...rule, key: { column: 'nope', otherColumn: 'id' } }, cols)).toMatchObject({ valid: false, code: 'TABLE_COLUMN_NOT_DECLARED' })
  })
})

describe('接口来源的读取计划', () => {
  const columns = [{ key: 'id', name: 'id', path: 'id', valueType: 'number', numericKind: 'integer' }]
  it('按行读须有 rowsPath，按列读不能有；每列都要有字段路径；缺省窗口为页面加载以来、最多等 10 秒', () => {
    const ok = tableNetworkPlanSchema.parse({ protocol: TABLE_NETWORK_PROTOCOL, match: { url: '/api/site/list' }, rowsPath: 'data.list', columns })
    expect(ok).toMatchObject({ pick: 'latest', layout: 'rows', window: { since: 'page_load', waitMs: 10_000 } })
    expect(tableNetworkPlanSchema.safeParse({ protocol: TABLE_NETWORK_PROTOCOL, match: { url: '/x' }, columns }).success).toBe(false)
    expect(tableNetworkPlanSchema.safeParse({ protocol: TABLE_NETWORK_PROTOCOL, match: { url: '/x' }, layout: 'columns', rowsPath: 'a', columns }).success).toBe(false)
    expect(tableNetworkPlanSchema.safeParse({ protocol: TABLE_NETWORK_PROTOCOL, match: { url: '/x' }, rowsPath: 'a', columns: [{ key: 'id', name: 'id', valueType: 'text' }] }).success).toBe(false)
    expect(tableNetworkPlanSchema.safeParse({ protocol: TABLE_NETWORK_PROTOCOL, match: { url: '/x' }, rowsPath: 'a..b', columns }).success).toBe(false)
  })
  it('提取步骤输入：接口来源不需要页面目标；旧的页面 / 文件输入照常解析', () => {
    const plan = { protocol: TABLE_NETWORK_PROTOCOL, match: { url: '/api' }, rowsPath: 'list', columns }
    expect(extractInputSchema.parse({ as: 'table', source: 'network', table: plan })).toMatchObject({ source: 'network' })
    expect(extractInputSchema.safeParse({ as: 'table', source: 'network', table: { ...plan, protocol: 'table.file@1' } }).success).toBe(false)
  })
})
