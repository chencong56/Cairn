import { useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import {
  Activity,
  AlertCircle,
  Check,
  ChevronDown,
  Clock,
  ExternalLink,
  Loader2,
  Monitor,
  Play,
  RefreshCw,
  X,
  XCircle,
} from 'lucide-react'
import { describeAuthIssue, hasPermission, isFinishedRunStatus } from '@cairn/shared'
import { toast } from 'sonner'
import {
  classifyStudioSessionConnect,
  deriveSessionPreparationStage,
  formatOperationTimeout,
  PREPARATION_STEPS,
  resolveLatestEventSummary,
  resolveStudioConnectAction,
  studioDisconnectedCopy,
} from './studio-connect'
import { ApiRequestError } from '@/lib/api-client'
import { useAuthStore } from '@/stores/auth-store'
import {
  cancelSessionOperation,
  fetchAccountSession,
  fetchAccountSessionEvents,
  fetchSessionOperation,
  newSessionIdempotencyKey,
  requestAccountSessionOperation,
  sessionBrowserTransport,
} from '@/lib/sessions-api'
import { useSessionObservation } from '@/features/sessions/use-session-observation'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  canCancelOperation,
  describeOccupancyBy,
  describeQueuedTrialWait,
  findFollowableOperation,
  findLiveManualHold,
  instanceOccupancyText,
  isInstanceIdle,
  pickViewInstance,
  projectDetailToInstance,
  readPreferredInstance,
  writePreferredInstance,
} from './studio-instances'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { StatusBadge } from '@/components/status-badge'
import { BrowserView } from '@/features/runs/browser-view'
import { RunVideoSection } from '@/features/runs/run-video'
import { PlacementHint } from '@/features/runs/placement-hint'
import { useRunObservation } from '@/features/runs/use-run-observation'
import { RUN_STATUS_LABELS, runStatusTone, WAIT_REASON_COPY } from '@/features/runs/labels'
import { computeScreenAlignment } from '@/features/authoring/observe'
import { cn } from '@/lib/utils'

const LIVE_RUN_STATUSES = ['SCHEDULED', 'QUEUED', 'RUNNING', 'WAITING_FOR_AUTH', 'HOLDING']
const sessionTransport = sessionBrowserTransport('session')
const operationTransport = sessionBrowserTransport('operation')

export type StudioScreenProps = {
  runId?: string
  scenarioId?: string
  targetId?: string
  targetAccountId?: string
  onStartTrial?: () => void
  selectedStepId?: string
  selectedStepName?: string
  selectedIsFirst?: boolean
  stepOrder?: string[]
  onRunToStep?: (targetStepId: string) => void
  trialDisabledReason?: string
  /** 画面连的是访客会话：准备不登录；到了登录页提示会污染访客数据。 */
  accountIsVisitor?: boolean
}

