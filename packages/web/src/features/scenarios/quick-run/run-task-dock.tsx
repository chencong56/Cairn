import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { CheckCircle2, Loader2, LogIn, PanelRight, Square, X, XCircle, AlertTriangle, Ban } from 'lucide-react'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { cancelRun } from '@/lib/runs-api'
import { formatDurationMs } from '@/lib/formatters'
import { useCan } from '@/hooks/use-permissions'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { useRunObservation } from '@/features/runs/use-run-observation'
import { MAX_LIVE_RUNS, useQuickRunStore, type QuickRunEntry } from './quick-run-store'
import { runVerdict } from '../list/run-verdict'
import { isActiveRunStatus, runProgress, type RunPhase, type TrackNode } from './run-progress'

const PHASE_TILE: Record<RunPhase, string> = {
  running: 'bg-status-info-background text-status-info-foreground',
  waiting: 'bg-status-warning-background text-status-warning-foreground',
  passed: 'bg-status-success-background text-status-success-foreground',
  attention: 'bg-status-warning-background text-status-warning-foreground',
  failed: 'bg-status-error-background text-status-error-foreground',
  cancelled: 'bg-status-neutral-background text-status-neutral-foreground',
}

export function PhaseIcon({ phase, status }: { phase: RunPhase; status?: string }) {
  const className = 'size-[18px]'
  if (phase === 'running') return <Loader2 aria-hidden='true' className={cn(className, 'animate-spin motion-reduce:animate-none')} />
  if (phase === 'waiting') return status === 'WAITING_FOR_AUTH' ? <LogIn aria-hidden='true' className={className} /> : <AlertTriangle aria-hidden='true' className={className} />
  if (phase === 'passed') return <CheckCircle2 aria-hidden='true' className={className} />
  if (phase === 'attention') return <AlertTriangle aria-hidden='true' className={className} />
  if (phase === 'failed') return <XCircle aria-hidden='true' className={className} />
  return <Ban aria-hidden='true' className={className} />
}

export function PhaseTile({ phase, status, size = 'md' }: { phase: RunPhase; status?: string; size?: 'md' | 'lg' }) {
  return (
    <span
      aria-hidden='true'
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-md transition-colors duration-200',
        size === 'lg' ? 'size-10' : 'size-9',
        PHASE_TILE[phase],
      )}
    >
      <PhaseIcon phase={phase} status={status} />
    </span>
  )
}

const NODE_CLASS: Record<TrackNode, string> = {
  done: 'bg-status-success',
  live: 'bg-status-info',
  failed: 'bg-status-error',
  skipped: 'bg-text-disabled',
  pending: 'bg-card ring-1 ring-inset ring-border-control',
}

