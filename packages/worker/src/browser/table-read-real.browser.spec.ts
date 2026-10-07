/**
 * table.read@2 × 对照真实老系统页面（BI 报表中心 / OA 门户 / 帆软报表）自建的靶场：
 * jQuery EasyUI 1.4.5 datagrid（隐藏列、空表头、值带单位）、Element UI el-table（表头表体分表、分组表头、合计行、空态）、
 * FineReport 冻结表（四块拼接、行头 rowspan、隐藏列）。夹具只复刻 DOM 结构，数据全部虚构。
 * 无浏览器时 skip，跳过不等于通过。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from 'playwright'
import { isChromiumAvailableCached } from '../testing/chromium-probe.js'
import { detectTable } from './table-read-v2.js'
import { centerOf, deps, plan, run, startHarness, valueOf, type FixtureHarness } from '../testing/table-read-test-kit.js'

describe('table.read@2 × 真实老系统结构靶场', { timeout: 180_000 }, () => {
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

  it('EasyUI（BI 报表中心风格）：隐藏列、空表头、冻结区为空，按 field 取列', async ({ skip }) => {
    if (!available) skip()
    const page = await open('easyui-edc.html')
    const sample = await run(
      page,
      plan('#report-grid', [
        { key: 'no', name: '序号', field: 'report_num', valueType: 'number', numericKind: 'integer' },
        { key: 'name', name: '报表名称', field: 'item1' },
        { key: 'uses', name: '使用次数', field: 'item4', valueType: 'number', numericKind: 'integer' },
        { key: 'date', name: '最新数据', field: 'item2' },
        { key: 'op', name: '操作', field: 'item8' },
      ]),
    )
    expect(sample.coverage.status).toBe('complete')
    expect(sample.coverage.clues).toContain('pagination_present')
    expect(sample.rows.map((r) => valueOf(r, 'name'))).toEqual(['本年累计4G订单统计表', '本年累计5G订单统计表', '历史累计5G订单统计表'])
    expect(sample.rows.map((r) => valueOf(r, 'uses'))).toEqual([35, 668, 23])
    expect(sample.rows.map((r) => valueOf(r, 'op'))).toEqual(['查看', '查看', '查看'])
    await page.close()
  })

  it('EasyUI：点选识别——序号 / 操作 / 隐藏列自动排除，数字列认出来', async ({ skip }) => {
    if (!available) skip()
    const page = await open('easyui-edc.html')
    const result = await detectTable(page, { kind: 'point', ...(await centerOf(page, '#report-grid td[field="item1"]')) }, deps)
    expect(result.outcome).toBe('FOUND')
    if (result.outcome !== 'FOUND') return
    const d = result.detected
    expect(d.shape).toBe('easyui')
    const kept = d.columns.filter((c) => !c.excludedReason).map((c) => c.name)
    expect(kept).toEqual(['报表名称', '使用次数', '使用人数', '最新数据', '更新周期', '报表提出人'])
    expect(d.columns.find((c) => c.name === '序号')?.excludedReason).toBe('index')
    expect(d.columns.find((c) => c.name === '操作')?.excludedReason).toBe('action')
    expect(d.columns.filter((c) => c.excludedReason === 'hidden')).toHaveLength(2)
    expect(d.columns.find((c) => c.name === '使用次数')?.valueType).toBe('number')
    await page.close()
  })

  it('EasyUI：值带单位（个 / 秒 / kb）、百分号与占位符 -', async ({ skip }) => {
    if (!available) skip()
    const page = await open('easyui-edc.html')
    const sample = await run(
      page,
      plan('#indicator-grid', [
        { key: 'name', name: '指标' },
        { key: 'val', name: '指标值', valueType: 'number', numericKind: 'decimal' },
        { key: 'mom', name: '环比', valueType: 'number', numericKind: 'decimal' },
      ]),
    )
    expect(sample.rows.map((r) => valueOf(r, 'val'))).toEqual([684494, 609615, 2, 4])
    expect(sample.rows.map((r) => valueOf(r, 'mom'))).toEqual([12.5, -3.2, null, 0])
    expect(sample.rows[2]!.mom!.status).toBe('missing')
    await page.close()
  })

  it('Element UI：表头表体分表、选择列与操作列、gutter 列不影响取列', async ({ skip }) => {
    if (!available) skip()
    const page = await open('elementui-table.html')
    const sample = await run(
      page,
      plan('.report-table', [
        { key: 'name', name: '报表名称' },
        { key: 'date', name: '最新数据' },
        { key: 'cycle', name: '更新周期' },
        { key: 'op', name: '操作' },
      ]),
    )
    expect(sample.coverage.status).toBe('complete')
    expect(sample.rows.map((r) => valueOf(r, 'name'))).toEqual(['存量业务统计表', '楼宇覆盖面积统计表', '结算全流程明细表'])
    expect(sample.rows.map((r) => valueOf(r, 'cycle'))).toEqual(['每月6日', '每日', '每日'])
    expect(sample.rows.map((r) => valueOf(r, 'op'))).toEqual(['查看', '查看', '查看'])
    await page.close()
  })

  it('Element UI：点选识别——自动排除选择列与操作列', async ({ skip }) => {
    if (!available) skip()
    const page = await open('elementui-table.html')
    const result = await detectTable(page, { kind: 'point', ...(await centerOf(page, '.report-table tbody tr:nth-child(2) td:nth-child(3)')) }, deps)
    expect(result.outcome).toBe('FOUND')
    if (result.outcome !== 'FOUND') return
    const d = result.detected
    expect(d.shape).toBe('elementui')
    expect(d.columns.filter((c) => !c.excludedReason).map((c) => c.name)).toEqual(['报表名称', '最新数据', '更新周期'])
    expect(d.columns[0]?.excludedReason).toBe('checkbox')
    expect(d.columns.find((c) => c.name === '操作')?.excludedReason).toBe('action')
    expect(d.sample.rows).toHaveLength(3)
    await page.close()
  })

  it('Element UI：暂无数据的空表读成“空表已确认”，不是读取失败', async ({ skip }) => {
    if (!available) skip()
    const page = await open('elementui-table.html')
    const sample = await run(page, plan('.empty-table', [{ key: 'name', name: '合同名称' }, { key: 'end', name: '合同到期时间' }]))
    expect(sample.rows).toHaveLength(0)
    expect(sample.coverage.status).toBe('complete')
    await page.close()
  })

  it('Element UI：分组表头用“上级 / 列名”取列，合计行（footer）单独输出，分页提示进线索', async ({ skip }) => {
    if (!available) skip()
    const page = await open('elementui-table.html')
    const sample = await run(
      page,
      plan('.summary-table', [
        { key: 'area', name: '区域' },
        { key: 'month', name: '收入（万元） / 本月', valueType: 'number', numericKind: 'decimal' },
        { key: 'total', name: '收入（万元） / 累计', valueType: 'number', numericKind: 'decimal' },
        { key: 'sites', name: '站址数', valueType: 'number', numericKind: 'integer' },
      ]),
    )
    expect(sample.rows.map((r) => valueOf(r, 'area'))).toEqual(['华北', '华东', '华南'])
    expect(sample.rows.map((r) => r.month!.decimalValue)).toEqual(['1200.50', '2300.25', '980.00'])
    expect(sample.summaryRows).toHaveLength(1)
    expect(valueOf(sample.summaryRows![0], 'area')).toBe('合计')
    expect(sample.summaryRows![0]!.month!.decimalValue).toBe('4480.75')
    expect(sample.coverage.clues).toContain('pagination_present')
    await page.close()
  })

  it('FineReport 冻结表：四块拼回一张表，行头 rowspan 向下补齐，隐藏列不读，合计行单独输出', async ({ skip }) => {
    if (!available) skip()
    const page = await open('finereport-frozen.html')
    const sample = await run(
      page,
      plan('.frozen-table', [
        { key: 'prov', name: '省分' },
        { key: 'city', name: '地市' },
        { key: 'kind', name: '口径' },
        { key: 'income', name: '收入（万元）', valueType: 'number', numericKind: 'decimal' },
        { key: 'mom', name: '环比（%）', valueType: 'number', numericKind: 'decimal' },
      ]),
    )
    expect(sample.coverage.status).toBe('complete')
    expect(sample.rows.map((r) => valueOf(r, 'prov'))).toEqual(['广东', '广东', '广东', '广西'])
    expect(sample.rows.map((r) => valueOf(r, 'city'))).toEqual(['-', '广州市', '深圳市', '-'])
    expect(sample.rows.map((r) => r.income!.decimalValue)).toEqual(['61080.77', '11385.57', '1573.04', '2000.00'])
    expect(sample.rows.map((r) => valueOf(r, 'mom'))).toEqual([-99.82, -7.99, -46.74, 3.1])
    expect(sample.summaryRows).toHaveLength(1)
    expect(valueOf(sample.summaryRows![0], 'prov')).toBe('合计')
    await page.close()
  })

  it('FineReport：点选任一块单元格都识别成整张冻结表，隐藏列自动排除；参数栏的排版表不当数据表', async ({ skip }) => {
    if (!available) skip()
    const page = await open('finereport-frozen.html')
    for (const sel of ['#frozen-west td[id^="B4"]', '#frozen-center td[id^="G5"]', '#frozen-north td[id^="G2"]']) {
      const result = await detectTable(page, { kind: 'point', ...(await centerOf(page, sel)) }, deps)
      expect(result.outcome, sel).toBe('FOUND')
      if (result.outcome !== 'FOUND') return
      const d = result.detected
      expect(d.shape).toBe('finereport')
      expect(d.columns.filter((c) => !c.excludedReason).map((c) => c.name), sel).toEqual(['省分', '地市', '口径', '运营商', '收入（万元）', '环比（%）'])
      expect(d.columns.filter((c) => c.excludedReason === 'hidden').length).toBeGreaterThanOrEqual(2)
      expect(d.columns.find((c) => c.name === '收入（万元）')?.valueType).toBe('number')
      expect(d.sample.summaryRows).toHaveLength(1)
    }
    const layout = await detectTable(page, { kind: 'point', ...(await centerOf(page, '.parameter-container td')) }, deps)
    if (layout.outcome === 'FOUND') expect(layout.detected.shape).not.toBe('finereport')
    await page.close()
  })
})
