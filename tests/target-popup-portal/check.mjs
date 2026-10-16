import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPortalServer } from './server.mjs'

/** 自检：登录与跳转链路，以及四种开页方式在真浏览器里各开出一张子系统页。 */
const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..')
const { chromium } = createRequire(resolve(root, 'packages/worker/package.json'))('playwright')

const server = createPortalServer()
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const origin = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ headless: true })

try {
  const denied = await fetch(`${origin}/eip/index`, { redirect: 'manual' })
  assert.equal(denied.status, 302)
  assert.equal(denied.headers.get('location'), '/login')

  const context = await browser.newContext()
  const portal = await context.newPage()
  await portal.goto(`${origin}/login`)
  await portal.fill('#username', 'demo')
  await portal.fill('#password', 'demo123')
  await portal.click('#login-submit')
  await portal.waitForURL(`${origin}/eip/index`)

  for (const [selector, app] of [
    ['#quick-mail', '工作邮箱'],
    ['#quick-doc', '公文起草'],
    ['#quick-bi', '数据展示'],
  ]) {
    const [opened] = await Promise.all([context.waitForEvent('page'), portal.click(selector)])
    await opened.waitForSelector('#app-title')
    assert.equal(await opened.textContent('#app-title'), app)
    assert.equal(portal.url(), `${origin}/eip/index`, '门户页不应自己跳走')
  }

  // 中转弹窗：先开中转页，中转页再开子系统并关闭自己。
  const relayed = context.waitForEvent('page', { predicate: (page) => page.url().includes('/apps/itsm/') })
  const [relay] = await Promise.all([context.waitForEvent('page'), portal.click('#quick-itsm')])
  const itsm = await relayed
  if (!relay.isClosed()) await relay.waitForEvent('close')
  await itsm.waitForSelector('#app-title')
  assert.equal(await itsm.textContent('#app-title'), 'IT工单')

  // 对照：同页跳转不开新页。
  const before = context.pages().length
  await portal.click('#nav-news')
  await portal.waitForURL(`${origin}/eip/news`)
  assert.equal(context.pages().length, before)
  console.log('target-popup-portal 自检通过')
} finally {
  await browser.close()
  server.close()
}
