/**
 * L2：真实 chromium + tests/target-surface-lab。
 * 无浏览器时 skip，不拖垮 CI。
 */
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BrowserCommand, TargetDescriptor } from '@cairn/shared'
import { highlightOnPage, pickOnPage } from './observe'
import { executeOnPage as executeOnPageRaw } from './surface'
import { launchSession, stopSession, type BrowserHandle } from './runtime'
import { ensureProfileDir } from './profiles'
import { withTestOccupancy } from './test-occupancy'
import { isChromiumAvailableCached } from '../testing/chromium-probe.js'

function executeOnPage(...args: Parameters<typeof executeOnPageRaw>) {
  return withTestOccupancy(() => executeOnPageRaw(...args))
}

const LAB_PUBLIC = resolve(__dirname, '../../../../tests/target-surface-lab/public')
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
}

/**
 * 浸泡采样次数：交付门默认 3 次采样（确定性回归由同文件其余用例捕获），
 * 概率性误点的深浸泡走 `pnpm --filter @cairn/worker test:soak`（20 次）。
 */
const SOAK_ITERS = Math.max(1, Number(process.env.CAIRN_SOAK_ITERS ?? 3))

function button(name: string, extra: Partial<TargetDescriptor> = {}): TargetDescriptor {
  return {
    framePath: extra.framePath ?? [],
    candidates: extra.candidates ?? [{ by: 'role', value: 'button', name }],
    anchor: extra.anchor,
  }
}

