import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { seedPortal } from './seed.mjs'

/**
 * 对本机运行中的识途做端到端核对：开会话 → 取手动操作权 → 在受管画面点门户菜单 →
 * 新标签页登记并成为会话当前页 → 指认作用于所看的页 → 跨标签试跑 → 会话画面停在子系统页。
 * 需要本机 API / Worker 与 node server.mjs 已启动；会真实开会话并发起一次试跑。
 */
const lab = process.env.PORTAL_ORIGIN ?? 'http://127.0.0.1:4183'
const seeded = await seedPortal()
const api = `${seeded.api}/api`
const { token, targetId, accountId, scenarioId } = seeded
const fail = (message) => {
  console.error(`✗ ${message}`)
  process.exitCode = 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function req(path, method = 'GET', body) {
  const res = await fetch(`${api}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text(); let data; try { data = JSON.parse(text) } catch { data = text }
  if (!res.ok) { const e = new Error(`${method} ${path} ${res.status} ${JSON.stringify(data)}`); e.data = data; throw e }
  return data
}
async function firstFrame(sessionId, pageId) {
  const ctl = new AbortController()
  const res = await fetch(`${api}/browser-sessions/${sessionId}/browser/frames${pageId ? `?pageId=${pageId}` : ''}`, { headers: { authorization: `Bearer ${token}`, Accept: 'text/event-stream' }, signal: ctl.signal })
  const reader = res.body.getReader(); let buf = ''
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const { value, done } = await reader.read(); if (done) break
    buf += new TextDecoder().decode(value)
    const m = /event: (\w+)\ndata: (.*)\n\n/.exec(buf)
    if (m) { ctl.abort(); return { event: m[1], data: JSON.parse(m[2]) } }
  }
  ctl.abort(); throw new Error('no frame')
}
const step = (msg, extra) => console.log(`\n== ${msg}`, extra ? JSON.stringify(extra, null, 0).slice(0, 600) : '')

// 1. 打开会话
const base = `/targets/${targetId}/accounts/${accountId}/session`
let detail = await req(base)
let sessionId = detail.session?.status === 'OPEN' ? detail.session.id : undefined
if (!sessionId) {
  await req(`${base}/operations`, 'POST', { kind: 'PREPARE', idempotencyKey: `e2e-${randomUUID()}`, originContext: 'INTERACTIVE' })
  for (let i = 0; i < 60 && !sessionId; i++) {
    await sleep(2000); detail = await req(base)
    if (detail.session?.status === 'OPEN' && detail.session?.authState === 'AUTHENTICATED') sessionId = detail.session.id
  }
}
if (!sessionId) throw new Error(`会话未就绪 ${JSON.stringify(detail).slice(0, 400)}`)
let meta = await req(`/browser-sessions/${sessionId}/browser`)
step('会话就绪', { sessionId, current: meta.currentPage?.url, pages: meta.pages.map((p) => [p.kind, p.url]) })

// 2. 取得手动操作权，拿当前帧
const granted = await req(`/browser-sessions/${sessionId}/auth-control/acquire`, 'POST', {})
const frame1 = await firstFrame(sessionId)
step('取得操作权与首帧', { pagesRevision: frame1.data.pagesRevision, viewport: [frame1.data.width, frame1.data.height] })

// 3. 用同视口的本地浏览器量出「工作邮箱」按钮坐标
const { chromium } = createRequire(new URL('../../packages/worker/package.json', import.meta.url))('playwright')
const browser = await chromium.launch()
const probe = await browser.newPage({ viewport: { width: frame1.data.width, height: frame1.data.height } })
await probe.goto(`${lab}/login`); await probe.fill('#username', 'demo'); await probe.fill('#password', 'demo123'); await probe.click('#login-submit'); await probe.waitForURL('**/eip/index')
const mailBox = await probe.locator('#quick-mail').boundingBox()
await probe.goto(`${lab}/apps/mail/`)
const submitBox = await probe.locator('#submit-apply').boundingBox()
await browser.close()

let seq = 0
const input = (command, f) => req(`/browser-sessions/${sessionId}/auth-control/input`, 'POST', { token: granted.token, command: { ...command, pageRef: f.pageRef, commandId: randomUUID(), seq: ++seq, frameId: f.frameId, viewport: { width: f.width, height: f.height } } })
await input({ type: 'mouse_click', x: Math.round(mailBox.x + mailBox.width / 2), y: Math.round(mailBox.y + mailBox.height / 2), button: 'left' }, frame1.data)
step('已在受管画面点击「工作邮箱」')

// 4. 新页应出现在页列表并成为会话当前页；帧序号变化
let popup
for (let i = 0; i < 20 && !popup; i++) {
  await sleep(500); meta = await req(`/browser-sessions/${sessionId}/browser`)
  popup = meta.pages.find((p) => p.kind === 'popup' && (p.url ?? '').includes('/apps/mail/'))
}
step('点击后页列表', { current: meta.currentPage?.url, pages: meta.pages.map((p) => [p.kind, p.url, p.currentExecution, p.canClose]) })
if (!popup?.currentExecution) throw new Error('新页未成为会话当前页')
const frame2 = await firstFrame(sessionId)
step('当前帧已切到新页', { pageId: frame2.data.pageRef.pageId === popup.pageRef.pageId, pagesRevision: frame2.data.pagesRevision })

// 5. 指认作用于所看的页
await req(`/browser-sessions/${sessionId}/observe`, 'POST', { op: 'highlight', pageId: popup.pageRef.pageId })
const picked = await req(`/browser-sessions/${sessionId}/observe`, 'POST', { op: 'pick', pageId: popup.pageRef.pageId, x: Math.round(submitBox.x + submitBox.width / 2), y: Math.round(submitBox.y + submitBox.height / 2) })
step('在新页上拾取「提交申请」', { outcome: picked.outcome, page: picked.page?.url, candidates: picked.target?.candidates?.slice(0, 3) })
const basePage = meta.pages.find((p) => p.kind !== 'popup')
const onBase = await req(`/browser-sessions/${sessionId}/observe`, 'POST', { op: 'highlight', pageId: basePage.pageRef.pageId })
step('切回门户页指认作用于门户页', { page: onBase.page?.url })
if (picked.outcome !== 'FOUND' || !picked.page?.url?.includes('/apps/mail/')) fail('新页上的拾取没有作用于新页')
if (!onBase.page?.url?.includes('/eip/index')) fail('指定门户页的指认没有作用于门户页')
try { await req(`/browser-sessions/${sessionId}/observe`, 'POST', { op: 'highlight', pageId: randomUUID() }); fail('未知页未被拒绝') } catch (e) { step('未知页被拒绝', { code: e.data?.code }) }

// 6. 在新页上手动输入
await input({ type: 'mouse_click', x: Math.round(submitBox.x + submitBox.width / 2), y: Math.round(submitBox.y + submitBox.height / 2), button: 'left' }, frame2.data)
step('在新页上手动点击「提交申请」已落地')
await req(`/browser-sessions/${sessionId}/auth-control/release`, 'POST', { token: granted.token })

// 7. 试跑：跨标签场景
const run = await req('/runs', 'POST', { scenarioId })
let finished
for (let i = 0; i < 60 && !finished; i++) {
  await sleep(2000); const r = await req(`/runs/${run.id}`)
  if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'NEEDS_REVIEW'].includes(r.status)) finished = r
}
step('试跑结束', { status: finished?.status })
await sleep(1500)
meta = await req(`/browser-sessions/${sessionId}/browser`)
step('试跑后会话画面', { current: meta.currentPage?.url, pages: meta.pages.map((p) => [p.kind, p.url, p.currentExecution]) })
if (finished?.status !== 'SUCCEEDED') fail(`跨标签试跑未成功：${finished?.status ?? '超时'}`)
if (!meta.currentPage?.url?.includes('/apps/mail/')) fail('试跑结束后会话画面没有停在执行实际结束的子系统页')
console.log(JSON.stringify({ sessionId, runId: run.id }))
if (!process.exitCode) console.log('target-popup-portal 本机端到端核对通过')
