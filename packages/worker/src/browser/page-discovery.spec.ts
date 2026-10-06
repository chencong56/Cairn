import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const appendRunEvents = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('@cairn/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cairn/db')>()),
  appendRunEvents,
}))

import { SessionGuard } from './guard.js'
import { attachPageDiscovery, closeDiscoveredPages, MAX_DISCOVERED_PAGES_PER_OWNER } from './page-discovery.js'
import { openInternalPage, type BrowserHandle } from './runtime.js'
import { adoptPage, closeManagedPage, closeRunPage, ensureRunPage } from './session-command.js'
import { emptyLive, type LiveHandle, type SessionManagerContext } from './session-live.js'

const SESSION_ID = '00000000-0000-4000-8000-0000000000a1'
const RUN_ID = '00000000-0000-4000-8000-0000000000b1'
const LEASE_ID = '00000000-0000-4000-8000-0000000000c1'

const PORTAL_HTML = `<!doctype html><html lang="zh-CN"><body>
<button id="open-js" onclick="window.open('/sub?via=js')">脚本开新页</button>
<a id="open-blank" href="/sub?via=blank" target="_blank">链接开新页</a>
<button id="open-sso" onclick="window.open('/sso')">中转页</button>
<button id="open-many" onclick="for (let i = 0; i < 10; i++) window.open('/sub?n=' + i)">连开十页</button>
</body></html>`

function page(html: string) {
  return `<!doctype html><html lang="zh-CN"><body>${html}</body></html>`
}

type FakeManager = {
  lives: Map<string, LiveHandle>
  leaseToSession: Map<string, string>
  leaseToRun: Map<string, string>
  guard: SessionGuard
  logger: { log: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> }
  dbHandle: unknown
  adoptPage: (...args: Parameters<typeof adoptPage>) => ReturnType<typeof adoptPage>
  ensureRunPage: (...args: Parameters<typeof ensureRunPage>) => ReturnType<typeof ensureRunPage>
  lookupRunSession: (ownerId: string) => Promise<unknown>
  sessionOwnedHere: () => boolean
}

