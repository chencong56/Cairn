import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { CartesianGrid, ComposedChart, Line, ReferenceLine, Scatter, XAxis, YAxis } from 'recharts'
import type { DurationNodeRow } from '@cairn/shared'
import { QueryErrorState } from '@/components/query-error-state'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { fetchScenarioNodeHistory } from '@/lib/duration-api'
import { formatMs, type DurationFilters } from '../format'

const chartConfig: ChartConfig = {
  activeMs: { label: '单次执行耗时', color: 'var(--chart-1)' },
  p50: { label: 'P50', color: 'var(--chart-3)' },
}

/** 单节点历史：每次运行一个点 + 按桶 P50 + 版本分界；点一个点跳到那次运行的「与上次对比」。 */
export function NodeHistorySheet({
  scenarioId,
  node,
  filters,
  onClose,
}: {
  scenarioId: string
  node: DurationNodeRow | null
  filters: DurationFilters
  onClose: () => void
}) {
  const navigate = useNavigate()
  const history = useQuery({
    queryKey: ['duration-analysis', 'node', scenarioId, node?.nodeKey, filters],
    queryFn: () => fetchScenarioNodeHistory(scenarioId, { ...filters, nodeKey: node!.nodeKey }),
    enabled: Boolean(node),
  })
  const data = React.useMemo(() => {
    if (!history.data) return { points: [], band: [] as Array<{ t: number; p50: number | null }> }
    const points = history.data.points
      .filter((p) => p.status === 'SUCCEEDED')
      .map((p) => ({ t: Date.parse(p.finishedAt), activeMs: p.activeMs, runId: p.runId, attempts: p.attemptCount, iterations: p.iterationCount }))
    const band = history.data.buckets.map((b) => ({ t: Date.parse(`${b.bucket}T12:00:00`), p50: b.p50 }))
    return { points, band }
  }, [history.data])
  const failed = history.data ? history.data.points.filter((p) => p.status !== 'SUCCEEDED').length : 0

  return (
    <Sheet open={Boolean(node)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side='right' className='w-full overflow-y-auto sm:max-w-2xl'>
        <SheetHeader>
          <SheetTitle>{node?.name ?? '步骤历史'}</SheetTitle>
          <SheetDescription>
            每个点是一次成功运行里这一步的执行耗时（含重试）；折线是按{filters.granularity === 'week' ? '周' : '天'}的 P50；竖线是版本发布。点击一个点查看那次运行与上次的对比。
          </SheetDescription>
        </SheetHeader>
        <div className='flex flex-col gap-3 px-4 pb-6'>
          {history.isError ? (
            <QueryErrorState onRetry={() => void history.refetch()} />
          ) : !history.data ? (
            <Skeleton className='h-72 w-full' />
          ) : data.points.length === 0 ? (
            <p className='py-10 text-center text-label text-muted-foreground'>时间窗内没有这一步的成功样本。</p>
          ) : (
            <>
              <div className='h-72 w-full'>
                <ChartContainer config={chartConfig} className='h-full w-full'>
                  <ComposedChart margin={{ top: 12, right: 8, left: -8, bottom: 0 }}>
                    <CartesianGrid strokeDasharray='3 3' stroke='var(--border-divider)' />
                    <XAxis
                      dataKey='t'
                      type='number'
                      scale='time'
                      domain={['dataMin', 'dataMax']}
                      tickFormatter={(t: number) => new Date(t).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}
                      tickLine={false}
                      axisLine={false}
                      fontSize='var(--font-size-label)'
                    />
                    <YAxis tickLine={false} axisLine={false} width={60} tickFormatter={(v: number) => formatMs(v)} fontSize='var(--font-size-label)' />
                    <ChartTooltip
                      content={
                        <ChartTooltipContent
                          labelFormatter={(_, payload) => {
                            const point = payload?.[0]?.payload as { t: number; attempts?: number; iterations?: number } | undefined
                            if (!point) return null
                            const when = new Date(point.t).toLocaleString('zh-CN', { hour12: false })
                            return point.attempts !== undefined ? `${when} · 尝试 ${point.attempts} 次 · 迭代 ${point.iterations} 次` : when
                          }}
                          formatter={(value) => formatMs(Number(value))}
                        />
                      }
                    />
                    <Line data={data.band} dataKey='p50' stroke='var(--color-p50)' strokeWidth={2} dot={data.band.filter((b) => b.p50 !== null).length <= 12 ? { r: 3 } : false} connectNulls />
                    <Scatter
                      data={data.points}
                      dataKey='activeMs'
                      fill='var(--color-activeMs)'
                      className='cursor-pointer'
                      onClick={(item) => {
                        const runId = (item as { payload?: { runId?: string } }).payload?.runId
                        if (runId) void navigate({ to: '/runs/$runId', params: { runId }, search: { duration: 'compare' } })
                      }}
                    />
                    {history.data.versionBoundaries.map((boundary) => (
                      <ReferenceLine
                        key={boundary.at}
                        x={Date.parse(boundary.at)}
                        stroke='var(--status-warning)'
                        strokeDasharray='2 2'
                        label={{ value: boundary.versionNo ? `v${boundary.versionNo}` : '新版本', position: 'top', fontSize: 'var(--font-size-label)', fill: 'var(--status-warning)' }}
                      />
                    ))}
                  </ComposedChart>
                </ChartContainer>
              </div>
              <p className='text-label text-muted-foreground'>
                成功样本 {data.points.length} 个{failed ? `，另有 ${failed} 次这一步未成功（不计入）` : ''}
                {history.data.truncated ? '；运行过多，只取最近的运行' : ''}
              </p>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
