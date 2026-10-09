import { Link } from '@tanstack/react-router'
import { DURATION_MIN_SAMPLES, type TargetDurationScenario } from '@cairn/shared'
import { cn } from '@/lib/utils'
import type { DurationSearch } from '../search'
import { formatMs } from '../format'
import { DeltaText, InsightBadges, Sparkline } from '../shared'

/** 一个场景一张小图：执行耗时 P50 / P95 走势、当前值、对比涨跌、样本数。 */
export function ScenarioTile({ scenario, search }: { scenario: TargetDurationScenario; search: DurationSearch }) {
  const lowSamples = scenario.samples < DURATION_MIN_SAMPLES
  return (
    <Link
      to='/duration-analysis/scenarios/$scenarioId'
      params={{ scenarioId: scenario.scenarioId }}
      search={search}
      className={cn(
        'group flex min-w-0 flex-col gap-2 rounded-lg border border-border-card bg-card p-4 shadow-card transition-[border-color,box-shadow] hover:border-border-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
        lowSamples && 'opacity-70',
      )}
    >
      <div className='flex min-w-0 items-start justify-between gap-2'>
        <span className='truncate text-body font-medium text-text-primary group-hover:underline' title={scenario.name}>
          {scenario.name}
        </span>
        <span className='shrink-0 text-label text-muted-foreground'>{scenario.runs} 次</span>
      </div>
      <div className='flex items-baseline gap-2'>
        <span className='text-section font-semibold tabular-nums text-text-primary'>{formatMs(scenario.activeP50.current)}</span>
        <DeltaText pct={scenario.activeP50.deltaPct} className='text-label' />
        <span className='ml-auto text-label text-muted-foreground'>P95 {formatMs(scenario.activeP95)}</span>
      </div>
      <Sparkline series={scenario.series.map((point) => point.p50)} secondary={scenario.series.map((point) => point.p95)} />
      <div className='flex min-h-5 flex-wrap items-center justify-between gap-1'>
        <span className='text-label text-muted-foreground'>
          {lowSamples ? `样本 ${scenario.samples}，不足 ${DURATION_MIN_SAMPLES} 次` : `样本 ${scenario.samples}`}
        </span>
        <InsightBadges insights={scenario.insights} limit={2} />
      </div>
    </Link>
  )
}
