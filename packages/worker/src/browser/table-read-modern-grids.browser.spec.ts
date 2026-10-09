/**
 * table.read@2 × 现代前端表格控件（AG Grid / Ant Design Table / Handsontable）。
 * 页面来自目标系统 tests/target-popup-portal 的 /grids/，由真实控件库渲染（数据虚构）。
 * 无浏览器时 skip，跳过不等于通过。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from 'playwright'
import { isChromiumAvailableCached } from '../testing/chromium-probe.js'
import { detectTable } from './table-read-v2.js'
import { centerOf, deps, plan, run, startPortalHarness, valueOf, type PortalHarness } from '../testing/table-read-test-kit.js'

const COLUMNS = [
  { key: 'id', name: '编号', valueType: 'number' as const, numericKind: 'integer' as const },
  { key: 'name', name: '站点名称' },
  { key: 'region', name: '区域' },
  { key: 'qty', name: '数量', valueType: 'number' as const, numericKind: 'integer' as const },
  { key: 'amount', name: '金额（元）', valueType: 'number' as const, numericKind: 'decimal' as const },
  { key: 'status', name: '状态' },
  { key: 'date', name: '日期', valueType: 'date' as const },
]

describe('table.read@2 × 现代表格控件靶场', { timeout: 180_000 }, () => {
  let available = false
  let portal: PortalHarness | undefined

  beforeAll(async () => {
    available = await isChromiumAvailableCached()
    if (available) portal = await startPortalHarness()
  })
  afterAll(async () => {
    await portal?.close()
  })

  async function open(path: string, ready: string): Promise<Page> {
    const page = await portal!.newPage()
    await page.goto(`${portal!.base}/grids/${path}`)
    await page.waitForSelector(ready)
    return page
  }

  describe('AG Grid', () => {
    const ROW = '#grid .ag-center-cols-container .ag-row'
    it('按表头取列：排除选择列，数字 / 日期规范化', async ({ skip }) => {
      if (!available) skip()
      const page = await open('aggrid?rows=8', ROW)
      const sample = await run(page, plan('#grid', COLUMNS))
      expect(sample.coverage.status).toBe('complete')
      expect(sample.rows).toHaveLength(8)
      expect(sample.rows.map((r) => valueOf(r, 'id'))).toEqual([1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007])
      expect(sample.rows[0]!.name!.value).toBe('站点0001')
      expect(valueOf(sample.rows[1], 'qty')).toBe(2)
      expect(sample.rows[0]!.amount!.decimalValue).toBe('1234.56')
      expect(valueOf(sample.rows[0], 'date')).toBe('2026-10-01')
      await page.close()
    })

    it('点选识别：认出 AG Grid，选择列自动排除', async ({ skip }) => {
      if (!available) skip()
      const page = await open('aggrid?rows=8', ROW)
      const result = await detectTable(page, { kind: 'point', ...(await centerOf(page, `${ROW} .ag-cell[col-id="name"]`)) }, deps)
      expect(result.outcome).toBe('FOUND')
      if (result.outcome !== 'FOUND') return
      const d = result.detected
      expect(d.shape).toBe('aggrid')
      expect(d.columns.filter((c) => !c.excludedReason).map((c) => c.name)).toEqual(['编号', '站点名称', '区域', '数量', '金额（元）', '状态', '日期'])
      expect(d.columns.find((c) => c.name === '金额（元）')?.valueType).toBe('number')
      await page.close()
    })

    it('固定列 + 分组表头 + 底部合计：按视觉列序拼接左 / 中 / 右三个容器', async ({ skip }) => {
      if (!available) skip()
      const page = await open('aggrid?rows=4&pinned=1&summary=1&group=1', ROW)
      const sample = await run(page, plan('#grid', COLUMNS))
      expect(sample.rows.map((r) => valueOf(r, 'id'))).toEqual([1000, 1001, 1002, 1003])
      expect(sample.rows.map((r) => r.status!.value)).toEqual(['在用', '停用', '待核查', '在用'])
      expect(sample.rows.map((r) => valueOf(r, 'qty'))).toEqual([1, 2, 3, 4])
      expect(sample.summaryRows).toHaveLength(1)
      expect(valueOf(sample.summaryRows![0], 'qty')).toBe(10)
      expect(sample.summaryRows![0]!.amount!.decimalValue).toBe('12345.60')
      await page.close()
    })

    it('5000 行：只渲染屏幕上的行，如实标记为部分而不是完整', async ({ skip }) => {
      if (!available) skip()
      const page = await open('aggrid?rows=5000', ROW)
      const sample = await run(page, plan('#grid', COLUMNS))
      expect(sample.coverage.status).toBe('partial')
      expect(sample.coverage.reasonCode).toBe('TABLE_VIRTUAL_SCROLL')
      expect(sample.rows.length).toBeGreaterThan(0)
      expect(sample.rows.length).toBeLessThan(60)
      await page.close()
    })

    it('空数据：能确认确实为空；加载中不能当作空', async ({ skip }) => {
      if (!available) skip()
      const empty = await open('aggrid?empty=1', '#grid .ag-overlay-no-rows-wrapper')
      const done = await run(empty, plan('#grid', COLUMNS))
      expect(done.rows).toHaveLength(0)
      expect(done.coverage.status).toBe('complete')
      await empty.close()
      const loading = await open('aggrid?rows=3&delay=600', '#grid .ag-overlay-loading-center')
      const sample = await run(loading, plan('#grid', COLUMNS))
      expect(sample.rows).toHaveLength(3)
      expect(sample.coverage.status).toBe('complete')
      await loading.close()
      // 一直在加载：不能把“还没加载出来”当成空表
      const slow = await open('aggrid?rows=3&delay=6000', '#grid .ag-overlay-loading-center')
      const unknown = await run(slow, plan('#grid', COLUMNS))
      expect(unknown.coverage.status).toBe('unknown')
      expect(unknown.coverage.reasonCode).toBe('TABLE_READINESS_TIMEOUT')
      await slow.close()
    })

    it('分页条被识别，且选择器指向内部部件也读整张表', async ({ skip }) => {
      if (!available) skip()
      const page = await open('aggrid?rows=45&paged=1', ROW)
      const sample = await run(page, plan('#grid .ag-body-viewport', COLUMNS))
      expect(sample.coverage.clues).toContain('pagination_present')
      // 分页后每页 20 行，但 AG Grid 仍按视口渲染其中的一部分：不能宣称读全
      console.log('paged', sample.rows.length, sample.coverage.status, sample.coverage.reasonCode)
      await page.close()
    })
  })
  describe('Ant Design Table', () => {
    const ROW = '#grid tbody tr.ant-table-row'
    it('固定表头（表头表体分表）：按表头取列，测量行与选择列不计入', async ({ skip }) => {
      if (!available) skip()
      const page = await open('antd?rows=6', ROW)
      const sample = await run(page, plan('#grid', COLUMNS))
      expect(sample.coverage.status).toBe('complete')
      expect(sample.rows).toHaveLength(6)
      expect(sample.rows.map((r) => valueOf(r, 'id'))).toEqual([1000, 1001, 1002, 1003, 1004, 1005])
      expect(sample.rows[0]!.amount!.decimalValue).toBe('1234.56')
      expect(valueOf(sample.rows[2], 'date')).toBe('2026-10-03')
      await page.close()
    })

    it('点选识别：认出 Ant Design Table，选择列自动排除', async ({ skip }) => {
      if (!available) skip()
      const page = await open('antd?rows=6', ROW)
      const result = await detectTable(page, { kind: 'point', ...(await centerOf(page, `${ROW} td:nth-child(3)`)) }, deps)
      expect(result.outcome).toBe('FOUND')
      if (result.outcome !== 'FOUND') return
      expect(result.detected.shape).toBe('antd')
      expect(result.detected.columns.filter((c) => !c.excludedReason).map((c) => c.name)).toEqual(['编号', '站点名称', '区域', '数量', '金额（元）', '状态', '日期'])
      await page.close()
    })

    it('固定列 + 分组表头 + 合计（合计在单独的 table 里）', async ({ skip }) => {
      if (!available) skip()
      const page = await open('antd?rows=3&pinned=1&summary=1&group=1', ROW)
      const sample = await run(page, plan('#grid', COLUMNS))
      expect(sample.rows).toHaveLength(3)
      expect(sample.rows.map((r) => valueOf(r, 'qty'))).toEqual([1, 2, 3])
      expect(sample.summaryRows).toHaveLength(1)
      expect(valueOf(sample.summaryRows![0], 'qty')).toBe(6)
      expect(sample.summaryRows![0]!.amount!.decimalValue).toBe('7407.36')
      await page.close()
    })

    it('合计行核对：合计不一致时数据可读，由数据检查判不通过', async ({ skip }) => {
      if (!available) skip()
      const page = await open('antd?rows=3&summary=1&bad=1', ROW)
      const sample = await run(page, plan('#grid', COLUMNS))
      expect(valueOf(sample.summaryRows![0], 'qty')).toBe(7)
      expect(sample.rows.map((r) => valueOf(r, 'qty')).reduce((a, b) => Number(a) + Number(b), 0)).toBe(6)
      await page.close()
    })

    it('空数据确认为空；加载中等加载完，一直加载不当作空', async ({ skip }) => {
      if (!available) skip()
      const empty = await open('antd?empty=1', '#grid tr.ant-table-placeholder')
      const done = await run(empty, plan('#grid', COLUMNS))
      expect(done.rows).toHaveLength(0)
      expect(done.coverage.status).toBe('complete')
      await empty.close()
      const loading = await open('antd?rows=3&delay=600', '#grid .ant-spin-spinning')
      const sample = await run(loading, plan('#grid', COLUMNS))
      expect(sample.rows).toHaveLength(3)
      await loading.close()
      const slow = await open('antd?rows=3&delay=6000', '#grid .ant-spin-spinning')
      const unknown = await run(slow, plan('#grid', COLUMNS))
      expect(unknown.coverage.reasonCode).toBe('TABLE_READINESS_TIMEOUT')
      await slow.close()
    })

    it('分页条被识别；选择器指向表体内部部件也读整张表', async ({ skip }) => {
      if (!available) skip()
      const page = await open('antd?rows=45&paged=1', ROW)
      const sample = await run(page, plan('#grid .ant-table-body', COLUMNS))
      expect(sample.coverage.clues).toContain('pagination_present')
      expect(sample.rows).toHaveLength(20)
      await page.close()
    })

    it('虚拟列表（virtual）：div 结构仍可读，如实标记为部分', async ({ skip }) => {
      if (!available) skip()
      const page = await open('antd?rows=2000&virtual=1', '#grid .ant-table-tbody-virtual .ant-table-row')
      const sample = await run(page, plan('#grid', COLUMNS))
      expect(sample.coverage.status).toBe('partial')
      expect(sample.coverage.reasonCode).toBe('TABLE_VIRTUAL_SCROLL')
      expect(sample.rows.length).toBeGreaterThan(0)
      expect(sample.rows[0]!.name!.value).toBe('站点0001')
      await page.close()
    })
  })
  describe('Handsontable', () => {
    const CELL = '#grid .ht_master tbody td'
    it('按表头文本取列：只读主视图（冻结区克隆表不重复），行头不计入', async ({ skip }) => {
      if (!available) skip()
      const page = await open('handsontable?rows=6', CELL)
      const sample = await run(page, plan('#grid', COLUMNS))
      expect(sample.coverage.status).toBe('complete')
      expect(sample.rows).toHaveLength(6)
      expect(sample.rows.map((r) => valueOf(r, 'id'))).toEqual([1000, 1001, 1002, 1003, 1004, 1005])
      expect(sample.rows[0]!.amount!.decimalValue).toBe('1234.56')
      expect(valueOf(sample.rows[1], 'date')).toBe('2026-10-02')
      await page.close()
    })

    it('冻结列：克隆表里的格子不会让数据重复，点冻结区也归到主视图', async ({ skip }) => {
      if (!available) skip()
      const page = await open('handsontable?rows=4&pinned=1', CELL)
      const sample = await run(page, plan('#grid', COLUMNS))
      expect(sample.rows).toHaveLength(4)
      const result = await detectTable(page, { kind: 'point', ...(await centerOf(page, '#grid .ht_clone_inline_start tbody td')) }, deps)
      expect(result.outcome).toBe('FOUND')
      if (result.outcome === 'FOUND') {
        expect(result.detected.shape).toBe('handsontable')
        expect(result.detected.sample.rows).toHaveLength(4)
      }
      await page.close()
    })

    it('点选识别：认出 Handsontable，列名取自表头，行头自动排除', async ({ skip }) => {
      if (!available) skip()
      const page = await open('handsontable?rows=6', CELL)
      const result = await detectTable(page, { kind: 'point', ...(await centerOf(page, `${CELL}:nth-child(3)`)) }, deps)
      expect(result.outcome).toBe('FOUND')
      if (result.outcome !== 'FOUND') return
      expect(result.detected.shape).toBe('handsontable')
      expect(result.detected.columns.filter((c) => !c.excludedReason).map((c) => c.name)).toEqual(['编号', '站点名称', '区域', '数量', '金额（元）', '状态', '日期'])
      await page.close()
    })

    it('分组表头（nestedHeaders，hiddenHeader 占位不参与定位）与末行合计', async ({ skip }) => {
      if (!available) skip()
      const page = await open('handsontable?rows=3&group=1&summary=1', CELL)
      const sample = await run(page, plan('#grid', COLUMNS))
      expect(sample.rows.map((r) => valueOf(r, 'qty'))).toEqual([1, 2, 3])
      expect(sample.summaryRows).toHaveLength(1)
      expect(valueOf(sample.summaryRows![0], 'qty')).toBe(6)
      await page.close()
    })

    it('500 行：只渲染视口内的行，如实标记为部分', async ({ skip }) => {
      if (!available) skip()
      const page = await open('handsontable?rows=500', CELL)
      const sample = await run(page, plan('#grid', COLUMNS))
      expect(sample.coverage.status).toBe('partial')
      expect(sample.coverage.reasonCode).toBe('TABLE_VIRTUAL_SCROLL')
      await page.close()
    })

    it('0 行：没有空态提示，不自行宣称确实为空；计划声明“没有数据即为无”才算空', async ({ skip }) => {
      if (!available) skip()
      const page = await open('handsontable?empty=1', '#grid .ht_master')
      const unverified = await run(page, plan('#grid', COLUMNS))
      expect(unverified.rows).toHaveLength(0)
      expect(unverified.coverage.reasonCode).toBe('TABLE_EMPTY_UNVERIFIED')
      const declared = await run(page, plan('#grid', COLUMNS, { readiness: { waitVisible: true, timeoutMs: 3000, emptyMeansNone: true } }))
      expect(declared.coverage.status).toBe('complete')
      await page.close()
    })
  })
})
