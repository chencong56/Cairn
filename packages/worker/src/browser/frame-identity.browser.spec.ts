/**
 * iframe 跳转后 src ≠ 落地 URL：点选、回放定位、抽表不得再报 SURFACE_LOST。
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import type { TargetDescriptor } from '@cairn/shared'
import { isChromiumAvailableCached } from '../testing/chromium-probe.js'
import { locate } from './surface.js'
import { pickOnPage } from './observe.js'
import { executeOnPage as executeOnPageRaw } from './surface.js'
import { withTestOccupancy } from './test-occupancy.js'

const FIXTURES = join(__dirname, '__fixtures__', 'legacy-grids')
const JUMP_SRC =
  '/frame-jump.html?priv_id=10100010&cct_url=http%3A%2F%2Fbi.example%2Fctb-thematic-web%2FtowerSkip%2FgoReportMgt'

function executeOnPage(...args: Parameters<typeof executeOnPageRaw>) {
  return withTestOccupancy(() => executeOnPageRaw(...args))
}

function target(framePath: TargetDescriptor['framePath'], value = 'A001'): TargetDescriptor {
  return { framePath, candidates: [{ by: 'text', value }] }
}

describe('iframe 跳转身份 × 回放定位', { timeout: 60_000 }, () => {
  let available = false
  let browser: Browser | undefined
  let server: ReturnType<typeof createServer> | undefined
  let base = ''

  beforeAll(async () => {
    available = await isChromiumAvailableCached()
    if (!available) return
    server = createServer(async (req, res) => {
      const name = (req.url ?? '/').split('?')[0]!.replace(/^\/+/, '') || 'frame-inner.html'
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

  async function waitJumpTable(page: Page, frame = '#jump-frame', cell = '#orders td') {
    await page.locator(frame).waitFor()
    await page.frameLocator(frame).locator(cell).first().waitFor()
  }

  it('旧描述符只记跳转 src：回放仍能点到落地表', async ({ skip }) => {
    if (!available) skip()
    const page = await open('frame-jump-outer.html')
    await waitJumpTable(page)
    const found = await locate(page, target([{ urlPattern: JUMP_SRC }]), 4_000)
    expect(found.kind).toBe('found')
    const clicked = await executeOnPage(page, { type: 'click', target: target([{ urlPattern: JUMP_SRC }]) })
    expect(clicked.ok).toBe(true)
    await page.close()
  })

  it('点选记下落地 path，不含跳转 src，回放能找到', async ({ skip }) => {
    if (!available) skip()
    const page = await open('frame-jump-outer.html')
    await waitJumpTable(page)
    const box = await page.frameLocator('#jump-frame').locator('#orders td').first().boundingBox()
    expect(box).toBeTruthy()
    const picked = await pickOnPage(page, box!.x + box!.width / 2, box!.y + box!.height / 2)
    expect(picked.outcome).toBe('FOUND')
    const step = picked.target?.framePath[0]
    expect(step?.urlPattern).toBe('/frame-inner.html')
    expect(step?.selector).toBe('#jump-frame')
    expect(picked.enclosingTable?.framePath[0]?.urlPattern).toBe('/frame-inner.html')
    const again = await locate(page, picked.target!, 4_000)
    expect(again.kind).toBe('found')
    const table = await locate(page, picked.enclosingTable!, 4_000)
    expect(table.kind).toBe('found')
    await page.close()
  })

  it('urlPattern 对不上但 selector 唯一：放行', async ({ skip }) => {
    if (!available) skip()
    const page = await open('frame-jump-outer.html')
    await waitJumpTable(page)
    const found = await locate(
      page,
      target([{ urlPattern: '/never-existed-jump.do?x=1', selector: '#jump-frame' }]),
      4_000,
    )
    expect(found.kind).toBe('found')
    await page.close()
  })

  it('urlPattern 对不上且 selector 不唯一：SURFACE_LOST', async ({ skip }) => {
    if (!available) skip()
    const page = await open('frame-jump-twin.html')
    await page.locator('#frame-a').waitFor()
    await page.frameLocator('#frame-a').locator('#orders td').first().waitFor()
    await page.frameLocator('#frame-b').locator('#orders-b td').first().waitFor()
    const missed = await locate(
      page,
      target([{ urlPattern: '/never-existed-jump.do?x=1', selector: 'iframe' }]),
      1_200,
    )
    expect(missed.kind).toBe('miss')
    if (missed.kind === 'miss') expect(missed.outcome).toBe('SURFACE_LOST')
    await page.close()
  })

  it('两个跳转框共用同一 src 片段且无唯一身份：匹配到多个', async ({ skip }) => {
    if (!available) skip()
    const page = await open('frame-jump-twin.html')
    await page.frameLocator('#frame-a').locator('#orders td').first().waitFor()
    const missed = await locate(page, target([{ urlPattern: '/frame-jump.html' }]), 1_200)
    expect(missed.kind).toBe('miss')
    if (missed.kind === 'miss') expect(missed.outcome).toBe('SURFACE_LOST')
    const unique = await locate(page, target([{ urlPattern: '/frame-jump.html', selector: '#frame-b' }], 'B001'), 4_000)
    expect(unique.kind).toBe('found')
    await page.close()
  })

  it('name 与 selector 对不上仍失败', async ({ skip }) => {
    if (!available) skip()
    const page = await open('frame-jump-outer.html')
    await waitJumpTable(page)
    const missed = await locate(page, target([{ name: 'jump', selector: '#nope' }]), 1_200)
    expect(missed.kind).toBe('miss')
    if (missed.kind === 'miss') expect(missed.outcome).toBe('SURFACE_LOST')
    await page.close()
  })

  it('src 稳定、落地 URL 换 token：记下的 path 仍能回放', async ({ skip }) => {
    if (!available) skip()
    const page = await open('frame-query-drift-outer.html')
    await waitJumpTable(page, '#stable-frame')
    const box = await page.frameLocator('#stable-frame').locator('#orders td').first().boundingBox()
    const picked = await pickOnPage(page, box!.x + box!.width / 2, box!.y + box!.height / 2)
    expect(picked.outcome).toBe('FOUND')
    expect(picked.target?.framePath[0]?.urlPattern).toBe('/frame-inner-drift.html')
    expect(picked.target?.framePath[0]?.urlPattern).not.toContain('token=')
    const child = page.frames().find((frame) => frame.url().includes('frame-inner-drift'))
    expect(child).toBeTruthy()
    await child!.evaluate(() => {
      const loc = (globalThis as unknown as { location: { pathname: string; replace: (url: string) => void } }).location
      loc.replace(`${loc.pathname}?token=second-99`)
    })
    await page.frameLocator('#stable-frame').locator('#orders td').first().waitFor()
    const again = await locate(page, picked.target!, 4_000)
    expect(again.kind).toBe('found')
    await page.close()
  })
})
