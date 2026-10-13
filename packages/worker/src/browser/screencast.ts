import type { CDPSession, Page } from 'playwright'
import {
  BROWSER_FRAME_MAX_EDGE,
  BROWSER_FRAME_MAX_FPS,
  BROWSER_FRAME_QUALITY,
  DEFAULT_MANAGED_VIEWPORT,
  type ManagedBrowserFrame,
  type PageRef,
} from '@cairn/shared'
import type { CapturedFrame } from './captured-frame.js'

export type ScreencastHandle = {
  latest: ManagedBrowserFrame | null
  captureEpoch: number
  stop: () => Promise<void>
  subscribe: (listener: (frame: ManagedBrowserFrame) => void) => () => void
  subscribeCaptured: (listener: (frame: CapturedFrame) => void) => () => void
}

let nextCaptureEpoch = 1

/**
 * 帧派发的最小间隔：取消费端（SSE 推送、录像写帧）间隔的一半，消费端总能拿到够新的帧。
 * 限速落在派发端而不是 ack：推迟 ack 虽能把限速压到 Chromium 产帧侧，但会让
 * `Page.screencastFrameAck` 的响应跨越 CDP 会话 detach 仍在途，而 Playwright 在 `_markAsCrashed`
 * 后只清空回调、不摘除会话，迟到的响应会撞上 `assert(!object.id)` 把整个 Worker 进程打崩
 * （浏览器崩溃本该只损失该会话，不该带走执行面）。CDP 的 `framesPerSecond` 在此 Chromium
 * 构建上不生效，故用派发端限速 + 尾帧补发：窗口内只留最新一帧，窗口结束补发，
 * 页面停止重绘后最后一次变化照样送达，不会像直接丢帧那样停在旧画面。
 */
export const SCREENCAST_MIN_FRAME_INTERVAL_MS = Math.max(100, Math.floor(1000 / (BROWSER_FRAME_MAX_FPS * 2)))

function emitLive(
  state: ScreencastHandle & { liveListeners: Set<(frame: ManagedBrowserFrame) => void> },
  frame: ManagedBrowserFrame,
) {
  state.latest = frame
  for (const listener of state.liveListeners) listener(frame)
}

function emitCaptured(
  capturedListeners: Set<(frame: CapturedFrame) => void>,
  frame: CapturedFrame,
) {
  for (const listener of capturedListeners) listener(frame)
}

/** CDP 投屏在静止登录页上可能十几秒不推新帧；过期后鼠标会被拒。用截图补新鲜度。 */
export async function refreshScreencastIfStale(
  page: Page,
  state: ScreencastHandle,
  pageRef: PageRef | (() => PageRef),
  staleMs = 1000,
): Promise<void> {
  const currentRef = typeof pageRef === 'function' ? pageRef() : pageRef
  const age = state.latest ? Date.now() - Date.parse(state.latest.capturedAt) : Number.POSITIVE_INFINITY
  const epochMatches =
    state.latest?.pageRef.documentEpoch === currentRef.documentEpoch &&
    state.latest?.pageRef.sessionGeneration === currentRef.sessionGeneration &&
    state.latest?.pageRef.pageId === currentRef.pageId
  if (Number.isFinite(age) && age <= staleMs && epochMatches) return
  if (page.isClosed()) return
  try {
    const buffer = await page.screenshot({ type: 'jpeg', quality: BROWSER_FRAME_QUALITY })
    const viewport = page.viewportSize() ?? DEFAULT_MANAGED_VIEWPORT
    const frame: ManagedBrowserFrame = {
      pageRef: currentRef,
      frameId: `s-${Date.now().toString(36)}`,
      width: viewport.width,
      height: viewport.height,
      capturedAt: new Date().toISOString(),
      image: `data:image/jpeg;base64,${buffer.toString('base64')}`,
    }
    const liveListeners =
      'liveListeners' in state
        ? (state as typeof state & { liveListeners: Set<(frame: ManagedBrowserFrame) => void> }).liveListeners
        : undefined
    state.latest = frame
    if (liveListeners) {
      for (const listener of liveListeners) listener(frame)
    }
  } catch {
    return
  }
}

