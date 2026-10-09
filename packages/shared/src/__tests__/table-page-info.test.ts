import { describe, expect, it } from 'vitest'
import {
  evaluateTableExpectation,
  expectedPageRows,
  tableExpectRuleSchema,
  tableSampleSchema,
  validateTableExpectRuleAgainstPlan,
  type TablePageInfo,
  type TableSample,
} from '../index.js'

function sample(rows: number, pageInfo?: TablePageInfo, status: 'complete' | 'partial' | 'unknown' = 'complete'): TableSample {
  return tableSampleSchema.parse({
    protocol: 'table.sample@1',
    source: { runId: '11111111-1111-4111-8111-111111111111', sampledAt: new Date().toISOString(), planDigest: 'a'.repeat(64) },
    columns: [{ key: 'n', name: '编号', valueType: 'text' }],
    rows: Array.from({ length: rows }, (_, i) => ({ n: { value: String(i), status: 'ok' } })),
    rowCount: rows,
    coverage: { status, clues: ['pagination_present'] },
    presentation: { omitted: false, previewCount: rows },
    ...(pageInfo ? { pageInfo } : {}),
  })
}
const total = (op: string, value: number) => tableExpectRuleSchema.parse({ rule: 'page_total', op, value })
const consistency = tableExpectRuleSchema.parse({ rule: 'page_consistency' })

describe('总条数（page_total）', () => {
  it('读到总条数：按比较判定，不看本页行数', () => {
    const s = sample(20, { totalRows: 45, rawText: '共 45 条' })
    expect(evaluateTableExpectation(s, total('eq', 45)).passed).toBe(true)
    const bad = evaluateTableExpectation(s, total('eq', 50))
    expect(bad.passed).toBe(false)
    expect(bad.factsUnavailable).toBeFalsy()
    expect(bad.reasonMessage).toContain('共 45 条')
  })
  it('行读不全（虚拟滚动等部分覆盖）不影响总条数判定', () => {
    expect(evaluateTableExpectation(sample(18, { totalRows: 45, rawText: '' }, 'partial'), total('gt', 0)).passed).toBe(true)
  })
  it('没读到总条数 / 表格未就绪：无法确认', () => {
    expect(evaluateTableExpectation(sample(20), total('gt', 0)).reasonCode).toBe('PAGE_INFO_UNAVAILABLE')
    expect(evaluateTableExpectation(sample(20, { totalRows: 45, rawText: '' }, 'unknown'), total('gt', 0)).factsUnavailable).toBe(true)
  })
})

describe('本页条数与分页一致（page_consistency）', () => {
  it('依据一：分页显示的行区间', () => {
    expect(expectedPageRows({ rowRange: { from: 21, to: 40 }, rawText: '' })).toMatchObject({ rows: 20 })
    expect(evaluateTableExpectation(sample(20, { rowRange: { from: 21, to: 40 }, rawText: '' }), consistency).passed).toBe(true)
  })
  it('依据二：每页条数 + 总条数 + 当前页（最后一页不满）', () => {
    const info = { pageSize: 20, totalRows: 45, currentPage: 3, rawText: '' }
    expect(expectedPageRows(info)).toMatchObject({ rows: 5 })
    expect(evaluateTableExpectation(sample(5, info), consistency).passed).toBe(true)
    const short = evaluateTableExpectation(sample(4, info), consistency)
    expect(short.passed).toBe(false)
    expect(short.reasonCode).toBe('PAGE_ROWS_MISMATCH')
    expect(short.reasonMessage).toContain('应有 5 行')
  })
  it('依据三：不是最后一页就应满页', () => {
    const info = { pageSize: 20, totalPages: 3, currentPage: 1, rawText: '' }
    expect(evaluateTableExpectation(sample(18, info), consistency).passed).toBe(false)
  })
  it('信息不够 / 行读不全：无法确认，不猜', () => {
    expect(evaluateTableExpectation(sample(20, { totalRows: 45, rawText: '' }), consistency).reasonCode).toBe('PAGE_INFO_INSUFFICIENT')
    expect(evaluateTableExpectation(sample(18, { rowRange: { from: 1, to: 20 }, rawText: '' }, 'partial'), consistency).factsUnavailable).toBe(true)
  })
  it('两条新规则不引用列，校验总是通过', () => {
    expect(validateTableExpectRuleAgainstPlan(total('gte', 1), []).valid).toBe(true)
    expect(validateTableExpectRuleAgainstPlan(consistency, []).valid).toBe(true)
  })
})
