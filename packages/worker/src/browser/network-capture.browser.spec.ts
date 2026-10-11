/**
 * 接口来源：受管页面的接口响应捕获 × 目标系统 tests/target-popup-portal 的 /grids/ 靶场。
 * 页面真实发出 /grids/api/* 请求（GET / POST / 延迟 / 失败 / 非 JSON），读出与 /grids/truth 的标准答案比。
 * 无浏览器时 skip，跳过不等于通过。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from 'playwright'
import { TABLE_NETWORK_CAPTURE_MAX_ENTRIES, TABLE_NETWORK_PROTOCOL, tableNetworkPlanSchema, type TableNetworkPlan } from '@cairn/shared'
import { suggestJsonTables } from '@cairn/table-file'
import { isChromiumAvailableCached } from '../testing/chromium-probe.js'
import { centerOf, deps, startPortalHarness, type PortalHarness, type TruthRows } from '../testing/table-read-test-kit.js'
import { NetworkCapture } from './network-capture.js'
import { describeCapturedEntry, readNetworkTable } from './network-table.js'
import { detectTable } from './table-read-v2.js'

const SITES = { url: '/grids/api/sites' }
const plan = (extra: Partial<TableNetworkPlan> = {}): TableNetworkPlan =>
  tableNetworkPlanSchema.parse({
    protocol: TABLE_NETWORK_PROTOCOL,
    match: SITES,
    rowsPath: 'data.list',
    totalPath: 'data.total',
    columns: [
      { key: 'id', name: 'id', path: 'id', valueType: 'number', numericKind: 'integer' },
      { key: 'name', name: 'name', path: 'name', valueType: 'text' },
      { key: 'qty', name: 'qty', path: 'qty', valueType: 'number', numericKind: 'integer' },
      { key: 'amount', name: 'amount', path: 'amount', valueType: 'number', numericKind: 'decimal' },
    ],
    window: { since: 'page_load', waitMs: 5_000 },
    ...extra,
  })
const META = { runId: '00000000-0000-4000-8000-0000000000a9' }

describe('接口来源：受管页面的接口响应捕获', { timeout: 180_000 }, () => {
  let available = false
  let portal: PortalHarness | undefined
  let capture: NetworkCapture
  let page: Page

  beforeAll(async () => {
    available = await isChromiumAvailableCached()
    if (!available) return
    portal = await startPortalHarness()
    capture = new NetworkCapture(portal.context as never)
    capture.attach()
    page = await portal.newPage()
  })
  afterAll(async () => {
    capture?.dispose()
    await portal?.close()
  })

  const open = async (path: string) => {
    await page.goto(`${portal!.base}/grids/${path}`)
  }
  const truth = (view: string, query: string) => portal!.truth<TruthRows>(view, query)

  it('页面自己发出的 GET：读出与接口真值逐行一致；只留去掉查询串的地址，不存请求头', async (ctx) => {
    if (!available) return ctx.skip()
    await open('antd?rows=12')
    const read = await readNetworkTable(capture, page, plan(), META)
    if (!read.ok) throw new Error(`${read.code}：${read.message}`)
    const t = await truth('api-sites', 'rows=12')
    expect(read.sample.rows.map((r) => [r.id?.value, r.name?.value, r.qty?.value, r.amount?.value])).toEqual(t.rows.map((r) => [r.id, r.name, r.qty, r.amount]))
    expect(read.sample.pageInfo?.totalRows).toBe(12)
    expect(read.sample.source).toMatchObject({ kind: 'network', request: { method: 'GET', status: 200 } })
    expect(read.sample.source.request?.url).toMatch(/\/grids\/api\/sites$/)
    expect(Object.keys(read.entry)).not.toEqual(expect.arrayContaining(['headers']))
    expect(read.sample).toStrictEqual(JSON.parse(JSON.stringify(read.sample)))
    // 列表描述：对象数组 → 有行数提示
    expect(describeCapturedEntry(read.entry)).toMatchObject({ json: true, rowHint: 12 })
  })

  it('POST 查询：按方法区分；方法不对就是“来源未找到”，不是空表', async (ctx) => {
    if (!available) return ctx.skip()
    await open('antd?rows=5&post=1')
    const post = await readNetworkTable(capture, page, plan({ match: { ...SITES, method: 'POST' } }), META)
    expect(post.ok && post.sample.rowCount).toBe(5)
    const get = await readNetworkTable(capture, page, plan({ match: { ...SITES, method: 'GET' }, window: { since: 'page_load', waitMs: 300 } }), META)
    expect(get).toMatchObject({ ok: false, code: 'TABLE_SOURCE_NOT_FOUND' })
  })

  it('匹配的请求还在途：等它返回；等不到时说清楚还没返回', async (ctx) => {
    if (!available) return ctx.skip()
    await page.goto(`${portal!.base}/grids/antd?rows=4&delay=1500`, { waitUntil: 'commit' })
    const slow = await readNetworkTable(capture, page, plan({ window: { since: 'page_load', waitMs: 300 } }), META)
    expect(slow).toMatchObject({ ok: false, code: 'TABLE_SOURCE_NOT_FOUND' })
    const waited = await readNetworkTable(capture, page, plan({ window: { since: 'page_load', waitMs: 8_000 } }), META)
    expect(waited.ok && waited.sample.rowCount).toBe(4)
  })

  it('“本步开始后的新响应”：之前的不算，本步里新发出的才算；整页跳转后旧页面的响应不算', async (ctx) => {
    if (!available) return ctx.skip()
    await open('antd?rows=6')
    await readNetworkTable(capture, page, plan(), META)
    capture.beginStep()
    const stale = await readNetworkTable(capture, page, plan({ window: { since: 'step_start', waitMs: 300 } }), META)
    expect(stale).toMatchObject({ ok: false, code: 'TABLE_SOURCE_NOT_FOUND' })
    await page.evaluate(() => fetch('/grids/api/sites?rows=3'))
    const fresh = await readNetworkTable(capture, page, plan({ window: { since: 'step_start', waitMs: 3_000 } }), META)
    expect(fresh.ok && fresh.sample.rowCount).toBe(3)
    // 跳到没有发接口的页面：页面加载以来没有匹配
    await open('export-page?rows=3')
    expect(await readNetworkTable(capture, page, plan({ window: { since: 'page_load', waitMs: 300 } }), META)).toMatchObject({ ok: false, code: 'TABLE_SOURCE_NOT_FOUND' })
  })

  it('状态码不符 / 不是 JSON / 必须只有一个却有多个：各自明确报错', async (ctx) => {
    if (!available) return ctx.skip()
    await open('export-page?rows=1')
    await page.evaluate(() => fetch('/grids/api/sites?fail=1'))
    expect(await readNetworkTable(capture, page, plan({ window: { since: 'page_load', waitMs: 2_000 } }), META)).toMatchObject({ ok: false, code: 'TABLE_NETWORK_STATUS_MISMATCH' })
    await open('export-page?rows=1')
    await page.evaluate(() => fetch('/grids/api/sites?nonjson=1'))
    expect(await readNetworkTable(capture, page, plan({ window: { since: 'page_load', waitMs: 2_000 } }), META)).toMatchObject({ ok: false, code: 'TABLE_NETWORK_NOT_JSON' })
    await open('export-page?rows=1')
    await page.evaluate(async () => {
      await fetch('/grids/api/sites?rows=2')
      await fetch('/grids/api/sites?rows=3')
    })
    expect(await readNetworkTable(capture, page, plan({ pick: 'single', window: { since: 'page_load', waitMs: 2_000 } }), META)).toMatchObject({ ok: false, code: 'TABLE_NETWORK_MULTIPLE' })
    const latest = await readNetworkTable(capture, page, plan({ window: { since: 'page_load', waitMs: 2_000 } }), META)
    expect(latest.ok && latest.sample.rowCount).toBe(3)
  })

  it(`缓冲有界：只留最近 ${TABLE_NETWORK_CAPTURE_MAX_ENTRIES} 个，先进先出`, async (ctx) => {
    if (!available) return ctx.skip()
    await open('export-page?rows=1')
    await page.evaluate(async () => {
      for (let i = 1; i <= 40; i++) await fetch(`/grids/api/sites?rows=${i}`)
    })
    await expect.poll(() => capture.list(page).length).toBeGreaterThanOrEqual(TABLE_NETWORK_CAPTURE_MAX_ENTRIES)
    expect(capture.list().length).toBe(TABLE_NETWORK_CAPTURE_MAX_ENTRIES)
    const read = await readNetworkTable(capture, page, plan(), META)
    expect(read.ok && read.sample.rowCount).toBe(40)
  })

  it('图表：点在 ECharts / Chart.js 上识别为图表（引导改读接口）；图表接口的列式数据按下标拼行与真值一致', async (ctx) => {
    if (!available) return ctx.skip()
    for (const lib of ['echarts', 'chartjs'] as const) {
      await open(`chart?lib=${lib}&months=6`)
      await page.waitForSelector('body[data-ready="1"]')
      const box = lib === 'echarts' ? '#chart' : '#chart-canvas'
      const { x, y } = await centerOf(page, box)
      const detected = await detectTable(page, { kind: 'point', x, y }, deps)
      expect(detected, lib).toMatchObject({ outcome: 'NOT_FOUND', reason: { code: 'TABLE_IS_CHART' }, chart: { lib } })
    }
    const entry = capture.list(page).find((e) => e.url.endsWith('/grids/api/series'))!
    const [best] = suggestJsonTables(JSON.parse(entry.body!))
    expect(best?.layout).toBe('columns')
    const read = await readNetworkTable(capture, page, tableNetworkPlanSchema.parse({ protocol: TABLE_NETWORK_PROTOCOL, match: { url: '/grids/api/series' }, layout: 'columns', columns: best!.columns }), META)
    if (!read.ok) throw new Error(read.message)
    const t = await truth('series', 'months=6')
    expect(read.sample.rows.map((r) => Object.values(r).map((f) => f.value))).toEqual(t.rows.map((r) => [r.month, r.income, r.expense]))
  })
})
