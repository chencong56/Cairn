import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Chromium 可用性探针（带跨文件磁盘缓存）。
 *
 * 浏览器组多个 spec 的 beforeAll 需要预先判断"本机能否启动 Chromium"来决定
 * skip 还是继续。原先每个文件各自试启动一个一次性 Chromium 再关闭，串行执行下
 * 整段要白付十几次浏览器启动。这里探测成功后写 tmp 缓存，同轮后续文件直接复用。
 *
 * 信号纪律（docs/spec/2026-09-29 worker 浏览器段治理方案 P2）：
 * - 只缓存「可用」结论；探测失败不写缓存，下一个文件重试，避免瞬时抖动被固化为 skip。
 * - 缓存过期最坏导致「误以为可用」→ 后续真实会话启动失败会响亮红，不会静默跳过。
 * - 判定不可用时打印醒目警告：跳过不等于通过。
 */
const CACHE_FILE = join(tmpdir(), 'cairn-chromium-probe.json')
const CACHE_TTL_MS = 15 * 60_000

function readCachedAvailable(): boolean | undefined {
  try {
    const info = statSync(CACHE_FILE)
    if (Date.now() - info.mtimeMs >= CACHE_TTL_MS) return undefined
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8')).available === true
  } catch {
    return undefined
  }
}

function writeCachedAvailable(): void {
  try {
    writeFileSync(CACHE_FILE, JSON.stringify({ available: true, at: Date.now() }))
  } catch {
    // 缓存写失败只是退化为逐文件探测，不影响判定
  }
}

async function probeOnce(): Promise<boolean> {
  try {
    const { chromium } = await import('playwright')
    const browser = await Promise.race([
      chromium.launch({ headless: true }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('launch timeout')), 8_000)),
    ])
    await browser.close()
    return true
  } catch {
    return false
  }
}

export async function isChromiumAvailableCached(): Promise<boolean> {
  const cached = readCachedAvailable()
  if (cached === true) return true
  const available = await probeOnce()
  if (available) {
    writeCachedAvailable()
  } else {
    console.warn(
      '[chromium 不可用] 本文件用例将 skip —— 跳过不等于通过。' +
        '请检查 Playwright 浏览器安装：pnpm --filter @cairn/worker browser:install',
    )
  }
  return available
}
