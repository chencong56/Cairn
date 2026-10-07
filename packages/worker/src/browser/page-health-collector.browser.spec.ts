import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chromium, type Browser, type BrowserContext } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRuntimeInvariant } from '@cairn/shared'
import { PageHealthCollector } from './page-health-collector.js'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const PAGE = `<!doctype html><html><body>
<script src="/missing.js"></script>
<script>
fetch('/api/ok'); fetch('/api/boom'); fetch('/api/order/123456', { method: 'POST' });
fetch('/api/slow').catch(() => {}); fetch('/api/lag'); fetch('/api/lag-ok');
setTimeout(() => { throw new Error('页面脚本炸了 token=abc123') }, 50)
</script>
<script src="http://cdn.example.invalid/lib.js"></script>
<iframe src="/frame"></iframe>
</body></html>`

describe('PageHealthCollector（真实 Chromium）', () => {
  let server: Server
  let origin = ''
  let browser: Browser
  let context: BrowserContext

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = req.url ?? ''
      if (url === '/') {
        res.writeHead(200, { 'content-type': 'text/html' })
        return res.end(PAGE)
      }
      if (url === '/frame') {
        res.writeHead(200, { 'content-type': 'text/html' })
        return res.end('<script>fetch("/api/in-frame")</script>')
      }
      if (url === '/api/lag') return void setTimeout(() => res.writeHead(200).end('{}'), 500)
      if (url === '/api/lag-ok') return void res.writeHead(200).end('{}')
      if (url === '/api/ok') return void res.writeHead(200).end('{}')
      if (url === '/api/slow') return void setTimeout(() => res.writeHead(503).end('slow'), 800)
      if (url.startsWith('/api/')) return void res.writeHead(url === '/api/in-frame' ? 404 : 500).end('x')
      res.writeHead(404).end('nope')
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

  it('接口 4xx / 5xx、静态脚本 404、未捕获异常、iframe 内错误按发起步骤归属；外部地址不计；步骤间延迟返回归到发起步骤', async () => {
    const collector = new PageHealthCollector(context, {
      invariants: [
        { ...createRuntimeInvariant('network_health', id(1)), network: { slowRules: [{ match: '/api/lag*', maxMs: 200 }] } },
        createRuntimeInvariant('script_errors', id(2)),
      ],
      knownOrigins: [origin],
    })
    collector.attach()
    const page = await context.newPage()
    collector.beginStep({ stepId: 'step-1', stepRunId: 'sr-1' })
    await page.goto(origin, { waitUntil: 'load' })
    await page.waitForTimeout(200)
    collector.endStep()
    // 延迟返回的 503 在步骤结束后才到：仍应归到 step-1（「之后」的间隙内）
    collector.beginStep({ stepId: 'step-2', stepRunId: 'sr-2' })
    await page.waitForTimeout(1_200)
    collector.endStep()
    const drained = collector.drain()
    collector.dispose()
    await page.close()

    const net = drained.network!
    const byUrl = new Map(net.samples.map((sample) => [sample.url!.replace(origin, ''), sample]))
    expect(byUrl.get('/api/boom')).toMatchObject({ status: 500, stepId: 'step-1' })
    expect(byUrl.get('/api/order/*')).toMatchObject({ method: 'POST', status: 500, stepId: 'step-1' })
    expect(byUrl.get('/missing.js')).toMatchObject({ status: 404, resourceType: 'script' })
    expect(byUrl.get('/api/in-frame')).toMatchObject({ status: 404 })
    expect(byUrl.get('/api/slow')).toMatchObject({ status: 503, stepId: 'step-1' })
    expect(byUrl.has('/api/ok')).toBe(false)
    // 耗时阈值：只有超阈的 /api/lag 算慢，/api/lag-ok 不超阈
    expect(byUrl.get('/api/lag')).toMatchObject({ type: 'slow', maxMs: 200, stepId: 'step-1' })
    expect(byUrl.get('/api/lag')!.durationMs).toBeGreaterThan(200)
    expect(byUrl.has('/api/lag-ok')).toBe(false)
    expect(net.samples.some((sample) => sample.url?.includes('cdn.example.invalid'))).toBe(false)

    const script = drained.script!
    expect(script.total).toBe(1)
    expect(script.samples[0]).toMatchObject({ type: 'script_error', stepId: 'step-1' })
    expect(script.samples[0]!.text).toContain('token=***')
  })
})
