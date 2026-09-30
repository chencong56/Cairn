/**
 * P2 规范验收测试：接通共享与重建链路
 * 覆盖用例：
 * - A06：SHARED 模式真实跑通两 Run，复用同 host 且各自分离 context
 * - A08：SHARED 模式认证态落入 JSON 且下次复用成功加载
 *
 * 注：RESTART 传承（A05/A18 的 accountSlot 与 isolation 延续）在
 * session-maintenance.spec.ts 的「RESTART 成功路径」与
 * db maintenance-regressions.test.ts 的「受控重启」用例中验证。
 */
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { BrowserHostPool } from './host-pool.js'
import { withTestOccupancy } from './test-occupancy.js'
import { isChromiumAvailableCached } from '../testing/chromium-probe.js'

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('无法绑定本地端口'))
        return
      }
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

describe('P2: 接通共享与重建链路验收 (A06 / A08 / A18)', { timeout: 120_000 }, () => {
  let hasBrowser = false
  let server: Server | undefined
  let baseUrl = ''
  let pool: BrowserHostPool | undefined
  const launchedBrowsers: Browser[] = []

  beforeAll(async () => {
    hasBrowser = await isChromiumAvailableCached()
    if (!hasBrowser) return

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
      if (url.pathname === '/login') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Set-Cookie': 'auth_token=secret_token_123; Path=/; HttpOnly',
        })
        res.end(`<!doctype html>
<html>
<head><title>Login Page</title></head>
<body>
  <h1>Authenticated Page</h1>
  <script>
    localStorage.setItem('user_session', JSON.stringify({ userId: 'u-123', role: 'admin' }));
  </script>
</body>
</html>`)
        return
      }

      if (url.pathname === '/profile') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html>
<html>
<head><title>Profile</title></head>
<body>
  <div id="status">OK</div>
</body>
</html>`)
        return
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html><body><h1>Root</h1></body></html>')
    })

    baseUrl = await listen(server)

    pool = new BrowserHostPool(
      'worker-p2-test',
      {
        maxContextsPerHost: 6,
        hostMaxAgeSeconds: 14400,
        hostRssHighWatermarkMb: 0,
        targetSpread: 'prefer',
        idleCloseDelayMs: 60_000,
      },
      async (hostId) => {
        const browser = await chromium.launch({
          headless: true,
          args: ['--no-sandbox', '--disable-dev-shm-usage', `--cairn-host=${hostId}`],
        })
        launchedBrowsers.push(browser)
        return browser
      },
    )
  })

  afterAll(async () => {
    for (const b of launchedBrowsers) {
      if (b.isConnected()) await b.close().catch(() => {})
    }
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()))
    }
  })

  it('A06: SHARED 模式真实跑通两 Run，复用同 host 且各自分离 context', async () => {
    if (!hasBrowser || !pool) return

    // Run 1 acquires context on shared host
    const h1 = await withTestOccupancy(() =>
      pool!.acquireContext('session-a06-1', ['target:target-1', 'host:site1.local'], { headless: true }, 0, 8),
    )
    expect(h1.handle.isolation).toBe('SHARED')
    expect(h1.hostId).toBeTruthy()

    // Run 2 acquires context for a different target; under prefer mode, it should pack onto the same host
    const h2 = await withTestOccupancy(() =>
      pool!.acquireContext('session-a06-2', ['target:target-2', 'host:site2.local'], { headless: true }, 1, 8),
    )
    expect(h2.handle.isolation).toBe('SHARED')
    // 复用同一宿主
    expect(h2.hostId).toBe(h1.hostId)
    // 宿主当前 context 数为 2
    expect(pool.getContextCount()).toBe(2)
    expect(pool.getHostCount()).toBe(1)

    // 各自分离 Context 实例
    expect(h1.handle.context).not.toBe(h2.handle.context)
    expect(h1.handle.basePage).not.toBe(h2.handle.basePage)

    // 分别在两个 context 中独立导航与写入存储
    const page1 = h1.handle.basePage
    const page2 = h2.handle.basePage

    await page1.goto(baseUrl)
    await page1.evaluate(() => {
      localStorage.setItem('shared_test_key', 'val-1')
    })
    await h1.handle.context.addCookies([{ name: 'c_key', value: 'c_val_1', url: baseUrl }])

    await page2.goto(baseUrl)
    await page2.evaluate(() => {
      localStorage.setItem('shared_test_key', 'val-2')
    })
    await h2.handle.context.addCookies([{ name: 'c_key', value: 'c_val_2', url: baseUrl }])

    // 验证隔离性：两边各自读到的值互不干扰
    const val1 = await page1.evaluate(() => localStorage.getItem('shared_test_key'))
    const val2 = await page2.evaluate(() => localStorage.getItem('shared_test_key'))
    expect(val1).toBe('val-1')
    expect(val2).toBe('val-2')

    const cookies1 = await h1.handle.context.cookies(baseUrl)
    const cookies2 = await h2.handle.context.cookies(baseUrl)
    expect(cookies1.find((c) => c.name === 'c_key')?.value).toBe('c_val_1')
    expect(cookies2.find((c) => c.name === 'c_key')?.value).toBe('c_val_2')

    // 释放 session 1，session 2 仍然健康存活且 host 不关闭
    await pool.releaseContext('session-a06-1')
    expect(pool.getContextCount()).toBe(1)
    expect(pool.getHostCount()).toBe(1)

    const isConnectedAfter = h2.handle.context.browser()?.isConnected()
    expect(isConnectedAfter).toBe(true)

    // 释放 session 2
    await pool.releaseContext('session-a06-2')
    expect(pool.getContextCount()).toBe(0)
  })

  it('A08: SHARED 模式认证态落入 JSON 且下次复用成功加载 (storageState 验证)', async () => {
    if (!hasBrowser || !pool) return

    // 1. 会话 1 登录并获取 cookies + localStorage
    const h1 = await withTestOccupancy(() =>
      pool!.acquireContext('session-a08-source', ['target:target-auth'], { headless: true }, 0, 8),
    )
    const p1 = h1.handle.basePage
    await p1.goto(`${baseUrl}/login`, { waitUntil: 'networkidle' })

    // 2. 导出 context.storageState() 成为标准快照 JSON
    const exportedState = await h1.handle.context.storageState()
    expect(exportedState).toBeDefined()
    expect(exportedState.cookies.length).toBeGreaterThan(0)
    const authCookie = exportedState.cookies.find((c) => c.name === 'auth_token')
    expect(authCookie).toBeDefined()
    expect(authCookie?.value).toBe('secret_token_123')

    expect(exportedState.origins.length).toBeGreaterThan(0)
    const originEntry = exportedState.origins.find((o) => baseUrl.startsWith(o.origin))
    expect(originEntry).toBeDefined()
    const lsItem = originEntry?.localStorage.find((item) => item.name === 'user_session')
    expect(lsItem).toBeDefined()
    expect(lsItem?.value).toContain('u-123')

    // 验证 Playwright 1.63.0 storageState 格式规范：明确不包含 IndexedDB
    expect((exportedState as any).indexedDB).toBeUndefined()

    // 释放源会话
    await pool.releaseContext('session-a08-source')

    // 3. 新会话携带导出的 storageState 启动并导回
    const h2 = await withTestOccupancy(() =>
      pool!.acquireContext(
        'session-a08-target',
        ['target:target-auth'],
        {
          headless: true,
          storageState: exportedState,
        },
        0,
        8,
      ),
    )

    const p2 = h2.handle.basePage
    await p2.goto(`${baseUrl}/profile`, { waitUntil: 'domcontentloaded' })

    // 验证导入后的 Cookie 与 LocalStorage 均已生效
    const cookiesInTarget = await h2.handle.context.cookies()
    const restoredCookie = cookiesInTarget.find((c) => c.name === 'auth_token')
    expect(restoredCookie).toBeDefined()
    expect(restoredCookie?.value).toBe('secret_token_123')

    const restoredLs = await p2.evaluate(() => localStorage.getItem('user_session'))
    expect(restoredLs).toBeDefined()
    expect(restoredLs).toContain('u-123')

    // 释放会话 2
    await pool.releaseContext('session-a08-target')
  })
})
