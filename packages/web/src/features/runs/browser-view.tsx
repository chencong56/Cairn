import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { newUuid } from '@/lib/uuid'
import {
  AUTH_CONTROL_HEARTBEAT_SECONDS,
  AUTH_CONTROL_IDLE_SECONDS,
  describeManagedAuthWait,
  hasAllPermissions,
  managedPageBadge,
  managedPageCaption,
  type BrowserAuthInputCommand,
  type ManagedBrowserFrame,
  type ManagedBrowserMeta,
  type PageRef,
} from '@cairn/shared'
import { toast } from 'sonner'
import { useAuthStore } from '@/stores/auth-store'
import { useNow } from '@/hooks/use-now'
import { ApiRequestError } from '@/lib/api-client'
import {
  acquireAuthControl as runAcquireAuthControl,
  closeManagedPage as runCloseManagedPage,
  fetchManagedBrowser as runFetchManagedBrowser,
  heartbeatAuthControl as runHeartbeatAuthControl,
  inputAuthControl as runInputAuthControl,
  releaseAuthControl as runReleaseAuthControl,
  resumeRunAuth as runResumeRunAuth,
  subscribeBrowserFrames as runSubscribeBrowserFrames,
} from '@/lib/runs-api'
import { Globe, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/status-badge'
import { useAuthoringObserve } from '@/features/authoring'
import { cn } from '@/lib/utils'

import { useResetOnChange } from '@/hooks/use-reset-on-change'
const LIVE_VIEW_STATUSES = new Set([
  'QUEUED',
  'RUNNING',
  'RECOVERING',
  'WAITING_FOR_AUTH',
  'HOLDING',
])

function isLiveViewRun(status: string) {
  return LIVE_VIEW_STATUSES.has(status)
}

function viewPlaceholder(input: {
  runStatus: string
  waiting: boolean
  controlling: boolean
  framesAvailable: boolean
  degradedReason: ManagedBrowserMeta['degradedReason']
  streamError: string | null
  connecting: boolean
}) {
  if (input.streamError) return input.streamError
  if (!isLiveViewRun(input.runStatus))
    return '运行已结束，实时画面已关闭。本次录像与步骤截图在结果里。'
  if (input.waiting && !input.controlling && !input.framesAvailable)
    return '认证画面仅对有操作权限的用户开放，避免把验证码广播给其他观察者。'
  if (input.degradedReason === 'worker_generation_mismatch')
    return '执行面已更换，不能继续看这一轮画面。'
  if (input.degradedReason === 'worker_unreachable')
    return '执行面暂时不可达，仍显示会话所有权。'
  if (input.connecting) return '正在连接受管浏览器画面…'
  if (!input.framesAvailable)
    return '等待执行面就绪。会话建立后会自动开始抓取画面。'
  return '运行已结束，实时画面已关闭。本次录像与步骤截图在结果里。'
}

/** 展开后还没有帧时是加载中，不能写成「没有页面」。 */
export function isBrowserViewConnecting(input: {
  open: boolean
  hasFrame: boolean
  waitingWithoutControl: boolean
  degradedReason: ManagedBrowserMeta['degradedReason']
}) {
  return (
    input.open &&
    !input.hasFrame &&
    !input.waitingWithoutControl &&
    input.degradedReason !== 'worker_generation_mismatch'
  )
}

/** 画面是 object-contain，按整块按钮比例换算并夹紧在有效视口内。 */
function framePointFromClick(
  event: { currentTarget: HTMLElement; clientX: number; clientY: number },
  frame: { width: number; height: number }
): { x: number; y: number } {
  const rect = event.currentTarget.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0 || frame.width <= 0 || frame.height <= 0) {
    return { x: 0, y: 0 }
  }
  const scale = Math.min(rect.width / frame.width, rect.height / frame.height)
  if (scale <= 0 || !Number.isFinite(scale)) {
    return { x: 0, y: 0 }
  }
  const rawX =
    (event.clientX - rect.left - (rect.width - frame.width * scale) / 2) / scale
  const rawY =
    (event.clientY - rect.top - (rect.height - frame.height * scale) / 2) /
    scale
  return {
    x: Number.isFinite(rawX) ? Math.max(0, Math.min(frame.width, Math.round(rawX))) : 0,
    y: Number.isFinite(rawY) ? Math.max(0, Math.min(frame.height, Math.round(rawY))) : 0,
  }
}

export type BrowserTransport = {
  fetchManagedBrowser: typeof runFetchManagedBrowser
  acquireAuthControl: typeof runAcquireAuthControl
  heartbeatAuthControl: typeof runHeartbeatAuthControl
  inputAuthControl: typeof runInputAuthControl
  releaseAuthControl: typeof runReleaseAuthControl
  closeManagedPage?: typeof runCloseManagedPage
  resumeRunAuth: (id: string, body: { token?: string }) => Promise<unknown>
  subscribeBrowserFrames: typeof runSubscribeBrowserFrames
}
const runTransport: BrowserTransport = {
  fetchManagedBrowser: runFetchManagedBrowser,
  acquireAuthControl: runAcquireAuthControl,
  heartbeatAuthControl: runHeartbeatAuthControl,
  inputAuthControl: runInputAuthControl,
  releaseAuthControl: runReleaseAuthControl,
  closeManagedPage: runCloseManagedPage,
  resumeRunAuth: runResumeRunAuth,
  subscribeBrowserFrames: runSubscribeBrowserFrames,
}

type Props = {
  runId: string
  runStatus: string
  eventSeq?: number
  onRunChanged?: () => void
  transport?: BrowserTransport
  sessionMode?: boolean
  defaultOpen?: boolean
  observationConnected?: boolean
  onRefreshLogin?: (pageRef: PageRef) => Promise<unknown>
  onSettleLanding?: () => Promise<unknown>
  embedded?: boolean
  waitReason?: string | null
  /** 只读围观：不显示手动操作入口（例如实例被他人的运行占用）。 */
  readOnly?: boolean
}

