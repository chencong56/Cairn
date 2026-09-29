import { describe, it, expect } from 'vitest'
import { chromium } from 'playwright'
import { detectChallenge, solveChallenge } from '../index.js'

/**
 * 依赖外部真实站点（demo.gin-vue-admin.com / www.vben.pro）与在线 OCR 识别准确率。
 * 宿主不可达时自行跳过；宿主可达但识别失败时仍会断言失败——这是外部页面内容与
 * OCR 模型的固有不确定性，不代表本仓库代码回归。
 *
 * 2026-09-29 复查：从 test:browser 默认必过路径中移出（原因见
 * docs/spec/2026-09-28-test-pipeline-acceleration-and-clean-baseline.md 附录）。
 * 不纳入 pnpm test / CI 的默认门禁，仅供 `pnpm test:live` 手动巡检。
 */
describe('Captcha Live Target Integration (AC-01 / AC-02，外部站点，非必过)', () => {
  it('Gin-Vue-Admin live target: extracts, recognizes OCR and fills captcha input', async () => {
    let isReachable = false
    try {
      const res = await fetch('https://demo.gin-vue-admin.com/#/login', { signal: AbortSignal.timeout(4000) })
      isReachable = res.ok
    } catch {
      isReachable = false
    }

    if (!isReachable) {
      console.warn('Gin-Vue-Admin demo host unreachable, skipping live network test')
      return
    }

    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.goto('https://demo.gin-vue-admin.com/#/login', {
        waitUntil: 'networkidle',
        timeout: 15_000,
      })

      const challenge = await detectChallenge(page, null)
      expect(challenge).not.toBeNull()
      expect(challenge?.type).toBe('IMAGE_CAPTCHA')
      expect(challenge?.source).toBe('FINGERPRINT:gin-vue-admin-image')

      const outcome = await solveChallenge(page, challenge!, { timeoutMs: 15_000 })
      expect(outcome.solved).toBe(true)
      expect(outcome.handledBy).toBe('MACHINE')
      expect(outcome.durationMs).toBeGreaterThan(0)

      // Verify input value was populated
      const inputValue = await challenge!.locators.input!.inputValue()
      expect(inputValue.length).toBeGreaterThan(0)
    } finally {
      await browser.close()
    }
  }, 30_000)

  it('Gin-Vue-Admin full login flow (AC-01): fills credentials, solves captcha and submits form', async () => {
    let isReachable = false
    try {
      const res = await fetch('https://demo.gin-vue-admin.com/#/login', { signal: AbortSignal.timeout(4000) })
      isReachable = res.ok
    } catch {
      isReachable = false
    }

    if (!isReachable) {
      console.warn('Gin-Vue-Admin demo host unreachable, skipping live network test')
      return
    }

    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.goto('https://demo.gin-vue-admin.com/#/login', {
        waitUntil: 'networkidle',
        timeout: 15_000,
      })

      await page.locator('input[placeholder*="用户名"]').fill('admin')
      await page.locator('input[placeholder*="密码"]').fill('123456')

      const challenge = await detectChallenge(page, null)
      expect(challenge).not.toBeNull()
      const outcome = await solveChallenge(page, challenge!, { timeoutMs: 15_000 })
      expect(outcome.solved).toBe(true)

      await page.locator('button:has-text("登 录")').click()
      const leftLogin = await page
        .waitForFunction(
          `(() => {
            const hashPath = (location.hash.replace(/^#/, '').split('?')[0] || '').trim()
            const path = (hashPath.startsWith('/') ? hashPath : location.pathname).replace(/\\/+$/, '') || '/'
            return path !== '/login'
          })()`,
          undefined,
          { timeout: 8_000 },
        )
        .then(() => true)
        .catch(() => false)

      expect(leftLogin || page.url().includes('/#/layout') || !page.url().includes('/login')).toBe(true)
    } finally {
      await browser.close()
    }
  }, 30_000)

  it('Vben Admin live target: detects slider and performs a human-like drag', async () => {
    let isReachable = false
    try {
      const res = await fetch('https://www.vben.pro/', { signal: AbortSignal.timeout(4000) })
      isReachable = res.ok
    } catch {
      isReachable = false
    }

    if (!isReachable) {
      console.warn('Vben Admin demo host unreachable, skipping live network test')
      return
    }

    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.goto('https://www.vben.pro/#/auth/login', {
        waitUntil: 'networkidle',
        timeout: 20_000,
      })
      await page.locator('input[type="password"], input[placeholder*="密码"]').first().waitFor({
        state: 'visible',
        timeout: 10_000,
      }).catch(() => undefined)

      const challenge = await detectChallenge(page, null)
      if (!challenge || challenge.type !== 'SLIDER_CAPTCHA') {
        console.warn('Vben slider widget not visible, skipping live drag assertion')
        return
      }

      const outcome = await solveChallenge(page, challenge, {
        timeoutMs: 15_000,
        minDurationMs: 800,
        maxDurationMs: 1500,
      })
      expect(outcome.challengeType).toBe('SLIDER_CAPTCHA')
      expect(outcome.handledBy).toBe('MACHINE')
      expect(outcome.durationMs).toBeGreaterThan(0)
    } finally {
      await browser.close()
    }
  }, 40_000)
})
