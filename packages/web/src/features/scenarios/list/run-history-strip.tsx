import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  ClipboardCheck,
  Loader2,
  LogIn,
  PauseCircle,
  XCircle,
} from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { formatRelativeTime } from '../labels'
import { runVerdict, type ListRun, type RunVerdict, type VerdictTone } from './run-verdict'

export type StripRun = ListRun & {
  id: string
  createdAt: string
  triggerSource?: string | null
  executionOrigin?: string | null
}

const SEGMENT_CLASS: Record<VerdictTone, string> = {
  success: 'bg-status-success',
  warning: 'bg-status-warning',
  error: 'bg-status-error',
  info: 'bg-status-info',
  neutral: 'bg-text-disabled',
  muted: 'bg-border-default',
}

const TRIGGER_LABELS: Record<string, string> = {
  manual: '手动触发',
  schedule: '定时触发',
  service: '服务调用',
}

const ORIGIN_LABELS: Record<string, string> = {
  suite_member: '经场景集',
  batch_item: '经批量任务',
}

function segmentTip(run: StripRun, verdict: RunVerdict): string {
  return [
    verdict.label,
    formatRelativeTime(run.createdAt),
    [run.executionOrigin ? ORIGIN_LABELS[run.executionOrigin] : undefined, run.triggerSource ? TRIGGER_LABELS[run.triggerSource] : undefined]
      .filter(Boolean)
      .join('') || undefined,
    verdict.evidenceIncomplete ? '证据不完整' : undefined,
  ]
    .filter(Boolean)
    .join(' · ')
}

/**
 * 最近几次正式运行的分段条（旧 → 新）。传 slots 时用空段补足，
 * 表示「没有更早的正式运行」；不知道更早历史时不传，避免把未知画成没有。
 */
export function RunHistoryStrip({
  runs,
  slots,
  canOpenRun = false,
}: {
  runs: StripRun[]
  slots?: number
  /** 有运行查看权限时每一段都能点进那次运行。 */
  canOpenRun?: boolean
}) {
  const pad = slots ? Math.max(0, slots - runs.length) : 0
  const latest = runs[runs.length - 1]
  return (
    <span
      role={canOpenRun ? 'group' : 'img'}
      aria-label={latest ? `最近 ${runs.length} 次正式运行，最近一次${runVerdict(latest).label}` : '还没有正式运行'}
      className='inline-flex shrink-0 items-center gap-[3px]'
    >
      {Array.from({ length: pad }, (_, index) => (
        <span key={`pad-${index}`} className='h-1.5 w-2.5 rounded-[3px] bg-border-default' />
      ))}
      {runs.length === 0 && !slots ? <span className='h-1.5 w-2.5 rounded-[3px] bg-border-default' /> : null}
      {runs.map((run) => {
        const verdict = runVerdict(run)
        const segmentClass = cn(
          'relative block h-1.5 w-2.5 rounded-[3px]',
          SEGMENT_CLASS[verdict.tone],
          verdict.evidenceIncomplete && 'ring-[1.5px] ring-status-warning ring-offset-1 ring-offset-card',
        )
        const pulse = verdict.live ? (
          // 状态灯：只在运行未结束时扩散，减少动效时静止。
          <span
            aria-hidden='true'
            className={cn(
              'absolute inset-0 animate-ping rounded-[inherit] [animation-duration:1.6s] motion-reduce:animate-none',
              SEGMENT_CLASS[verdict.tone],
            )}
          />
        ) : null
        return (
          <Tooltip key={run.id}>
            <TooltipTrigger asChild>
              {canOpenRun ? (
                <Link
                  to='/runs/$runId'
                  params={{ runId: run.id }}
                  aria-label={segmentTip(run, verdict)}
                  // 分段只有 10×6，外扩一圈透明点击区，免得点不中。
                  className={cn(segmentClass, 'z-[1] outline-none after:absolute after:-inset-1.5 focus-visible:ring-2 focus-visible:ring-ring')}
                >
                  {pulse}
                </Link>
              ) : (
              <span className={segmentClass}>
                {pulse}
              </span>
              )}
            </TooltipTrigger>
            <TooltipContent side='top'>{segmentTip(run, verdict)}</TooltipContent>
          </Tooltip>
        )
      })}
    </span>
  )
}

function VerdictIcon({ run, verdict }: { run: ListRun | null | undefined; verdict: RunVerdict }) {
  const className = 'size-3.5'
  if (verdict.bucket === 'running') {
    if (run?.status === 'WAITING_FOR_AUTH') return <LogIn aria-hidden='true' className={className} />
    if (run?.status === 'HOLDING') return <PauseCircle aria-hidden='true' className={className} />
    if (run?.status === 'NEEDS_REVIEW') return <ClipboardCheck aria-hidden='true' className={className} />
    return <Loader2 aria-hidden='true' className={cn(className, 'animate-spin motion-reduce:animate-none')} />
  }
  if (verdict.tone === 'success') return <CheckCircle2 aria-hidden='true' className={className} />
  if (verdict.tone === 'error') return <XCircle aria-hidden='true' className={className} />
  if (verdict.tone === 'warning') return <AlertTriangle aria-hidden='true' className={className} />
  if (verdict.tone === 'neutral') return <Ban aria-hidden='true' className={className} />
  return null
}

const VERDICT_CLASS: Record<VerdictTone, string> = {
  success: 'text-status-success-foreground',
  warning: 'text-status-warning-foreground',
  // 异常用警示药丸：浅红底、红字、细边，在一屏卡片里一眼跳出来。
  error:
    'rounded-sm border border-status-error-accent/30 bg-status-error-background px-1.5 text-status-error-foreground',
  info: 'text-status-info-foreground',
  neutral: 'text-status-neutral-foreground',
  muted: 'font-normal text-muted-foreground',
}

/** 结论文字：图标 + 文字 + 颜色三者都有，不只靠颜色。可选链接到该次运行。 */
export function RunVerdictLabel({
  run,
  canOpenRun,
  onOpenRun,
  showTime = true,
  extra,
}: {
  run: StripRun | null | undefined
  canOpenRun: boolean
  /** 运行还没结束时，点结论在当前页打开观测抽屉，而不是跳走。 */
  onOpenRun?: (runId: string) => void
  showTime?: boolean
  extra?: ReactNode
}) {
  const verdict = runVerdict(run)
  const body = (
    <>
      <span
        className={cn(
          'inline-flex shrink-0 items-center gap-1 text-label font-medium whitespace-nowrap',
          VERDICT_CLASS[verdict.tone],
        )}
      >
        <VerdictIcon run={run} verdict={verdict} />
        {verdict.label}
      </span>
      {run && showTime ? (
        <span className='min-w-0 truncate text-label text-muted-foreground @max-[300px]/card:hidden'>
          {formatRelativeTime(run.createdAt)}
        </span>
      ) : null}
      {extra}
    </>
  )
  if (!run || !canOpenRun) return <span className='flex min-w-0 items-center gap-2'>{body}</span>
  if (verdict.live && onOpenRun) {
    return (
      <button
        type='button'
        onClick={() => onOpenRun(run.id)}
        className='relative z-[1] flex min-w-0 items-center gap-2 rounded-sm text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring'
        title='在本页查看这次运行'
      >
        {body}
      </button>
    )
  }
  return (
    <Link
      to='/runs/$runId'
      params={{ runId: run.id }}
      className='relative z-[1] flex min-w-0 items-center gap-2 rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring'
      title='查看这次运行'
    >
      {body}
    </Link>
  )
}
