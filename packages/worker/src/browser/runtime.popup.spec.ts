import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openInternalPage, waitForAdoptedPageReady, waitForPopupsFrom } from './runtime.js'

const PORTAL = `<!doctype html><html lang="zh-CN"><body>
<button id="open-js" onclick="window.open('/child?via=js')">脚本开新页</button>
<a id="open-blank" href="/child?via=blank" target="_blank" rel="noopener">链接开新页</a>
</body></html>`

describe('waitForPopupsFrom', () => {
  let server: Server
  let origin = ''
  let browser: Browser
  let context: BrowserContext
  let page: Page

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      if (url.pathname === '/child') res.end(`<!doctype html><html><body><h1>子页 ${url.search}</h1></body></html>`)
      else if (url.pathname === '/slow-child') {
        res.end(`<!doctype html><html><body>
<div id="shell">空壳</div>
<iframe id="late-frame"></iframe>
<script>
  setTimeout(() => {
    const frame = document.getElementById('late-frame')
    if (frame) frame.src = '/child?via=delayed'
  }, 500)
</script>
</body></html>`)
      } else if (url.pathname === '/blank-then-text') {
        res.end(`<!doctype html><html><body>
<script>
  setTimeout(() => { document.body.textContent = '数据展示' }, 600)
</script>
</body></html>`)
      } else res.end(PORTAL)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    browser = await chromium.launch({ headless: true })
  })

  afterAll(async () => {
    await browser?.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  beforeEach(async () => {
    context = await browser.newContext({ viewport: { width: 800, height: 600 } })
    page = await context.newPage()
    await page.goto(`${origin}/`)
  })

  afterEach(async () => {
    await context.close()
  })

  it('收集 window.open 打开的新页', async () => {
    const popped = await waitForPopupsFrom(page, () => page.click('#open-js'))
    expect(popped).toHaveLength(1)
    expect(popped[0]!.url()).toContain('via=js')
    expect(await popped[0]!.opener()).toBe(page)
  })

  it('target=_blank rel=noopener 打开的新页也能收集', async () => {
    const popped = await waitForPopupsFrom(page, () => page.click('#open-blank'))
    expect(popped).toHaveLength(1)
    expect(popped[0]!.url()).toContain('via=blank')
  })

  it('Worker 自建页不计入交接候选', async () => {
    const popped = await waitForPopupsFrom(page, async () => {
      await openInternalPage(context)
    }, 200)
    expect(popped).toHaveLength(0)
  })

  it('交接后等到晚到的 iframe 挂上，不把空壳当就绪', async () => {
    await page.goto(`${origin}/slow-child`)
    const started = Date.now()
    await waitForAdoptedPageReady(page, 3_000)
    expect(Date.now() - started).toBeGreaterThan(450)
    const urls = page.frames().map((frame) => frame.url())
    expect(urls.some((url) => url.includes('via=delayed'))).toBe(true)
  })

  it('没有 iframe 的白页等到正文出现，不按 DCL 立刻放行', async () => {
    await page.goto(`${origin}/blank-then-text`, { waitUntil: 'domcontentloaded' })
    const started = Date.now()
    await waitForAdoptedPageReady(page, 3_000)
    expect(Date.now() - started).toBeGreaterThan(550)
    expect((await page.locator('body').innerText()).trim()).toBe('数据展示')
  })
})