export function BrowserView({
  runId,
  runStatus,
  eventSeq = 0,
  onRunChanged,
  transport = runTransport,
  sessionMode = false,
  defaultOpen = false,
  onRefreshLogin,
  onSettleLanding,
  embedded = false,
  waitReason = null,
  readOnly = false,
}: Props) {
  const {
    fetchManagedBrowser,
    acquireAuthControl,
    heartbeatAuthControl,
    inputAuthControl,
    releaseAuthControl,
    resumeRunAuth,
    subscribeBrowserFrames,
  } = transport
  const observe = useAuthoringObserve()
  const user = useAuthStore((state) => state.auth.user)
  const canView = Boolean(
    user &&
    hasAllPermissions(user.permissions, [
      sessionMode ? 'session:read' : 'run:read',
      'session:view',
    ])
  )
  const canControl = Boolean(
    !readOnly &&
    user &&
    hasAllPermissions(
      user.permissions,
      sessionMode ? ['session:control'] : ['session:control', 'run:execute']
    )
  )
  const [open, setOpen] = useState(defaultOpen)
  const [meta, setMeta] = useState<ManagedBrowserMeta | null>(null)
  const [frame, setFrame] = useState<ManagedBrowserFrame | null>(null)
  const [busy, setBusy] = useState(false)
  const [token, setToken] = useState<string | null>(null)
  const [pageRef, setPageRef] = useState<PageRef | null>(null)
  const [expiresAt, setExpiresAt] = useState<string | null>(null)
  const [viewPageId, setViewPageId] = useState<string | undefined>()
  const [streamError, setStreamError] = useState<string | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)
  const [acquireError, setAcquireError] = useState<{ code: string; message: string } | null>(null)
  const [closingPageId, setClosingPageId] = useState<string | null>(null)
  // 换运行／会话时所选页签作废，避免拿上一个对象的 pageId 去订阅画面。
  useResetOnChange(runId, () => setViewPageId(undefined))
  const knownPageIds = useRef<{ owner: string; ids: Set<string> } | null>(null)
  const seq = useRef(0)
  const composing = useRef(false)
  const tokenRef = useRef<string | null>(null)
  // 手动操作的最近一次输入时间：服务端空闲 10 分钟会收回，这里提前一分钟提醒。
  const lastActivityRef = useRef(0)
  const idleWarnedRef = useRef(false)
  const inputId = useId()
  const now = useNow(Boolean(expiresAt))
  // 回调与后续 effect 读最新 token；effect 按声明顺序执行，这里先同步。
  useEffect(() => {
    tokenRef.current = token
  })

  // 持有操作权时出现新标签页就切过去：编排会话里 Worker 已把它设为当前页，跟随即可；
  // 认证等待时执行页不变，只切查看。
  const acceptMeta = useCallback(
    (next: ManagedBrowserMeta) => {
      const known = knownPageIds.current
      knownPageIds.current = {
        owner: next.runId,
        ids: new Set(next.pages.map((page) => page.pageRef.pageId)),
      }
      setMeta(next)
      if (!known || known.owner !== next.runId || !tokenRef.current) return
      const added = next.pages.filter(
        (page) => page.kind === 'popup' && !known.ids.has(page.pageRef.pageId)
      )
      const newest = added[added.length - 1]
      if (!newest) return
      setViewPageId(
        sessionMode && newest.currentExecution ? undefined : newest.pageRef.pageId
      )
    },
    [sessionMode]
  )

  // 运行进入可实时观看的状态时自动展开画面（切换运行或状态变化时重新判断）。
  useResetOnChange(`${runId}:${runStatus}:${sessionMode}`, () => {
    if (!sessionMode && isLiveViewRun(runStatus)) setOpen(true)
    // 认证等待时用户最需要看画面排查原因，有控制资格者直接展开只读画面。
    if (sessionMode && runStatus === 'WAITING_FOR_AUTH' && canControl) setOpen(true)
  })

  useEffect(() => {
    if (!canView) return
    if (!open && (sessionMode || !isLiveViewRun(runStatus))) return
    let cancelled = false
    let timer = 0
    const load = () => {
      void fetchManagedBrowser(runId, viewPageId)
        .then((next) => {
          if (cancelled) return
          acceptMeta(next)
          const waitingAuthGate =
            next.runStatus === 'WAITING_FOR_AUTH' && !tokenRef.current
          const needRetry =
            open &&
            isLiveViewRun(runStatus) &&
            !next.framesAvailable &&
            next.degradedReason !== 'worker_generation_mismatch' &&
            !waitingAuthGate
          if (needRetry) timer = window.setTimeout(load, 800)
        })
        .catch((error) => {
          if (cancelled) return
          toast.error(
            error instanceof ApiRequestError
              ? error.message
              : '无法读取浏览器状态'
          )
          if (open && isLiveViewRun(runStatus))
            timer = window.setTimeout(load, 1600)
        })
    }
    load()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [
    open,
    canView,
    runId,
    runStatus,
    viewPageId,
    token,
    fetchManagedBrowser,
    sessionMode,
    acceptMeta,
  ])

  useEffect(() => {
    if (!canView || !open || !eventSeq) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      void fetchManagedBrowser(runId, viewPageId)
        .then((next) => {
          if (!cancelled) acceptMeta(next)
        })
        .catch(() => undefined)
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [eventSeq, open, canView, runId, viewPageId, fetchManagedBrowser, acceptMeta])

  useEffect(() => {
    return () => {
      const held = tokenRef.current
      if (held)
        void releaseAuthControl(runId, { token: held }).catch(() => undefined)
    }
  }, [runId, releaseAuthControl])

  const streamFailToastAt = useRef(0)

  // 等待认证时画面门禁由服务端判定（持有输入权或具备控制资格才有 framesAvailable）；
  // 不满足条件就不订阅，并清掉上一段画面与错误。
  const streamEnabled = open && canView && Boolean(meta?.framesAvailable)
  useResetOnChange(streamEnabled, (enabled) => {
    if (enabled) return
    setFrame(null)
    setStreamError(null)
  })

  useEffect(() => {
    if (!streamEnabled) return
    let cancelled = false
    let retryTimer = 0
    let metaTimer = 0
    let seenRevision: number | undefined
    let controller: AbortController | null = null
    const connect = () => {
      if (cancelled) return
      controller = new AbortController()
      setStreamError(null)
      void subscribeBrowserFrames(runId, {
        signal: controller.signal,
        pageId: viewPageId,
        onFrame: (next) => {
          setStreamError(null)
          setFrame(next)
          // 页列表变化（新标签页出现、关闭、当前页变化）随帧推送，序号变了才重取。
          if (next.pagesRevision === undefined || next.pagesRevision === seenRevision) return
          seenRevision = next.pagesRevision
          window.clearTimeout(metaTimer)
          metaTimer = window.setTimeout(() => {
            void fetchManagedBrowser(runId, viewPageId)
              .then((meta) => {
                if (!cancelled) acceptMeta(meta)
              })
              .catch(() => undefined)
          }, 150)
        },
        onPageStale: () => {
          if (cancelled) return
          toast.message('所看的页面已关闭，已回到当前页')
          setViewPageId(undefined)
        },
      })
        .then(() => {
          if (cancelled || controller?.signal.aborted) return
          if (!isLiveViewRun(runStatus)) return
          setStreamError('画面流已中断，正在重连…')
          retryTimer = window.setTimeout(connect, 800)
        })
        .catch((error) => {
          if (cancelled || controller?.signal.aborted) return
          const message =
            error instanceof ApiRequestError
              ? error.message
              : '无法订阅受管浏览器画面'
          setStreamError(message)
          const now = Date.now()
          if (now - streamFailToastAt.current > 8000) {
            streamFailToastAt.current = now
            toast.error(message)
          }
          if (isLiveViewRun(runStatus))
            retryTimer = window.setTimeout(connect, 1600)
        })
    }
    connect()
    return () => {
      cancelled = true
      controller?.abort()
      window.clearTimeout(retryTimer)
      window.clearTimeout(metaTimer)
    }
  }, [
    streamEnabled,
    open,
    canView,
    runId,
    runStatus,
    token,
    viewPageId,
    meta?.framesAvailable,
    meta?.authControl?.epoch,
    meta?.authControl?.heldByViewer,
    subscribeBrowserFrames,
    fetchManagedBrowser,
    acceptMeta,
  ])

  useEffect(() => {
    if (!token || !canControl || !sessionMode) return
    lastActivityRef.current = Date.now()
    idleWarnedRef.current = false
    let timer = 0
    const check = () => {
      const idleFor = Date.now() - lastActivityRef.current
      if (!idleWarnedRef.current && idleFor > (AUTH_CONTROL_IDLE_SECONDS - 60) * 1000) {
        idleWarnedRef.current = true
        toast.warning('1 分钟内无操作将自动退出手动操作')
      }
      timer = window.setTimeout(check, 15_000)
    }
    timer = window.setTimeout(check, 15_000)
    return () => window.clearTimeout(timer)
  }, [token, canControl, sessionMode])

  useEffect(() => {
    if (!token || !canControl) return
    let cancelled = false
    let timer = 0
    const beat = () => {
      if (cancelled || !token) return
      void Promise.resolve(heartbeatAuthControl(runId, { token }))
        .then((next) => {
          if (!cancelled && next) setExpiresAt(next.expiresAt)
        })
        .catch((error) => {
          if (!cancelled) {
            setToken(null)
            if (error instanceof ApiRequestError && error.payload.code === 'AUTH_CONTROL_IDLE') {
              toast.warning('长时间无操作，已退出手动操作')
              return
            }
            toast.error(
              sessionMode
                ? '手动操作权已失效：可能被运行或维护占用、长时间无操作，或实例已关闭'
                : '登录控制权已失效',
            )
          }
        })
        .finally(() => {
          if (!cancelled)
            timer = window.setTimeout(
              beat,
              AUTH_CONTROL_HEARTBEAT_SECONDS * 1000
            )
        })
    }
    timer = window.setTimeout(beat, AUTH_CONTROL_HEARTBEAT_SECONDS * 1000)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [token, canControl, runId, heartbeatAuthControl])

  useEffect(() => {
    const shouldRevoke =
      !canControl || !open || (!sessionMode && runStatus !== 'WAITING_FOR_AUTH')
    if (shouldRevoke) {
      const held = tokenRef.current
      tokenRef.current = null
      // 撤销控制权与释放服务端控制租约必须同一处完成，不拆成渲染期派生。
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setToken(null)
      if (held)
        void releaseAuthControl(runId, { token: held }).catch(() => undefined)
    }
  }, [canControl, open, runStatus, sessionMode, runId, releaseAuthControl])

  const pendingWheel = useRef<{
    x: number
    y: number
    deltaX: number
    deltaY: number
  } | null>(null)
  const wheelTimer = useRef<number | null>(null)
  const wheelInFlight = useRef(false)

  // 滚轮在途时要在稍后重放自己；经 ref 调用，避免在 useCallback 内引用尚未声明完成的自身。
  const flushWheelRef = useRef<() => void>(() => undefined)
  const flushWheel = useCallback(() => {
    if (!pendingWheel.current || wheelInFlight.current) return
    if (!token || !pageRef || !frame || !canControl) {
      pendingWheel.current = null
      return
    }
    const { x, y, deltaX, deltaY } = pendingWheel.current
    const clampedDeltaX = Math.max(-1000, Math.min(1000, Math.round(deltaX)))
    const clampedDeltaY = Math.max(-1000, Math.min(1000, Math.round(deltaY)))
    pendingWheel.current = null
    if (clampedDeltaX === 0 && clampedDeltaY === 0) return

    wheelInFlight.current = true
    seq.current += 1
    const command = {
      type: 'mouse_wheel' as const,
      x,
      y,
      deltaX: clampedDeltaX,
      deltaY: clampedDeltaY,
      pageRef: frame.pageRef,
      commandId: newUuid(),
      seq: seq.current,
      frameId: frame.frameId,
      viewport: { width: frame.width, height: frame.height },
    } as BrowserAuthInputCommand

    lastActivityRef.current = Date.now()
    idleWarnedRef.current = false
    void Promise.resolve(inputAuthControl(runId, { token, command }))
      .catch((error) => {
        if (
          error instanceof ApiRequestError &&
          (error.status === 401 ||
            error.status === 403 ||
            error.payload.code.startsWith('AUTH_'))
        ) {
          setToken(null)
        }
        if (error instanceof ApiRequestError && error.payload.code === 'PAGE_STALE') {
          void fetchManagedBrowser(runId, viewPageId)
            .then((next) => {
              if (next) acceptMeta(next)
            })
            .catch(() => undefined)
        }
        toast.error(
          error instanceof ApiRequestError ? error.message : '输入被拒绝'
        )
      })
      .finally(() => {
        wheelInFlight.current = false
        if (pendingWheel.current) {
          if (wheelTimer.current === null) {
            wheelTimer.current = window.setTimeout(() => {
              wheelTimer.current = null
              flushWheelRef.current()
            }, 40)
          }
        }
      })
  }, [token, pageRef, frame, canControl, runId, inputAuthControl, acceptMeta])
  useEffect(() => {
    flushWheelRef.current = flushWheel
  }, [flushWheel])

  const scheduleWheel = useCallback(
    (x: number, y: number, deltaX: number, deltaY: number) => {
      if (!pendingWheel.current) {
        pendingWheel.current = { x, y, deltaX, deltaY }
      } else {
        pendingWheel.current.x = x
        pendingWheel.current.y = y
        pendingWheel.current.deltaX += deltaX
        pendingWheel.current.deltaY += deltaY
      }
      if (wheelTimer.current === null && !wheelInFlight.current) {
        wheelTimer.current = window.setTimeout(() => {
          wheelTimer.current = null
          flushWheel()
        }, 40)
      }
    },
    [flushWheel]
  )

  useEffect(() => {
    return () => {
      if (wheelTimer.current !== null) {
        window.clearTimeout(wheelTimer.current)
        wheelTimer.current = null
      }
      pendingWheel.current = null
    }
  }, [])

  // 指认、高亮作用于正在查看的页；跟随当前页时不带 pageId。
  const viewedKind = meta?.pages.find(
    (page) => page.pageRef.pageId === (viewPageId ?? meta.currentPage?.pageRef.pageId)
  )?.kind
  const { setViewedPage } = observe
  useEffect(() => {
    setViewedPage({ pageId: viewPageId, kind: viewedKind })
  }, [setViewedPage, viewPageId, viewedKind])
  useEffect(() => () => setViewedPage(null), [setViewedPage])

  if (!canView) return null

  const waiting = runStatus === 'WAITING_FOR_AUTH'
  const holding = runStatus === 'HOLDING'
  // 调试挂起时步骤只在执行当前页上运行：看着别的页指认会写进对不上的定位。
  const pickBlockedOnOtherPage = !sessionMode && holding && Boolean(meta?.viewingOtherPage)
  const picking =
    observe.pickMode &&
    !pickBlockedOnOtherPage &&
    (holding || (sessionMode && observe.livePage))
  const highlightBox = observe.highlight?.preview?.box
  const tableMarkers = observe.tableMarkers
  const controlling = Boolean(token && canControl)
  // 他人持有该实例的手动操作权：按钮置灰并写明是谁，观看不受影响。
  const heldByOther = Boolean(
    sessionMode && meta?.authControl?.actorId && !meta.authControl.heldByViewer && !controlling,
  )
  const holderLabel = `${meta?.authControl?.actorName ?? '其他用户'} 正在手动操作`
  const connecting = isBrowserViewConnecting({
    open,
    hasFrame: Boolean(frame),
    waitingWithoutControl: waiting && !controlling && !meta?.framesAvailable,
    degradedReason: meta?.degradedReason ?? null,
  })
  const remain =
    expiresAt && Date.parse(expiresAt)
      ? Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000))
      : null

  type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
    ? Omit<T, K>
    : never
  type BrowserAuthInputPayload = DistributiveOmit<
    BrowserAuthInputCommand,
    'pageRef' | 'commandId' | 'seq' | 'frameId' | 'viewport'
  >

  const sendCommand = (partial: BrowserAuthInputPayload) => {
    if (!token || !pageRef || !frame || !canControl) return
    if (authError) setAuthError(null)
    seq.current += 1
    const command = {
      ...partial,
      pageRef: frame.pageRef,
      commandId: newUuid(),
      seq: seq.current,
      frameId: frame.frameId,
      viewport: { width: frame.width, height: frame.height },
    } as BrowserAuthInputCommand
    lastActivityRef.current = Date.now()
    idleWarnedRef.current = false
    void Promise.resolve(inputAuthControl(runId, { token, command })).catch((error) => {
      if (
        error instanceof ApiRequestError &&
        (error.status === 401 ||
          error.status === 403 ||
          error.payload.code.startsWith('AUTH_'))
      )
        setToken(null)
      if (error instanceof ApiRequestError && error.payload.code === 'PAGE_STALE') {
        void fetchManagedBrowser(runId, viewPageId)
          .then((next) => {
            if (next) acceptMeta(next)
          })
          .catch(() => undefined)
      }
      toast.error(
        error instanceof ApiRequestError ? error.message : '输入被拒绝'
      )
    })
  }

  const handleAcquire = () => {
    setAuthError(null)
    setAcquireError(null)
    setBusy(true)
    void acquireAuthControl(runId)
      .then((granted) => {
        setToken(granted.token)
        setPageRef(granted.pageRef)
        setExpiresAt(granted.expiresAt)
        acceptMeta(granted.meta)
        setOpen(true)
        toast.success(sessionMode ? '已取得手动操作权' : '已取得登录输入权')
      })
      .catch((error) => {
        const message =
          error instanceof ApiRequestError
            ? error.message
            : sessionMode
              ? '无法取得操作权'
              : '无法取得输入权'
        setAcquireError({
          code: error instanceof ApiRequestError ? error.payload.code : 'UNKNOWN',
          message,
        })
        toast.error(message)
      })
      .finally(() => setBusy(false))
  }

  const handleRelease = () => {
    if (wheelTimer.current !== null) {
      window.clearTimeout(wheelTimer.current)
      wheelTimer.current = null
    }
    pendingWheel.current = null
    if (!token) return
    setBusy(true)
    void releaseAuthControl(runId, { token })
      .then(() => {
        setToken(null)
        toast.success(sessionMode ? '已退出手动操作' : '已放弃控制')
        onRunChanged?.()
      })
      .catch((error) => {
        toast.error(
          error instanceof ApiRequestError ? error.message : '撤权失败'
        )
      })
      .finally(() => setBusy(false))
  }

  const handleClosePage = (targetPageId: string) => {
    if (closingPageId) return
    setClosingPageId(targetPageId)
    const closeFn = transport.closeManagedPage ?? runCloseManagedPage
    void closeFn(runId, targetPageId)
      .then(() => {
        toast.success('已关闭标签页')
        if (viewPageId === targetPageId) {
          setViewPageId(undefined)
        }
        return fetchManagedBrowser(runId, undefined)
      })
      .then((next) => {
        if (next) acceptMeta(next)
      })
      .catch((error) => {
        toast.error(
          error instanceof ApiRequestError ? error.message : '无法关闭标签页'
        )
      })
      .finally(() => {
        setClosingPageId(null)
      })
  }

  const activePage =
    meta?.pages.find(
      (p) =>
        (viewPageId ?? meta.currentPage?.pageRef.pageId) ===
        p.pageRef.pageId,
    ) ?? meta?.currentPage

  const activeCaption = activePage
    ? managedPageCaption(activePage)
    : meta?.currentPage
      ? managedPageCaption(meta.currentPage)
      : null

  const renderTabStrip = () => {
    if (!meta || meta.pages.length <= 1) return null

    return (
      <div
        role='tablist'
        aria-label='受管页面标签'
        className='flex items-stretch gap-1 overflow-x-auto no-scrollbar border-b border-border-divider/70 bg-muted/40 px-2 pt-1.5'
      >
        {meta.pages.map((page) => {
          const selected =
            (viewPageId ?? meta.currentPage?.pageRef.pageId) ===
            page.pageRef.pageId
          const duplicateCount = meta.pages.filter(
            (p) => managedPageCaption(p) === managedPageCaption(page),
          ).length
          const isClosing = closingPageId === page.pageRef.pageId
          const caption = managedPageCaption(page)
          const badge = managedPageBadge(page.kind)
          const fullUrl = page.url ?? caption

          return (
            <div
              key={page.pageRef.pageId}
              role='presentation'
              className={cn(
                'group relative flex min-w-[130px] max-w-[280px] flex-1 items-center rounded-t-md border-t-2 border-x transition-colors',
                selected
                  ? 'border-t-primary border-x-border-default/80 bg-card text-foreground shadow-xs z-10'
                  : 'border-t-transparent border-x-transparent bg-transparent text-muted-foreground hover:bg-card/60 hover:text-foreground',
              )}
            >
              <button
                type='button'
                title={fullUrl}
                className={cn(
                  'flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left text-small outline-none cursor-pointer',
                  page.canClose && canControl ? 'pl-2.5 pr-1' : 'px-2.5',
                )}
                onClick={() => setViewPageId(page.pageRef.pageId)}
              >
                {duplicateCount > 1 || page.kind === 'popup' ? (
                  <span className='shrink-0 text-caption font-medium text-muted-foreground mr-0.5'>
                    [{badge}]
                  </span>
                ) : null}
                <span className='min-w-0 flex-1 truncate font-medium'>{caption}</span>
                {page.currentExecution ? ' · 当前页' : ''}
              </button>
              {page.canClose && canControl ? (
                <button
                  type='button'
                  aria-label={`关闭标签页 ${caption}`}
                  disabled={isClosing}
                  className={cn(
                    'mr-1.5 rounded-xs p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer shrink-0',
                    isClosing && 'opacity-50 pointer-events-none',
                  )}
                  onClick={(e) => {
                    e.stopPropagation()
                    handleClosePage(page.pageRef.pageId)
                  }}
                >
                  {isClosing ? (
                    <Loader2 className='size-3 animate-spin' />
                  ) : (
                    <X className='size-3' />
                  )}
                </button>
              ) : null}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <section
      aria-label='受管浏览器'
      className={cn(
        'min-w-0 overflow-hidden',
        embedded
          ? 'flex flex-1 flex-col border-0 p-0 shadow-none bg-transparent'
          : 'rounded-lg border border-border-card bg-card p-5 shadow-card',
      )}
    >
      {embedded ? (
        <div className='flex flex-col bg-card'>
          {open ? renderTabStrip() : null}
          <div className='flex items-center justify-between gap-2 px-3 py-1.5 border-b border-border-divider/60 bg-surface-header/40 text-label text-muted-foreground'>
            <div className='flex items-center gap-2 min-w-0 flex-1 max-w-xl rounded-md border border-border-default/60 bg-muted/30 hover:bg-muted/50 px-2.5 py-1 transition-[background-color,border-color]'>
              <Globe className='size-3.5 shrink-0 text-muted-foreground' />
              <span
                className='truncate font-mono text-foreground select-all text-small'
                title={activePage?.url ?? activeCaption ?? undefined}
              >
                {activeCaption ? `当前页 ${activeCaption}` : '受管浏览器画面'}
              </span>
              {frame ? (
                <span className='shrink-0 pl-1.5 font-mono text-caption text-muted-foreground border-l border-border-divider/50'>
                  {frame.width}×{frame.height}
                </span>
              ) : null}
            </div>
            <div className='flex items-center gap-2 shrink-0'>
              {meta?.degradedReason ? (
                <StatusBadge tone='warning'>画面不可用</StatusBadge>
              ) : null}
              {controlling ? (
                <StatusBadge tone='warning'>
                  {sessionMode ? '正在手动操作' : '正在输入'}
                </StatusBadge>
              ) : null}
              {sessionMode && canControl && !waiting && !controlling && heldByOther ? (
                <StatusBadge tone='info'>{holderLabel}</StatusBadge>
              ) : null}
              {sessionMode && canControl && !waiting && !controlling ? (
                <Button
                  size='sm'
                  variant='outline'
                  disabled={busy || heldByOther}
                  title={heldByOther ? `${holderLabel}，结束后才能接手` : undefined}
                  onClick={handleAcquire}
                >
                  手动操作
                </Button>
              ) : null}
              {sessionMode && canControl && !waiting && controlling ? (
                <>
                  <Button
                    size='sm'
                    variant='outline'
                    disabled={busy}
                    title='向下翻页滚动目标页面'
                    onClick={() => sendCommand({ type: 'key', key: 'PageDown' })}
                  >
                    向下翻页
                  </Button>
                  <Button
                    size='sm'
                    variant='outline'
                    disabled={busy}
                    title='向上翻页滚动目标页面'
                    onClick={() => sendCommand({ type: 'key', key: 'PageUp' })}
                  >
                    向上翻页
                  </Button>
                  <Button
                    size='sm'
                    variant='outline'
                    disabled={busy}
                    onClick={handleRelease}
                  >
                    退出操作
                  </Button>
                </>
              ) : null}
              {sessionMode && canControl && !waiting && !controlling && onSettleLanding ? (
                <Button
                  size='sm'
                  variant='outline'
                  disabled={busy}
                  onClick={() => {
                    setBusy(true)
                    void onSettleLanding()
                      .then(() => toast.success('已提交整理页面'))
                      .catch((error) =>
                        toast.error(
                          error instanceof ApiRequestError ? error.message : '无法整理页面',
                        ),
                      )
                      .finally(() => setBusy(false))
                  }}
                >
                  整理页面
                </Button>
              ) : null}
              <Button
                size='sm'
                variant='outline'
                onClick={() => setOpen((value) => !value)}
              >
                {open ? '收起画面' : '展开画面'}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className='flex flex-wrap items-center justify-between gap-3'>
          <div>
            <h2 className='text-section font-semibold'>受管浏览器</h2>
            <p className='mt-1 text-label text-muted-foreground'>
              {waiting
                ? describeManagedAuthWait(meta?.lastAuthError ?? waitReason)
                : picking
                  ? '指认中。在画面上点选元素，校验框画在叠加层，不会改目标页。'
                  : holding
                    ? '调试挂起中。指认在画面上点选，校验框画在叠加层，不会改目标页。'
                    : sessionMode
                      ? controlling
                        ? '正在手动操作。可在画面中点击、滚动或在下方输入文本；点击「拾取对象」可随时指认元素。'
                        : '实时画面已连接。点击「手动操作」可接管画面操作菜单与表单；指认前请先切至目标视图。'
                      : isLiveViewRun(runStatus)
                        ? '只读跟随当前页。在途运行会自动展开画面。'
                        : '只读跟随当前页。运行结束后不再抓取实时画面。'}
            </p>
          </div>
          <div className='flex items-center gap-2'>
            {meta?.degradedReason ? (
              <StatusBadge tone='warning'>画面不可用</StatusBadge>
            ) : null}
            {frame ? (
              <StatusBadge tone='success'>画面已连接</StatusBadge>
            ) : null}
            {controlling ? (
              <StatusBadge tone='warning'>
                {sessionMode ? '正在手动操作' : '正在输入'}
              </StatusBadge>
            ) : null}
            {sessionMode && canControl && !waiting && !controlling && heldByOther ? (
              <StatusBadge tone='info'>{holderLabel}</StatusBadge>
            ) : null}
            {sessionMode && canControl && !waiting && !controlling ? (
              <Button
                variant='outline'
                disabled={busy || heldByOther}
                title={heldByOther ? `${holderLabel}，结束后才能接手` : undefined}
                onClick={handleAcquire}
              >
                手动操作
              </Button>
            ) : null}
            {sessionMode && canControl && !waiting && controlling ? (
              <>
                <Button
                  size='sm'
                  variant='outline'
                  disabled={busy}
                  title='向下翻页滚动目标页面'
                  onClick={() => sendCommand({ type: 'key', key: 'PageDown' })}
                >
                  向下翻页
                </Button>
                <Button
                  size='sm'
                  variant='outline'
                  disabled={busy}
                  title='向上翻页滚动目标页面'
                  onClick={() => sendCommand({ type: 'key', key: 'PageUp' })}
                >
                  向上翻页
                </Button>
                <Button
                  variant='outline'
                  disabled={busy}
                  onClick={handleRelease}
                >
                  退出操作
                </Button>
              </>
            ) : null}
            {sessionMode && canControl && !waiting && !controlling && onSettleLanding ? (
              <Button
                variant='outline'
                disabled={busy}
                onClick={() => {
                  setBusy(true)
                  void onSettleLanding()
                    .then(() => toast.success('已提交整理页面'))
                    .catch((error) =>
                      toast.error(
                        error instanceof ApiRequestError ? error.message : '无法整理页面',
                      ),
                    )
                    .finally(() => setBusy(false))
                }}
              >
                整理页面
              </Button>
            ) : null}
            <Button
              variant='outline'
              onClick={() => setOpen((value) => !value)}
            >
              {open ? '收起画面' : '展开画面'}
            </Button>
          </div>
        </div>
      )}
      {waiting && meta?.currentPage?.url ? (
        <p className='mt-3 break-all text-small text-muted-foreground'>
          当前页：{meta.currentPage.url}
        </p>
      ) : null}
      {waiting && canControl && !controlling ? (
        <div className='mt-4 flex flex-wrap gap-2'>
          <Button
            disabled={
              busy ||
              Boolean(
                meta?.authControl?.actorId && !meta.authControl.heldByViewer
              )
            }
            onClick={handleAcquire}
          >
            {acquireError ? '重试处理登录' : '处理登录'}
          </Button>
          {meta?.viewMode === 'readonly' && !acquireError ? (
            <p className='self-center text-small text-muted-foreground'>
              只读观看中，点击「处理登录」后才能输入
            </p>
          ) : null}
          {acquireError ? (
            <p role='alert' className='w-full text-small font-medium text-destructive'>
              无法取得登录输入权：{acquireError.message}（{acquireError.code}）
            </p>
          ) : null}
          {meta?.authControl?.actorId && !meta.authControl.heldByViewer ? (
            <p className='self-center text-small text-muted-foreground'>
              由其他用户处理登录
            </p>
          ) : null}
        </div>
      ) : null}
      {controlling && (!sessionMode || waiting) ? (
        <div className='mt-4 flex flex-wrap gap-2'>
          {onRefreshLogin ? (
            <Button
              variant='outline'
              disabled={busy || !pageRef}
              onClick={() => {
                const ref = frame?.pageRef ?? pageRef
                if (!ref) return
                setBusy(true)
                void onRefreshLogin(ref)
                  .catch((error) => toast.error(error.message))
                  .finally(() => setBusy(false))
              }}
            >
              刷新登录页
            </Button>
          ) : null}
          <Button
            disabled={busy}
            onClick={() => {
              setAuthError(null)
              setBusy(true)
              void resumeRunAuth(runId, { token: token ?? undefined })
                .then(() => {
                  setToken(null)
                  setAuthError(null)
                  toast.success(
                    sessionMode
                      ? '已完成认证'
                      : '已确认目标系统登录，等待再次领取'
                  )
                  onRunChanged?.()
                })
                .catch((error) => {
                  const msg =
                    error instanceof ApiRequestError
                      ? error.message
                      : '尚未检测到登录成功，请在页面中确认并提交'
                  setAuthError(msg)
                  toast.error(msg)
                })
                .finally(() => setBusy(false))
            }}
          >
            {busy ? <Loader2 className='size-3.5 mr-1.5 animate-spin' /> : null}
            {busy
              ? '正在核验登录态…'
              : sessionMode
                ? '完成认证'
                : '登录完成，继续运行'}
          </Button>
          <Button
            variant='outline'
            disabled={busy || !token}
            onClick={() => {
              setAuthError(null)
              handleRelease()
            }}
          >
            放弃控制
          </Button>
          {authError ? (
            <p className='w-full text-small text-destructive font-medium mt-1'>{authError}</p>
          ) : null}
        </div>
      ) : null}
      {open ? (
        <div className={cn(embedded ? 'flex flex-col' : 'mt-4 flex flex-col space-y-3')}>
          {!embedded ? renderTabStrip() : null}
          {!embedded &&
            (activeCaption ? (
              <div className='flex items-center justify-between gap-2 px-3 py-1.5 rounded-md border border-border-default/60 bg-muted/30 text-label text-muted-foreground'>
                <div className='flex items-center gap-2 min-w-0 flex-1 truncate'>
                  <Globe className='size-3.5 shrink-0 text-muted-foreground' />
                  <span
                    className='truncate font-mono text-foreground select-all text-small'
                    title={activePage?.url ?? activeCaption ?? undefined}
                  >
                    当前页 {activeCaption}
                  </span>
                  {frame ? (
                    <span className='shrink-0 pl-1.5 font-mono text-caption text-muted-foreground border-l border-border-divider/50'>
                      {frame.width}×{frame.height}
                    </span>
                  ) : null}
                </div>
              </div>
            ) : (
              <p className='text-small text-muted-foreground'>
                {meta?.degradedReason === 'worker_unreachable'
                  ? '执行面暂时不可达，仍显示会话所有权。'
                  : connecting
                    ? '正在连接受管浏览器画面…'
                    : '还没有可观察的受管页面。'}
              </p>
            ))}
          {meta?.viewingOtherPage ? (
            <p className='text-small text-status-warning-foreground px-3 py-1 bg-status-warning/10 border-y border-status-warning/20'>
              {sessionMode
                ? '正在查看非当前页：手动操作与指认作用于此页。'
                : '正在查看其他页面，不会改变执行当前页。'}
            </p>
          ) : null}
          {observe.pickMode && pickBlockedOnOtherPage ? (
            <p className='text-small text-status-warning-foreground px-3 py-1 bg-status-warning/10 border-y border-status-warning/20'>
              步骤将在执行当前页上运行，请切回当前页再指认。
            </p>
          ) : null}
          {frame && meta?.capabilities.screencast !== 'closed' ? (
            <div className='w-full'>
              <button
                type='button'
                className={cn(
                  'relative block w-full overflow-hidden bg-card',
                  embedded
                    ? 'border-y border-border-default'
                    : 'rounded-md border border-border-default shadow-sm',
                  (controlling || picking) && 'cursor-crosshair',
                )}
                disabled={!controlling && !picking}
                onClick={(event) => {
                  if (picking) {
                    const point = framePointFromClick(event, frame)
                    observe.pickAt(point.x, point.y)
                    return
                  }
                  if (!controlling) return
                  sendCommand({
                    type: 'mouse_click',
                    ...framePointFromClick(event, frame),
                    button: 'left',
                  })
                }}
                onWheel={(event) => {
                  if (!controlling) return
                  event.preventDefault()
                  const point = framePointFromClick(event, frame)
                  scheduleWheel(point.x, point.y, event.deltaX, event.deltaY)
                }}
                onKeyDown={(event) => {
                  if (!controlling) return
                  if (
                    event.key === 'PageUp' ||
                    event.key === 'PageDown' ||
                    event.key === 'ArrowUp' ||
                    event.key === 'ArrowDown'
                  ) {
                    event.preventDefault()
                    sendCommand({ type: 'key', key: event.key })
                  }
                }}
              >
                <img
                  src={frame.image}
                  alt='受管浏览器当前画面'
                  className='block h-auto w-full object-contain'
                  style={{
                    aspectRatio: `${frame.width} / ${frame.height}`,
                    imageRendering: '-webkit-optimize-contrast',
                  }}
                />
                {highlightBox ? (
                  <svg
                    className='pointer-events-none absolute inset-0 h-full w-full'
                    viewBox={`0 0 ${frame.width} ${frame.height}`}
                    preserveAspectRatio='none'
                    aria-hidden
                  >
                    <rect
                      x={highlightBox.x}
                      y={highlightBox.y}
                      width={highlightBox.width}
                      height={highlightBox.height}
                      fill='none'
                      stroke='var(--action-primary)'
                      strokeWidth={2}
                    />
                  </svg>
                ) : null}
                {tableMarkers?.tables?.length ? (
                  <div className='absolute inset-0' aria-label='探测到的表格'>
                    {tableMarkers.tables.map((tbl, i) =>
                      tbl.box ? (
                        <div
                          key={i}
                          role='button'
                          tabIndex={0}
                          aria-label={`选择表格 ${i + 1}`}
                          className={
                            'absolute cursor-pointer rounded-sm border-2 transition-colors ' +
                            (i === tableMarkers.activeIndex
                              ? 'border-action-primary bg-action-primary/15'
                              : 'border-blue-500/80 bg-blue-500/5 hover:bg-blue-500/15')
                          }
                          style={{
                            left: `${(tbl.box.x / frame.width) * 100}%`,
                            top: `${(tbl.box.y / frame.height) * 100}%`,
                            width: `${(tbl.box.width / frame.width) * 100}%`,
                            height: `${(tbl.box.height / frame.height) * 100}%`,
                          }}
                          onClick={(event) => {
                            event.stopPropagation()
                            tableMarkers?.onPick?.(i)
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              event.stopPropagation()
                              tableMarkers?.onPick?.(i)
                            }
                          }}
                        >
                          <span className='absolute -top-5 left-0 rounded bg-blue-600 px-1.5 py-0.5 text-[10px] font-medium leading-none text-white shadow-sm'>
                            表格 {i + 1}
                          </span>
                        </div>
                      ) : null,
                    )}
                  </div>
                ) : null}
              </button>
            </div>
          ) : (
            <div
              role='status'
              className='flex min-h-56 items-center justify-center rounded-md border border-dashed border-border-default bg-muted px-4 py-8 text-center text-small text-muted-foreground'
            >
              {viewPlaceholder({
                runStatus,
                waiting,
                controlling,
                framesAvailable: Boolean(meta?.framesAvailable),
                degradedReason: meta?.degradedReason ?? null,
                streamError,
                connecting,
              })}
            </div>
          )}
          {controlling && meta?.capabilities.authInput !== 'closed' ? (
            <div className='space-y-2'>
              <label
                className='text-label text-muted-foreground'
                htmlFor={inputId}
              >
                {sessionMode
                  ? '键盘输入将直接发送至目标网页。中文请先组字再发送。支持方向键与 PageUp/PageDown 滚动。'
                  : '输入将作用于目标系统。中文请先组字再发送。支持方向键与 PageUp/PageDown 滚动。'}
              </label>
              <input
                id={inputId}
                className='w-full rounded-md border border-border-default bg-background px-3 py-2 text-body'
                placeholder={
                  sessionMode
                    ? '输入文本后回车发送，或按上下方向键、PageUp/PageDown 滚动目标页面'
                    : '输入文本后回车发送，或按上下方向键、PageUp/PageDown 滚动'
                }
                onCompositionStart={() => {
                  composing.current = true
                }}
                onCompositionEnd={(event) => {
                  composing.current = false
                  const text = event.currentTarget.value.trim()
                  if (
                    text &&
                    meta?.capabilities.chineseInsertText !== 'closed'
                  ) {
                    sendCommand({ type: 'insert_text', text })
                  }
                  event.currentTarget.value = ''
                }}
                onKeyDown={(event) => {
                  if (composing.current) return
                  if (
                    event.key === 'Enter' &&
                    event.currentTarget.value.trim()
                  ) {
                    sendCommand({
                      type: 'insert_text',
                      text: event.currentTarget.value,
                    })
                    event.currentTarget.value = ''
                    event.preventDefault()
                    return
                  }
                  if (
                    event.key === 'PageUp' ||
                    event.key === 'PageDown' ||
                    event.key === 'ArrowUp' ||
                    event.key === 'ArrowDown'
                  ) {
                    event.preventDefault()
                    sendCommand({ type: 'key', key: event.key })
                    return
                  }
                  if (
                    event.key === 'Enter' ||
                    event.key === 'Tab' ||
                    event.key === 'Escape' ||
                    event.key === 'Backspace' ||
                    ((event.key === 'Home' || event.key === 'End') &&
                      !event.currentTarget.value)
                  ) {
                    sendCommand({ type: 'key', key: event.key })
                  }
                }}
              />
              {remain !== null ? (
                <p className='text-label text-muted-foreground'>
                  {sessionMode
                    ? `手动操作中 · 控制权剩余 ${remain} 秒（有操作或心跳自动续期）`
                    : `控制权剩余 ${remain} 秒`}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
