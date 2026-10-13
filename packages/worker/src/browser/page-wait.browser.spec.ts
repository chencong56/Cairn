import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chromium, type Browser, type BrowserContext } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { executeOnPage } from './surface.js'
import { withTestOccupancy } from './test-occupancy.js'
import { runWithPageWaitCollector, type PageWaitSink } from './page-wait-collector.js'

function recordingSink() {
  const reasons: string[] = []
  const sink: PageWaitSink = {
    async markReady() {
      reasons.push('collector_ready')
    },
    async record(reason) {
      reasons.push(reason)
    },
  }
  return { reasons, sink }
}

describe('页面等待采集（真实 Chromium）', () => {
  let server: Server
  let origin = ''
  let browser: Browser
  let context: BrowserContext

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = req.url ?? '/'
      if (url.startsWith('/next')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        return res.end('<!doctype html><html><body><p id="ready">已跳转</p></body></html>')
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><html><body>
        <p id="home">首页</p>
        <a id="go" href="/next">去下一页</a>
        <div id="later" hidden>稍后出现</div>
        <script>setTimeout(() => { document.getElementById('later').hidden = false }, 80)</script>
      </body></html>`)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    browser = await chromium.launch({ headless: true })
    context = await browser.newContext()
  })

  afterAll(async () => {
    await context?.close()
    await browser?.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('navigate / landing_settle / wait_condition / nav_request 会记；time 等待不记', async () => {
    const { reasons, sink } = recordingSink()
    const page = await context.newPage()
    await runWithPageWaitCollector(sink, () =>
      withTestOccupancy(async () => {
        const nav = await executeOnPage(page, { type: 'navigate', url: origin })
        expect(nav.ok).toBe(true)
        const waitUrl = await executeOnPage(page, { type: 'wait', kind: 'url', urlPattern: origin, timeoutMs: 2_000 })
        expect(waitUrl.ok).toBe(true)
        const waitVisible = await executeOnPage(page, {
          type: 'wait',
          kind: 'visible',
          target: { framePath: [], candidates: [{ by: 'css', value: '#later' }] },
          timeoutMs: 2_000,
        })
        expect(waitVisible.ok).toBe(true)
        const waitTime = await executeOnPage(page, { type: 'wait', kind: 'time', durationMs: 20 })
        expect(waitTime.ok).toBe(true)
        const clicked = await executeOnPage(page, {
          type: 'click',
          target: { framePath: [], candidates: [{ by: 'css', value: '#go' }] },
        })
        expect(clicked.ok).toBe(true)
      }),
    )
    await page.close()
    expect(reasons).toEqual(expect.arrayContaining(['navigate', 'landing_settle', 'wait_condition', 'nav_request']))
    expect(reasons.filter((reason) => reason === 'wait_condition').length).toBeGreaterThanOrEqual(2)
    expect(reasons).not.toContain('collector_ready')
  })
})
