/**
 * 交叉表读取（layout.mode = crosstab）× 靶场与真实快照：
 * /grids/crosstab 原生两层列头 + 纵向合并行头——识别建议、逆透视长表与 /grids/truth?view=crosstab 逐行一致、
 * 合计行 / 列分离成 totals、crosstab_total_match 一正（默认）一反（bad=1 华东小计不符）。
 * 真实 FineReport 快照（/legacy/1/r/22，只在 tmp/ 里有快照的机器上可跑）验证冻结表合并行头与千分位数值的逆透视。
 * 无浏览器时 skip，跳过不等于通过。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from 'playwright'
import { evaluateTableExpectation, tableExpectRuleSchema, type TableReadPlanV2 } from '@cairn/shared'
import { isChromiumAvailableCached } from '../testing/chromium-probe.js'
import { deps, plan, run, startPortalHarness, type PortalHarness } from '../testing/table-read-test-kit.js'
import { detectTable } from './table-read-v2.js'

const ROW_DIMS = [
  { key: 'col_1', name: '区域' },
  { key: 'col_2', name: '城市' },
]
const crossPlan = (selector = '#cross'): TableReadPlanV2 =>
  plan(selector, ROW_DIMS, { layout: { mode: 'crosstab', columnDims: ['指标', '月份'], value: { name: '值', numericKind: 'decimal' } } })
const totalMatch = tableExpectRuleSchema.parse({ rule: 'crosstab_total_match' })

type CrossTruthRow = { region: string; city: string; kind: string; month: string; value: number | null }

describe('交叉表读取', { timeout: 180_000 }, () => {
  let available = false
  let portal: PortalHarness | undefined
  let page: Page

  beforeAll(async () => {
    available = await isChromiumAvailableCached()
    if (!available) return
    portal = await startPortalHarness()
    page = await portal.newPage()
  })
  afterAll(async () => {
    await portal?.close()
  })

  const openCross = async (query = '') => {
    await page.goto(`${portal!.base}/grids/crosstab${query ? `?${query}` : ''}`)
    await page.locator('#cross tbody td.dim').first().waitFor()
  }
  const truth = async (query = '') => (await portal!.truth<{ rows: CrossTruthRow[] }>('crosstab', query)).rows

  it('识别：像交叉表时给建议（前几列是行维度、列头有几层），不自动改读法', async (ctx) => {
    if (!available) return ctx.skip()
    await openCross()
    const box = await page.locator('#cross tbody tr').first().locator('td.num').first().boundingBox()
    const detected = await detectTable(page, { kind: 'point', x: box!.x + 4, y: box!.y + 4 }, deps)
    expect(detected.outcome).toBe('FOUND')
    if (detected.outcome !== 'FOUND') return
    expect(detected.detected.crosstabHint).toEqual({ rowDims: 2, depth: 2 })
    expect(detected.detected.plan.layout).toBeUndefined()
    // 同一张表按普通读法照常可读
    expect((await run(page, detected.detected.plan)).coverage.status).toBe('complete')
  })

  it('逆透视：长表与真值逐行一致（每格一行，空格当 0）；合计行 / 列分离', async (ctx) => {
    if (!available) return ctx.skip()
    await openCross()
    const sample = await run(page, crossPlan())
    const t = await truth()
    expect(sample.rows.map((r) => [r.col_1?.value, r.col_2?.value, r.dim_1?.value, r.dim_2?.value, r.value?.decimalValue ?? null]))
      .toEqual(t.map((r) => [r.region, r.city, r.kind, r.month, r.value === null ? null : r.value.toFixed(1)]))
    expect(sample.coverage.status).toBe('complete')
    expect(sample.summaryRows).toBeUndefined()
    expect(sample.crosstab).toMatchObject({ rowDims: ['col_1', 'col_2'], colDims: ['dim_1', 'dim_2'], valueKey: 'value', sourceRows: 4, sourceColumns: 6 })
    const totals = sample.crosstab!.totals
    // 3 个合计行 × 7 列 + 4 个数据行 × 合计列
    expect(totals).toHaveLength(25)
    expect(sample.crosstab!.totalsTruncated).toBeUndefined()
    const eastCol = totals.find((x) => x.rowLevel === 1 && x.colLevel === 0 && x.dims[0] === '华东')
    expect(eastCol?.dims).toEqual(['华东', '小计', '合计', null])
    expect(eastCol?.value.decimalValue).toBe('277.5')
    const shanghaiRow = totals.find((x) => x.rowLevel === 2 && x.colLevel === 0 && x.dims[1] === '上海')
    expect(shanghaiRow?.value.decimalValue).toBe('138.0')
    const grandCell = totals.find((x) => x.rowLevel === 0 && x.colLevel === 2 && x.dims[2] === '本年累计' && x.dims[3] === '1月')
    expect(grandCell?.value.decimalValue).toBe('92.0')
  })

  it('crosstab_total_match：一致时通过；华东小计不符时只报错的合计格；普通读法如实说无法核对', async (ctx) => {
    if (!available) return ctx.skip()
    await openCross()
    const good = evaluateTableExpectation(await run(page, crossPlan()), totalMatch)
    expect(good.passed).toBe(true)
    expect(good.details.matchedRows).toBe(25)
    await openCross('bad=1')
    const bad = evaluateTableExpectation(await run(page, crossPlan()), totalMatch)
    expect(bad.passed).toBe(false)
    expect(bad.factsUnavailable).toBeFalsy()
    expect(bad.reasonCode).toBe('CROSSTAB_TOTAL_MISMATCH')
    expect(bad.details.violatingRowsCount).toBe(4)
    expect(bad.details.violatingRows[0]?.reasonSummary).toContain('「华东 / 小计」×「本年累计 / 1月」')
    // 普通读法没有合计格：无法确认，不当作通过
    const flat = await run(page, plan('#cross', ROW_DIMS))
    const unknown = evaluateTableExpectation(flat, totalMatch)
    expect(unknown.factsUnavailable).toBe(true)
    expect(unknown.reasonCode).toBe('TABLE_CROSSTAB_MISSING')
  })

  it('真实 FineReport 快照：冻结表 + 纵向合并行头 + 千分位数值，按交叉表读成宽指标长表', async (ctx) => {
    if (!available) return ctx.skip()
    // 快照在被忽略的 tmp/ 里，只在有快照的机器上可跑；没有时跳过不算失败
    const probe = await portal!.context.request.get(`${portal!.base}/legacy/1/r/22`)
    if (!probe.ok()) return ctx.skip()
    await page.goto(`${portal!.base}/legacy/1/r/22`)
    await page.locator('.frozen-table').first().waitFor()
    const detected = await detectTable(page, { kind: 'root', selector: '.frozen-table', framePath: [] }, deps)
    expect(detected.outcome).toBe('FOUND')
    if (detected.outcome !== 'FOUND') return
    expect(detected.detected.shape).toBe('finereport')
    const real = plan('.frozen-table', [
      { key: 'col_1', name: '省分' },
      { key: 'col_2', name: '地市' },
    ], { layout: { mode: 'crosstab', columnDims: ['指标'], value: { name: '值', numericKind: 'decimal' } } })
    const sample = await run(page, real)
    const x = sample.crosstab!
    // 行头全部纵向合并成「广东」，一个省级行 + 21 个地市行；每个地市行 58 个指标列（口径、运营商 + 56 个金额指标；管理区域列在页面上是隐藏的）
    expect(x.sourceRows).toBe(22)
    expect(x.sourceColumns).toBe(58)
    expect(sample.rows.every((r) => r.col_1?.value === '广东')).toBe(true)
    // 数值列头与页面表头逐一对齐（第一行明细的长表行就是各指标名）。worker 的 tsconfig 不带 DOM lib，
    // evaluate 回调里经 globalThis 取 document / getComputedStyle，不直接引用 DOM 全局名。
    const headers = await page.evaluate((count: number) => {
      const g = globalThis as Record<string, any>
      const row = g.document.querySelector('#frozen-north table tbody tr:nth-child(2)')
      return Array.from(row?.querySelectorAll('td') ?? [])
        .filter((td: any) => g.getComputedStyle(td).display !== 'none')
        .slice(0, count)
        .map((td: any) => (td.textContent ?? '').trim())
    }, x.sourceColumns)
    expect(sample.rows.slice(0, headers.length).map((r) => r.dim_1?.value ?? null)).toEqual(headers.map((t) => t || null))
    // 宽表逆透视超出单步输出预算：如实判“部分”并说明截断，不给“读全了”的假象
    expect(sample.coverage).toMatchObject({ status: 'partial', reasonCode: 'TABLE_OUTPUT_BUDGET' })
    expect(sample.rows.length).toBeLessThan(22 * 58)
    // 千分位数字读成了数：ok 的数值格都有 decimalValue
    const numeric = sample.rows.filter((r) => r.value?.status === 'ok')
    expect(numeric.length).toBeGreaterThan(0)
    expect(numeric.every((r) => typeof r.value?.decimalValue === 'string' && !r.value.decimalValue.includes(','))).toBe(true)
    // 这张快照没有合计行 / 列（totals 为空），且读不全时合计检查先被覆盖门挡下，不下结论
    expect(sample.crosstab!.totals).toHaveLength(0)
    const checked = evaluateTableExpectation(sample, totalMatch)
    expect(checked.factsUnavailable).toBe(true)
    expect(checked.reasonCode).toBe('TABLE_FACTS_UNAVAILABLE')
  })
})
