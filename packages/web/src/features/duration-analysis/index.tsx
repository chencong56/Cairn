import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { ChevronDown } from 'lucide-react'
import { DURATION_MIN_SAMPLES, type TargetDurationScenario } from '@cairn/shared'
import { EmptyState } from '@/components/empty-state'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Label } from '@/components/ui/label'
import { SelectField, SelectFieldOption } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { fetchTargetDurationAnalysis } from '@/lib/duration-api'
import { fetchSuites } from '@/lib/suites-api'
import { fetchTargets } from '@/lib/targets-api'
import { PeriodReportMenu } from './components/period-report-menu'
import { ReportSubscriptionsButton } from './components/report-subscriptions-dialog'
import { ScenarioTile } from './components/scenario-tile'
import { SuiteSummaryCard } from './components/suite-summary'
import { filtersOf, filtersToSearch, type TargetDurationSearch } from './search'
import { formatMs, formatRatio, type DurationFilters } from './format'
import { CaliberNote, FilterBar, KpiCard, dataNotes } from './shared'

const route = getRouteApi('/_authenticated/duration-analysis/')
const TARGET_KEY = 'cairn.duration-analysis.targetId'

function rememberedTarget(): string | null {
  try {
    return localStorage.getItem(TARGET_KEY)
  } catch {
    return null
  }
}

function rememberTarget(targetId: string) {
  try {
    localStorage.setItem(TARGET_KEY, targetId)
  } catch {
    // 浏览器存储不可用时不记忆
  }
}

function sortScenarios(items: TargetDurationScenario[], sort: TargetDurationSearch['sort']): TargetDurationScenario[] {
  const copy = [...items]
  if (sort === 'name') return copy.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  if (sort === 'p95') return copy.sort((a, b) => (b.activeP95 ?? -1) - (a.activeP95 ?? -1))
  // 按涨幅：变慢的排前面，无法比较的排后面
  return copy.sort((a, b) => (b.activeP50.deltaPct ?? -Infinity) - (a.activeP50.deltaPct ?? -Infinity))
}

