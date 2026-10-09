import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { DURATION_INSIGHT_LABELS, type DurationNodeRow } from '@cairn/shared'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { Button } from '@/components/ui/button'
import { useBreadcrumb } from '@/stores/breadcrumb-store'
import { fetchScenarioDurationAnalysis, fetchScenarioNodeChildren } from '@/lib/duration-api'
import { NodeHistorySheet } from './components/node-history-sheet'
import { NodeTable } from './components/node-table'
import { RunTrendChart } from './components/run-trend-chart'
import { filtersOf, filtersToSearch } from './search'
import { COMPARE_LABELS, formatMs, formatRatio, type DurationFilters } from './format'
import { CaliberNote, FilterBar, KpiCard, dataNotes } from './shared'

const route = getRouteApi('/_authenticated/duration-analysis/scenarios/$scenarioId/')

export function ScenarioDurationPage() {
  const { scenarioId } = route.useParams()
  const search = route.useSearch()
  const navigate = useNavigate()
  const filters = filtersOf(search)
  const [openNode, setOpenNode] = React.useState<DurationNodeRow | null>(null)

  const analysis = useQuery({
    queryKey: ['duration-analysis', 'scenario', scenarioId, filters],
    queryFn: () => fetchScenarioDurationAnalysis(scenarioId, filters),
  })
  const data = analysis.data
  useBreadcrumb({ entityId: scenarioId, title: data?.scenario.name })

  const onFilters = (next: Partial<DurationFilters>) =>
    void navigate({
      to: '/duration-analysis/scenarios/$scenarioId',
      params: { scenarioId },
      search: { ...search, ...filtersToSearch({ ...filters, ...next }) },
    })

  const scenarioInsights = (data?.insights ?? []).filter((insight) => insight.nodeKey === null)
  const nodeInsights = (data?.insights ?? []).filter((insight) => insight.nodeKey !== null)

  return (
    <Main className='flex min-w-0 flex-1 flex-col gap-5'>
      <PageHeader
        title={data ? `${data.scenario.name} · 耗时分析` : '场景耗时分析'}
        description={data ? `目标系统：${data.scenario.targetName}` : undefined}
        parent={
          <Button variant='ghost' size='sm' asChild className='-ml-2 h-7 px-2 text-label'>
            <Link to='/duration-analysis' search={{ ...filtersToSearch(filters), targetId: data?.scenario.targetId }}>
              <ArrowLeft className='size-3.5' />
              耗时分析
            </Link>
          </Button>
        }
        actions={
          <Button variant='outline' size='sm' asChild>
            <Link to='/runs' search={{ scenarioId }}>
              查看运行记录
            </Link>
          </Button>
        }
      />

      <div className='flex flex-col gap-2'>
        <FilterBar value={filters} onChange={onFilters} timeZone={data?.window.tz} />
        <CaliberNote
          extra={
            data
              ? [
                  `对比：${COMPARE_LABELS[filters.compare]}`,
                  data.incompleteRuns ? `${data.incompleteRuns} 次成功运行缺少分解，只计总耗时` : null,
                  ...dataNotes(data),
                ]
                  .filter(Boolean)
                  .join(' · ')
              : undefined
          }
        />
      </div>

      {analysis.isError ? (
        <QueryErrorState onRetry={() => void analysis.refetch()} />
      ) : !data ? (
        <PageSkeleton />
      ) : (
        <>
          <div className='grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6'>
            <KpiCard label='执行耗时 P50' value={formatMs(data.kpis.activeP50.current)} comparison={data.kpis.activeP50} />
            <KpiCard label='执行耗时 P95' value={formatMs(data.kpis.activeP95.current)} comparison={data.kpis.activeP95} />
            <KpiCard label='总耗时 P50' value={formatMs(data.kpis.totalP50.current)} comparison={data.kpis.totalP50} />
            <KpiCard label='等待占比' value={formatRatio(data.kpis.waitRatio.current)} comparison={data.kpis.waitRatio} ratio />
            <KpiCard label='开跑前排队 P50' value={formatMs(data.kpis.queueP50.current)} comparison={data.kpis.queueP50} />
            <KpiCard label='运行 / 样本' value={`${data.kpis.runs} / ${data.kpis.samples}`} hint='样本为成功且分解完整的运行' />
          </div>

          {data.insights.length > 0 ? (
            <section className='flex flex-col gap-2 rounded-lg border border-border-card bg-card p-4 shadow-card'>
              <h2 className='text-body font-semibold text-text-primary'>隐藏问题 {data.insights.length} 项</h2>
              <ul className='flex flex-col gap-1.5 text-label'>
                {[...scenarioInsights, ...nodeInsights].map((insight, index) => (
                  <li key={`${insight.kind}-${insight.nodeKey ?? ''}-${index}`} className='flex flex-wrap gap-x-2'>
                    <span className={insight.kind === 'faster' ? 'font-medium text-status-success' : 'font-medium text-status-warning'}>
                      {DURATION_INSIGHT_LABELS[insight.kind]}
                    </span>
                    <span className='text-text-secondary'>
                      {insight.nodeName ? `『${insight.nodeName}』` : '整次运行：'}
                      {insight.message}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className='flex flex-col gap-2 rounded-lg border border-border-card bg-card p-5 shadow-card'>
            <div>
              <h2 className='text-section font-semibold text-text-primary'>整次运行耗时走势</h2>
              <p className='mt-0.5 text-label text-muted-foreground'>柱为运行次数（成功 / 失败），实线为执行耗时 P50 / P95，虚线为总耗时 P50；两条线拉开说明等待变多</p>
            </div>
            <RunTrendChart buckets={data.buckets} boundaries={data.versionBoundaries} granularity={data.window.granularity} />
          </section>

          <NodeTable
            nodes={data.nodes}
            onOpen={setOpenNode}
            childrenQueryKey={['duration-analysis', 'children', scenarioId, filters]}
            fetchChildren={async (parentKey) => (await fetchScenarioNodeChildren(scenarioId, { ...filters, parentKey })).nodes}
          />
        </>
      )}

      <NodeHistorySheet scenarioId={scenarioId} node={openNode} filters={filters} onClose={() => setOpenNode(null)} />
    </Main>
  )
}
