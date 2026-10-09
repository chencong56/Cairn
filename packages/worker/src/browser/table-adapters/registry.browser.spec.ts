/**
 * 适配器注册表一致性：每个已登记的适配器都必须有一份靶场点选用例，点选后认出的形态等于它声明的 shape。
 * 新增适配器忘记挂用例时，这里会失败。无浏览器时 skip，跳过不等于通过。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isChromiumAvailableCached } from '../../testing/chromium-probe.js'
import { detectTable } from '../table-read-v2.js'
import { FIXTURES, centerOf, deps, plan, run, startHarness, startPortalHarness, type FixtureHarness, type PortalHarness, type TruthRows } from '../../testing/table-read-test-kit.js'
import { ADAPTER_FACTORIES } from './registry.js'
import type { AdapterHelpers } from './types.js'

/** shape → 靶场页面与一个落在数据格上的选择器。`portal` 为真时页面来自目标系统 target-popup-portal 的 /grids/（真实控件库渲染）。 */
export const CONFORMANCE_CASES: Record<string, { file: string; cell: string; portal?: boolean }> = {
  easyui: { file: 'easyui-edc.html', cell: '#report-grid td[field="item1"]' },
  jqgrid: { file: 'jqgrid.html', cell: '#grid tr.jqgrow td[aria-describedby="grid_name"]' },
  extjs: { file: 'extjs4.html', cell: 'div.x-grid tr.x-grid-row td:nth-child(2)' },
  layui: { file: 'layui-table.html', cell: '.layui-table-main td[data-field="name"]' },
  elementui: { file: 'elementui-table.html', cell: '.report-table tbody tr:nth-child(2) td:nth-child(3)' },
  finereport: { file: 'finereport-frozen.html', cell: '#frozen-center td[id^="G5"]' },
  aggrid: { file: 'aggrid?rows=6', cell: '#grid .ag-center-cols-container .ag-cell[col-id="name"]', portal: true },
  antd: { file: 'antd?rows=6', cell: '#grid tbody tr.ant-table-row td:nth-child(3)', portal: true },
  handsontable: { file: 'handsontable?rows=6', cell: '#grid .ht_master tbody td:nth-child(3)', portal: true },
}

/**
 * 声明了分页条选择器（pagerSelector）的适配器：靶场页面、表根，以及分页条上应读到的信息。
 * expected 为 'truth' 时取门户 /grids/truth 的 paging（只比对该控件分页条上实际显示的字段）。
 */
type PageInfoCase = {
  file: string
  root: string
  portal?: boolean
  /** 静态靶场：分页条上应读到的字段。 */
  expected?: Record<string, unknown>
  /** 门户靶场：取真值里的这些字段比对。 */
  truthFields?: Array<'totalRows' | 'currentPage' | 'pageSize' | 'totalPages' | 'rowRange'>
}
export const PAGE_INFO_CASES: Record<string, PageInfoCase> = {
  easyui: { file: 'easyui-datagrid.html', root: '#dg-wrap', expected: { totalRows: 3, rowRange: { from: 1, to: 3 } } },
  jqgrid: { file: 'jqgrid.html', root: '#gbox_grid', expected: { totalRows: 3, rowRange: { from: 1, to: 3 } } },
  extjs: { file: 'extjs4.html', root: 'div.x-grid', expected: { totalRows: 3 } },
  layui: { file: 'layui-table.html', root: 'div.layui-table-view', expected: { totalRows: 3 } },
  elementui: { file: 'elementui-table.html', root: '.summary-table', expected: { totalRows: 3 } },
  aggrid: { file: 'aggrid?rows=45&paged=1', root: '#grid', portal: true, truthFields: ['totalRows', 'currentPage', 'pageSize', 'totalPages', 'rowRange'] },
  antd: { file: 'antd?rows=45&paged=1', root: '#grid', portal: true, truthFields: ['totalRows', 'currentPage', 'pageSize'] },
}

const adapters = ADAPTER_FACTORIES.map((f) => f({} as AdapterHelpers))

describe('适配器注册表描述', () => {
  it('shape 不重复，选择器都已填写', () => {
    expect(new Set(adapters.map((a) => a.shape)).size).toBe(adapters.length)
    for (const a of adapters) {
      expect(a.claimSelector, a.shape).not.toBe('')
      expect(a.gridSelector, a.shape).not.toBe('')
    }
  })
  it('每个已登记的适配器都有一致性用例', () => {
    expect(adapters.map((a) => a.shape).filter((s) => !CONFORMANCE_CASES[s])).toEqual([])
  })
  it('声明了分页条选择器的适配器都有分页读数用例', () => {
    expect(adapters.filter((a) => a.pagerSelector && !PAGE_INFO_CASES[a.shape]).map((a) => a.shape)).toEqual([])
  })
})