async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待条件超时')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe('会话级页发现', () => {
  let server: Server
  let origin = ''
  let browser: Browser
  let context: BrowserContext
  let live: LiveHandle
  let manager: FakeManager

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      if (url.pathname === '/portal') res.end(PORTAL_HTML)
      else if (url.pathname === '/sso') res.end(page('<p>中转</p><script>setTimeout(() => window.close(), 200)</script>'))
      else res.end(page(`<h1>子系统 ${url.search}</h1>`))
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
    appendRunEvents.mockClear()
    context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
    const basePage = await openInternalPage(context)
    const handle = { context, basePage, isolation: 'SHARED', hostId: null, profileDir: null } as unknown as BrowserHandle
    live = emptyLive(handle, SESSION_ID)
    manager = {
      lives: new Map([[SESSION_ID, live]]),
      leaseToSession: new Map(),
      leaseToRun: new Map(),
      guard: new SessionGuard(),
      logger: { log: vi.fn(), warn: vi.fn() },
      dbHandle: {},
      adoptPage(...args) {
        return adoptPage.apply(this as unknown as SessionManagerContext, args)
      },
      ensureRunPage(...args) {
        return ensureRunPage.apply(this as unknown as SessionManagerContext, args)
      },
      async lookupRunSession(ownerId: string) {
        // 与真实寻址一致：直接会话的合成状态是 RUNNING。
        return { session: { id: SESSION_ID }, live, run: { id: ownerId, status: 'RUNNING' } }
      },
      sessionOwnedHere: () => true,
    }
    attachPageDiscovery(manager as unknown as SessionManagerContext, live)
    await basePage.goto(`${origin}/portal`)
  })

  afterEach(async () => {
    live.pageDiscovery?.dispose()
    await context.close()
  })

  const ctx = () => manager as unknown as SessionManagerContext
  const discovered = (owner: string) =>
    [...live.pages.values()].filter((entry) => entry.runId === owner && entry.discovered && !entry.page.isClosed())

  function leaseRun(): void {
    manager.leaseToSession.set(LEASE_ID, SESSION_ID)
    manager.leaseToRun.set(LEASE_ID, RUN_ID)
    manager.guard.install({
      leaseId: LEASE_ID,
      sessionId: SESSION_ID,
      generation: 1,
      sessionFencingToken: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      purpose: 'EXECUTION',
      ownerKind: 'RUN',
      runId: RUN_ID,
    } as never)
  }

  it('Worker 自建页不登记；脚本与 target=_blank 打开的新页登记为 popup 并递增页序号', async () => {
    const internal = await openInternalPage(context)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect([...live.pages.values()].some((entry) => entry.page === internal)).toBe(false)

    const before = live.pagesRevision
    await live.handle.basePage.click('#open-js')
    await live.handle.basePage.click('#open-blank')
    await until(() => discovered(SESSION_ID).length === 2)
    expect(discovered(SESSION_ID).every((entry) => entry.kind === 'popup')).toBe(true)
    expect(live.pagesRevision).toBeGreaterThan(before)
  })

  it('编排会话持有手动操作权时，新页成为会话当前页；未持有时只登记', async () => {
    await live.handle.basePage.click('#open-js')
    await until(() => discovered(SESSION_ID).length === 1)
    expect(live.currentPageIdByRun.get(SESSION_ID)).toBeUndefined()

    live.inputAccepting = true
    await live.handle.basePage.click('#open-blank')
    await until(() => discovered(SESSION_ID).length === 2)
    const newest = discovered(SESSION_ID).at(-1)!
    expect(live.currentPageIdByRun.get(SESSION_ID)).toBe(newest.pageId)
    expect(ensureRunPage.call(ctx(), live, SESSION_ID).pageId).toBe(newest.pageId)
  })

  it('有 Run 租约时新页归属该 Run、不改执行页，并写运行事件', async () => {
    leaseRun()
    const runEntry = ensureRunPage.call(ctx(), live, RUN_ID, LEASE_ID)
    live.inputAccepting = true
    await live.handle.basePage.click('#open-js')
    await until(() => discovered(RUN_ID).length === 1)
    expect(discovered(SESSION_ID)).toHaveLength(0)
    expect(ensureRunPage.call(ctx(), live, RUN_ID, LEASE_ID).pageId).toBe(runEntry.pageId)
    await until(() => appendRunEvents.mock.calls.length === 1)
    expect(appendRunEvents.mock.calls[0]).toEqual([
      {},
      RUN_ID,
      [expect.objectContaining({ type: 'run.page_discovered', payload: expect.objectContaining({ reason: 'popup' }) })],
    ])
  })

  it('页发现先登记、执行 handoff 再接管时复用同一 pageId', async () => {
    leaseRun()
    ensureRunPage.call(ctx(), live, RUN_ID, LEASE_ID)
    await live.handle.basePage.click('#open-js')
    await until(() => discovered(RUN_ID).length === 1)
    const [entry] = discovered(RUN_ID)
    const adopted = adoptPage.call(ctx(), live, RUN_ID, entry!.page, 'popup', LEASE_ID)
    expect(adopted.pageId).toBe(entry!.pageId)
    expect(adopted.discovered).toBe(false)
    expect([...live.pages.values()].filter((item) => item.page === entry!.page)).toHaveLength(1)
    expect(live.currentPageIdByLease.get(LEASE_ID)).toBe(entry!.pageId)
  })

  it('站点自行关闭的新页撤登记；会话当前页回落', async () => {
    live.inputAccepting = true
    await live.handle.basePage.click('#open-sso')
    await until(() => discovered(SESSION_ID).length === 1)
    const closing = discovered(SESSION_ID)[0]!
    await until(() => !live.pages.has(closing.pageId))
    expect(ensureRunPage.call(ctx(), live, SESSION_ID).page).toBe(live.handle.basePage)
  })

  it('每归属至多保留上限个新页，当前页不被淘汰', async () => {
    live.inputAccepting = true
    await live.handle.basePage.click('#open-many')
    const discoveredLogs = () =>
      manager.logger.log.mock.calls.filter(([, message]) => message === 'session.page_discovered').length
    await until(() => discoveredLogs() === 10)
    await new Promise((resolve) => setTimeout(resolve, 300))
    const kept = discovered(SESSION_ID)
    expect(kept.length).toBe(MAX_DISCOVERED_PAGES_PER_OWNER)
    const currentId = live.currentPageIdByRun.get(SESSION_ID)
    expect(kept.some((entry) => entry.pageId === currentId)).toBe(true)
    expect(context.pages().filter((item) => !item.isClosed()).length).toBe(1 + MAX_DISCOVERED_PAGES_PER_OWNER)
  })

  it('Run 结束：跨标签执行后会话停在执行实际结束的页，最初运行页与自发新页被关闭', async () => {
    leaseRun()
    const runPage = await openInternalPage(context)
    await runPage.goto(`${origin}/portal`)
    live.runPages.set(LEASE_ID, runPage)
    adoptPage.call(ctx(), live, RUN_ID, runPage, 'run', LEASE_ID)
    await runPage.click('#open-js')
    await until(() => discovered(RUN_ID).length === 1)
    const handedOff = discovered(RUN_ID)[0]!.page
    adoptPage.call(ctx(), live, RUN_ID, handedOff, 'popup', LEASE_ID)
    await runPage.click('#open-blank')
    await until(() => discovered(RUN_ID).length === 1)
    const stray = discovered(RUN_ID)[0]!.page
    await handedOff.waitForLoadState()

    await closeRunPage.call(ctx(), LEASE_ID)

    expect(runPage.isClosed()).toBe(true)
    expect(stray.isClosed()).toBe(true)
    expect(handedOff.isClosed()).toBe(false)
    expect(live.lastPage).toBe(handedOff)
    expect(ensureRunPage.call(ctx(), live, SESSION_ID).page).toBe(handedOff)
    expect([...live.pages.values()].some((entry) => entry.runId === RUN_ID)).toBe(false)
  })

  it('同一 Run 已换新租约时，旧租约回收不得关闭新租约正在用的页', async () => {
    leaseRun()
    const NEW_LEASE = '00000000-0000-4000-8000-0000000000c2'
    manager.leaseToSession.set(NEW_LEASE, SESSION_ID)
    manager.leaseToRun.set(NEW_LEASE, RUN_ID)
    const runPage = await openInternalPage(context)
    await runPage.goto(`${origin}/portal`)
    live.runPages.set(NEW_LEASE, runPage)
    const entry = adoptPage.call(ctx(), live, RUN_ID, runPage, 'run', NEW_LEASE)
    await runPage.click('#open-js')
    await until(() => discovered(RUN_ID).length === 1)
    const popup = discovered(RUN_ID)[0]!.page

    // 认证等待租约过期回收：这条旧租约没有自己的运行页。
    await closeRunPage.call(ctx(), LEASE_ID)

    expect(runPage.isClosed()).toBe(false)
    expect(popup.isClosed()).toBe(false)
    expect(live.currentPageIdByRun.get(RUN_ID)).toBe(entry.pageId)
    expect(ensureRunPage.call(ctx(), live, RUN_ID, NEW_LEASE).page).toBe(runPage)
  })

  it('Run 结束且未跨标签：保留最初运行页，行为与原先一致', async () => {
    leaseRun()
    const runPage = await openInternalPage(context)
    await runPage.goto(`${origin}/portal`)
    live.runPages.set(LEASE_ID, runPage)
    adoptPage.call(ctx(), live, RUN_ID, runPage, 'run', LEASE_ID)

    await closeRunPage.call(ctx(), LEASE_ID)

    expect(runPage.isClosed()).toBe(false)
    expect(live.lastPage).toBe(runPage)
    expect(ensureRunPage.call(ctx(), live, SESSION_ID).page).toBe(runPage)
  })

  it('认证等待恢复后关闭等待期间发现的新页；用户关闭会话当前新页后回落', async () => {
    leaseRun()
    await live.handle.basePage.click('#open-js')
    await until(() => discovered(RUN_ID).length === 1)
    const popup = discovered(RUN_ID)[0]!.page
    await closeDiscoveredPages(live, RUN_ID)
    expect(popup.isClosed()).toBe(true)

    manager.leaseToSession.clear()
    manager.leaseToRun.clear()
    live.inputAccepting = true
    await live.handle.basePage.click('#open-blank')
    await until(() => discovered(SESSION_ID).length === 1)
    const current = discovered(SESSION_ID)[0]!
    const closed = await closeManagedPage.call(ctx(), { ownerId: SESSION_ID, pageId: current.pageId })
    expect(closed.closed).toBe(true)
    expect(current.page.isClosed()).toBe(true)
    expect(ensureRunPage.call(ctx(), live, SESSION_ID).page).toBe(live.handle.basePage)
  })
})
