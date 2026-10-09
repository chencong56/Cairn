import * as React from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import {
  DURATION_INSIGHT_LABELS,
  DURATION_MIN_SAMPLES,
  durationPeriodBaseLabel,
  durationPeriodLabel,
  shiftLocalDate,
  shiftLocalMonth,
  type DurationComparison,
  type DurationCompareMode,
  type DurationInsight,
  type DurationPeriodKind,
  type DurationTriggerFilter,
} from '@cairn/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SelectField, SelectFieldOption } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { COMPARE_LABELS, TRIGGER_LABELS, deltaTone, formatMs, formatPct, formatRatio, latestPeriodStart, timeZoneLabel, type DurationFilters } from './format'

export function DeltaText({ pct, unit, className }: { pct: number | null | undefined; unit?: string; className?: string }) {
  // 比例类（百分点）上升 10 个点以上提示，其余按耗时涨跌着色
  const tone = unit ? (pct !== null && pct !== undefined && pct >= 10 ? 'text-status-warning' : 'text-text-secondary') : deltaTone(pct)
  return <span className={cn('font-mono tabular-nums', tone, className)}>{formatPct(pct, unit)}</span>
}

export function KpiCard({
  label,
  value,
  comparison,
  ratio,
  hint,
}: {
  label: string
  value: string
  comparison?: DurationComparison
  /** 比例类：对比值为百分点差。 */
  ratio?: boolean
  hint?: string
}) {
  const insufficient = comparison && (comparison.currentSamples < DURATION_MIN_SAMPLES || comparison.baseSamples < DURATION_MIN_SAMPLES)
  return (
    <div className='flex min-w-0 flex-col gap-1 rounded-lg border border-border-card bg-card px-4 py-3 shadow-card'>
      <span className='text-label text-muted-foreground'>{label}</span>
      <span className='text-stat font-semibold tabular-nums text-text-primary'>{value}</span>
      {comparison ? (
        <span className='flex flex-wrap items-center gap-x-2 text-label text-muted-foreground'>
          {insufficient ? (
            <span>样本不足，不比较</span>
          ) : (
            <>
              <span>对比</span>
              <DeltaText pct={comparison.deltaPct} unit={ratio ? ' 个百分点' : undefined} />
              <span className='text-text-muted'>基准 {ratio ? formatRatio(comparison.base) : formatMs(comparison.base)}</span>
            </>
          )}
        </span>
      ) : hint ? (
        <span className='text-label text-muted-foreground'>{hint}</span>
      ) : null}
    </div>
  )
}

export function InsightBadges({ insights, limit = 3 }: { insights: readonly DurationInsight[]; limit?: number }) {
  if (insights.length === 0) return null
  const shown = insights.slice(0, limit)
  return (
    <span className='flex flex-wrap items-center gap-1'>
      {shown.map((insight, index) => (
        <Tooltip key={`${insight.kind}-${insight.nodeKey ?? ''}-${index}`}>
          <TooltipTrigger asChild>
            <Badge variant='outline' className={cn('cursor-default', insight.kind === 'faster' ? 'text-status-success' : 'text-status-warning')}>
              {DURATION_INSIGHT_LABELS[insight.kind]}
            </Badge>
          </TooltipTrigger>
          <TooltipContent className='max-w-xs'>
            {insight.nodeName ? `『${insight.nodeName}』` : ''}
            {insight.message}
          </TooltipContent>
        </Tooltip>
      ))}
      {insights.length > limit ? <span className='text-label text-muted-foreground'>+{insights.length - limit}</span> : null}
    </span>
  )
}

const WINDOW_OPTIONS = [
  { value: '7', label: '近 7 天' },
  { value: '30', label: '近 30 天' },
  { value: '90', label: '近 90 天' },
  { value: 'week', label: '上周（自然周）' },
  { value: 'month', label: '上月（自然月）' },
] as const

export function FilterBar({
  value,
  onChange,
  timeZone,
  children,
}: {
  value: DurationFilters
  onChange: (next: Partial<DurationFilters>) => void
  /** 统计时区（接口返回）；自然周期按它判断「最近一个已结束的周期」。 */
  timeZone?: string
  children?: React.ReactNode
}) {
  const period = value.period
  const compareModes: DurationCompareMode[] = period ? ['prev_period', 'last_year'] : (Object.keys(COMPARE_LABELS) as DurationCompareMode[])
  const compareLabel = (mode: DurationCompareMode) =>
    period && (mode === 'prev_period' || mode === 'last_year') ? `${mode === 'prev_period' ? '环比' : '同比'}·${durationPeriodBaseLabel(period, mode)}` : COMPARE_LABELS[mode]
  return (
    <div className='flex flex-wrap items-center gap-2'>
      {children}
      <SelectField
        className='w-36'
        aria-label='时间窗'
        value={period ?? String(value.days)}
        onValueChange={(next) => {
          if (next === 'week' || next === 'month') {
            onChange({ period: next, periodStart: undefined, granularity: 'day', compare: value.compare === 'last_year' ? 'last_year' : 'prev_period' })
            return
          }
          const days = Number(next) as DurationFilters['days']
          onChange({ days, period: undefined, periodStart: undefined, ...(days === 7 ? { granularity: 'day' as const } : {}) })
        }}
      >
        {WINDOW_OPTIONS.map((option) => (
          <SelectFieldOption key={option.value} value={option.value}>
            {option.label}
          </SelectFieldOption>
        ))}
      </SelectField>
      {period ? (
        <PeriodStepper kind={period} start={value.periodStart} timeZone={timeZone} onChange={(periodStart) => onChange({ periodStart })} />
      ) : (
        <SelectField
          className='w-24'
          aria-label='粒度'
          value={value.days === 7 ? 'day' : value.granularity}
          disabled={value.days === 7}
          onValueChange={(next) => onChange({ granularity: next as DurationFilters['granularity'] })}
        >
          <SelectFieldOption value='day'>按天</SelectFieldOption>
          <SelectFieldOption value='week'>按周</SelectFieldOption>
        </SelectField>
      )}
      <SelectField className='w-36' aria-label='对比方式' value={value.compare} onValueChange={(next) => onChange({ compare: next as DurationCompareMode })}>
        {compareModes.map((mode) => (
          <SelectFieldOption key={mode} value={mode}>
            {compareLabel(mode)}
          </SelectFieldOption>
        ))}
      </SelectField>
      <SelectField className='w-32' aria-label='发起方' value={value.trigger} onValueChange={(next) => onChange({ trigger: next as DurationTriggerFilter })}>
        {(Object.keys(TRIGGER_LABELS) as DurationTriggerFilter[]).map((trigger) => (
          <SelectFieldOption key={trigger} value={trigger}>
            {TRIGGER_LABELS[trigger]}
          </SelectFieldOption>
        ))}
      </SelectField>
    </div>
  )
}

