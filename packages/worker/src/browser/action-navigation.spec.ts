import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserCommand } from '@cairn/shared'
import { executeOnPage as executeOnPageRaw } from './surface'
import { withTestOccupancy } from './test-occupancy'

const executeOnPage = (...args: Parameters<typeof executeOnPageRaw>) =>
  withTestOccupancy(() => executeOnPageRaw(...args))

const css = (value: string) => ({ framePath: [], candidates: [{ by: 'css' as const, value }] })

const FORM_PAGE = `<!doctype html><html lang="zh-CN"><body>
<form method="POST" action="/drop"><button id="drop">提交后断开</button></form>
<form method="POST" action="/accept"><button id="accept">正常提交</button></form>
<form method="POST" action="/slow" id="superseded"><button id="supersede">被新导航顶替</button></form>
<form method="POST" action="/drop"><input id="enter-drop" name="q"></form>
<button id="plain" onclick="document.body.dataset.clicked='1'">不跳转</button>
<script>
document.getElementById('superseded').addEventListener('submit', () => {
  setTimeout(() => { location.href = '/done' }, 50)
})
</script>
</body></html>`

describe('动作触发的导航结局', () => {
  let server: Server
  let origin = ''
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/drop') return req.socket.destroy()
      if (req.url === '/accept') {
        res.writeHead(302, { Location: '/done' })
        return res.end()
      }
      if (req.url === '/slow') {
        setTimeout(() => {
          res.writeHead(302, { Location: '/done' })
          res.end()
        }, 3_000)
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(req.url === '/done' ? '<h1 id="done">已完成</h1>' : FORM_PAGE)
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
    page = await browser.newPage()
    await page.goto(`${origin}/`)
  })

  it('点击提交后连接被断开：结果未确认，记 UNKNOWN 且不当作成功', async () => {
    const result = await executeOnPage(page, { type: 'click', target: css('#drop') } as BrowserCommand)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('click')
    expect(result.error).toMatchObject({ code: 'ACTION_NAVIGATION_FAILED', category: 'UNKNOWN', retryable: false })
  })

  it('回车提交后连接被断开同样记 UNKNOWN', async () => {
    const result = await executeOnPage(page, { type: 'keyboard', target: css('#enter-drop'), keys: ['Enter'] } as BrowserCommand)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('keyboard')
    expect(result.error.code).toBe('ACTION_NAVIGATION_FAILED')
  })

  it('正常提交与重定向、被新导航顶替、无导航的点击都照常成功', async () => {
    expect((await executeOnPage(page, { type: 'click', target: css('#accept') } as BrowserCommand)).ok).toBe(true)
    await page.waitForSelector('#done')

    await page.goto(`${origin}/`)
    expect((await executeOnPage(page, { type: 'click', target: css('#supersede') } as BrowserCommand)).ok).toBe(true)
    await page.waitForSelector('#done')

    await page.goto(`${origin}/`)
    expect((await executeOnPage(page, { type: 'click', target: css('#plain') } as BrowserCommand)).ok).toBe(true)
    expect(await page.locator('body').getAttribute('data-clicked')).toBe('1')
  })
})