export function StudioScreen({
  runId,
  scenarioId: _scenarioId,
  targetId,
  targetAccountId,
  onStartTrial,
  selectedStepId,
  selectedStepName,
  selectedIsFirst,
  stepOrder = [],
  onRunToStep,
  trialDisabledReason,
  accountIsVisitor = false,
}: StudioScreenProps) {
  const user = useAuthStore((state) => state.auth.user)
  const canRead = Boolean(user && hasPermission(user.permissions, 'run:read'))
  const canExecute = Boolean(user && hasPermission(user.permissions, 'run:execute'))
  const canReadSession = Boolean(user && hasPermission(user.permissions, 'session:read'))
  const canControlSession = Boolean(user && hasPermission(user.permissions, 'session:control'))
  const canDisposeSession = Boolean(user && hasPermission(user.permissions, 'session:dispose'))
  const myId = user?.id ?? null
  const { run, evidence, refresh, eventSeq, query } = useRunObservation(
    runId ?? '',
    Boolean(runId && canRead),
  )

  // 接入会话 SSE 订阅：后端事件实时触发缓存失效
  const { eventSeq: sessionEventSeq } = useSessionObservation(targetId, targetAccountId)

  const [videoOpen, setVideoOpen] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [prepareFailed, setPrepareFailed] = useState(false)
  const [abandoning, setAbandoning] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [pendingOperationId, setPendingOperationId] = useState<string | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [preferredInstanceId, setPreferredInstanceId] = useState<string | null>(() =>
    readPreferredInstance(targetId, targetAccountId),
  )
  // 取消后同一个进行中的操作在刷新前仍会短暂可见，记下已放弃的操作避免立刻再次跟随。
  const dismissedOps = useRef(new Set<string>())

  // 目标或账号切换时及时重置连接与失败状态，防止历史状态泄漏
  useEffect(() => {
    setConnecting(false)
    setPrepareFailed(false)
    setPendingOperationId(null)
    setConnectError(null)
    setPreferredInstanceId(readPreferredInstance(targetId, targetAccountId))
  }, [targetId, targetAccountId])

  const sessionQuery = useQuery({
    queryKey: ['account-session', targetId, targetAccountId],
    queryFn: () => fetchAccountSession(targetId!, targetAccountId!),
    enabled: Boolean(targetId && targetAccountId && canReadSession),
  })
  const accountDetail = sessionQuery.data
  const runSessionId = (run as { placement?: { sessionId?: string | null } } | undefined)?.placement?.sessionId ?? null
  const viewInstance = pickViewInstance(accountDetail, { preferredId: preferredInstanceId, myId, runSessionId })
  // 账号有多个实例时，其余界面仍按「一个会话」读取：这里把详情投影到当前看的实例。
  const session = projectDetailToInstance(accountDetail, viewInstance)
  const instances = accountDetail?.instances ?? []

  const activeOpId = session?.currentOperation?.id ?? pendingOperationId
  const operationQuery = useQuery({
    queryKey: ['session-operation', activeOpId],
    queryFn: () => fetchSessionOperation(activeOpId!),
    enabled: Boolean(activeOpId && canReadSession && (connecting || prepareFailed)),
  })

  const eventsQuery = useQuery({
    queryKey: ['account-session-events', targetId, targetAccountId],
    queryFn: () => fetchAccountSessionEvents(targetId!, targetAccountId!),
    enabled: Boolean(
      targetId &&
        targetAccountId &&
        canReadSession &&
        (connecting || prepareFailed || (accountIsVisitor && session?.session?.status === 'OPEN')),
    ),
  })
  // 访客会话最新一条相关事件是「到了登录页」：提示在这里登录会把登录状态留在访客数据里。
  const visitorOnLoginPage = (() => {
    if (!accountIsVisitor || session?.session?.status !== 'OPEN') return false
    const currentSessionId = session.session.id
    const latest = (eventsQuery.data?.items ?? []).find(
      (event) =>
        (event.sessionId === currentSessionId || event.type === 'profile.reset') &&
        ['auth.signal_observed', 'session.created', 'session.closed', 'session.restarted', 'profile.reset'].includes(event.type),
    )
    return latest?.type === 'auth.signal_observed'
  })()
  const [resettingVisitor, setResettingVisitor] = useState(false)
  const resetVisitorData = async () => {
    if (!targetId || !targetAccountId) return
    setResettingVisitor(true)
    try {
      await requestAccountSessionOperation(targetId, targetAccountId, {
        kind: 'RESET_PROFILE',
        idempotencyKey: newSessionIdempotencyKey('RESET_PROFILE'),
        confirmAccountId: targetAccountId,
        ...(session?.session?.id ? { expectedSessionId: session.session.id } : {}),
      })
      toast.success('已清空访客浏览数据，下次连接会用全新的访客会话')
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '清空访客浏览数据失败')
    } finally {
      setResettingVisitor(false)
    }
  }

  // 当处于 connecting 时每秒更新计时；每 3 秒兜底刷新一次，防范 SSE 瞬时断线或延迟。
  // 依赖只取稳定的 refetch：查询结果对象每次渲染都会变，放进依赖会让计时器每秒重建、计数永远到不了 3。
  const refetchSession = sessionQuery.refetch
  const refetchOperation = operationQuery.refetch
  useEffect(() => {
    if (!connecting) return
    let timer: ReturnType<typeof setTimeout>
    let counter = 0
    const tick = () => {
      setNowMs(Date.now())
      counter++
      if (counter % 3 === 0) {
        void refetchSession()
        void refetchOperation()
      }
      timer = setTimeout(tick, 1000)
    }
    timer = setTimeout(tick, 1000)
    return () => clearTimeout(timer)
  }, [connecting, refetchSession, refetchOperation])

  const sessionOpen = session?.session?.status === 'OPEN'
  // 账号已有会话实例时，会话操作必须带上实例与代次（服务端据此防止操作到已重建的实例）。
  const expectedInstance = () =>
    session?.session
      ? { expectedSessionId: session.session.id, expectedGeneration: session.session.generation }
      : {}
  const occupyingRunId = session?.occupancy?.occupyingRunId ?? null
  const occupyingOperationId = session?.occupancy?.occupyingOperationId ?? null
  const sessionViewId = occupyingOperationId ?? session?.session?.id
  const isLiveState = Boolean(run && LIVE_RUN_STATUSES.includes(run.status))
  const isFinished = Boolean(run && isFinishedRunStatus(run.status))
  // 本页试跑还在排队时不切到运行画面：继续显示当前实例，并说明在等什么。
  const ownRunQueued = Boolean(run && ['QUEUED', 'SCHEDULED'].includes(run.status))
  const queuedHold = ownRunQueued ? findLiveManualHold(accountDetail, myId) : null
  const showRunLive = isLiveState && !(ownRunQueued && sessionOpen && sessionViewId)
  // 实例被别人的运行占用：只读围观，不给手动操作与调试入口。
  const occupiedByOtherRun = Boolean(occupyingRunId && occupyingRunId !== runId)

  const connectState = classifyStudioSessionConnect(session, pendingOperationId, operationQuery.data)
  const isWaitingForAuth = Boolean(
    !showRunLive &&
      (connectState === 'waiting_for_auth' ||
        session?.currentOperation?.status === 'WAITING_FOR_AUTH' ||
        operationQuery.data?.status === 'WAITING_FOR_AUTH'),
  )

  const showSessionLive = Boolean(
    !showRunLive &&
      (sessionOpen || isWaitingForAuth) &&
      sessionViewId &&
      (!occupyingRunId || occupiedByOtherRun),
  )
  const sessionPending = Boolean(
    targetId && targetAccountId && canReadSession && sessionQuery.isPending,
  )
  const showVideoFallback = Boolean(isFinished && !showSessionLive && !sessionPending)
  const disconnected = studioDisconnectedCopy({
    connecting,
    lastAuthError: session?.lastAuthError,
  })

  const selectedStepRun = run?.stepRuns?.find((sr) => sr.stepId === selectedStepId)
  const selectedScreenshotEvidence = evidence?.items?.find(
    (item) =>
      item.type === 'screenshot' &&
      item.status === 'available' &&
      (selectedStepRun ? item.stepRunId === selectedStepRun.id : true),
  )

  const liveRunForAlignment = isLiveState && run
    ? {
        status: run.status,
        checkpoint: run.checkpoint,
        stepRuns: run.stepRuns,
      }
    : null

  const alignmentStatus = computeScreenAlignment({
    sessionOpen: Boolean(sessionOpen),
    liveRun: liveRunForAlignment,
    selectedStepId,
    stepOrder,
    hasOfflineScreenshot: Boolean(selectedScreenshotEvidence),
  })

  const alignmentBanner =
    (alignmentStatus === 'behind' || alignmentStatus === 'session_initial') && selectedStepId ? (
      <div className='mx-3 mt-1.5 flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-caption'>
        <div className='flex items-center gap-1.5 min-w-0'>
          <span className='size-1.5 shrink-0 rounded-full bg-status-warning' />
          <span className='text-foreground truncate'>
            当前画面处于【{alignmentStatus === 'session_initial' ? '系统初始页' : '前序步骤'}】，选中的步骤是【{selectedStepName || '当前步骤'}】
          </span>
        </div>
        <div className='flex items-center gap-2'>
          {canExecute ? (
            <Button
              size='sm'
              className='h-7 px-2.5 text-label'
              disabled={Boolean(trialDisabledReason)}
              onClick={() => onRunToStep?.(selectedStepId)}
            >
              <Play className='size-3.5 mr-1' />
              运行到此步前置
            </Button>
          ) : null}
          {trialDisabledReason ? (
            <span className='text-label text-muted-foreground'>试跑不可用：{trialDisabledReason}。</span>
          ) : null}
        </div>
      </div>
    ) : alignmentStatus === 'aligned' && selectedStepId ? (
      <div className='mx-3 mt-1.5 flex items-center gap-2 rounded-md border border-status-success/30 bg-status-success/10 px-2.5 py-1 text-caption font-medium text-status-success-foreground'>
        <span className='size-1.5 shrink-0 rounded-full bg-status-success' />
        <span className='truncate'>画面已对齐至步骤「{selectedStepName || '当前步骤'}」前置，可在画面上精准指认目标</span>
      </div>
    ) : !selectedStepId && selectedIsFirst === false && showSessionLive ? (
      <Alert variant='info' className='mx-3 mt-2'>
        <AlertDescription>
          <p>
            现在看到的是会话停放的当前页面，不是执行到「{selectedStepName || '当前步骤'}」之后的页面。您可以点击上方「手动操作」在受管画面中切到对应菜单或弹窗后再点「拾取对象」；也可以保存并试跑已保存的步骤。
          </p>
          <div className='mt-2 flex flex-wrap items-center gap-2'>
            <Button size='sm' disabled={Boolean(trialDisabledReason)} onClick={onStartTrial}>
              试跑
            </Button>
            {trialDisabledReason ? (
              <span className='text-label'>试跑不可用：{trialDisabledReason}。</span>
            ) : null}
          </div>
        </AlertDescription>
      </Alert>
    ) : null

  const currentOpStatus = session?.currentOperation?.status ?? operationQuery.data?.status
  const currentErrorCode = operationQuery.data?.errorCode ?? session?.lastAuthError

  const currentAction = resolveStudioConnectAction({
    sessionDetail: session,
    activeOpStatus: currentOpStatus,
    activeOpErrorCode: currentErrorCode,
    isFailed: prepareFailed,
  })

  const stageInfo = deriveSessionPreparationStage({
    operationStatus: currentOpStatus,
    events: eventsQuery.data?.items,
    sessionOpen,
    lastAuthError: session?.lastAuthError,
    errorCode: currentErrorCode,
    prepareFailed,
    errorMessage: connectError,
  })

  const latestEventSummary = resolveLatestEventSummary(eventsQuery.data?.items, activeOpId)

  const timeoutInfo = formatOperationTimeout({
    status: currentOpStatus,
    queueDeadlineAt: operationQuery.data?.queueDeadlineAt,
    createdAt: operationQuery.data?.createdAt,
    nowMs,
  })

  useEffect(() => {
    if (!connecting) return
    if (connectState === 'open') {
      setConnecting(false)
      setPrepareFailed(false)
      setPendingOperationId(null)
      setConnectError(null)
      return
    }
    if (connectState === 'failed') {
      setConnecting(false)
      setPrepareFailed(true)
      const errorMsg =
        stageInfo.detail || describeAuthIssue(session?.lastAuthError) || '无法连接受管会话'
      toast.error(errorMsg)
    }
  }, [connecting, connectState, session, stageInfo.detail])

  // 兜底安全上限：300 秒（对齐平台默认排队与调度上限）
  useEffect(() => {
    if (!connecting) return
    const timer = window.setTimeout(() => {
      setConnecting(false)
      setPrepareFailed(true)
      setPendingOperationId(null)
      const msg = '会话准备已超时。可到会话页查看详细排障信息，或稍后重试。'
      setConnectError(msg)
      toast.error(msg)
    }, 300_000)
    return () => window.clearTimeout(timer)
  }, [connecting])

  // 别人已经在准备同一个实例：自动跟随它的进度，不另发请求，也不会撞上「已有操作」的冲突。
  const followOp = findFollowableOperation(accountDetail, viewInstance)
  const followOpId = followOp && ['QUEUED', 'RUNNING'].includes(followOp.status) ? followOp.id : null
  useEffect(() => {
    if (!followOpId || sessionOpen || connecting || prepareFailed) return
    if (dismissedOps.current.has(followOpId)) return
    setConnecting(true)
    setPendingOperationId(followOpId)
  }, [followOpId, sessionOpen, connecting, prepareFailed])
  const followedRequester =
    session?.currentOperation?.requestedBy && session.currentOperation.requestedBy.id !== myId
      ? session.currentOperation.requestedBy
      : null
  // 只有发起人或会话管理员能取消别人排上的操作；自己刚发起、尚未回读时放行。
  const canCancelPrepare =
    !session?.currentOperation ||
    canCancelOperation(session.currentOperation, { myId, canDispose: canDisposeSession })

  // 「新开实例」只在并发模式、没到上限、又没有空闲就绪实例时出现；建好后自动切过去。
  const knownInstanceIds = useRef<Set<string> | null>(null)
  const awaitingNewInstance = useRef(false)
  useEffect(() => {
    const ids = new Set(instances.map((item) => item.id))
    const known = knownInstanceIds.current
    knownInstanceIds.current = ids
    if (!known || !awaitingNewInstance.current) return
    const added = instances.find((item) => !known.has(item.id))
    if (added) {
      awaitingNewInstance.current = false
      setPreferredInstanceId(added.id)
      writePreferredInstance(targetId, targetAccountId, added.id)
    }
  }, [instances, targetId, targetAccountId])
  const canOpenNewInstance = Boolean(
    canControlSession &&
      accountDetail &&
      accountDetail.effectiveCap > 1 &&
      instances.length >= 1 &&
      accountDetail.liveCount < accountDetail.effectiveCap &&
      !instances.some(isInstanceIdle) &&
      !accountDetail.activeOperations?.some((op) => op.newInstance),
  )
  async function openNewInstance() {
    if (!targetId || !targetAccountId) return
    try {
      awaitingNewInstance.current = true
      await requestAccountSessionOperation(targetId, targetAccountId, {
        kind: 'PREPARE',
        idempotencyKey: newSessionIdempotencyKey('PREPARE'),
        newInstance: true,
      })
      toast.info('正在新开一个浏览器实例，就绪后自动切换')
      await sessionQuery.refetch()
    } catch (error) {
      awaitingNewInstance.current = false
      toast.error(error instanceof ApiRequestError ? error.message : '新开实例失败')
    }
  }

  function switchInstance(id: string) {
    setPreferredInstanceId(id)
    writePreferredInstance(targetId, targetAccountId, id)
    setConnecting(false)
    setPrepareFailed(false)
    setPendingOperationId(null)
    setConnectError(null)
  }

  async function connectSession() {
    if (!targetId || !targetAccountId || !canControlSession) {
      onStartTrial?.()
      return
    }
    setConnecting(true)
    setPrepareFailed(false)
    setConnectError(null)
    setPendingOperationId(null)
    try {
      const action = resolveStudioConnectAction({
        sessionDetail: session,
        activeOpStatus: currentOpStatus,
        activeOpErrorCode: currentErrorCode,
        isFailed: prepareFailed,
      })

      if (sessionOpen && action.kind === 'PREPARE' && !prepareFailed) {
        await sessionQuery.refetch()
        setConnecting(false)
        return
      }

      const accepted = await requestAccountSessionOperation(targetId, targetAccountId, {
        kind: action.kind,
        idempotencyKey: newSessionIdempotencyKey(action.kind),
        force: action.kind === 'RESTART',
        ...expectedInstance(),
      })
      setPendingOperationId(accepted.operationId)
      await sessionQuery.refetch()
    } catch (error) {
      setConnecting(false)
      setPrepareFailed(true)
      setPendingOperationId(null)
      const message =
        error instanceof ApiRequestError
          ? error.message
          : error instanceof Error
            ? error.message
            : '无法连接受管会话'
      setConnectError(message)
      toast.error(message)
    }
  }

  async function abandonTakeover() {
    if (!targetId || !targetAccountId) return
    setAbandoning(true)
    try {
      await requestAccountSessionOperation(targetId, targetAccountId, {
        kind: 'CLOSE',
        idempotencyKey: newSessionIdempotencyKey('CLOSE'),
        force: true,
        ...expectedInstance(),
      })
      toast.info('已放弃人工接管，受管浏览器会话已关闭')
      setConnecting(false)
      setPrepareFailed(false)
      setPendingOperationId(null)
      setConnectError(null)
      await sessionQuery.refetch()
    } catch (err) {
      toast.error(err instanceof ApiRequestError ? err.message : '关闭会话失败')
    } finally {
      setAbandoning(false)
    }
  }

  async function cancelConnecting() {
    const opId = activeOpId
    if (opId) {
      dismissedOps.current.add(opId)
      try {
        await cancelSessionOperation(opId)
        toast.success('已取消会话准备')
      } catch (err) {
        toast.error(err instanceof ApiRequestError ? err.message : '取消失败')
      }
    }
    setConnecting(false)
    setPrepareFailed(false)
    setPendingOperationId(null)
    setConnectError(null)
    void sessionQuery.refetch()
  }

  const headerAction = showRunLive ? (
    canExecute ? (
      <Button size='sm' variant='outline' className='h-7 px-2 text-label' onClick={onStartTrial}>
        <Play className='size-3.5 mr-1' />
        重连环境
      </Button>
    ) : null
  ) : showSessionLive ? (
    <Button
      size='sm'
      variant='outline'
      className='h-7 px-2 text-label'
      disabled={sessionQuery.isFetching}
      onClick={() => void sessionQuery.refetch()}
    >
      <RefreshCw className='size-3.5 mr-1' />
      同步画面
    </Button>
  ) : canControlSession && targetId && targetAccountId ? (
    <Button
      size='sm'
      variant='outline'
      className='h-7 px-2 text-label'
      disabled={(connecting && !prepareFailed) || abandoning}
      onClick={() => void connectSession()}
    >
      <Play className='size-3.5 mr-1' />
      {connecting && !prepareFailed ? '准备中…' : currentAction.label}
    </Button>
  ) : canExecute ? (
    <Button size='sm' variant='outline' className='h-7 px-2 text-label' onClick={onStartTrial}>
      <Play className='size-3.5 mr-1' />
      唤起环境
    </Button>
  ) : null

  return (
    <section
      aria-label='受管画面'
      className='flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-card'
    >
      <div className='flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border-divider px-3 bg-surface-header'>
        <div className='flex items-center gap-2 shrink-0'>
          <Monitor className='size-4 text-primary shrink-0' />
          <h2 className='text-body font-semibold shrink-0'>受管画面</h2>
          {showRunLive && run ? (
            <StatusBadge tone={runStatusTone(run.status)} className='shrink-0'>
              {RUN_STATUS_LABELS[run.status]}
            </StatusBadge>
          ) : isWaitingForAuth ? (
            <StatusBadge tone='warning' className='shrink-0'>
              需要人工验证
            </StatusBadge>
          ) : showSessionLive ? (
            <StatusBadge tone='success' className='shrink-0'>
              会话已连接
            </StatusBadge>
          ) : prepareFailed ? (
            <StatusBadge tone='error' className='shrink-0'>
              {stageInfo.title}
            </StatusBadge>
          ) : connecting ? (
            <StatusBadge tone={stageInfo.statusTone} className='shrink-0'>
              {stageInfo.title}
            </StatusBadge>
          ) : run ? (
            <StatusBadge tone={runStatusTone(run.status)} className='shrink-0'>
              {RUN_STATUS_LABELS[run.status]}
            </StatusBadge>
          ) : (
            <StatusBadge tone='neutral' className='shrink-0'>
              未连接
            </StatusBadge>
          )}
        </div>
        <div className='flex items-center gap-1.5 shrink-0'>
          {runId ? (
            <Button
              size='sm'
              variant='ghost'
              className='size-7 p-0'
              title='同步试跑'
              aria-label='同步试跑'
              onClick={() => void refresh()}
            >
              <RefreshCw className='size-3.5' />
            </Button>
          ) : null}
          {runId ? (
            <Button size='sm' variant='ghost' className='size-7 p-0' asChild title='查看完整运行详情'>
              <Link to='/runs/$runId' params={{ runId }}>
                <ExternalLink className='size-3.5' />
              </Link>
            </Button>
          ) : null}
          {canOpenNewInstance ? (
            <Button size='sm' variant='outline' className='h-7 px-2 text-label' onClick={() => void openNewInstance()}>
              新开实例
            </Button>
          ) : null}
          {instances.length >= 2 ? (
            <Select value={viewInstance?.id} onValueChange={switchInstance}>
              <SelectTrigger aria-label='选择浏览器实例' className='h-7 w-auto min-w-[150px] text-label'>
                <SelectValue placeholder='选择实例' />
              </SelectTrigger>
              <SelectContent>
                {instances.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    实例 #{item.accountSlot ?? 1} · {instanceOccupancyText(item, myId)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          {headerAction}
        </div>
      </div>

      <div className='flex min-h-0 flex-1 flex-col justify-start overflow-y-auto'>
        {showRunLive && run ? (
          <div className='space-y-1.5'>
            {alignmentBanner}
            {run.authCheckpoint ? (
              <div className='mx-3 mt-2 space-y-1 rounded-md border border-border-card bg-muted/40 p-3 text-small'>
                <p className='font-medium text-foreground'>
                  {run.authCheckpoint.status === 'recovering'
                    ? '正在等待登录恢复…'
                    : run.authCheckpoint.status === 'recovered'
                      ? '登录已恢复，已通过续跑校验'
                      : '需要完成认证'}
                </p>
                <p className='text-muted-foreground'>{run.authCheckpoint.trigger.summary}</p>
              </div>
            ) : null}
            <BrowserView
              runId={run.id}
              runStatus={run.status}
              eventSeq={eventSeq}
              onRunChanged={refresh}
              waitReason={session?.lastAuthError}
              defaultOpen
              embedded
            />
          </div>
        ) : showSessionLive && sessionViewId ? (
          <div className='space-y-1.5'>
            {isWaitingForAuth ? (
              <Alert variant='warning' className='mx-3 mt-2 border-warning/40 bg-warning/10 text-foreground'>
                <AlertDescription className='flex flex-wrap items-center justify-between gap-3'>
                  <div className='text-small'>
                    <span className='font-semibold text-warning-foreground'>需要人工辅助验证：</span>
                    {describeAuthIssue(session?.lastAuthError) ?? '目标系统需要完成人机验证（滑块/验证码）或登录'}。请在下方画面中点击「取得控制权」完成操作。
                  </div>
                  <div className='flex items-center gap-2'>
                    {activeOpId && canCancelPrepare ? (
                      <Button
                        size='sm'
                        variant='outline'
                        className='h-7 text-label'
                        onClick={() => void cancelConnecting()}
                      >
                        取消准备
                      </Button>
                    ) : null}
                    {canCancelPrepare ? (
                      <Button
                        size='sm'
                        variant='destructive'
                        className='h-7 text-label'
                        disabled={abandoning}
                        onClick={() => void abandonTakeover()}
                      >
                        {abandoning ? '正在关闭…' : '放弃接管并关闭'}
                      </Button>
                    ) : null}
                  </div>
                </AlertDescription>
              </Alert>
            ) : null}
            {occupiedByOtherRun ? (
              <Alert variant='info' className='mx-3 mt-2'>
                <AlertDescription>
                  该实例正被 {describeOccupancyBy(session?.occupancy?.by)} 占用，只读观看；运行结束后可手动操作。
                  {occupyingRunId && canRead ? (
                    <>
                      {' '}
                      <Link to='/runs/$runId' params={{ runId: occupyingRunId }} className='font-medium text-link underline'>
                        查看运行
                      </Link>
                    </>
                  ) : null}
                </AlertDescription>
              </Alert>
            ) : null}
            {ownRunQueued ? (
              <Alert variant={queuedHold ? 'warning' : 'info'} className='mx-3 mt-2'>
                <AlertDescription>
                  {describeQueuedTrialWait({
                    hold: queuedHold,
                    waitReasonCopy: run?.placement?.waitReason
                      ? (WAIT_REASON_COPY[run.placement.waitReason] ?? run.placement.waitReason)
                      : undefined,
                  })}
                </AlertDescription>
              </Alert>
            ) : null}
            {alignmentBanner}
            {visitorOnLoginPage ? (
              <Alert variant='warning' className='mx-3 mt-2 w-auto'>
                <AlertDescription>
                  这是访客会话。在这里登录会把登录状态留在访客的浏览数据里，影响之后所有访客运行。需要登录请把场景的运行账号改为登录账号。
                  {canDisposeSession ? (
                    <>
                      {' '}
                      <Button
                        size='sm'
                        variant='link'
                        className='h-auto p-0 align-baseline'
                        loading={resettingVisitor}
                        onClick={() => void resetVisitorData()}
                      >
                        清空访客浏览数据
                      </Button>
                    </>
                  ) : null}
                </AlertDescription>
              </Alert>
            ) : null}
            <BrowserView
              runId={sessionViewId}
              runStatus={occupyingOperationId ? (session?.currentOperation?.status ?? 'RUNNING') : 'RUNNING'}
              sessionMode
              defaultOpen
              transport={occupyingOperationId ? operationTransport : sessionTransport}
              eventSeq={sessionEventSeq}
              onRunChanged={() => void sessionQuery.refetch()}
              waitReason={session?.lastAuthError}
              readOnly={occupiedByOtherRun}
              embedded
            />
            {isFinished && run ? (
              <div className='px-3 pt-1'>
                <Collapsible open={videoOpen} onOpenChange={setVideoOpen}>
                  <CollapsibleTrigger asChild>
                    <Button variant='ghost' size='sm' className='w-full justify-between'>
                      本次试跑录像
                      <ChevronDown className={videoOpen ? 'size-3.5 rotate-180' : 'size-3.5'} />
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className='pt-2'>
                    <RunVideoSection run={run} items={evidence?.items ?? []} />
                  </CollapsibleContent>
                </Collapsible>
              </div>
            ) : null}
          </div>
        ) : alignmentStatus === 'offline_snapshot' && selectedScreenshotEvidence && runId ? (
          <div className='flex flex-col flex-1 p-3 space-y-2'>
            <div className='flex items-center justify-between rounded-md border border-border-card bg-muted/40 px-3 py-1.5 text-label text-muted-foreground'>
              <span>📷 正在展示历史试跑留存现场截图（离线参考）</span>
              {run?.finishedAt ? <span>执行于 {new Date(run.finishedAt).toLocaleTimeString()}</span> : null}
            </div>
            <div className='flex-1 overflow-auto rounded-md border border-border-default bg-black/5 flex items-center justify-center p-2 min-h-[300px]'>
              <img
                src={`/api/runs/${runId}/evidences/${selectedScreenshotEvidence.id}/content`}
                alt='离线步骤历史截图'
                className='max-w-full max-h-[480px] object-contain shadow-sm rounded border border-border-card'
              />
            </div>
            <p className='text-center text-caption text-muted-foreground'>
              当前受管会话未连接。连接会话或发起试跑后可启用实时指认与单步调试。
            </p>
          </div>
        ) : showVideoFallback && run ? (
          <div className='space-y-3 p-3'>
            <RunVideoSection run={run} items={evidence?.items ?? []} />
            <div className='flex flex-wrap items-center justify-between gap-2 rounded-md border border-border-default bg-muted/20 p-3'>
              <div className='space-y-0.5 text-small'>
                <p className='font-medium'>运行已结束 · {RUN_STATUS_LABELS[run.status]}</p>
                <p className='text-label text-muted-foreground'>
                  版本 {run.scenarioVersionId}
                  {run.finishedAt ? ` · 结束于 ${new Date(run.finishedAt).toLocaleTimeString()}` : ''}
                </p>
              </div>
              {headerAction}
            </div>
          </div>
        ) : sessionPending ? (
          <p className='p-6 text-center text-small text-muted-foreground'>正在连接受管浏览器…</p>
        ) : connecting || prepareFailed ? (
          <div className='flex flex-col items-center justify-center p-8 text-center max-w-lg mx-auto w-full'>
            <div
              className={cn(
                'mb-3 flex size-12 items-center justify-center rounded-full',
                prepareFailed
                  ? stageInfo.statusTone === 'warning'
                    ? 'bg-warning/10 text-warning'
                    : 'bg-destructive/10 text-destructive'
                  : 'bg-primary/10 text-primary',
              )}
            >
              {prepareFailed ? (
                <AlertCircle className='size-6' />
              ) : (
                <Loader2 className='size-6 animate-spin' />
              )}
            </div>
            <div className='flex items-center gap-2'>
              <h3 className='text-body font-semibold'>{stageInfo.title}</h3>
              <StatusBadge tone={stageInfo.statusTone}>{stageInfo.stageBadge}</StatusBadge>
            </div>
            <p
              className={cn(
                'mt-1 text-small max-w-sm',
                prepareFailed ? 'text-destructive font-medium' : 'text-muted-foreground',
              )}
            >
              {stageInfo.detail}
            </p>
            {!prepareFailed && followedRequester ? (
              <p className='mt-1 text-label text-muted-foreground'>
                正在跟随 {followedRequester.name ?? '其他用户'} 发起的会话准备
              </p>
            ) : null}

            {/* 四阶段 Stepper 进度条 */}
            <div className='my-5 flex items-center justify-between w-full px-2'>
              {PREPARATION_STEPS.map((rawStep, idx) => {
                // 访客不登录：登录这一步显示为已跳过，避免让人以为在等登录。
                const step =
                  accountIsVisitor && rawStep.key === 'authenticating'
                    ? { ...rawStep, title: '无需登录（已跳过）' }
                    : rawStep
                const isFailed = prepareFailed && stageInfo.failedStepIndex === idx
                const isDone = !isFailed && stageInfo.stepIndex > idx
                const isCurrent = !prepareFailed && stageInfo.stepIndex === idx
                return (
                  <div key={step.key} className='flex items-center flex-1 last:flex-none'>
                    <div className='flex flex-col items-center gap-1'>
                      <div
                        className={cn(
                          'flex size-7 items-center justify-center rounded-full text-caption font-semibold transition-colors',
                          isFailed
                            ? 'bg-destructive text-destructive-foreground ring-4 ring-destructive/20'
                            : isDone
                              ? 'bg-success text-success-foreground'
                              : isCurrent
                                ? 'bg-primary text-primary-foreground ring-4 ring-primary/20 animate-pulse'
                                : 'bg-muted text-muted-foreground',
                        )}
                      >
                        {isFailed ? <X className='size-3.5' /> : isDone ? <Check className='size-3.5' /> : idx + 1}
                      </div>
                      <span
                        className={cn(
                          'text-caption font-medium whitespace-nowrap',
                          isFailed
                            ? 'text-destructive font-semibold'
                            : isCurrent
                              ? 'text-foreground font-semibold'
                              : 'text-muted-foreground',
                        )}
                      >
                        {step.title}
                      </span>
                    </div>
                    {idx < PREPARATION_STEPS.length - 1 ? (
                      <div
                        className={cn(
                          'h-0.5 flex-1 mx-2 transition-colors',
                          isDone ? 'bg-success' : 'bg-border-divider',
                        )}
                      />
                    ) : null}
                  </div>
                )
              })}
            </div>

            {/* 最新动态展示 */}
            {latestEventSummary ? (
              <div className='w-full flex items-center gap-1.5 rounded-md border border-border-card bg-muted/40 px-3 py-2 text-label text-muted-foreground'>
                <Activity
                  className={cn(
                    'size-3.5 shrink-0',
                    prepareFailed ? 'text-destructive' : 'text-primary animate-pulse',
                  )}
                />
                <span className='truncate text-left'>最新动态：{latestEventSummary}</span>
              </div>
            ) : null}

            {/* 倒计时与超时预估 */}
            <div className='mt-3 flex items-center justify-center gap-1.5 text-label text-muted-foreground'>
              <Clock className='size-3.5 shrink-0' />
              <span>{timeoutInfo.hint}</span>
            </div>

            {/* 操作与逃生按钮 */}
            <div className='mt-5 flex flex-wrap items-center justify-center gap-3'>
              {prepareFailed ? (
                <>
                  <Button size='sm' onClick={() => void connectSession()}>
                    <Play className='size-3.5 mr-1' />
                    {currentAction.label}
                  </Button>
                  <Button
                    size='sm'
                    variant='outline'
                    onClick={() => {
                      setPrepareFailed(false)
                      setPendingOperationId(null)
                      setConnectError(null)
                    }}
                  >
                    关闭
                  </Button>
                  <Button
                    size='sm'
                    variant='destructive'
                    disabled={abandoning}
                    onClick={() => void abandonTakeover()}
                  >
                    {abandoning ? '正在关闭…' : '彻底重置会话'}
                  </Button>
                </>
              ) : canCancelPrepare ? (
                <Button size='sm' variant='outline' onClick={() => void cancelConnecting()}>
                  <XCircle className='size-3.5 mr-1 text-destructive' />
                  取消准备
                </Button>
              ) : null}
              <Link
                to='/sessions/$targetId/$accountId'
                params={{ targetId: targetId!, accountId: targetAccountId! }}
                className='text-small font-medium text-link underline'
              >
                查看会话详情
              </Link>
            </div>
          </div>
        ) : !runId || !run || isFinished || sessionQuery.isFetched ? (
          <div className='flex flex-col items-center justify-center p-8 text-center'>
            <div className='mb-3 flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground'>
               <Monitor className='size-6' />
            </div>
            <h3 className='text-body font-medium'>{disconnected.title}</h3>
            <p className='mt-1 max-w-sm text-small text-muted-foreground'>{disconnected.body}</p>
            {canControlSession && targetId && targetAccountId ? (
              <div className='mt-4 flex flex-wrap items-center justify-center gap-2'>
                <Button disabled={connecting || abandoning} onClick={() => void connectSession()}>
                  <Play />
                  {connecting
                    ? '准备中…'
                    : currentAction.kind === 'PREPARE'
                      ? session?.lastAuthError
                        ? '再试一次'
                        : '连接受管会话'
                      : currentAction.label}
                </Button>
                <Link
                  to='/sessions/$targetId/$accountId'
                  params={{ targetId, accountId: targetAccountId }}
                  className='text-small font-medium text-link underline'
                >
                  查看会话
                </Link>
              </div>
            ) : canExecute ? (
              <Button className='mt-4' onClick={onStartTrial}>
                <Play />
                唤起受管环境
              </Button>
            ) : (
              <p className='mt-3 text-label text-muted-foreground'>暂无可看的会话，需要有会话控制权限的成员先连接。</p>
            )}
          </div>
        ) : (
          <p className='p-6 text-center text-small text-muted-foreground'>
            {query.isError ? '无法加载运行数据。草稿不受影响。' : '正在加载受管浏览器…'}
          </p>
        )}
      </div>

      {run?.placement ? (
        <div className='border-t border-border-divider bg-surface-header px-4 py-2 text-label text-muted-foreground'>
          <PlacementHint placement={run.placement} />
        </div>
      ) : null}
    </section>
  )
}