/** 自然周期翻页：最新只能到最近一个已结束的周期；回到最新时不写 periodStart，地址保持「上周 / 上月」语义。 */
function PeriodStepper({
  kind,
  start,
  timeZone,
  onChange,
}: {
  kind: DurationPeriodKind
  start?: string
  timeZone?: string
  onChange: (start: string | undefined) => void
}) {
  const latest = latestPeriodStart(kind, timeZone)
  const current = start && start <= latest ? start : latest
  const shift = (offset: number) => (kind === 'week' ? shiftLocalDate(current, offset * 7) : shiftLocalMonth(current, offset))
  const next = shift(1)
  return (
    <div className='flex items-center gap-1 rounded-md border border-border-card bg-card px-1'>
      <Button variant='ghost' size='icon' className='size-7' aria-label={kind === 'week' ? '上一周' : '上一月'} onClick={() => onChange(shift(-1))}>
        <ChevronLeft className='size-4' />
      </Button>
      <span className='min-w-0 px-1 text-label tabular-nums text-text-primary'>{durationPeriodLabel(kind, current)}</span>
      <Button
        variant='ghost'
        size='icon'
        className='size-7'
        aria-label={kind === 'week' ? '下一周' : '下一月'}
        disabled={next > latest}
        onClick={() => onChange(next === latest ? undefined : next)}
      >
        <ChevronRight className='size-4' />
      </Button>
    </div>
  )
}

/** 口径说明条：始终可见，图不「假装客观」。 */
/** 数据口径补充：按哪个时区统计、最近数据是否还在整理、是否截断。 */
export function dataNotes(data: { window: { tz: string }; truncated: boolean; aggregation: { source: 'rollup' | 'raw'; settling: boolean } } | undefined): string[] {
  if (!data) return []
  return [
    `按${timeZoneLabel(data.window.tz)}统计`,
    data.aggregation.settling ? '最近数据整理中，新完成的运行稍后计入' : null,
    data.truncated ? '运行过多，已只取最近的运行' : null,
  ].filter((note): note is string => note !== null)
}

export function CaliberNote({ extra }: { extra?: React.ReactNode }) {
  return (
    <p className='text-label text-muted-foreground'>
      以执行耗时为主（不含等登录、重新排队、待核查）· 仅统计可比运行，已排除试跑与地图采集 · 分位取成功运行 · 样本少于 {DURATION_MIN_SAMPLES} 不给涨跌 · 开跑前排队不含场景集成员（见场景集筛选）
      {extra ? <> · {extra}</> : null}
    </p>
  )
}

/** 轻量迷你趋势：小图并列时不必为每张图挂一个完整图表。 */
export function Sparkline({
  series,
  secondary,
  className,
  height = 40,
}: {
  series: readonly (number | null)[]
  secondary?: readonly (number | null)[]
  className?: string
  height?: number
}) {
  const width = 160
  const values = [...series, ...(secondary ?? [])].filter((v): v is number => v !== null)
  if (values.length === 0) {
    return <div className={cn('flex items-center text-label text-text-muted', className)} style={{ height }}>暂无样本</div>
  }
  const max = Math.max(...values)
  const min = Math.min(0, ...values)
  const span = max - min || 1
  // 空桶跳过、前后样本连成线（与图表的 connectNulls 一致）；稀疏时另画点，单个样本也看得见
  const toPoints = (points: readonly (number | null)[]) => {
    const step = points.length > 1 ? width / (points.length - 1) : 0
    return points.flatMap((value, index) =>
      value === null ? [] : [{ x: points.length > 1 ? index * step : width / 2, y: height - 3 - ((value - min) / span) * (height - 6) }],
    )
  }
  const toPath = (points: Array<{ x: number; y: number }>) =>
    points.map((p, index) => `${index === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
  const main = toPoints(series)
  const second = secondary ? toPoints(secondary) : []
  const sparse = main.length <= 12
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio='none' className={cn('w-full', className)} style={{ height }} aria-hidden>
      {second.length > 1 ? <path d={toPath(second)} fill='none' stroke='var(--chart-3)' strokeWidth={1.2} strokeDasharray='3 2' vectorEffect='non-scaling-stroke' /> : null}
      {main.length > 1 ? <path d={toPath(main)} fill='none' stroke='var(--chart-1)' strokeWidth={1.6} vectorEffect='non-scaling-stroke' /> : null}
      {sparse
        ? main.map((p, index) => (
            <line key={index} x1={p.x} y1={p.y} x2={p.x} y2={p.y} stroke='var(--chart-1)' strokeWidth={4} strokeLinecap='round' vectorEffect='non-scaling-stroke' />
          ))
        : null}
    </svg>
  )
}