export async function startScreencast(page: Page, pageRef: PageRef | (() => PageRef)): Promise<ScreencastHandle> {
  const getPageRef = typeof pageRef === 'function' ? pageRef : () => pageRef
  const cdp: CDPSession = await page.context().newCDPSession(page)
  const liveListeners = new Set<(frame: ManagedBrowserFrame) => void>()
  const capturedListeners = new Set<(frame: CapturedFrame) => void>()
  const captureEpoch = nextCaptureEpoch
  nextCaptureEpoch += 1
  let sourceSeq = 0
  const state: ScreencastHandle & {
    liveListeners: typeof liveListeners
    capturedListeners: typeof capturedListeners
  } = {
    latest: null,
    captureEpoch,
    liveListeners,
    capturedListeners,
    subscribe: (listener) => {
      liveListeners.add(listener)
      return () => liveListeners.delete(listener)
    },
    subscribeCaptured: (listener) => {
      capturedListeners.add(listener)
      return () => capturedListeners.delete(listener)
    },
    stop: async () => undefined,
  }
  let stopped = false
  // 立即 ack：不留下跨会话生命周期的在途命令，浏览器崩溃时 Worker 不再被 Playwright 的断言带走。
  // 产帧限速落在派发端：CDP `Page.startScreencast` 的 `framesPerSecond` 在此 Chromium 构建上不生效
  // （实测持续重绘 2500ms 仍出 117 帧），推迟 ack 又会让命令在途跨越会话 teardown，故两者都不用。
  let lastDispatchMono = 0
  // 限速窗口内只扣住最新一帧，窗口结束补发：页面停止重绘后最后一次变化照样送达，不会停在旧画面。
  let pending: { captured: CapturedFrame; frame: ManagedBrowserFrame } | null = null
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  const dispatch = (item: { captured: CapturedFrame; frame: ManagedBrowserFrame }) => {
    lastDispatchMono = performance.now()
    emitCaptured(capturedListeners, item.captured)
    emitLive(state, item.frame)
  }

  const scheduleFlush = () => {
    if (flushTimer || stopped) return
    const wait = Math.max(0, SCREENCAST_MIN_FRAME_INTERVAL_MS - (performance.now() - lastDispatchMono))
    flushTimer = setTimeout(() => {
      flushTimer = null
      if (stopped || !pending) return
      const item = pending
      pending = null
      dispatch(item)
    }, wait)
  }

  const onFrame = (event: {
    data: string
    sessionId: number
    metadata?: { deviceWidth?: number; deviceHeight?: number; timestamp?: number }
  }) => {
    if (stopped) return
    void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => undefined)
    sourceSeq += 1
    let jpeg: Buffer
    try {
      jpeg = Buffer.from(event.data, 'base64')
    } catch {
      return
    }
    const currentRef = getPageRef()
    const width = event.metadata?.deviceWidth ?? BROWSER_FRAME_MAX_EDGE
    const height = event.metadata?.deviceHeight ?? BROWSER_FRAME_MAX_EDGE
    const sourceTimestampMs =
      event.metadata?.timestamp != null && Number.isFinite(event.metadata.timestamp)
        ? event.metadata.timestamp * 1000
        : undefined
    const captured: CapturedFrame = {
      pageId: currentRef.pageId,
      captureEpoch,
      sourceSeq,
      origin: 'cdp',
      ...(sourceTimestampMs != null ? { sourceTimestampMs } : {}),
      receivedMonoMs: performance.now(),
      jpeg,
      width,
      height,
    }
    const frame: ManagedBrowserFrame = {
      pageRef: currentRef,
      frameId: `f-${captureEpoch}-${sourceSeq}`,
      width,
      height,
      capturedAt: new Date().toISOString(),
      image: `data:image/jpeg;base64,${event.data}`,
    }
    // 最新画面立刻落到 state.latest，供 refreshScreencastIfStale 判新鲜度；派发本身按间隔限速。
    state.latest = frame
    const item = { captured, frame }
    if (performance.now() - lastDispatchMono >= SCREENCAST_MIN_FRAME_INTERVAL_MS) {
      dispatch(item)
    } else {
      pending = item
      scheduleFlush()
    }
  }
  cdp.on('Page.screencastFrame', onFrame)
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: BROWSER_FRAME_QUALITY,
    maxWidth: BROWSER_FRAME_MAX_EDGE,
    maxHeight: BROWSER_FRAME_MAX_EDGE,
  })
  state.stop = async () => {
    stopped = true
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = null
    pending = null
    cdp.off('Page.screencastFrame', onFrame)
    liveListeners.clear()
    capturedListeners.clear()
    await cdp.send('Page.stopScreencast').catch(() => undefined)
    await cdp.detach().catch(() => undefined)
  }
  return state
}
