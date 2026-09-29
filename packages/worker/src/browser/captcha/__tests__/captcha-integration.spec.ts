import { describe, it, expect } from 'vitest'
import { chromium } from 'playwright'
import { solveChallenge } from '../index.js'

/**
 * 本文件只保留本地可控、确定性的验证码交互测试。
 * 依赖外部真实站点与在线 OCR 识别准确率的用例见 captcha-live-target.spec.ts，
 * 不纳入 test:browser 默认必过路径（2026-09-29 复查确认其偶发失败非本仓库代码回归）。
 */
describe('Captcha Slider Interaction (Deterministic)', () => {
  it('Track slider interaction: smoothly drags knob to target with Bézier mouse trajectory', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.setContent(`
        <html>
          <head>
            <style>
              #track { width: 400px; height: 40px; background: #eee; position: relative; }
              #knob { width: 40px; height: 40px; background: #007bff; position: absolute; left: 0; top: 0; cursor: move; }
            </style>
          </head>
          <body>
            <div id="track">
              <div id="knob" class="cursor-move"></div>
            </div>
            <script>
              const knob = document.getElementById('knob');
              let isDragging = false;
              let startX = 0;
              let startLeft = 0;
              knob.addEventListener('mousedown', (e) => {
                isDragging = true;
                startX = e.clientX;
                startLeft = parseInt(knob.style.left || '0', 10);
              });
              window.addEventListener('mousemove', (e) => {
                if (!isDragging) return;
                const deltaX = e.clientX - startX;
                knob.style.left = Math.max(0, Math.min(360, startLeft + deltaX)) + 'px';
              });
              window.addEventListener('mouseup', () => {
                isDragging = false;
              });
            </script>
          </body>
        </html>
      `)

      const knob = page.locator('#knob')
      const track = page.locator('#track')

      const outcome = await solveChallenge(
        page,
        {
          type: 'SLIDER_CAPTCHA',
          source: 'TEST',
          confidence: 1.0,
          locators: {
            knob,
            containerOrBg: track,
          },
        },
        { minDurationMs: 400, maxDurationMs: 800 },
      )

      expect(outcome.solved).toBe(true)
      expect(outcome.challengeType).toBe('SLIDER_CAPTCHA')

      // Check that knob position moved towards the right end (>= 350px)
      const finalLeft = await knob.evaluate((el) => parseInt(el.style.left || '0', 10))
      expect(finalLeft).toBeGreaterThanOrEqual(350)
    } finally {
      await browser.close()
    }
  }, 15_000)
})
