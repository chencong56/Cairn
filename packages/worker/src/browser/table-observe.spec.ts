import { describe, expect, it } from 'vitest'
import { sampleTableOnPage, TableObserveError } from './table-observe.js'
import type { Page } from './runtime.js'

type EvalCallback = (arg: unknown) => unknown

/** 可编程 Page 桩：按调用序返回不同的 evaluate 结果，模拟页面变化。 */
function pageStub(results: Array<Record<string, unknown>>): Page {
  let call = 0
  const evaluate = async (fn: EvalCallback, _arg: unknown) => {
    const snapshot = results[Math.min(call, results.length - 1)]!
    call++
    // 让页面脚本读到的"DOM 采样"直接来自预置快照
    return snapshot
  }
  return { evaluate } as unknown as Page
}

const PLAN = {
  protocol: 'table.read@1' as const,
  target: { framePath: [], candidates: [{ by: 'css' as const, value: '#tbl' }] },
  scope: 'current_page' as const,
  columns: [
    { key: 'name', name: '名称', valueType: 'text' as const },
    { key: 'amount', name: '金额', valueType: 'number' as const, numericKind: 'decimal' as const },
  ],
  limits: { maxRows: 200, maxCols: 32 },
}

function snap(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    rootFound: true,
    rootCount: 1,
    isBusy: false,
    hasDeclaredLoading: false,
    emptyVerified: false,
    headerDigest: '名称|金额',
    hasPagination: false,
    totalDomRows: 1,
    rows: [
      {
        values: {
          name: { value: '订单A', rawText: '订单A', status: 'ok' },
          amount: { value: 100, rawText: '¥100.00', decimalValue: '100.00', status: 'ok' },
        },
        rawDigest: 'name:订单A|amount:100',
      },
    ],
    ...overrides,
  }
}

describe('sampleTableOnPage', () => {
  it('连续两次一致采样 → coverage complete，保留 decimalValue', async () => {
    const page = pageStub([snap()])
    const sample = await sampleTableOnPage(page, PLAN as any)
    expect(sample.coverage.status).toBe('complete')
    expect(sample.rows[0]!.amount!.decimalValue).toBe('100.00')
    expect(sample.rowCount).toBe(1)
  })

  it('存在分页不降低覆盖状态，只保留范围线索', async () => {
    const page = pageStub([snap({ hasPagination: true })])
    const sample = await sampleTableOnPage(page, PLAN as any)
    expect(sample.coverage.status).toBe('complete')
    expect(sample.coverage.clues).toContain('pagination_present')
  })

  it('两次内容变化 → coverage unknown + TABLE_MUTATING_UNSTABLE', async () => {
    const page = pageStub([
      snap(),
      snap({ rows: [{ values: { name: { value: '订单B', rawText: '订单B', status: 'ok' } }, rawDigest: 'x' }] }),
      snap({ rows: [{ values: { name: { value: '订单C', rawText: '订单C', status: 'ok' } }, rawDigest: 'y' }] }),
      snap({ rows: [{ values: { name: { value: '订单D', rawText: '订单D', status: 'ok' } }, rawDigest: 'z' }] }),
      snap({ rows: [{ values: { name: { value: '订单E', rawText: '订单E', status: 'ok' } }, rawDigest: 'w' }] }),
      snap({ rows: [{ values: { name: { value: '订单F', rawText: '订单F', status: 'ok' } }, rawDigest: 'v' }] }),
    ])
    const sample = await sampleTableOnPage(page, PLAN as any)
    expect(sample.coverage.status).toBe('unknown')
    expect(sample.coverage.reasonCode).toBe('TABLE_MUTATING_UNSTABLE')
  })

  it('持续加载 → coverage unknown + TABLE_READINESS_TIMEOUT，不产出空表', async () => {
    const page = pageStub([snap({ isBusy: true })])
    const sample = await sampleTableOnPage(page, PLAN as any, { timeoutMs: 200 })
    expect(sample.coverage.status).toBe('unknown')
    expect(sample.coverage.reasonCode).toBe('TABLE_READINESS_TIMEOUT')
  })

  it('零行且无空态证据 → coverage unknown + TABLE_EMPTY_UNVERIFIED', async () => {
    const page = pageStub([snap({ rows: [], totalDomRows: 0 })])
    const sample = await sampleTableOnPage(page, PLAN as any)
    expect(sample.coverage.status).toBe('unknown')
    expect(sample.coverage.reasonCode).toBe('TABLE_EMPTY_UNVERIFIED')
  })

  it('零行且命中声明空态 → coverage complete 的可信空表', async () => {
    const page = pageStub([snap({ rows: [], totalDomRows: 0, emptyVerified: true })])
    const sample = await sampleTableOnPage(page, PLAN as any)
    expect(sample.coverage.status).toBe('complete')
    expect(sample.rows).toHaveLength(0)
  })

  it('超出读取上限 → coverage partial + 截断原因', async () => {
    const page = pageStub([snap({ totalDomRows: 500 })])
    const sample = await sampleTableOnPage(page, { ...PLAN, limits: { maxRows: 2, maxCols: 32 } } as any)
    expect(sample.coverage.status).toBe('partial')
    expect(sample.coverage.reasonCode).toBe('TABLE_ROW_LIMIT_TRUNCATED')
    expect(sample.rowCount).toBe(1)
  })

  it('根不存在 → 抛 TABLE_NOT_FOUND，不产出貌似完整的空样本', async () => {
    const page = pageStub([snap({ rootFound: false, rootCount: 0, rows: [] })])
    await expect(sampleTableOnPage(page, PLAN as any)).rejects.toMatchObject({ code: 'TABLE_NOT_FOUND' })
  })

  it('根不唯一 → 抛 TABLE_AMBIGUOUS', async () => {
    const page = pageStub([snap({ rootCount: 3 })])
    await expect(sampleTableOnPage(page, PLAN as any)).rejects.toBeInstanceOf(TableObserveError)
    await expect(sampleTableOnPage(pageStub([snap({ rootCount: 3 })]), PLAN as any)).rejects.toMatchObject({
      code: 'TABLE_AMBIGUOUS',
    })
  })

  it('meta 绑定进入 sample.source（runId 不再伪造）', async () => {
    const page = pageStub([snap()])
    const sample = await sampleTableOnPage(page, PLAN as any, {
      meta: { runId: '11111111-1111-4111-8111-111111111111' },
    })
    expect(sample.source.runId).toBe('11111111-1111-4111-8111-111111111111')
  })
})