export function DurationAnalysisPage() {
  const search = route.useSearch()
  const navigate = useNavigate()
  const filters = filtersOf(search)

  const patch = React.useCallback(
    (next: Partial<TargetDurationSearch>, replace = false) => {
      void navigate({ to: '/duration-analysis', replace, search: { ...search, ...next } })
    },
    [navigate, search],
  )

  const targets = useQuery({ queryKey: ['targets', { limit: 100 }], queryFn: () => fetchTargets({ limit: 100 }) })
  const targetItems = targets.data?.items ?? []
  const remembered = rememberedTarget()
  const targetId =
    search.targetId ?? (remembered && targetItems.some((t) => t.id === remembered) ? remembered : targetItems[0]?.id)

  React.useEffect(() => {
    if (!search.targetId && targetId) patch({ targetId }, true)
    if (targetId) rememberTarget(targetId)
  }, [search.targetId, targetId, patch])

  const suites = useQuery({
    queryKey: ['suites', { targetId, limit: 100 }],
    queryFn: () => fetchSuites({ targetId, limit: 100 }),
    enabled: Boolean(targetId),
  })

  const analysis = useQuery({
    queryKey: ['duration-analysis', 'target', targetId, filters, search.suiteId ?? null],
    queryFn: () => fetchTargetDurationAnalysis(targetId!, { ...filters, suiteId: search.suiteId }),
    enabled: Boolean(targetId),
  })

  const onFilters = (next: Partial<DurationFilters>) => patch(filtersToSearch({ ...filters, ...next }))
  const scenarioSearch = filtersToSearch(filters)
  const data = analysis.data
  const withData = (data?.scenarios ?? []).filter((s) => s.runs > 0)
  const noData = (data?.scenarios ?? []).filter((s) => s.runs === 0)
  const visible = sortScenarios(withData, search.sort).filter(
    (s) => (!search.slower || (s.activeP50.deltaPct ?? 0) >= 20) && (!search.issues || s.insights.length > 0),
  )

  return (
    <Main className='flex min-w-0 flex-1 flex-col gap-5'>
      <PageHeader title='耗时分析' description='选定目标系统，看它下面各场景的耗时走势、环比同比与隐藏问题；点击场景看到每一步。' />

      <div className='flex flex-col gap-2'>
        <FilterBar value={filters} onChange={onFilters} timeZone={data?.window.tz}>
          <SelectField
            className='w-52'
            aria-label='目标系统'
            placeholder={targets.isLoading ? '加载中…' : '选择目标系统'}
            value={targetId ?? ''}
            onValueChange={(next) => patch({ targetId: next, suiteId: undefined })}
          >
            {targetItems.map((target) => (
              <SelectFieldOption key={target.id} value={target.id}>
                {target.name}
              </SelectFieldOption>
            ))}
          </SelectField>
          <SelectField
            className='w-60'
            aria-label='场景集'
            value={search.suiteId ?? 'all'}
            disabled={!targetId}
            onValueChange={(next) => patch({ suiteId: next === 'all' ? undefined : next })}
          >
            <SelectFieldOption value='all'>全部场景</SelectFieldOption>
            {(suites.data?.items ?? []).map((suite) => (
              <SelectFieldOption key={suite.id} value={suite.id}>
                场景集：{suite.name}
              </SelectFieldOption>
            ))}
          </SelectField>
        </FilterBar>
        <div className='flex flex-wrap items-center justify-between gap-2'>
          <CaliberNote extra={dataNotes(data).join(' · ') || undefined} />
          {targetId ? (
            <div className='flex flex-wrap items-center gap-2'>
              <PeriodReportMenu targetId={targetId} suiteId={search.suiteId} filters={filters} timeZone={data?.window.tz} />
              <ReportSubscriptionsButton targetId={targetId} suiteId={search.suiteId} suites={(suites.data?.items ?? []).map((suite) => ({ id: suite.id, name: suite.name }))} />
            </div>
          ) : null}
        </div>
      </div>

      {targets.isSuccess && targetItems.length === 0 ? (
        <EmptyState title='没有可查看的目标系统' description='当前账号没有可读的目标系统，请联系管理员分配目标范围。' />
      ) : analysis.isError ? (
        <QueryErrorState onRetry={() => void analysis.refetch()} />
      ) : !data ? (
        <PageSkeleton />
      ) : (
        <>
          <div className='grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6'>
            <KpiCard label='可比运行' value={`${data.kpis.runs} 次`} hint={`${withData.length} 个场景有运行`} />
            <KpiCard label='执行耗时 P50' value={formatMs(data.kpis.activeP50.current)} comparison={data.kpis.activeP50} />
            <KpiCard label='等待占比' value={formatRatio(data.kpis.waitRatio.current)} comparison={data.kpis.waitRatio} ratio />
            <KpiCard label='开跑前排队 P50' value={formatMs(data.kpis.queueP50.current)} comparison={data.kpis.queueP50} />
            <KpiCard label='变慢 / 变快场景' value={`${data.kpis.slower} / ${data.kpis.faster}`} hint='执行耗时 P50 变化 ≥ 20%' />
            <KpiCard label='隐藏问题' value={`${data.kpis.insightCount} 项`} hint='报表侧标注，不影响运行结论' />
          </div>

          {data.suite ? <SuiteSummaryCard suite={data.suite} /> : null}

          <section className='flex flex-col gap-3'>
            <div className='flex flex-wrap items-center justify-between gap-3'>
              <h2 className='text-section font-semibold text-text-primary'>
                {data.suite ? '成员场景' : '各场景耗时'}
                <span className='ml-2 text-label font-normal text-muted-foreground'>{visible.length} 个</span>
              </h2>
              <div className='flex flex-wrap items-center gap-4'>
                <div className='flex items-center gap-2'>
                  <Switch id='duration-slower' checked={Boolean(search.slower)} onCheckedChange={(checked) => patch({ slower: checked || undefined })} />
                  <Label htmlFor='duration-slower' className='text-label'>只看变慢</Label>
                </div>
                <div className='flex items-center gap-2'>
                  <Switch id='duration-issues' checked={Boolean(search.issues)} onCheckedChange={(checked) => patch({ issues: checked || undefined })} />
                  <Label htmlFor='duration-issues' className='text-label'>只看有问题</Label>
                </div>
                <SelectField className='w-32' aria-label='排序' value={search.sort ?? 'delta'} onValueChange={(next) => patch({ sort: next === 'delta' ? undefined : (next as TargetDurationSearch['sort']) })}>
                  <SelectFieldOption value='delta'>按涨幅</SelectFieldOption>
                  <SelectFieldOption value='p95'>按 P95</SelectFieldOption>
                  <SelectFieldOption value='name'>按名称</SelectFieldOption>
                </SelectField>
              </div>
            </div>
            {visible.length === 0 ? (
              <EmptyState
                title={withData.length === 0 ? '时间窗内没有可比运行' : '没有符合条件的场景'}
                description={withData.length === 0 ? '换一个时间窗或发起方试试；试跑与地图采集不计入耗时分析。' : '关闭「只看变慢」或「只看有问题」查看全部场景。'}
              />
            ) : (
              <div className='grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4'>
                {visible.map((scenario) => (
                  <ScenarioTile key={scenario.scenarioId} scenario={scenario} search={scenarioSearch} />
                ))}
              </div>
            )}
            {noData.length > 0 ? (
              <Collapsible>
                <CollapsibleTrigger className='group flex items-center gap-1 text-label text-muted-foreground hover:text-text-primary'>
                  <ChevronDown className='size-3.5 transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none' />
                  暂无数据的场景 {noData.length} 个
                </CollapsibleTrigger>
                <CollapsibleContent className='pt-2'>
                  <p className='text-label text-muted-foreground'>{noData.map((s) => s.name).join('、')}</p>
                </CollapsibleContent>
              </Collapsible>
            ) : null}
            <p className='text-label text-text-muted'>样本少于 {DURATION_MIN_SAMPLES} 次的场景淡化显示，不给涨跌。</p>
          </section>
        </>
      )}
    </Main>
  )
}
