/** table.read@2 靶场测试的共用工具：静态页服务、读取计划构造、断言辅助。仅测试使用。 */
import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AddressInfo } from 'node:net'
import { expect } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { tableReadPlanV2Schema, TABLE_READ_PROTOCOL_V2, type TableReadPlanV2 } from '@cairn/shared'
import { locate } from '../browser/surface.js'
import { pickOnPage } from '../browser/observe.js'
import { sampleTableV2, type DetectDeps } from '../browser/table-read-v2.js'
import { TableObserveError } from '../browser/table-observe.js'

export const FIXTURES = join(__dirname, '..', 'browser', '__fixtures__', 'legacy-grids')

export type ColumnInput = {
  key: string
  name: string
  field?: string
  valueType?: 'text' | 'number' | 'boolean' | 'date'
  numericKind?: 'integer' | 'decimal'
  source?: 'header' | 'index'
  index?: number
  sensitive?: boolean
  scaleUnits?: boolean
}

export function plan(
  selector: string,
  columns: ColumnInput[],
  extra: Partial<Pick<TableReadPlanV2, 'rows' | 'readiness' | 'limits' | 'kind' | 'layout'>> = {},
  framePath: TableReadPlanV2['target']['framePath'] = [],
): TableReadPlanV2 {
  return tableReadPlanV2Schema.parse({
    protocol: TABLE_READ_PROTOCOL_V2,
    target: { framePath, candidates: [{ by: 'css', value: selector }] },
    columns: columns.map((c) => ({ ...c, valueType: c.valueType ?? 'text' })),
    ...extra,
  })
}

export const deps: DetectDeps = { locate: locate as DetectDeps['locate'], pick: pickOnPage }
export const run = (page: Page, p: TableReadPlanV2) => sampleTableV2(page, p, { locate: locate as DetectDeps['locate'] })

export async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error, `应报 ${code}`).toBeInstanceOf(TableObserveError)
  expect((error as TableObserveError).code).toBe(code)
}

export function valueOf(row: Record<string, { value: unknown }> | undefined, key: string): unknown {
  return row?.[key]?.value
}

export type FixtureHarness = { browser: Browser; base: string; close: () => Promise<void> }

/** 起静态页服务并启动 chromium；调用方负责在 afterAll 里 close。 */
export async function startHarness(): Promise<FixtureHarness> {
  const server: Server = createServer(async (req, res) => {
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
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const browser = await chromium.launch({ headless: true })
  return {
    browser,
    base,
    close: async () => {
      await browser.close()
      await new Promise<void>((done) => server.close(() => done()))
    },
  }
}

export async function centerOf(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = await page.locator(selector).first().boundingBox()
  if (!box) throw new Error(`没有 ${selector}`)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

export type PortalHarness = {
  base: string
  newPage: () => Promise<Page>
  /** 页面所在的浏览器上下文（接口捕获挂在上下文上）。 */
  context: BrowserContext
  /** 靶场标准答案：/grids/truth?view=…&<与页面相同的参数>。 */
  truth: <T = TruthRows>(view: string, query: string) => Promise<T>
  close: () => Promise<void>
}

export type TruthRows = { rowCount: number; total: number; rows: Array<Record<string, string | number>>; summary?: Record<string, number> }

/**
 * 按真值逐行比对读取结果：mapping 为 读取列 key → 真值字段。数字列比 value，金额等小数列比 decimalValue（两位小数），其余比 value。
 * 不一致时报出第几行哪一列，便于定位适配器问题。
 */
export function expectRowsMatchTruth(
  rows: Array<Record<string, { value: unknown; decimalValue?: string }>>,
  truthRows: TruthRows['rows'],
  mapping: Record<string, { field: string; as?: 'value' | 'decimal2' }>,
): void {
  expect(rows.length, '行数与真值不一致').toBe(truthRows.length)
  rows.forEach((row, i) => {
    for (const [key, spec] of Object.entries(mapping)) {
      const want = truthRows[i]![spec.field]
      const got = spec.as === 'decimal2' ? row[key]?.decimalValue : row[key]?.value
      const expected = spec.as === 'decimal2' ? Number(want).toFixed(2) : want
      expect(got, `第 ${i + 1} 行「${key}」`).toEqual(expected)
    }
  })
}

const PORTAL_DIR = join(__dirname, '..', '..', '..', '..', 'tests', 'target-popup-portal')

/**
 * 起目标系统 tests/target-popup-portal（/grids/ 表格控件靶场）并启动 chromium，页面已带登录态。
 * 新三个控件（AG Grid / Ant Design Table / Handsontable）用真实库渲染，依赖装在门户目录里；
 * 没装时明确失败（不静默跳过）：cd tests/target-popup-portal && pnpm install --ignore-workspace
 */
export async function startPortalHarness(): Promise<PortalHarness> {
  const mod = (await import(pathToFileURL(join(PORTAL_DIR, 'server.mjs')).href)) as { createPortalServer: () => Server }
  const server = mod.createPortalServer()
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  await context.addCookies([{ name: 'portal_session', value: 'demo', url: base }])
  return {
    base,
    context,
    newPage: () => context.newPage(),
    truth: async <T,>(view: string, query: string) => {
      const res = await context.request.get(`${base}/grids/truth?view=${view}&${query.replace(/^\?/, '')}`)
      if (!res.ok()) throw new Error(`取真值失败：${res.status()}`)
      return (await res.json()) as T
    },
    close: async () => {
      await browser.close()
      await new Promise<void>((done) => server.close(() => done()))
    },
  }
}

/** 靶场树形真值（/grids/truth?view=tree）的一行。 */
export type TreeTruthRow = { level: number; name: string; path: string; qty: number; amount: number; hasChildren: boolean; expanded?: boolean }

/** 全部展开的树形真值 → 指定节点折叠后页面上看得到的行（折叠节点的后代都看不到）。 */
export function visibleTreeRows(rows: readonly TreeTruthRow[], collapsed: readonly string[]): TreeTruthRow[] {
  const shut = new Set(collapsed)
  const hidden = (path: string) => [...shut].some((name) => rows.some((r) => r.name === name && path.startsWith(`${r.path} / `)))
  return rows.filter((r) => !hidden(r.path)).map((r) => (shut.has(r.name) ? { ...r, expanded: false } : r))
}