describe('适配器注册表 × 点选识别一致性', { timeout: 120_000 }, () => {
  let available = false
  let harness: FixtureHarness | undefined
  let portal: PortalHarness | undefined
  beforeAll(async () => {
    available = await isChromiumAvailableCached()
    if (available) {
      harness = await startHarness()
      portal = await startPortalHarness()
    }
  })
  afterAll(async () => {
    await harness?.close()
    await portal?.close()
  })

  for (const a of adapters) {
    it(`${a.shape}：点选数据格，认出的形态等于声明的 shape`, async ({ skip }) => {
      if (!available) skip()
      const c = CONFORMANCE_CASES[a.shape]
      expect(c, `${a.shape} 缺少一致性用例`).toBeTruthy()
      const page = c!.portal ? await portal!.newPage() : await harness!.browser.newPage()
      await page.goto(c!.portal ? `${portal!.base}/grids/${c!.file}` : `${harness!.base}/${c!.file}`)
      await page.waitForSelector(c!.cell)
      const result = await detectTable(page, { kind: 'point', ...(await centerOf(page, c!.cell)) }, deps)
      expect(result.outcome).toBe('FOUND')
      if (result.outcome === 'FOUND') expect(result.detected.shape).toBe(a.shape)
      await page.close()
    })
  }

  for (const a of adapters.filter((x) => CONFORMANCE_CASES[x.shape]?.portal)) {
    it(`${a.shape}：按挂载容器的选择器识别，认出的形态等于声明的 shape`, async ({ skip }) => {
      if (!available) skip()
      const c = CONFORMANCE_CASES[a.shape]!
      const page = await portal!.newPage()
      await page.goto(`${portal!.base}/grids/${c.file}`)
      await page.waitForSelector(c.cell)
      const result = await detectTable(page, { kind: 'root', selector: '#grid', framePath: [] }, deps)
      expect(result.outcome).toBe('FOUND')
      if (result.outcome === 'FOUND') expect(result.detected.shape).toBe(a.shape)
      await page.close()
    })
  }

  for (const a of adapters.filter((x) => x.pagerSelector)) {
    it(`${a.shape}：分页条读数与预期一致`, async ({ skip }) => {
      if (!available) skip()
      const c = PAGE_INFO_CASES[a.shape]!
      const page = c.portal ? await portal!.newPage() : await harness!.browser.newPage()
      await page.goto(c.portal ? `${portal!.base}/grids/${c.file}` : `${harness!.base}/${c.file}`)
      await page.waitForSelector(c.root)
      const sample = await run(page, plan(c.root, [{ key: 'c1', name: '第1列', source: 'index', index: 0 }]))
      let expected: Record<string, unknown>
      if (c.truthFields) {
        const truth = await portal!.truth<TruthRows & { paging: Record<string, number> }>('sites', c.file.split('?')[1] ?? '')
        const p = truth.paging
        const all: Record<string, unknown> = {
          totalRows: p.shownTotal,
          currentPage: p.currentPage,
          pageSize: p.pageSize,
          totalPages: p.totalPages,
          rowRange: { from: 1, to: p.pageRows },
        }
        expected = Object.fromEntries(c.truthFields.map((k) => [k, all[k]]))
      } else {
        expected = c.expected ?? {}
      }
      const { rawText: _raw, ...fields } = sample.pageInfo ?? { rawText: '' }
      expect(fields, `分页条原文：${sample.pageInfo?.rawText ?? '（没找到分页条）'}`).toEqual(expected)
      await page.close()
    })
  }

  it('严格 CSP（script-src none、禁 eval）的页面也能读：入口靠序列化函数，页面里不需要 eval', async ({ skip }) => {
    if (!available) skip()
    const body = await readFile(join(FIXTURES, 'easyui-edc.html'), 'utf8')
    const page = await harness!.browser.newPage()
    await page.route('**/csp-grid.html', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', headers: { 'Content-Security-Policy': "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'" }, body }),
    )
    await page.goto(`${harness!.base}/csp-grid.html`)
    const sample = await run(page, plan('#report-grid', [{ key: 'name', name: '报表名称', field: 'item1' }]))
    expect(sample.rows.map((r) => r.name!.value)).toEqual(['本年累计4G订单统计表', '本年累计5G订单统计表', '历史累计5G订单统计表'])
    await page.close()
  })
})