/** 执行轨迹：每个顶层步骤一个节点，节点之间细线相连；只显示最近 14 个。 */
function ExecutionTrack({ nodes }: { nodes: TrackNode[] }) {
  const visible = nodes.slice(-14)
  if (visible.length === 0) return null
  return (
    <span aria-hidden='true' className='flex shrink-0 items-center'>
      {visible.map((node, index) => (
        <span key={index} className='flex items-center'>
          {index > 0 ? (
            <span className={cn('h-px w-[7px]', node === 'pending' ? 'bg-border-default' : 'bg-status-success/50')} />
          ) : null}
          <span className={cn('relative size-1.5 rounded-full', NODE_CLASS[node])}>
            {node === 'live' ? (
              <span className='absolute inset-0 animate-ping rounded-full bg-status-info [animation-duration:1.6s] motion-reduce:animate-none' />
            ) : null}
          </span>
        </span>
      ))}
    </span>
  )
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

function RunTaskBar({ entry, onOpen }: { entry: QuickRunEntry; onOpen: (runId: string) => void }) {
  const queryClient = useQueryClient()
  const remove = useQuickRunStore((state) => state.remove)
  const setStatus = useQuickRunStore((state) => state.setStatus)
  const canCancel = useCan('run:cancel')
  const { run } = useRunObservation(entry.runId)
  const progress = runProgress(run)
  const active = isActiveRunStatus(run?.status ?? entry.status)
  const now = useNow(active)
  const [cancelOpen, setCancelOpen] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const hovered = useRef(false)
  const settled = useRef(false)

  useEffect(() => {
    if (run?.status) setStatus(entry.runId, run.status)
  }, [entry.runId, run?.status, setStatus])

  // 结束时刷新列表与计数一次。
  useEffect(() => {
    if (!run || active || settled.current) return
    settled.current = true
    void queryClient.invalidateQueries({ queryKey: ['scenarios'] })
  }, [run, active, queryClient])

  // 通过且证据完整：3 秒后淡出；指针停留或标签页不可见时暂停。其余结论保持到手动关闭。
  const autoDismiss = !active && progress.phase === 'passed' && !progress.evidenceIncomplete
  useEffect(() => {
    if (!autoDismiss) return
    let timer: ReturnType<typeof setTimeout>
    const schedule = () => {
      timer = setTimeout(() => {
        if (hovered.current || document.visibilityState !== 'visible') schedule()
        else setLeaving(true)
      }, 3000)
    }
    schedule()
    return () => clearTimeout(timer)
  }, [autoDismiss])
  useEffect(() => {
    if (!leaving) return
    const timer = setTimeout(() => remove(entry.runId), 150)
    return () => clearTimeout(timer)
  }, [leaving, entry.runId, remove])

  const startedAt = run?.startedAt ?? run?.createdAt
  const endedAt = run?.finishedAt
  const elapsed = startedAt ? (endedAt ? Date.parse(endedAt) : now) - Date.parse(startedAt) : now - entry.startedAt

  let text: string
  let textClass = 'text-muted-foreground'
  if (cancelling && active) text = '正在取消…'
  else if (progress.phase === 'running') text = progress.current ? `第 ${progress.current.ordinal} 步 · ${progress.current.name}` : '排队中'
  else if (progress.phase === 'waiting') {
    text = run?.status === 'WAITING_FOR_AUTH' ? '等待登录目标系统' : run?.status === 'NEEDS_REVIEW' ? '等待人工核查' : '已挂起，等待处理'
    textClass = 'text-status-warning-foreground'
  } else if (progress.phase === 'passed') {
    // 与卡片同一套结论文字：有检查且通过叫「通过」，没有检查叫「已完成」。
    const label = runVerdict(run).label
    text = `${progress.evidenceIncomplete ? `${label}，但证据不全` : label} · 用时 ${formatDurationMs(elapsed)}`
    textClass = progress.evidenceIncomplete ? 'text-status-warning-foreground' : 'text-status-success-foreground'
  } else if (progress.phase === 'attention') {
    text = `${runVerdict(run).label} · 用时 ${formatDurationMs(elapsed)}`
    textClass = 'text-status-warning-foreground'
  } else if (progress.phase === 'failed') {
    text = progress.failure ? `第 ${progress.failure.ordinal} 步失败：${progress.failure.reason}` : '检查未通过'
    textClass = 'text-status-error-foreground'
  } else text = '已取消'

  const finished = !active
  return (
    <div
      role='status'
      aria-label={`${entry.scenarioName}：${text}`}
      onPointerEnter={() => (hovered.current = true)}
      onPointerLeave={() => (hovered.current = false)}
      className={cn(
        'pointer-events-auto grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-lg border border-border-menu bg-card py-2.5 pr-2.5 pl-3 shadow-menu',
        'animate-in fade-in-0 slide-in-from-bottom-3 duration-200 motion-reduce:animate-none',
        'transition-[opacity,translate] duration-150',
        leaving && 'translate-y-2 opacity-0',
      )}
    >
      <PhaseTile phase={progress.phase} status={run?.status} />
      <div className='min-w-0'>
        <p className='flex min-w-0 items-baseline gap-1.5 text-small font-semibold text-text-primary'>
          <span className='truncate'>{entry.scenarioName}</span>
          {entry.versionNo ? <span className='shrink-0 text-label font-medium text-muted-foreground'>v{entry.versionNo}</span> : null}
        </p>
        <div className='mt-0.5 flex min-w-0 items-center gap-2.5 text-label'>
          <ExecutionTrack nodes={progress.nodes} />
          <span className={cn('min-w-0 truncate', textClass)}>{text}</span>
          {active ? <span className='ml-auto shrink-0 text-muted-foreground tabular-nums'>{formatDurationMs(elapsed)}</span> : null}
        </div>
      </div>
      <div className='flex items-center gap-0.5'>
        {progress.phase === 'failed' ? (
          <Button size='sm' variant='secondary' onClick={() => onOpen(entry.runId)}>
            <PanelRight />
            查看复盘
          </Button>
        ) : progress.phase === 'waiting' && run?.status === 'WAITING_FOR_AUTH' ? (
          <Button size='sm' variant='secondary' onClick={() => onOpen(entry.runId)}>
            <LogIn />
            去登录
          </Button>
        ) : (
          <Button size='sm' variant='ghost' onClick={() => onOpen(entry.runId)}>
            <PanelRight />
            查看
          </Button>
        )}
        {active && canCancel ? (
          <Button
            size='sm'
            variant='ghost'
            disabled={cancelling}
            onClick={() => setCancelOpen(true)}
            className='hover:bg-status-error-background hover:text-status-error-foreground'
          >
            <Square />
            终止
          </Button>
        ) : null}
        {finished ? (
          <Button size='icon' variant='ghost' className='size-8' aria-label='关闭' onClick={() => setLeaving(true)}>
            <X />
          </Button>
        ) : null}
      </div>
      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title='终止这次运行？'
        desc='已经执行的步骤不会回滚；终止要等执行节点确认后才会生效。'
        confirmText='终止'
        destructive
        handleConfirm={() => {
          setCancelOpen(false)
          setCancelling(true)
          cancelRun(entry.runId).catch((error) => {
            setCancelling(false)
            toast.error(error instanceof ApiRequestError ? error.message : '终止失败')
          })
        }}
      />
    </div>
  )
}

/** 页面内的运行任务条：贴在主区底部居中，跟随主区宽度（助手面板展开时一并收窄）。 */
export function RunTaskDock({ onOpen }: { onOpen: (runId: string) => void }) {
  const runs = useQuickRunStore((state) => state.runs)
  const hasRuns = runs.length > 0
  const [box, setBox] = useState<{ left: number; width: number } | null>(null)

  useEffect(() => {
    const main = document.getElementById('content')
    if (!main) return
    const measure = () => {
      const rect = main.getBoundingClientRect()
      setBox({ left: rect.left, width: rect.width })
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(main)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [hasRuns])

  if (runs.length === 0) return null
  const live = runs.slice(-MAX_LIVE_RUNS)
  const hidden = runs.length - live.length
  return (
    <div
      className='pointer-events-none fixed bottom-5 z-40 flex justify-center px-4'
      style={box ? { left: box.left, width: box.width } : { left: 0, right: 0 }}
    >
      <div className='flex w-full max-w-[620px] flex-col gap-2'>
        {hidden > 0 ? (
          <Link
            to='/runs'
            className='pointer-events-auto self-center rounded-full border border-border-menu bg-card px-3 py-1 text-label text-text-secondary shadow-menu hover:text-link'
          >
            另有 {hidden} 个运行 · 在运行记录里查看
          </Link>
        ) : null}
        {live.map((entry) => (
          <RunTaskBar key={entry.runId} entry={entry} onOpen={onOpen} />
        ))}
      </div>
    </div>
  )
}
