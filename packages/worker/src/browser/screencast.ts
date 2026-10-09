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
 * Chromium 侧产帧的最小间隔：取消费端（SSE 推送、录像写帧）间隔的一半，消费端总能拿到够新的帧。
 * 靠推迟 ack 实现：未 ack 前 Chromium 不会编码下一帧，所以限速落在产帧端；
 * 页面停止重绘后，最后一次变化也会在 ack 后送达，不会像丢帧那样停在旧画面。
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
  // Chromium 允许多帧在途：ack 时刻必须串行排队，否则几帧会在同一时刻一起 ack，限速被抵消。
  let nextAckAt = 0
  const ackTimers = new Set<ReturnType<typeof setTimeout>>()
  const ackLater = (cdpSessionId: number) => {
    const now = Date.now()
    const at = Math.max(now, nextAckAt)
    nextAckAt = at + SCREENCAST_MIN_FRAME_INTERVAL_MS
    const send = () => {
      if (stopped) return
      void cdp.send('Page.screencastFrameAck', { sessionId: cdpSessionId }).catch(() => undefined)
    }
    if (at <= now) {
      send()
      return
    }
    const timer = setTimeout(() => {
      ackTimers.delete(timer)
      send()
    }, at - now)
    ackTimers.add(timer)
  }
  const onFrame = (event: {
    data: string
    sessionId: number
    metadata?: { deviceWidth?: number; deviceHeight?: number; timestamp?: number }
  }) => {
    if (stopped) return
    ackLater(event.sessionId)
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
    emitCaptured(capturedListeners, captured)
    emitLive(state, {
      pageRef: currentRef,
      frameId: `f-${captureEpoch}-${sourceSeq}`,
      width,
      height,
      capturedAt: new Date().toISOString(),
      image: `data:image/jpeg;base64,${event.data}`,
    })
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
    for (const timer of ackTimers) clearTimeout(timer)
    ackTimers.clear()
    cdp.off('Page.screencastFrame', onFrame)
    liveListeners.clear()
    capturedListeners.clear()
    await cdp.send('Page.stopScreencast').catch(() => undefined)
    await cdp.detach().catch(() => undefined)
  }
  return state
}
