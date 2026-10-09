import { Link } from '@tanstack/react-router'
import { formatDurationShort, isFinishedRunStatus, type RunSummaryDto } from '@cairn/shared'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

const PARTS: Array<[keyof NonNullable<RunSummaryDto['duration']>, string]> = [
  ['activeMs', '执行'],
  ['authWaitMs', '认证等待'],
  ['requeueMs', '重新排队'],
  ['reviewMs', '待核查'],
  ['holdMs', '调试挂起'],
]

/** 运行列表的耗时列：总耗时，悬停看分解，点击进入运行详情的「与上次对比」。 */
export function RunDurationCell({ run }: { run: RunSummaryDto }) {
  if (!isFinishedRunStatus(run.status)) return <span className='text-muted-foreground'>—</span>
  const fallback = run.startedAt && run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : null
  const total = run.duration?.totalMs ?? fallback
  if (total === null || total < 0) return <span className='text-muted-foreground'>—</span>
  const duration = run.duration
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          to='/runs/$runId'
          params={{ runId: run.id }}
          search={{ duration: 'compare' }}
          className='font-mono tabular-nums text-text-primary hover:text-primary hover:underline'
        >
          {formatDurationShort(total)}
        </Link>
      </TooltipTrigger>
      <TooltipContent className='max-w-xs'>
        <div className='flex flex-col gap-0.5'>
          <span>总耗时 {formatDurationShort(total)}</span>
          {!duration ? (
            <span>分解计算中</span>
          ) : !duration.complete ? (
            <span>没有完整分解</span>
          ) : (
            PARTS.map(([key, label]) => {
              const value = duration[key] as number | null
              return value ? (
                <span key={key}>
                  {label} {formatDurationShort(value)}
                </span>
              ) : null
            })
          )}
          {duration?.queueMs ? <span>开跑前排队 {formatDurationShort(duration.queueMs)}（不计入总耗时）</span> : null}
          <span className='pt-1 opacity-80'>点击查看与上次对比</span>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
