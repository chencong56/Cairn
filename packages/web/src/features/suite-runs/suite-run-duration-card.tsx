import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ChevronDown, Timer } from 'lucide-react'
import { formatDurationShort } from '@cairn/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Skeleton } from '@/components/ui/skeleton'
import { fetchSuiteRunDuration } from '@/lib/duration-api'
import { cn } from '@/lib/utils'

function ms(value: number | null): string {
  return value === null ? '—' : formatDurationShort(value)
}

function signed(value: number | null): string {
  return value === null ? '—' : `${value < 0 ? '−' : '+'}${formatDurationShort(value)}`
}

/** 场景集运行「与上次对比」：总墙钟差值中有多少来自排队、多少来自关键路径上的成员。 */
export function SuiteRunDurationCard({ suiteRunId, suiteId, targetId }: { suiteRunId: string; suiteId: string; targetId: string }) {
  const [open, setOpen] = React.useState(false)
  const query = useQuery({ queryKey: ['suite-run-duration', suiteRunId], queryFn: () => fetchSuiteRunDuration(suiteRunId), enabled: open })
  const data = query.data
  return (
    <Collapsible open={open} onOpenChange={setOpen} className='rounded-lg border border-border-card bg-card shadow-card'>
      <div className='flex flex-wrap items-center justify-between gap-2 px-4 py-3'>
        <CollapsibleTrigger className='group flex items-center gap-2 text-body font-semibold text-text-primary'>
          <Timer className='size-4 text-primary' />
          与上次对比
          <ChevronDown className='size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none' />
        </CollapsibleTrigger>
        <Button variant='ghost' size='sm' asChild className='h-7 text-label'>
          <Link to='/duration-analysis' search={{ targetId, suiteId }}>
            查看场景集耗时分析
          </Link>
        </Button>
      </div>
      <CollapsibleContent className='border-t border-border-divider px-4 py-3'>
        {query.isError ? (
          <p className='text-label text-status-error'>对比数据加载失败。</p>
        ) : !data ? (
          <Skeleton className='h-20 w-full' />
        ) : (
          <div className='flex flex-col gap-3'>
            <p className='text-body font-medium text-text-primary'>{data.summary}</p>
            {data.base ? (
              <p className='text-label text-muted-foreground'>
                本次 {ms(data.suiteRun.wallMs)} · 上次 {ms(data.base.wallMs)} · 关键路径 {signed(data.criticalPathDeltaMs)} · 关键路径成员排队 {signed(data.queueDeltaMs)}
              </p>
            ) : null}
            {data.members.length ? (
              <div className='overflow-x-auto'>
                <table className='w-full text-label'>
                  <thead>
                    <tr className='text-left text-muted-foreground'>
                      <th className='py-1 pr-2 font-normal'>成员</th>
                      <th className='py-1 pr-2 font-normal'>阶段</th>
                      <th className='py-1 pr-2 font-normal'>上次</th>
                      <th className='py-1 pr-2 font-normal'>本次</th>
                      <th className='py-1 pr-2 font-normal'>差值</th>
                      <th className='py-1 font-normal'>开跑前排队</th>
                    </tr>
                  </thead>
                  <tbody className='divide-y divide-border-divider'>
                    {data.members.map((member) => (
                      <tr key={member.memberId}>
                        <td className='max-w-56 py-1.5 pr-2'>
                          <span className='flex min-w-0 items-center gap-1'>
                            {member.runId ? (
                              <Link to='/runs/$runId' params={{ runId: member.runId }} search={{ duration: 'compare' }} className='truncate text-primary hover:underline' title={member.name}>
                                {member.name}
                              </Link>
                            ) : (
                              <span className='truncate text-text-primary'>{member.name}</span>
                            )}
                            {member.onCriticalPath ? <Badge variant='outline' className='shrink-0 text-status-warning'>关键路径</Badge> : null}
                          </span>
                        </td>
                        <td className='py-1.5 pr-2 text-muted-foreground'>{member.stage}</td>
                        <td className='py-1.5 pr-2 font-mono tabular-nums'>{ms(member.baseTotalMs)}</td>
                        <td className='py-1.5 pr-2 font-mono tabular-nums'>{ms(member.totalMs)}</td>
                        <td className={cn('py-1.5 pr-2 font-mono tabular-nums', (member.deltaMs ?? 0) >= 1000 ? 'text-status-error' : (member.deltaMs ?? 0) <= -1000 ? 'text-status-success' : 'text-text-secondary')}>
                          {signed(member.deltaMs)}
                        </td>
                        <td className='py-1.5 font-mono tabular-nums text-muted-foreground'>
                          {ms(member.queueMs)}
                          {member.baseQueueMs !== null ? <span className='ml-1'>（上次 {ms(member.baseQueueMs)}）</span> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}
