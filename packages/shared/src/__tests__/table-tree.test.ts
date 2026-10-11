import { describe, expect, it } from 'vitest'
import {
  TABLE_READ_PROTOCOL_V2,
  TABLE_TREE_PATH_KEY,
  evaluateTableExpectation,
  tableExpectRuleSchema,
  tablePlanCheckColumns,
  tableReadPlanSchema,
  tableReadPlanV2Schema,
  tableSampleSchema,
  validateTableExpectRuleAgainstPlan,
  type TableSample,
} from '../index.js'

type Node = { path: string; v: number | null; level: number; parent?: number; kids?: boolean; expanded?: boolean; dec?: string }
function treeSample(nodes: Node[], status: 'complete' | 'partial' = 'complete'): TableSample {
  return tableSampleSchema.parse({
    protocol: 'table.sample@1',
    source: { runId: '11111111-1111-4111-8111-111111111111', sampledAt: new Date().toISOString(), planDigest: 'a'.repeat(64) },
    columns: [{ key: 'qty', name: '数量', valueType: 'number', numericKind: 'decimal' }, { key: TABLE_TREE_PATH_KEY, name: '层级路径', valueType: 'text' }],
    rows: nodes.map((n) => ({
      qty: n.v === null ? { value: null, status: 'missing' } : { value: n.v, ...(n.dec ? { decimalValue: n.dec } : {}), status: 'ok' },
      [TABLE_TREE_PATH_KEY]: { value: n.path, status: 'ok' },
    })),
    rowMeta: nodes.map((n) => ({ level: n.level, hasChildren: Boolean(n.kids), ...(n.kids ? { expanded: n.expanded ?? true } : {}), ...(n.parent !== undefined ? { parentIndex: n.parent } : {}) })),
    rowCount: nodes.length,
    coverage: { status },
    presentation: { omitted: false, previewCount: nodes.length },
  })
}
const rollup = (precision: 'display' | 'exact' = 'display') => tableExpectRuleSchema.parse({ rule: 'tree_rollup_match', column: 'qty', precision })

describe('父行等于子行之和（tree_rollup_match）', () => {
  const tree = (cityQty: number) => [
    { path: '华东', v: 3 + cityQty, level: 0, kids: true },
    { path: '华东 / 上海', v: cityQty, level: 1, parent: 0, kids: true },
    { path: '华东 / 上海 / A', v: 1, level: 2, parent: 1 },
    { path: '华东 / 上海 / B', v: 2, level: 2, parent: 1 },
    { path: '华东 / 杭州', v: 3, level: 1, parent: 0 },
  ]

  it('每个父行都等于直接子行之和：通过；某个小计不符：只报那一行', () => {
    expect(evaluateTableExpectation(treeSample(tree(3)), rollup()).passed).toBe(true)
    const bad = evaluateTableExpectation(treeSample(tree(4)), rollup())
    expect(bad.passed).toBe(false)
    expect(bad.details.violatingRows.map((v) => v.reasonSummary)).toEqual(['「华东 / 上海」的数量：子行相加 3，本行 4'])
  })

  it('display 精度：父行显示的小数位较少时按它四舍五入比较；exact 不放过', () => {
    const nodes: Node[] = [
      { path: '合计', v: 3.3, dec: '3.3', level: 0, kids: true },
      { path: '合计 / 甲', v: 1.12, dec: '1.12', level: 1, parent: 0 },
      { path: '合计 / 乙', v: 2.16, dec: '2.16', level: 1, parent: 0 },
    ]
    expect(evaluateTableExpectation(treeSample(nodes), rollup()).passed).toBe(true)
    expect(evaluateTableExpectation(treeSample(nodes), rollup('exact')).passed).toBe(false)
  })

  it('无法确认：不是树形读取 / 没有父子行 / 读不全 / 有读不出的值', () => {
    const flat = { ...treeSample(tree(3)) }
    delete (flat as { rowMeta?: unknown }).rowMeta
    expect(evaluateTableExpectation(flat, rollup()).reasonCode).toBe('TABLE_TREE_LEVELS_MISSING')
    expect(evaluateTableExpectation(treeSample([{ path: '甲', v: 1, level: 0 }, { path: '乙', v: 2, level: 0 }]), rollup()).reasonCode).toBe('TABLE_TREE_NO_PARENTS')
    expect(evaluateTableExpectation(treeSample(tree(3), 'partial'), rollup()).factsUnavailable).toBe(true)
    const missing = tree(3).map((n, i) => (i === 2 ? { ...n, v: null } : n))
    expect(evaluateTableExpectation(treeSample(missing), rollup()).reasonCode).toBe('TABLE_FIELD_UNAVAILABLE')
  })
})

describe('树形读法的契约', () => {
  const base = { protocol: TABLE_READ_PROTOCOL_V2, target: { framePath: [], candidates: [{ by: 'css', value: '#t' }] }, columns: [{ key: 'qty', name: '数量', valueType: 'number', numericKind: 'integer' }] }
  it('读法缺省是普通；树形缺省读全部已展开的行；旧计划不带 layout 照常解析', () => {
    expect(tableReadPlanV2Schema.parse(base).layout).toBeUndefined()
    expect(tableReadPlanV2Schema.parse({ ...base, layout: { mode: 'tree' } }).layout).toEqual({ mode: 'tree', scope: 'all' })
    expect(tableReadPlanSchema.safeParse({ ...base, layout: { mode: 'tree', scope: 'middle' } }).success).toBe(false)
  })
  it('数据检查可用的列：树形时多一列“层级路径”；父子之和只接受数字列', () => {
    const tree = tableReadPlanV2Schema.parse({ ...base, layout: { mode: 'tree' } })
    expect(tablePlanCheckColumns(tree).map((c) => c.key)).toEqual(['qty', TABLE_TREE_PATH_KEY])
    expect(tablePlanCheckColumns(tableReadPlanV2Schema.parse(base)).map((c) => c.key)).toEqual(['qty'])
    expect(validateTableExpectRuleAgainstPlan(rollup(), tree.columns)).toEqual({ valid: true })
    expect(validateTableExpectRuleAgainstPlan(tableExpectRuleSchema.parse({ rule: 'tree_rollup_match', column: TABLE_TREE_PATH_KEY }), tablePlanCheckColumns(tree))).toMatchObject({ valid: false, code: 'TABLE_NUMBER_COLUMN_REQUIRED' })
  })
})
