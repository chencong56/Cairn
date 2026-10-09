import * as React from 'react'
import { Bar, CartesianGrid, ComposedChart, Line, ReferenceLine, XAxis, YAxis } from 'recharts'
import type { DurationVersionBoundary, ScenarioDurationBucket } from '@cairn/shared'
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { bucketLabel, formatMs, formatRatio } from '../format'

const chartConfig: ChartConfig = {
  succeeded: { label: '成功', color: 'var(--chart-4)' },
  failed: { label: '失败', color: 'var(--status-error)' },
  activeP50: { label: '执行耗时 P50', color: 'var(--chart-1)' },
  activeP95: { label: '执行耗时 P95', color: 'var(--chart-2)' },
  totalP50: { label: '总耗时 P50', color: 'var(--chart-3)' },
}

/** 运行级趋势：柱为运行次数，线为执行耗时 P50 / P95，虚线为总耗时 P50；竖线为版本发布。 */
export function RunTrendChart({
  buckets,
  boundaries,
  granularity,
}: {
  buckets: ScenarioDurationBucket[]
  boundaries: DurationVersionBoundary[]
  granularity: 'day' | 'week'
}) {
  const data = React.useMemo(() => buckets.map((bucket) => ({ ...bucket, label: bucketLabel(bucket.bucket) })), [buckets])
  // 样本落在少数几个桶时折线连不起来，显示数据点
  const dot = buckets.filter((bucket) => bucket.activeP50 !== null).length <= 12 ? { r: 3 } : false
  const boundaryLabels = React.useMemo(() => {
    // 版本分界落到所在桶：取不晚于发布时刻的最后一个桶
    return boundaries.map((boundary) => {
      const at = boundary.at.slice(0, 10)
      const bucket = [...buckets].reverse().find((b) => b.bucket <= at) ?? buckets[0]
      return { label: bucket ? bucketLabel(bucket.bucket) : null, versionNo: boundary.versionNo }
    })
  }, [boundaries, buckets])

  return (
    <div className='h-72 w-full'>
      <ChartContainer config={chartConfig} className='h-full w-full'>
        <ComposedChart data={data} margin={{ top: 12, right: 8, left: -8, bottom: 0 }}>
          <CartesianGrid vertical={false} strokeDasharray='3 3' stroke='var(--border-divider)' />
          <XAxis dataKey='label' tickLine={false} axisLine={false} tickMargin={6} minTickGap={12} fontSize='var(--font-size-label)' />
          <YAxis yAxisId='ms' tickLine={false} axisLine={false} width={68} tickFormatter={(v: number) => formatMs(v)} fontSize='var(--font-size-label)' />
          <YAxis yAxisId='runs' orientation='right' tickLine={false} axisLine={false} width={32} allowDecimals={false} fontSize='var(--font-size-label)' />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(_, payload) => {
                  const point = payload?.[0]?.payload as (ScenarioDurationBucket & { label: string }) | undefined
                  if (!point) return null
                  return `${granularity === 'week' ? `${point.bucket} 起一周` : point.bucket} · 样本 ${point.samples} · 等待占比 ${formatRatio(point.waitRatio)}`
                }}
                formatter={(value, name) => (name === 'succeeded' || name === 'failed' ? `${value} 次` : formatMs(Number(value)))}
              />
            }
          />
          <ChartLegend content={<ChartLegendContent />} />
          <Bar yAxisId='runs' dataKey='succeeded' stackId='runs' fill='var(--color-succeeded)' opacity={0.35} />
          <Bar yAxisId='runs' dataKey='failed' stackId='runs' fill='var(--color-failed)' opacity={0.45} radius={[2, 2, 0, 0]} />
          <Line yAxisId='ms' dataKey='activeP50' stroke='var(--color-activeP50)' strokeWidth={2} dot={dot} connectNulls />
          <Line yAxisId='ms' dataKey='activeP95' stroke='var(--color-activeP95)' strokeWidth={1.5} dot={dot} connectNulls />
          <Line yAxisId='ms' dataKey='totalP50' stroke='var(--color-totalP50)' strokeWidth={1.5} strokeDasharray='4 3' dot={dot} connectNulls />
          {boundaryLabels.map((boundary, index) =>
            boundary.label ? (
              <ReferenceLine
                key={`${boundary.label}-${index}`}
                yAxisId='ms'
                x={boundary.label}
                stroke='var(--status-warning)'
                strokeDasharray='2 2'
                label={{ value: boundary.versionNo ? `v${boundary.versionNo}` : '新版本', position: 'top', fontSize: 'var(--font-size-label)', fill: 'var(--status-warning)' }}
              />
            ) : null,
          )}
        </ComposedChart>
      </ChartContainer>
    </div>
  )
}
