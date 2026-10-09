import { Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from 'recharts'
import type { SuiteDurationSummary } from '@cairn/shared'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { bucketLabel, formatMs } from '../format'
import { DeltaText } from '../shared'

const chartConfig: ChartConfig = {
  runs: { label: '运行次数', color: 'var(--chart-4)' },
  p50: { label: '总耗时 P50', color: 'var(--chart-1)' },
  p95: { label: '总耗时 P95', color: 'var(--chart-3)' },
}

const MODE_LABELS = { sequential: '顺序执行', parallel: '并行执行' } as const

/** 场景集筛选时的整组概况：墙钟走势、关键路径近似与成员排队。 */
export function SuiteSummaryCard({ suite }: { suite: SuiteDurationSummary }) {
  const data = suite.buckets.map((bucket) => ({ ...bucket, label: bucketLabel(bucket.bucket) }))
  const dot = suite.buckets.filter((bucket) => bucket.p50 !== null).length <= 12 ? { r: 3 } : false
  return (
    <section className='grid gap-4 rounded-lg border border-border-card bg-card p-5 shadow-card lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]'>
      <div className='flex min-w-0 flex-col gap-3'>
        <div className='flex flex-wrap items-baseline justify-between gap-2'>
          <div>
            <h2 className='text-section font-semibold text-text-primary'>场景集「{suite.name}」整组耗时</h2>
            <p className='mt-0.5 text-label text-muted-foreground'>
              墙钟总耗时（场景集运行起止）· {suite.staged ? '分阶段（阶段间串行）' : MODE_LABELS[suite.executionMode]} · {suite.runs} 次运行
            </p>
          </div>
          <div className='flex items-baseline gap-2 text-label text-muted-foreground'>
            <span>
              P50 <strong className='text-body text-text-primary'>{formatMs(suite.wallP50.current)}</strong>
            </span>
            <DeltaText pct={suite.wallP50.deltaPct} />
            <span>P95 {formatMs(suite.wallP95)}</span>
          </div>
        </div>
        <div className='h-48 w-full'>
          <ChartContainer config={chartConfig} className='h-full w-full'>
            <ComposedChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
              <CartesianGrid vertical={false} strokeDasharray='3 3' stroke='var(--border-divider)' />
              <XAxis dataKey='label' tickLine={false} axisLine={false} tickMargin={6} fontSize='var(--font-size-label)' />
              <YAxis yAxisId='ms' tickLine={false} axisLine={false} width={68} tickFormatter={(v: number) => formatMs(v)} fontSize='var(--font-size-label)' />
              <YAxis yAxisId='runs' orientation='right' hide />
              <ChartTooltip content={<ChartTooltipContent formatter={(value, name) => (name === 'runs' ? `${value} 次` : formatMs(Number(value)))} />} />
              <Bar yAxisId='runs' dataKey='runs' fill='var(--color-runs)' opacity={0.35} radius={[2, 2, 0, 0]} />
              <Line yAxisId='ms' dataKey='p50' stroke='var(--color-p50)' strokeWidth={2} dot={dot} connectNulls />
              <Line yAxisId='ms' dataKey='p95' stroke='var(--color-p95)' strokeWidth={1.5} strokeDasharray='4 3' dot={dot} connectNulls />
            </ComposedChart>
          </ChartContainer>
        </div>
      </div>
      <div className='flex min-w-0 flex-col gap-2'>
        <h3 className='text-body font-medium text-text-primary'>拖慢整组的是谁（关键路径近似）</h3>
        <p className='text-label text-muted-foreground'>
          成员开跑前排队 P50 <strong className='text-text-primary'>{formatMs(suite.memberQueueP50)}</strong>
          {' · '}关键路径合计 <strong className='text-text-primary'>{formatMs(suite.criticalPathP50)}</strong>
        </p>
        {suite.criticalPath.length === 0 ? (
          <p className='text-label text-muted-foreground'>窗口内没有成员运行。</p>
        ) : (
          <ol className='flex flex-col divide-y divide-border-divider rounded-md border border-border-divider'>
            {suite.criticalPath.map((member) => (
              <li key={member.memberId} className='flex items-center justify-between gap-2 px-3 py-2 text-label'>
                <span className='min-w-0 truncate text-text-primary' title={member.name}>
                  {member.name}
                </span>
                <span className='shrink-0 text-muted-foreground'>
                  {member.stage} · <span className='font-mono tabular-nums text-text-primary'>{formatMs(member.p50)}</span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  )
}