describe('Browser Surface × target-surface-lab（L2）', { timeout: 180_000 }, () => {
  let hasBrowser = false
  let baseUrl = ''
  let server: ReturnType<typeof createServer> | undefined
  let handle: BrowserHandle | undefined

  beforeAll(async () => {
    hasBrowser = await isChromiumAvailableCached()
    if (!hasBrowser) return
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '')
      const file = join(LAB_PUBLIC, relative)
      try {
        const info = await stat(file)
        if (!info.isFile()) throw new Error('not file')
        const body = await readFile(file)
        res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' })
        res.end(body)
      } catch {
        res.writeHead(404)
        res.end('Not Found')
      }
    })
    await new Promise<void>((resolveReady) => server!.listen(0, '127.0.0.1', resolveReady))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('lab port')
    baseUrl = `http://127.0.0.1:${address.port}`
    const profileRoot = mkdtempSync(join(tmpdir(), 'cairn-lab-'))
    const profile = ensureProfileDir(profileRoot, {
      targetId: '00000000-0000-4000-8000-0000000000aa',
      targetAccountId: '00000000-0000-4000-8000-0000000000ab',
    })
    handle = await withTestOccupancy(() => launchSession(profile.profileDir, { headless: true }))
  })

  afterAll(async () => {
    if (handle) await stopSession(handle)
    await new Promise<void>((resolveClose, reject) => {
      if (!server) return resolveClose()
      server.close((error) => (error ? reject(error) : resolveClose()))
    })
  })

  async function open(path: string) {
    if (!handle) throw new Error('no browser')
    await handle.basePage.goto(`${baseUrl}${path}`, { waitUntil: 'domcontentloaded' })
    return handle.basePage
  }

  async function run(command: BrowserCommand) {
    if (!handle) throw new Error('no browser')
    return executeOnPage(handle.basePage, command)
  }

  it(`普通 DOM / 两层 iframe / 重挂载 / popup / 行内锚点 各 ${SOAK_ITERS} 次无误点（CAIRN_SOAK_ITERS 可调）`, async ({ skip }) => {
    if (!hasBrowser) skip()
    try {
      for (let i = 0; i < SOAK_ITERS; i++) {
        const page = await open('/')
        const clicked = await executeOnPage(page, { type: 'click', target: button('查询') })
        expect(clicked.ok, `普通 DOM #${i}`).toBe(true)
        expect(await page.locator('#status').innerText()).toBe('已查询')
      }

      for (let i = 0; i < SOAK_ITERS; i++) {
        const page = await open('/nested.html')
        await page.waitForSelector('iframe[name="outer"]')
        const clicked = await executeOnPage(page, {
          type: 'click',
          target: button('深层确认', {
            framePath: [{ urlPattern: 'frame-outer.html' }, { urlPattern: 'frame-inner.html' }],
          }),
        })
        expect(clicked.ok, `嵌套 iframe #${i}`).toBe(true)
      }

      for (let i = 0; i < SOAK_ITERS; i++) {
        const page = await open('/remount.html')
        await page.waitForSelector('iframe[name="live"]')
        const clicked = await executeOnPage(page, {
          type: 'click',
          target: button('心跳', { framePath: [{ urlPattern: 'remount-frame.html' }] }),
        })
        expect(clicked.ok, `重挂载 #${i}`).toBe(true)
      }

      for (let i = 0; i < SOAK_ITERS; i++) {
        const page = await open('/popup.html')
        const opened = await executeOnPage(page, { type: 'click', target: button('打开子窗') })
        expect(opened.ok, `popup 打开 #${i}`).toBe(true)
        const child = page.context().pages().at(-1)
        expect(child).toBeTruthy()
        await child!.waitForLoadState('domcontentloaded')
        const confirmed = await executeOnPage(child!, { type: 'click', target: button('子窗确认') })
        expect(confirmed.ok, `popup 点击 #${i}`).toBe(true)
        await child!.close()
      }

      for (let i = 0; i < SOAK_ITERS; i++) {
        const page = await open('/icons.html')
        const clicked = await executeOnPage(page, {
          type: 'click',
          target: button('删除', { anchor: { withinText: '乙订单', scope: 'row' } }),
        })
        expect(clicked.ok, `小图标 #${i}`).toBe(true)
        expect(await page.locator('#deleted').innerText()).toBe('乙订单')
      }
    } catch (caught) {
      // 采样命中概率性信号时给出确定性复跑路径，避免在浅采样上反复猜
      if (caught instanceof Error) {
        caught.message = `${caught.message}\n[浸泡采样] 当前每场景 ${SOAK_ITERS} 次采样命中失败：请用 CAIRN_SOAK_ITERS=20 复跑定位（pnpm --filter @cairn/worker test:soak）`
      }
      throw caught
    }
  })

  it('FrameStep.selector 按父文档匹配 iframe，错选择器走 NOT_FOUND', async ({ skip }) => {
    if (!hasBrowser) skip()
    const page = await open('/nested.html')
    await page.waitForSelector('#outer-frame')
    const clicked = await executeOnPage(page, {
      type: 'click',
      target: button('深层确认', {
        framePath: [{ selector: '#outer-frame' }, { selector: 'iframe[name="inner"]' }],
      }),
    })
    expect(clicked.ok).toBe(true)
    expect(clicked.ok && clicked.diagnostics?.framePathResolved).toEqual([
      'main',
      '#outer-frame',
      'iframe[name="inner"]',
    ])

    const wrong = await executeOnPage(page, {
      type: 'click',
      target: button('深层确认', {
        framePath: [{ selector: 'iframe[name="nope"]' }],
      }),
    })
    expect(wrong.ok).toBe(false)
    if (wrong.ok) throw new Error('ok')
    expect(wrong.error.code).toBe('TARGET_NOT_FOUND')

    const mismatch = await executeOnPage(page, {
      type: 'click',
      target: button('深层确认', {
        framePath: [{ name: 'outer', selector: '#inner-frame' }],
      }),
    })
    expect(mismatch.ok).toBe(false)
    if (mismatch.ok) throw new Error('ok')
    expect(mismatch.error.code).toBe('TARGET_NOT_FOUND')
  })

  it('找不到 / 多匹配 / 页面关闭分别给出结构化错误', async ({ skip }) => {
    if (!hasBrowser) skip()
    await open('/missing.html')
    const missing = await run({ type: 'click', target: button('查询') })
    expect(missing.ok).toBe(false)
    if (missing.ok) throw new Error('ok')
    expect(missing.error.code).toBe('TARGET_NOT_FOUND')
    expect(missing.diagnostics?.candidatesTried[0]?.matches).toBe(0)

    await open('/icons.html')
    const ambiguous = await run({ type: 'click', target: button('删除') })
    expect(ambiguous.ok).toBe(false)
    if (ambiguous.ok) throw new Error('ok')
    expect(ambiguous.error.code).toBe('TARGET_AMBIGUOUS')
    expect(ambiguous.diagnostics?.candidatesTried[0]?.matches).toBeGreaterThan(1)

    const page = await open('/')
    await page.close()
    const lost = await executeOnPage(page, { type: 'click', target: button('查询') })
    expect(lost.ok).toBe(false)
    if (lost.ok) throw new Error('ok')
    expect(lost.error.code).toBe('SURFACE_LOST')
    handle!.basePage = await handle!.context.newPage()
  })

  it('closed Shadow 与 Canvas 返回 BROWSER_CAPABILITY_MISSING', async ({ skip }) => {
    if (!hasBrowser) skip()
    await open('/shadow.html')
    const closed = await run({
      type: 'click',
      target: { framePath: [], candidates: [{ by: 'text', value: '暗处按钮' }] },
    })
    expect(closed.ok).toBe(false)
    if (closed.ok) throw new Error('ok')
    expect(closed.error.code).toBe('BROWSER_CAPABILITY_MISSING')

    await open('/canvas.html')
    const canvas = await run({
      type: 'click',
      target: { framePath: [], candidates: [{ by: 'css', value: '#board' }] },
    })
    expect(canvas.ok).toBe(false)
    if (canvas.ok) throw new Error('ok')
    expect(canvas.error.code).toBe('BROWSER_CAPABILITY_MISSING')
  })

  it('extract / assert / navigate 跨域地址不受访问范围限制', async ({ skip }) => {
    if (!hasBrowser) skip()
    const page = await open('/')
    const extracted = await executeOnPage(page, {
      type: 'extract',
      target: { framePath: [], candidates: [{ by: 'testId', value: 'page-title' }] },
      as: 'text',
    })
    expect(extracted.ok).toBe(true)
    if (!extracted.ok) throw new Error('extract')
    expect(extracted.output).toEqual({ value: '普通 DOM' })

    const assertion = await executeOnPage(page, {
      type: 'assert',
      target: { framePath: [], candidates: [{ by: 'testId', value: 'page-title' }] },
      expect: { kind: 'text_equals', value: '普通 DOM' },
    })
    expect(assertion.ok).toBe(true)

    const failed = await executeOnPage(page, {
      type: 'assert',
      target: { framePath: [], candidates: [{ by: 'testId', value: 'page-title' }] },
      expect: { kind: 'text_equals', value: '别的' },
    })
    expect(failed.ok).toBe(false)
    if (failed.ok) throw new Error('assert')
    expect(failed.error.code).toBe('ASSERT_FAILED')
    expect(failed.output).toMatchObject({ expected: '别的', actual: '普通 DOM' })

    // 访问范围已移除：绝对地址跨域照常导航，旧 API 仍下发的 allowedOrigins 被忽略。保留域名经路由拦截，不访问外网。
    await page.route('https://other.example/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>跨域页</title><h1>跨域页</h1>' }),
    )
    try {
      const nav = await executeOnPage(page, {
        type: 'navigate',
        url: 'https://other.example/landing',
        allowedOrigins: [new URL(baseUrl).origin],
      })
      expect(nav.ok).toBe(true)
      expect(nav.output).toEqual({ url: 'https://other.example/landing' })
      expect(await page.locator('h1').textContent()).toBe('跨域页')
    } finally {
      await page.unroute('https://other.example/**')
    }
  })

  it('select / keyboard / wait 在编写夹具页可执行', async ({ skip }) => {
    if (!hasBrowser) skip()
    const page = await open('/authoring.html')
    const selected = await executeOnPage(page, {
      type: 'select',
      target: { framePath: [], candidates: [{ by: 'role', value: 'combobox', name: '城市' }] },
      by: 'label',
      value: '北京',
    })
    expect(selected.ok).toBe(true)
    expect(await page.locator('#city').inputValue()).toBe('bj')

    const typed = await executeOnPage(page, {
      type: 'keyboard',
      target: { framePath: [], candidates: [{ by: 'label', value: '搜索' }] },
      keys: ['Enter'],
    })
    expect(typed.ok).toBe(true)
    expect(await page.locator('#late').getAttribute('data-enter')).toBe('1')

    await page.locator('#reveal').click()
    const waited = await executeOnPage(page, {
      type: 'wait',
      kind: 'visible',
      target: { framePath: [], candidates: [{ by: 'text', value: '已出现' }] },
    })
    expect(waited.ok).toBe(true)
  })

  it('指认走 Resolver：唯一匹配 FOUND，多匹配 AMBIGUOUS 且列出邻近文本', async ({ skip }) => {
    if (!hasBrowser) skip()
    const page = await open('/authoring.html')
    const go = page.getByTestId('go')
    const box = await go.boundingBox()
    expect(box).toBeTruthy()
    const picked = await pickOnPage(page, box!.x + box!.width / 2, box!.y + box!.height / 2)
    expect(picked.outcome).toBe('FOUND')
    expect(picked.target?.candidates[0]).toMatchObject({ by: 'testId', value: 'go' })
    expect(picked.diagnostics.candidatesTried.some((item) => item.matches === 1)).toBe(true)
    expect(picked.diagnostics.framePathResolved?.includes('fragile-css')).toBeFalsy()

    const wrapped = page.locator('.text-nowrap', { hasText: '查询实例' })
    const wrappedBox = await wrapped.boundingBox()
    expect(wrappedBox).toBeTruthy()
    const fromSpan = await pickOnPage(
      page,
      wrappedBox!.x + wrappedBox!.width / 2,
      wrappedBox!.y + wrappedBox!.height / 2,
    )
    expect(fromSpan.outcome).toBe('FOUND')
    expect(fromSpan.target?.candidates[0]).toMatchObject({ by: 'role', value: 'button', name: '查询实例' })
    expect(fromSpan.diagnostics.framePathResolved?.includes('fragile-css')).toBeFalsy()

    const cssOnly = page.locator('span.unique-fragile-only')
    const cssBox = await cssOnly.boundingBox()
    expect(cssBox).toBeTruthy()
    const fromCss = await pickOnPage(page, cssBox!.x + cssBox!.width / 2, cssBox!.y + cssBox!.height / 2)
    expect(fromCss.outcome).toBe('FOUND')
    expect(fromCss.target?.candidates.some((item) => item.by === 'css')).toBe(true)
    expect(fromCss.diagnostics.candidatesTried.find((item) => item.matches === 1)?.by).toBe('css')
    expect(fromCss.diagnostics.framePathResolved).toContain('fragile-css')

    const highlighted = await highlightOnPage(page, {
      framePath: [],
      candidates: [{ by: 'role', value: 'button', name: '删除' }],
    })
    expect(highlighted.outcome).toBe('AMBIGUOUS')
    expect(highlighted.alternatives?.some((item) => /甲订单|乙订单/.test(item.reason))).toBe(true)

    const missing = await highlightOnPage(page, {
      framePath: [],
      candidates: [{ by: 'testId', value: 'no-such' }],
    })
    expect(missing.outcome).toBe('NOT_FOUND')
  })

  it('点击打开新页：未声明 pageAfter 时输出 popupOpened，显式 same 时不标记', async ({ skip }) => {
    if (!hasBrowser) skip()
    const page = await open('/popup.html')
    const undeclared = await executeOnPage(page, { type: 'click', target: button('打开子窗') })
    expect(undeclared.ok).toBe(true)
    expect(undeclared.ok && undeclared.output).toMatchObject({ popupOpened: true })
    await page.context().pages().at(-1)!.close()

    const declared = await executeOnPage(page, { type: 'click', target: button('打开子窗'), pageAfter: 'same' })
    expect(declared.ok).toBe(true)
    expect(declared.ok && declared.output).toEqual({})
    await page.context().pages().at(-1)!.close()
  })
})
