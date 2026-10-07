/**
 * table.read@2 采样器与识别：真实 chromium + 受版本管理的老系统形态靶场
 * （__fixtures__/legacy-grids，按各形态的常见 DOM 约定自建，不等于已兼容某真实系统）。
 * 无浏览器时 skip，跳过不等于通过。
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { jsonValueSchema, tableReadPlanV2Schema, TABLE_READ_PROTOCOL_V2, type TableReadPlanV2 } from '@cairn/shared'
import { isChromiumAvailableCached } from '../testing/chromium-probe.js'
import { locate } from './surface.js'
import { pickOnPage } from './observe.js'
import { detectTable, sampleTableV2, type DetectDeps } from './table-read-v2.js'
import { TableObserveError } from './table-observe.js'

const FIXTURES = join(__dirname, '__fixtures__', 'legacy-grids')

type ColumnInput = {
  key: string
  name: string
  valueType?: 'text' | 'number' | 'boolean'
  numericKind?: 'integer' | 'decimal'
  source?: 'header' | 'index'
  index?: number
  sensitive?: boolean
  scaleUnits?: boolean
}

function plan(
  selector: string,
  columns: ColumnInput[],
  extra: Partial<Pick<TableReadPlanV2, 'rows' | 'readiness' | 'limits'>> = {},
  framePath: TableReadPlanV2['target']['framePath'] = [],
): TableReadPlanV2 {
  return tableReadPlanV2Schema.parse({
    protocol: TABLE_READ_PROTOCOL_V2,
    target: { framePath, candidates: [{ by: 'css', value: selector }] },
    columns: columns.map((c) => ({ ...c, valueType: c.valueType ?? 'text' })),
    ...extra,
  })
}

const deps: DetectDeps = { locate: locate as DetectDeps['locate'], pick: pickOnPage }
const run = (page: Page, p: TableReadPlanV2) => sampleTableV2(page, p, { locate: locate as DetectDeps['locate'] })

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error, `应报 ${code}`).toBeInstanceOf(TableObserveError)
  expect((error as TableObserveError).code).toBe(code)
}

function valueOf(row: Record<string, { value: unknown }> | undefined, key: string): unknown {
  return row?.[key]?.value
}

describe('table.read@2 采样器 × 原生表格靶场', { timeout: 120_000 }, () => {
  let available = false
  let browser: Browser | undefined
  let server: ReturnType<typeof createServer> | undefined
  let base = ''

  beforeAll(async () => {
    available = await isChromiumAvailableCached()
    if (!available) return
    server = createServer(async (req, res) => {
      const name = (req.url ?? '/').split('?')[0]!.replace(/^\/+/, '') || 'native-basic.html'
      try {
        const body = await readFile(join(FIXTURES, name))
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(body)
      } catch {
        res.writeHead(404)
        res.end('not found')
      }
    })
    await new Promise<void>((ready) => server!.listen(0, '127.0.0.1', ready))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    browser = await chromium.launch({ headless: true })
  })

  afterAll(async () => {
    await browser?.close()
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()))
  })

  async function open(path: string): Promise<Page> {
    const page = await browser!.newPage()
    await page.goto(`${base}/${path}`)
    return page
  }

  it('按表头读取：数字格式、占位符、敏感列；排除合并行、分页行、页脚', async ({ skip }) => {
    if (!available) skip()
    const page = await open('native-basic.html')
    const sample = await run(
      page,
      plan('#report', [
        { key: 'region', name: '区域' },
        { key: 'income', name: '收入(万元)', valueType: 'number', numericKind: 'decimal' },
        { key: 'yoy', name: '同比', valueType: 'number', numericKind: 'decimal' },
        { key: 'phone', name: '负责人电话', sensitive: true },
        { key: 'status', name: '状态' },
      ]),
    )
    // 步骤输出要过平台的 JSON 值校验：不能带 undefined（否则引擎持久化时整步失败）
    expect(jsonValueSchema.safeParse({ value: sample }).success).toBe(true)
    expect(sample.coverage.status).toBe('complete')
    expect(sample.coverage.clues).toContain('pagination_present')
    expect(sample.rowCount).toBe(4)
    expect(sample.excluded).toEqual({ mergedRows: 1, paginationRows: 1, footerRows: 1 })

    const [liaoning, shanghai, guizhou, shaanxi] = sample.rows
    expect(valueOf(liaoning, 'region')).toBe('辽宁')
    expect(valueOf(liaoning, 'income')).toBe(24145.16)
    expect(liaoning!.income!.decimalValue).toBe('24145.16')
    expect(valueOf(liaoning, 'yoy')).toBe(3.5)
    expect(valueOf(shanghai, 'income')).toBe(23050.99)
    expect(valueOf(shanghai, 'yoy')).toBe(-1.2)
    // 括号负数 + 全角括号
    expect(valueOf(guizhou, 'income')).toBe(-1234.5)
    expect(guizhou!.income!.decimalValue).toBe('-1234.50')
    // 占位符记为缺失而不是错误
    expect(guizhou!.yoy!.status).toBe('missing')
    // 全角数字
    expect(valueOf(shaanxi, 'income')).toBe(1234)
    // 敏感列打码：不带值、不带原文
    for (const row of sample.rows) {
      expect(row.phone).toEqual({ value: null, status: 'masked' })
    }
    // 页脚单独输出，不混入数据行
    expect(sample.summaryRows).toHaveLength(1)
    expect(valueOf(sample.summaryRows![0], 'region')).toBe('合计')
    await page.close()
  })

  it('“万 / 亿”只在列显式要求时换算，且保持精确小数', async ({ skip }) => {
    if (!available) skip()
    const page = await open('native-basic.html')
    const sample = await run(
      page,
      plan('#report', [
        { key: 'income', name: '收入(万元)', valueType: 'number', numericKind: 'decimal', scaleUnits: true },
      ]),
    )
    expect(sample.rows[0]!.income!.decimalValue).toBe('241451600')
    expect(valueOf(sample.rows[0], 'income')).toBe(241451600)
    await page.close()
  })

  it('列映射不猜：表头改名后报“列找不到”，不会悄悄读到别的列', async ({ skip }) => {
    if (!available) skip()
    const page = await open('native-basic.html')
    await page.evaluate(() => {
      const doc = (globalThis as unknown as { document: { querySelectorAll: (s: string) => ArrayLike<{ textContent: string | null }> } }).document
      const th = doc.querySelectorAll('#report th')[3]
      if (th) th.textContent = '收入'
    })
    await expectCode(run(page, plan('#report', [{ key: 'income', name: '收入(万元)', valueType: 'number', numericKind: 'decimal' }])), 'TABLE_COLUMN_NOT_FOUND')
    await page.close()
  })

  it('按第几列取必须显式声明，越界报错', async ({ skip }) => {
    if (!available) skip()
    const page = await open('native-basic.html')
    const ok = await run(page, plan('#report', [{ key: 'region', name: '区域', source: 'index', index: 2 }]))
    expect(valueOf(ok.rows[0], 'region')).toBe('辽宁')
    await expectCode(run(page, plan('#report', [{ key: 'x', name: '不存在', source: 'index', index: 20 }])), 'TABLE_COLUMN_NOT_FOUND')
    await page.close()
  })

  it('无 thead 用首行表头；rowspan 合并单元格向下填充', async ({ skip }) => {
    if (!available) skip()
    const page = await open('native-headless-merged.html')
    const sample = await run(
      page,
      plan('#no-thead', [
        { key: 'region', name: '区域' },
        { key: 'site', name: '站点' },
        { key: 'qty', name: '数量', valueType: 'number', numericKind: 'integer' },
      ]),
    )
    expect(sample.rowCount).toBe(3)
    expect(sample.rows.map((r) => valueOf(r, 'region'))).toEqual(['华东', '华东', '华南'])
    expect(sample.rows.map((r) => valueOf(r, 'qty'))).toEqual([12, 7, 9])
    await page.close()
  })

  it('多级表头：用“上级 / 列名”区分重名列；仅写“本月”会报不唯一', async ({ skip }) => {
    if (!available) skip()
    const page = await open('native-headless-merged.html')
    const sample = await run(
      page,
      plan('#grouped', [
        { key: 'region', name: '区域' },
        { key: 'incomeMonth', name: '收入 / 本月', valueType: 'number', numericKind: 'integer' },
        { key: 'costTotal', name: '支出 / 累计', valueType: 'number', numericKind: 'integer' },
      ]),
    )
    expect(sample.rows.map((r) => valueOf(r, 'incomeMonth'))).toEqual([10, 20])
    expect(sample.rows.map((r) => valueOf(r, 'costTotal'))).toEqual([40, 60])
    await expectCode(run(page, plan('#grouped', [{ key: 'm', name: '本月' }])), 'TABLE_COLUMN_AMBIGUOUS')
    await page.close()
  })

  it('没有表头的表：按列名取会明确报错，按第几列取可用', async ({ skip }) => {
    if (!available) skip()
    const page = await open('native-headless-merged.html')
    await expectCode(run(page, plan('#bare', [{ key: 'a', name: '名称' }])), 'TABLE_HEADER_NOT_FOUND')
    const ok = await run(page, plan('#bare', [{ key: 'a', name: '列1', source: 'index', index: 0 }], { rows: { excludeHeader: true, header: 'none' } }))
    expect(ok.rows.map((r) => valueOf(r, 'a'))).toEqual(['甲', '乙'])
    await page.close()
  })

  it('空表：有“暂无数据”提示判完整；没有提示判无法确认；用户确认“空着就代表没有数据”判完整', async ({ skip }) => {
    if (!available) skip()
    const page = await open('empty-tables.html')
    const cols = [{ key: 'name', name: '名称' }]
    const withHint = await run(page, plan('#empty-with-hint', cols))
    expect(withHint.rowCount).toBe(0)
    expect(withHint.coverage.status).toBe('complete')

    const noHint = await run(page, plan('#empty-no-hint', cols))
    expect(noHint.coverage.status).toBe('unknown')
    expect(noHint.coverage.reasonCode).toBe('TABLE_EMPTY_UNVERIFIED')

    const confirmed = await run(page, plan('#empty-no-hint', cols, { readiness: { waitVisible: true, emptyMeansNone: true, timeoutMs: 10_000 } }))
    expect(confirmed.coverage.status).toBe('complete')
    await page.close()
  })

  it('体积超出预算：截断并标 partial，而不是整步失败', async ({ skip }) => {
    if (!available) skip()
    const page = await browser!.newPage()
    const rows = Array.from({ length: 200 }, (_, i) => `<tr><td>行${i}</td><td>${'说明'.repeat(30)}${i}</td></tr>`).join('')
    await page.setContent(`<table id="big"><thead><tr><th>名称</th><th>说明</th></tr></thead><tbody>${rows}</tbody></table>`)
    const sample = await run(page, plan('#big', [{ key: 'n', name: '名称' }, { key: 'd', name: '说明' }], { limits: { maxRows: 200, maxCols: 32, maxBytes: 8 * 1024 } }))
    expect(sample.coverage.status).toBe('partial')
    expect(sample.coverage.reasonCode).toBe('TABLE_OUTPUT_BUDGET')
    expect(sample.rows.length).toBeGreaterThan(0)
    expect(sample.rows.length).toBeLessThan(200)
    await page.close()
  })

  it('表根找不到 / 命中多个分别报明确错误', async ({ skip }) => {
    if (!available) skip()
    const page = await open('layout-nested.html')
    await expectCode(run(page, plan('#nope', [{ key: 'a', name: '名称' }])), 'TABLE_NOT_FOUND')
    await expectCode(run(page, plan('table', [{ key: 'a', name: '名称' }])), 'TABLE_AMBIGUOUS')
    await page.close()
  })
})

describe('table.read@2 识别 × 点选', { timeout: 120_000 }, () => {
  let available = false
  let browser: Browser | undefined
  let server: ReturnType<typeof createServer> | undefined
  let base = ''

  beforeAll(async () => {
    available = await isChromiumAvailableCached()
    if (!available) return
    server = createServer(async (req, res) => {
      const name = (req.url ?? '/').split('?')[0]!.replace(/^\/+/, '')
      try {
        const body = await readFile(join(FIXTURES, name))
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(body)
      } catch {
        res.writeHead(404)
        res.end('not found')
      }
    })
    await new Promise<void>((ready) => server!.listen(0, '127.0.0.1', ready))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    browser = await chromium.launch({ headless: true })
  })

  afterAll(async () => {
    await browser?.close()
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()))
  })

  async function centerOf(page: Page, selector: string): Promise<{ x: number; y: number }> {
    const box = await page.locator(selector).first().boundingBox()
    if (!box) throw new Error(`没有 ${selector}`)
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  }

  it('点表格里任意一格：认出整张表，自动排除复选框 / 序号 / 操作列，预览完整', async ({ skip }) => {
    if (!available) skip()
    const page = await browser!.newPage()
    await page.goto(`${base}/native-basic.html`)
    const point = await centerOf(page, '#report tbody tr:nth-child(3) td:nth-child(3)')
    const result = await detectTable(page, { kind: 'point', ...point }, deps)
    expect(result.outcome).toBe('FOUND')
    if (result.outcome !== 'FOUND') return
    const { detected } = result
    expect(detected.plan.target.candidates[0]).toEqual({ by: 'css', value: '#report' })
    expect(detected.selectorQuality).toBe('stable')
    expect(detected.title).toBe('区域收入报表')
    expect(detected.plan.columns.map((c) => c.name)).toEqual(['区域', '收入(万元)', '同比', '负责人电话', '状态'])
    expect(detected.columns.filter((c) => c.excludedReason).map((c) => c.excludedReason)).toEqual(['checkbox', 'index', 'action'])
    expect(detected.notes.some((n) => n.includes('复选框'))).toBe(true)
    expect(detected.notes.some((n) => n.includes('序号'))).toBe(true)
    expect(detected.notes.some((n) => n.includes('操作'))).toBe(true)
    expect(detected.sample.coverage.status).toBe('complete')
    expect(detected.sample.rows).toHaveLength(4)
    // 给用户看的行数只算数据行（4 个国家数据行；不含表头、合并行、分页行、页脚）
    expect(detected.rowCount).toBe(4)
    await page.close()
  })

  it('页面用表格排版：点内层数据表，选中内层那一张，并带上就近标题', async ({ skip }) => {
    if (!available) skip()
    const page = await browser!.newPage()
    await page.goto(`${base}/layout-nested.html`)
    const todo = await detectTable(page, { kind: 'point', ...(await centerOf(page, '#todo tbody td')) }, deps)
    const alarm = await detectTable(page, { kind: 'point', ...(await centerOf(page, '#alarm tbody td')) }, deps)
    expect(todo.outcome).toBe('FOUND')
    expect(alarm.outcome).toBe('FOUND')
    if (todo.outcome !== 'FOUND' || alarm.outcome !== 'FOUND') return
    expect(todo.detected.plan.target.candidates[0]).toEqual({ by: 'css', value: '#todo' })
    expect(todo.detected.title).toBe('待办事项')
    expect(alarm.detected.plan.target.candidates[0]).toEqual({ by: 'css', value: '#alarm' })
    expect(alarm.detected.title).toBe('告警列表')
    expect(alarm.detected.sample.rows.map((r) => valueOf(r, 'col_1'))).toEqual(['CPU 过高', '磁盘告警'])
    // 强制以指定表为根重新识别（“范围大一点 / 小一点”）
    const forced = await detectTable(page, { kind: 'root', selector: '#alarm', framePath: [] }, deps)
    expect(forced.outcome).toBe('FOUND')
    await page.close()
  })

  it('点到的位置不在表格里：给出明确原因', async ({ skip }) => {
    if (!available) skip()
    const page = await browser!.newPage()
    await page.goto(`${base}/native-basic.html`)
    const result = await detectTable(page, { kind: 'point', ...(await centerOf(page, '.panel-title')) }, deps)
    expect(result.outcome).toBe('NOT_FOUND')
    if (result.outcome === 'NOT_FOUND') {
      expect(result.reason.code).toBe('TABLE_SHAPE_UNSUPPORTED')
      // 随失败结果带回点击位置附近的页面结构，供用户主动复制反馈：含页面文本，去掉脚本与输入值
      expect(result.reason.feedback).toContain('区域收入报表')
      expect(result.reason.feedback).not.toContain('<script')
      expect(result.reason.feedback!.length).toBeLessThanOrEqual(8000)
    }
    await page.close()
  })

  it('表在 iframe 里：识别并读取，表根带上 frame 路径', async ({ skip }) => {
    if (!available) skip()
    const page = await browser!.newPage()
    await page.goto(`${base}/frame-outer.html`)
    const box = await page.frameLocator('#main-frame').locator('#orders tbody td').first().boundingBox()
    expect(box).toBeTruthy()
    const result = await detectTable(page, { kind: 'point', x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }, deps)
    expect(result.outcome).toBe('FOUND')
    if (result.outcome !== 'FOUND') return
    expect(result.detected.plan.target.framePath.length).toBeGreaterThan(0)
    expect(result.detected.sample.rows.map((r) => valueOf(r, 'col_1'))).toEqual(['A001', 'A002'])
    expect(result.detected.sample.rows.map((r) => valueOf(r, 'col_2'))).toEqual([100.5, 200])
    // 用识别出的计划再读一次（等同于运行时）
    const again = await run(page, result.detected.plan)
    expect(again.rowCount).toBe(2)
    await page.close()
  })

  it('iframe 的 id 以数字开头（老系统常见）：frame 路径里的选择器要转义，读取仍能找到表', async ({ skip }) => {
    if (!available) skip()
    const page = await browser!.newPage()
    await page.goto(`${base}/frame-numeric-id.html`)
    const box = await page.frameLocator('[id="800301000"]').locator('#orders tbody td').first().boundingBox()
    const result = await detectTable(page, { kind: 'point', x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }, deps)
    expect(result.outcome).toBe('FOUND')
    if (result.outcome !== 'FOUND') return
    const frames = result.detected.plan.target.framePath
    expect(frames.some((f) => f.selector?.startsWith('#'))).toBe(true)
    const again = await run(page, result.detected.plan)
    expect(again.rows.map((r) => valueOf(r, 'col_1'))).toEqual(['A001', 'A002'])
    await page.close()
  })

  it('点选 iframe 里的元素不能卡住：清理临时标记不得干等默认超时（曾因此每次点选卡 30 秒）', async ({ skip }) => {
    if (!available) skip()
    const page = await browser!.newPage()
    await page.goto(`${base}/frame-numeric-id.html`)
    const box = await page.frameLocator('[id="800301000"]').locator('#orders tbody td').first().boundingBox()
    const started = Date.now()
    const picked = await pickOnPage(page, box!.x + box!.width / 2, box!.y + box!.height / 2)
    expect(Date.now() - started).toBeLessThan(5000)
    expect(picked.outcome).not.toBe('NOT_FOUND')
    await page.close()
  })
})
