/**
 * table.read@2 × 常见老系统表格控件靶场（easyui / jqGrid / ExtJS 4–6 / layui / 虚拟滚动）。
 * 靶场按各控件官方默认 DOM 约定自建，不等于已兼容某真实系统。无浏览器时 skip，跳过不等于通过。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from 'playwright'
import { isChromiumAvailableCached } from '../testing/chromium-probe.js'
import { detectTable } from './table-read-v2.js'
import { centerOf, deps, expectCode, plan, run, startHarness, valueOf, type FixtureHarness } from '../testing/table-read-test-kit.js'

const DEVICE_COLUMNS = (extra: Record<string, unknown> = {}) => [
  { key: 'name', name: '名称', ...extra },
  { key: 'qty', name: '数量', valueType: 'number' as const, numericKind: 'integer' as const },
  { key: 'amount', name: '金额', valueType: 'number' as const, numericKind: 'decimal' as const },
]

describe('table.read@2 × 表格控件靶场', { timeout: 180_000 }, () => {
  let available = false
  let harness: FixtureHarness | undefined

  beforeAll(async () => {
    available = await isChromiumAvailableCached()
    if (available) harness = await startHarness()
  })
  afterAll(async () => {
    await harness?.close()
  })

  async function open(path: string): Promise<Page> {
    const page = await harness!.browser.newPage()
    await page.goto(`${harness!.base}/${path}`)
    return page
  }

  it('easyui：冻结列 + 主列拼接、分组表头、按 field 取列、日期规范化、页脚合计、隐藏列', async ({ skip }) => {
    if (!available) skip()
    const page = await open('easyui-datagrid.html')
    const sample = await run(
      page,
      plan('#dg-wrap', [
        { key: 'code', name: '编号', field: 'code' },
        { key: 'name', name: '名称', field: 'name' },
        { key: 'qty', name: '数量', field: 'qty', valueType: 'number', numericKind: 'integer' },
        { key: 'amount', name: '金额', field: 'amount', valueType: 'number', numericKind: 'decimal' },
        { key: 'expire', name: '到期日', field: 'expire', valueType: 'date' },
      ]),
    )
    expect(sample.coverage.status).toBe('complete')
    expect(sample.coverage.clues).toContain('pagination_present')
    expect(sample.rows.map((r) => valueOf(r, 'code'))).toEqual(['A001', 'A002', 'A003'])
    expect(sample.rows.map((r) => valueOf(r, 'name'))).toEqual(['服务器A', '服务器B', '服务器C'])
    expect(sample.rows.map((r) => valueOf(r, 'qty'))).toEqual([12, 7, 11])
    expect(sample.rows.map((r) => r.amount!.decimalValue)).toEqual(['1234.50', '2000.00', '2000.00'])
    expect(sample.rows.map((r) => valueOf(r, 'expire'))).toEqual(['2026-12-31', '2027-01-15', '2026-11-05'])
    expect(sample.summaryRows).toHaveLength(1)
    expect(valueOf(sample.summaryRows![0], 'name')).toBe('合计')
    expect(valueOf(sample.summaryRows![0], 'qty')).toBe(30)
    // 不带 field 时按表头列名读取同样可用
    const byName = await run(page, plan('#dg-wrap', [{ key: 'name', name: '名称' }]))
    expect(byName.rows.map((r) => valueOf(r, 'name'))).toEqual(['服务器A', '服务器B', '服务器C'])
    await page.close()
  })

  it('easyui：点选识别——认出控件、自动排除复选框与隐藏列、保留“编号”数据列', async ({ skip }) => {
    if (!available) skip()
    const page = await open('easyui-datagrid.html')
    const result = await detectTable(page, { kind: 'point', ...(await centerOf(page, '#dg-wrap .datagrid-view2 .datagrid-body td[field="name"]')) }, deps)
    expect(result.outcome).toBe('FOUND')
    if (result.outcome !== 'FOUND') return
    const d = result.detected
    expect(d.shape).toBe('easyui')
    expect(d.plan.target.candidates[0]).toEqual({ by: 'css', value: '#dg-wrap' })
    expect(d.title).toBe('设备清单')
    expect(d.plan.columns.map((c) => c.name)).toEqual(['编号', '名称', '数量', '金额', '到期日'])
    expect(d.plan.columns.map((c) => c.valueType)).toEqual(['text', 'text', 'number', 'number', 'date'])
    expect(d.plan.columns.every((c) => c.field)).toBe(true)
    expect(d.columns.filter((c) => c.excludedReason).map((c) => c.excludedReason)).toEqual(['checkbox', 'hidden'])
    expect(d.sample.rows).toHaveLength(3)
    expect(d.sample.coverage.status).toBe('complete')
    await page.close()
  })

  it('jqGrid：分组行不计入、隐藏首行与隐藏列、汇总行、按列名与路径取列', async ({ skip }) => {
    if (!available) skip()
    const page = await open('jqgrid.html')
    const sample = await run(
      page,
      plan('#gbox_grid', [
        { key: 'name', name: '名称', field: 'name' },
        { key: 'qty', name: '数量', field: 'qty', valueType: 'number', numericKind: 'integer' },
        { key: 'amount', name: '金额', field: 'amount', valueType: 'number', numericKind: 'decimal' },
        { key: 'expire', name: '到期日', field: 'expire', valueType: 'date' },
      ]),
    )
    expect(sample.coverage.status).toBe('complete')
    expect(sample.rows.map((r) => valueOf(r, 'name'))).toEqual(['服务器A', '服务器B', '服务器C'])
    expect(sample.rows.map((r) => valueOf(r, 'qty'))).toEqual([12, 7, 11])
    expect(sample.rows.map((r) => valueOf(r, 'expire'))).toEqual(['2026-12-31', '2027-01-15', '2026-11-05'])
    expect(sample.excluded).toEqual({ mergedRows: 2, paginationRows: 0, footerRows: 1 })
    expect(valueOf(sample.summaryRows![0], 'name')).toBe('合计')
    expect(sample.summaryRows![0]!.amount!.decimalValue).toBe('5234.50')
    await page.close()
  })

  it('jqGrid：点选识别——排除复选框 / 行号 / 隐藏列', async ({ skip }) => {
    if (!available) skip()
    const page = await open('jqgrid.html')
    const result = await detectTable(page, { kind: 'point', ...(await centerOf(page, '#grid tr.jqgrow td[aria-describedby="grid_name"]')) }, deps)
    expect(result.outcome).toBe('FOUND')
    if (result.outcome !== 'FOUND') return
    const d = result.detected
    expect(d.shape).toBe('jqgrid')
    expect(d.plan.target.candidates[0]).toEqual({ by: 'css', value: '#gbox_grid' })
    expect(d.plan.columns.map((c) => c.name)).toEqual(['名称', '数量', '金额', '到期日'])
    expect(d.columns.filter((c) => c.excludedReason).map((c) => c.excludedReason)).toEqual(['checkbox', 'index', 'hidden'])
    expect(d.sample.rows).toHaveLength(3)
    await page.close()
  })

  for (const version of ['4', '5'] as const) {
    it(`ExtJS ${version}.x：表头与 x-grid-row 按列序对齐，隐藏列与复选框列不影响取值`, async ({ skip }) => {
      if (!available) skip()
      const page = await open(`extjs${version}.html`)
      const sample = await run(page, plan('div.x-grid', DEVICE_COLUMNS()))
      expect(sample.coverage.status).toBe('complete')
      expect(sample.rows.map((r) => valueOf(r, 'name'))).toEqual(['服务器A', '服务器B', '服务器C'])
      expect(sample.rows.map((r) => valueOf(r, 'qty'))).toEqual([12, 7, 11])
      expect(sample.rows.map((r) => r.amount!.decimalValue)).toEqual(['1234.50', '2000.00', '2000.00'])
      await page.close()
    })
  }

  it('ExtJS 5.x：点选识别——自动排除复选框列，控件自增 id 不用于定位', async ({ skip }) => {
    if (!available) skip()
    const page = await open('extjs5.html')
    const result = await detectTable(page, { kind: 'point', ...(await centerOf(page, '#gridview-1025 tr.x-grid-row td:nth-child(2)')) }, deps)
    expect(result.outcome).toBe('FOUND')
    if (result.outcome !== 'FOUND') return
    const d = result.detected
    expect(d.shape).toBe('extjs')
    expect(d.plan.columns.map((c) => c.name)).toEqual(['名称', '数量', '金额'])
    expect(d.columns.filter((c) => c.excludedReason).map((c) => c.excludedReason)).toEqual(['checkbox'])
    const selector = (d.plan.target.candidates[0] as { value: string }).value
    expect(selector).not.toMatch(/\d{2,}/)
    expect(d.title).toBe('设备清单')
    await page.close()
  })

  it('ExtJS 6.x：锁定列 + 分组表头 + 汇总行；用“统计 / 数量”路径取列，仅写“数量”也唯一', async ({ skip }) => {
    if (!available) skip()
    const page = await open('extjs6.html')
    const sample = await run(
      page,
      plan('div.x-grid', [
        { key: 'name', name: '名称' },
        { key: 'qty', name: '统计 / 数量', valueType: 'number', numericKind: 'integer' },
        { key: 'amount', name: '金额', valueType: 'number', numericKind: 'decimal' },
      ]),
    )
    expect(sample.coverage.status).toBe('complete')
    expect(sample.rows.map((r) => valueOf(r, 'name'))).toEqual(['服务器A', '服务器B', '服务器C'])
    expect(sample.rows.map((r) => valueOf(r, 'qty'))).toEqual([12, 7, 11])
    expect(sample.summaryRows).toHaveLength(1)
    expect(valueOf(sample.summaryRows![0], 'name')).toBe('合计')
    expect(valueOf(sample.summaryRows![0], 'qty')).toBe(30)
    await page.close()
  })

  it('layui：固定列回退到固定区读取、隐藏列、合计行、特殊列排除', async ({ skip }) => {
    if (!available) skip()
    const page = await open('layui-table.html')
    const sample = await run(page, plan('div.layui-table-view', DEVICE_COLUMNS({ field: undefined })))
    expect(sample.coverage.status).toBe('complete')
    expect(sample.rows.map((r) => valueOf(r, 'name'))).toEqual(['服务器A', '服务器B', '服务器C'])
    expect(sample.rows.map((r) => valueOf(r, 'qty'))).toEqual([12, 7, 11])
    // 金额列的主表单元格被隐藏，数据在固定区里
    expect(sample.rows.map((r) => r.amount!.decimalValue)).toEqual(['1234.50', '2000.00', '2000.00'])
    expect(valueOf(sample.summaryRows![0], 'name')).toBe('合计')
    expect(sample.summaryRows![0]!.amount!.decimalValue).toBe('5234.50')
    expect(sample.coverage.clues).toContain('pagination_present')

    const detected = await detectTable(page, { kind: 'point', ...(await centerOf(page, '.layui-table-main td[data-field="name"]')) }, deps)
    expect(detected.outcome).toBe('FOUND')
    if (detected.outcome !== 'FOUND') return
    expect(detected.detected.shape).toBe('layui')
    expect(detected.detected.plan.columns.map((c) => c.name)).toEqual(['名称', '数量', '金额'])
    expect(detected.detected.columns.filter((c) => c.excludedReason).map((c) => c.excludedReason)).toEqual(['checkbox'])
    await page.close()
  })

  it('合计行：原生表格里首列写“合计”的行自动移出数据行；也可手工指定', async ({ skip }) => {
    if (!available) skip()
    const page = await harness!.browser.newPage()
    await page.setContent(
      `<table id="t"><thead><tr><th>类别</th><th>金额</th></tr></thead><tbody>
       <tr><td>甲</td><td>10</td></tr><tr><td>乙</td><td>20</td></tr><tr><td>合计</td><td>30</td></tr><tr><td>本页统计</td><td>30</td></tr>
       </tbody></table>`,
    )
    const columns = [
      { key: 'kind', name: '类别' },
      { key: 'amount', name: '金额', valueType: 'number' as const, numericKind: 'integer' as const },
    ]
    const auto = await run(page, plan('#t', columns))
    expect(auto.rows.map((r) => valueOf(r, 'kind'))).toEqual(['甲', '乙', '本页统计'])
    expect(auto.summaryRows!.map((r) => valueOf(r, 'kind'))).toEqual(['合计'])
    const manual = await run(page, plan('#t', columns, { rows: { excludeHeader: true, header: 'auto', totalRow: { columnKey: 'kind', equals: '本页统计' } } }))
    expect(manual.rows.map((r) => valueOf(r, 'kind'))).toEqual(['甲', '乙'])
    expect(manual.summaryRows!.map((r) => valueOf(r, 'kind'))).toEqual(['合计', '本页统计'])
    await page.close()
  })

  it('虚拟滚动：只渲染可视行的表格标 partial，普通滚动区的表格不误判', async ({ skip }) => {
    if (!available) skip()
    const page = await open('virtual-scroll.html')
    const columns = [{ key: 'name', name: '名称' }]
    const virtual = await run(page, plan('#virtual', columns))
    expect(virtual.coverage.status).toBe('partial')
    expect(virtual.coverage.reasonCode).toBe('TABLE_VIRTUAL_SCROLL')
    const normal = await run(page, plan('#plain', columns))
    expect(normal.coverage.status).toBe('complete')
    expect(normal.rowCount).toBe(7)
    await page.close()
  })

  it('日期列：无法识别的格式记为读不出，而不是猜', async ({ skip }) => {
    if (!available) skip()
    const page = await harness!.browser.newPage()
    await page.setContent(
      `<table id="t"><thead><tr><th>时间</th></tr></thead><tbody>
       <tr><td>2026-02-30</td></tr><tr><td>2026年3月5日 08:09</td></tr><tr><td>昨天</td></tr><tr><td>2026.10.07 23:59:01</td></tr>
       </tbody></table>`,
    )
    const sample = await run(page, plan('#t', [{ key: 'at', name: '时间', valueType: 'date' }]))
    expect(sample.rows.map((r) => r.at!.status)).toEqual(['error', 'ok', 'error', 'ok'])
    expect(sample.rows.map((r) => r.at!.value)).toEqual([null, '2026-03-05 08:09:00', null, '2026-10-07 23:59:01'])
    await page.close()
  })

  it('列不存在时各控件都明确报错，不回退序号', async ({ skip }) => {
    if (!available) skip()
    for (const [file, selector] of [
      ['easyui-datagrid.html', '#dg-wrap'],
      ['jqgrid.html', '#gbox_grid'],
      ['extjs4.html', 'div.x-grid'],
      ['layui-table.html', 'div.layui-table-view'],
    ] as const) {
      const page = await open(file)
      await expectCode(run(page, plan(selector, [{ key: 'x', name: '不存在的列' }])), 'TABLE_COLUMN_NOT_FOUND')
      await page.close()
    }
  })
})
