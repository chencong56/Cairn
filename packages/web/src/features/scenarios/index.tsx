import { useEffect, useMemo, useRef, useState } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRouteApi, useNavigate } from '@tanstack/react-router'
import type { ScenarioDto, ScenarioHealthFilter, ScenarioListSort } from '@cairn/shared'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import {
  fetchScenarios,
  fetchScenarioSummary,
  previewDeleteScenario,
  deleteScenario,
  updateScenario,
} from '@/lib/scenarios-api'
import { fetchTargets } from '@/lib/targets-api'
import { useCursorPage } from '@/hooks/use-cursor-page'
import { CursorPagination } from '@/components/data-table'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { ResourceDeleteDialog } from '@/components/resource-delete-dialog'
import { useCan } from '@/hooks/use-permissions'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/empty-state'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { QueryErrorState } from '@/components/query-error-state'
import { Can } from '@/components/rbac/can'
import { useAssistantContextBinding } from '@/features/assistant/use-assistant-context-binding'
import { RunCreateDialog } from '@/features/runs/create-dialog'
import { cn } from '@/lib/utils'
import { ScenarioCreateDialog } from './create-dialog'
import { ScenarioRunButton } from './quick-run/scenario-run-button'
import { RunTaskDock } from './quick-run/run-task-dock'
import { RunObservationSheet } from './quick-run/run-observation-sheet'
import { useQuickRunStore } from './quick-run/quick-run-store'
import { useQuickRun } from './quick-run/use-quick-run'
import { useCopyScenario } from './use-copy-scenario'
import { ScenarioCard, type ScenarioItemContext } from './list/scenario-card'
import { ScenarioCompactTable } from './list/scenario-compact-table'
import { ScenarioMoreMenu, type ScenarioMenuActions } from './list/scenario-more-menu'
import { RenameScenarioDialog } from './list/rename-scenario-dialog'
import {
  HEALTH_FILTER_LABELS,
  SCHEDULE_FILTER_LABELS,
  createdRangeInstants,
  createdRangeLabel,
  type CreatedRange,
  type ScheduleFilter,
} from './list/filter-labels'
import { useAuthStore } from '@/stores/auth-store'
import {
  FilterChips,
  ScenarioToolbar,
  type FilterChip,
  type ScenarioView,
  type StatusFilter,
} from './list/scenario-toolbar'

const route = getRouteApi('/_authenticated/scenarios/')
const VIEW_STORAGE_KEY = 'cairn:scenarios:view'

function readSavedView(): ScenarioView | undefined {
  try {
    const value = localStorage.getItem(VIEW_STORAGE_KEY)
    return value === 'grid' || value === 'list' ? value : undefined
  } catch {
    return undefined
  }
}

function saveView(view: ScenarioView) {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, view)
  } catch {
    // 记不住偏好不影响本次切换。
  }
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

type SearchPatch = Partial<{
  targetId: string | undefined
  view: ScenarioView | undefined
  status: 'active' | 'disabled' | undefined
  hasDraft: boolean | undefined
  q: string | undefined
  health: ScenarioHealthFilter[] | undefined
  schedule: ScheduleFilter | undefined
  sort: ScenarioListSort | undefined
  createdBy: string | undefined
  createdFrom: string | undefined
  createdTo: string | undefined
}>

export function ScenariosPage() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const routeSearch = route.useSearch()
  const canReadTargets = useCan('target:read')
  const canReadRuns = useCan('run:read')
  const targets = useQuery({
    queryKey: ['targets', { limit: 100 }],
    queryFn: () => fetchTargets({ limit: 100 }),
    enabled: canReadTargets,
  })

  const [savedView] = useState(readSavedView)
  const view: ScenarioView = routeSearch.view ?? savedView ?? 'grid'
  const status: StatusFilter = routeSearch.status ?? 'all'
  const targetId = routeSearch.targetId
  const hasDraft = routeSearch.hasDraft === true
  const q = routeSearch.q ?? ''
  const health = useMemo(() => routeSearch.health ?? [], [routeSearch.health])
  const schedule = routeSearch.schedule
  const sort: ScenarioListSort = routeSearch.sort ?? 'created'
  const createdBy = routeSearch.createdBy
  const createdRange: CreatedRange = useMemo(
    () => ({ from: routeSearch.createdFrom, to: routeSearch.createdTo }),
    [routeSearch.createdFrom, routeSearch.createdTo],
  )
  const currentUserId = useAuthStore((state) => state.auth.user?.id)

  const navigateList = route.useNavigate()
  const updateSearch = (patch: SearchPatch) => {
    void navigateList({ search: (prev) => ({ ...prev, ...patch }), replace: true })
  }

  // 搜索框即时响应输入，URL 去抖后再更新；URL 被外部改动（移除条件、后退）时回填输入框。
  const [searchInput, setSearchInput] = useState(q)
  const pushedQ = useRef(q)
  useEffect(() => {
    if (q !== pushedQ.current) {
      pushedQ.current = q
      setSearchInput(q)
    }
  }, [q])
  useEffect(() => {
    const next = searchInput.trim()
    if (next === pushedQ.current) return
    const timer = setTimeout(() => {
      pushedQ.current = next
      void navigateList({ search: (prev) => ({ ...prev, q: next || undefined }), replace: true })
    }, 250)
    return () => clearTimeout(timer)
  }, [searchInput, navigateList])

  // 页码按筛选条件分别记住：从场景返回时回到原页；条件变了回到第一页。
  const filterKey = JSON.stringify({ q, targetId, status, hasDraft, health, schedule, sort, createdBy, createdRange })
  const page = useCursorPage(20, `scenarios.list:${filterKey}`)
  const [pageFilterKey, setPageFilterKey] = useState(filterKey)
  if (pageFilterKey !== filterKey) {
    setPageFilterKey(filterKey)
    page.reset()
  }

  const summaryFilters = useMemo(
    () => ({
      search: q || undefined,
      targetId,
      status: status === 'all' ? undefined : status,
      hasDraft: hasDraft || undefined,
      schedule,
      createdBy,
      ...createdRangeInstants(createdRange),
    }),
    [q, targetId, status, hasDraft, schedule, createdBy, createdRange],
  )
  const filters = useMemo(
    () => ({
      ...summaryFilters,
      health: health.length > 0 ? health : undefined,
      sort,
      limit: page.pageSize,
      cursor: page.cursor,
    }),
    [summaryFilters, health, sort, page.pageSize, page.cursor],
  )
  const query = useQuery({
    queryKey: ['scenarios', filters],
    queryFn: () => fetchScenarios(filters),
    placeholderData: keepPreviousData,
  })
  // 计数只随筛选变化，不随页码与健康度变化；30 秒内复用，窗口重新聚焦时刷新。
  const summary = useQuery({
    queryKey: ['scenarios', 'summary', summaryFilters],
    queryFn: () => fetchScenarioSummary(summaryFilters),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })
  const matchedTotal = summary.data
    ? health.length > 0
      ? health.reduce((sum, bucket) => sum + summary.data.byHealth[bucket], 0)
      : summary.data.total
    : undefined

  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    // 「/」聚焦搜索：只在本页生效，输入时与弹层打开时不抢键。全局可配置快捷键要求强修饰键，故不进注册表。
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
      if (isTypingTarget(event.target) || document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return
      event.preventDefault()
      searchRef.current?.focus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  const [createOpen, setCreateOpen] = useState(false)
  const [removing, setRemoving] = useState<ScenarioDto | null>(null)
  const [renaming, setRenaming] = useState<ScenarioDto | null>(null)
  const [disabling, setDisabling] = useState<ScenarioDto | null>(null)
  const [statusSaving, setStatusSaving] = useState(false)
  const { copy, copyingId } = useCopyScenario()
  const { start, pendingId } = useQuickRun()
  const hasQuickRuns = useQuickRunStore((state) => state.runs.length > 0)
  const setQuickRunStatus = useQuickRunStore((state) => state.setStatus)
  const [sheetRunId, setSheetRunId] = useState<string | null>(null)
  const [moreOptionsFor, setMoreOptionsFor] = useState<ScenarioDto | null>(null)

  const setScenarioStatus = async (scenario: ScenarioDto, next: 'active' | 'disabled') => {
    setStatusSaving(true)
    try {
      await updateScenario(scenario.id, { status: next })
      await queryClient.invalidateQueries({ queryKey: ['scenarios'] })
      toast.success(next === 'active' ? `已启用「${scenario.name}」` : `已停用「${scenario.name}」`)
      setDisabling(null)
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '修改状态失败')
    } finally {
      setStatusSaving(false)
    }
  }

  const menuActions: ScenarioMenuActions = {
    copyingId,
    onCopy: (scenario) => void copy(scenario.id),
    onRename: setRenaming,
    onToggleStatus: (scenario) =>
      scenario.status === 'active' ? setDisabling(scenario) : void setScenarioStatus(scenario, 'active'),
    onDelete: setRemoving,
  }

  const items = useMemo(() => query.data?.items ?? [], [query.data])
  // 任务条只实时跟踪最新 3 个运行；更早的那些靠列表数据回写终态，按钮才不会一直停在「查看运行」。
  useEffect(() => {
    const tracked = new Set(useQuickRunStore.getState().runs.map((run) => run.runId))
    if (tracked.size === 0) return
    for (const scenario of items) {
      for (const run of [...(scenario.recentRuns ?? []), ...(scenario.latestRun ? [scenario.latestRun] : [])]) {
        if (tracked.has(run.id)) setQuickRunStatus(run.id, run.status)
      }
    }
  }, [items, setQuickRunStatus])
  const targetById = new Map((canReadTargets ? (targets.data?.items ?? []) : []).map((item) => [item.id, item]))
  const selectedTarget = targetId ? targetById.get(targetId) : undefined

  const contextOf = (scenario: ScenarioDto): ScenarioItemContext => {
    const target = targetById.get(scenario.targetId)
    return {
      target,
      targetLabel: target?.name ?? scenario.targetId,
      onFilterTarget: canReadTargets ? (id) => updateSearch({ targetId: id }) : undefined,
      runs: scenario.recentRuns ?? (scenario.latestRun ? [scenario.latestRun] : []),
      historyComplete: Boolean(scenario.recentRuns),
      canOpenRun: canReadRuns,
      onOpenRun: canReadRuns ? setSheetRunId : undefined,
      sort,
      menu: <ScenarioMoreMenu scenario={scenario} actions={menuActions} />,
      action: (
        <ScenarioRunButton
          scenario={scenario}
          targetDefaultAccountId={target?.defaultAccountId ?? null}
          start={start}
          pending={pendingId === scenario.id}
          onOpenRun={setSheetRunId}
          onMoreOptions={setMoreOptionsFor}
        />
      ),
    }
  }

  const chips: FilterChip[] = []
  if (targetId) {
    chips.push({
      key: 'target',
      label: `目标系统：${selectedTarget?.name ?? targetId}`,
      onRemove: () => updateSearch({ targetId: undefined }),
    })
  }
  if (hasDraft) chips.push({ key: 'draft', label: '有未发布修改', onRemove: () => updateSearch({ hasDraft: undefined }) })
  for (const bucket of health) {
    chips.push({
      key: `health:${bucket}`,
      label: `健康度：${HEALTH_FILTER_LABELS[bucket]}`,
      onRemove: () => {
        const next = health.filter((item) => item !== bucket)
        updateSearch({ health: next.length > 0 ? next : undefined })
      },
    })
  }
  if (schedule) {
    chips.push({ key: 'schedule', label: SCHEDULE_FILTER_LABELS[schedule], onRemove: () => updateSearch({ schedule: undefined }) })
  }
  if (createdBy) {
    const name =
      createdBy === currentUserId
        ? '我'
        : (summary.data?.creators?.find((creator) => creator.id === createdBy)?.displayName ?? '已选创建人')
    chips.push({ key: 'createdBy', label: `创建人：${name}`, onRemove: () => updateSearch({ createdBy: undefined }) })
  }
  if (createdRange.from || createdRange.to) {
    chips.push({
      key: 'created',
      label: `创建时间：${createdRangeLabel(createdRange)}`,
      onRemove: () => updateSearch({ createdFrom: undefined, createdTo: undefined }),
    })
  }
  if (q) chips.push({ key: 'q', label: `名称包含「${q}」`, onRemove: () => updateSearch({ q: undefined }) })
  const filtered = Boolean(
    q || targetId || hasDraft || status !== 'all' || health.length > 0 || schedule || createdBy || createdRange.from || createdRange.to,
  )
  const onlyFailing = health.length === 1 && health[0] === 'failing'
  const clearFilters = () =>
    updateSearch({
      q: undefined,
      targetId: undefined,
      hasDraft: undefined,
      status: undefined,
      health: undefined,
      schedule: undefined,
      createdBy: undefined,
      createdFrom: undefined,
      createdTo: undefined,
    })

  useAssistantContextBinding({
    page: 'scenario',
    routeKey: 'scenarios.index',
    ...(selectedTarget ? { targetId: selectedTarget.id } : {}),
    statusLabel: selectedTarget ? `场景列表 · ${selectedTarget.name}` : '场景列表',
    summaryText: selectedTarget
      ? `当前按目标系统「${selectedTarget.name}」筛选场景`
      : '当前场景列表没有绑定具体目标系统',
  })

  return (
    <>
      {/* 任务条出现时给主区底部留白，不压住分页。 */}
      <Main className={cn('flex min-w-0 flex-1 flex-col gap-6', hasQuickRuns && 'pb-36')}>
        <PageHeader
          title='场景编排'
          description='把业务任务组织成有序步骤，在同一场景中管理定义、版本与执行入口。'
          actions={
            <Can permission='workflow:write'>
              <Button onClick={() => setCreateOpen(true)}>
                <Plus />
                新建场景
              </Button>
            </Can>
          }
        />
        <section
          aria-label='场景列表'
          className='@container/panel min-w-0 rounded-lg border border-border-card bg-card shadow-card'
        >
          <ScenarioToolbar
            status={status}
            onStatusChange={(next) => updateSearch({ status: next === 'all' ? undefined : next })}
            failingCount={summary.data?.byHealth.failing}
            onlyFailing={onlyFailing}
            onToggleFailing={() => updateSearch({ health: onlyFailing ? undefined : ['failing'] })}
            targets={canReadTargets ? targets.data?.items : undefined}
            targetId={targetId}
            onTargetChange={(next) => updateSearch({ targetId: next })}
            health={health}
            onHealthChange={(next) => updateSearch({ health: next.length > 0 ? next : undefined })}
            hasDraft={hasDraft}
            onHasDraftChange={(next) => updateSearch({ hasDraft: next || undefined })}
            schedule={schedule}
            onScheduleChange={(next) => updateSearch({ schedule: next })}
            creators={summary.data?.creators}
            currentUserId={currentUserId}
            createdBy={createdBy}
            onCreatedByChange={(next) => updateSearch({ createdBy: next })}
            createdRange={createdRange}
            onCreatedRangeChange={(next) => updateSearch({ createdFrom: next.from, createdTo: next.to })}
            sort={sort}
            onSortChange={(next) => updateSearch({ sort: next === 'created' ? undefined : next })}
            search={searchInput}
            onSearchChange={setSearchInput}
            searchRef={searchRef}
            view={view}
            onViewChange={(next) => {
              saveView(next)
              updateSearch({ view: next })
            }}
          />
          <FilterChips
            chips={chips}
            onClearAll={clearFilters}
            summary={matchedTotal === undefined ? undefined : `找到 ${matchedTotal} 个场景`}
          />
          {canReadTargets && targets.isError ? (
            <p className='px-4 pt-3 text-small text-muted-foreground'>
              目标系统名称暂不可用，以下显示系统 ID。
              <Button variant='link' size='sm' onClick={() => void targets.refetch()}>
                重新加载名称
              </Button>
            </p>
          ) : null}
          {query.isPending ? (
            <ListSkeleton view={view} />
          ) : query.isError ? (
            <QueryErrorState title='无法加载场景' onRetry={() => void query.refetch()} />
          ) : items.length === 0 ? (
            <EmptyState
              title={filtered ? '没有匹配的场景' : '还没有场景'}
              description={filtered ? '试试其他关键词，或清除筛选条件。' : '从一个目标系统开始，创建第一组有序步骤。'}
              action={
                filtered ? (
                  <Button variant='outline' onClick={clearFilters}>
                    清除筛选
                  </Button>
                ) : undefined
              }
            />
          ) : view === 'grid' ? (
            <div className='@container/tray bg-surface-page p-4'>
              <div className='grid grid-cols-1 gap-4 @[600px]/tray:grid-cols-2 @[940px]/tray:grid-cols-3 @[1280px]/tray:grid-cols-4 @[1660px]/tray:grid-cols-5'>
                {items.map((scenario) => (
                  <ScenarioCard key={scenario.id} scenario={scenario} context={contextOf(scenario)} />
                ))}
              </div>
            </div>
          ) : (
            <ScenarioCompactTable items={items} contextOf={contextOf} />
          )}
          <div className='flex flex-wrap items-center justify-between gap-3 rounded-b-lg border-t border-border-divider px-4 py-3'>
            <p role='status' className='text-label text-muted-foreground tabular-nums'>
              {matchedTotal === undefined ? `当前页 ${items.length} 个场景` : `共 ${matchedTotal} 个场景 · 当前页 ${items.length} 个`}
            </p>
            <CursorPagination
              pageIndex={page.pageIndex}
              pageSize={page.pageSize}
              hasPreviousPage={page.pageIndex > 0}
              hasNextPage={Boolean(query.data?.nextCursor)}
              updating={query.isFetching && query.isPlaceholderData}
              onPageSizeChange={page.setPageSize}
              onPreviousPage={page.goPrev}
              onNextPage={() => {
                if (query.data?.nextCursor) page.goNext(query.data.nextCursor)
              }}
            />
          </div>
        </section>
      </Main>
      <ScenarioCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(id) => {
          void navigate({ to: '/scenarios/$scenarioId', params: { scenarioId: id } })
        }}
      />
      <RenameScenarioDialog scenario={renaming} onOpenChange={(open) => !open && setRenaming(null)} />
      <RunTaskDock onOpen={setSheetRunId} />
      <RunObservationSheet runId={sheetRunId} onOpenChange={(open) => !open && setSheetRunId(null)} />
      <RunCreateDialog
        open={Boolean(moreOptionsFor)}
        onOpenChange={(open) => !open && setMoreOptionsFor(null)}
        defaultScenarioId={moreOptionsFor?.id}
        defaultTargetId={moreOptionsFor?.targetId}
      />
      <ConfirmDialog
        open={Boolean(disabling)}
        onOpenChange={(open) => !open && setDisabling(null)}
        title='停用这个场景？'
        desc={
          disabling
            ? `停用后「${disabling.name}」不能再发起运行，定时调度到点也不会创建运行；随时可以重新启用。`
            : ''
        }
        confirmText='停用'
        destructive
        isLoading={statusSaving}
        handleConfirm={() => {
          if (disabling) void setScenarioStatus(disabling, 'disabled')
        }}
      />
      <ResourceDeleteDialog
        open={Boolean(removing)}
        onOpenChange={(next) => {
          if (!next) setRemoving(null)
        }}
        resourceId={removing?.id ?? ''}
        resourceName={removing?.name ?? ''}
        resourceType='scenario'
        previewFn={removing ? () => previewDeleteScenario(removing.id) : undefined}
        deleteFn={(body) => (removing ? deleteScenario(removing.id, body) : Promise.resolve())}
        onSuccess={async () => {
          setRemoving(null)
          if (items.length <= 1 && page.pageIndex > 0) page.goPrev()
          await queryClient.invalidateQueries({ queryKey: ['scenarios'] })
        }}
      />
    </>
  )
}

function ListSkeleton({ view }: { view: ScenarioView }) {
  if (view === 'list') {
    return (
      <div className='space-y-3 p-4' aria-busy='true' aria-label='正在加载场景'>
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className='flex items-center gap-3'>
            <Skeleton className='size-7 rounded-[9px]' />
            <div className='flex-1 space-y-1.5'>
              <Skeleton className='h-3.5 w-1/3' />
              <Skeleton className='h-3 w-1/5' />
            </div>
            <Skeleton className='h-3 w-32' />
          </div>
        ))}
      </div>
    )
  }
  return (
    <div className='@container/tray bg-surface-page p-4' aria-busy='true' aria-label='正在加载场景'>
      <div className='grid grid-cols-1 gap-4 @[600px]/tray:grid-cols-2 @[940px]/tray:grid-cols-3 @[1280px]/tray:grid-cols-4 @[1660px]/tray:grid-cols-5'>
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className='rounded-lg border border-border-card bg-card p-4 shadow-card'>
            <div className='flex gap-3'>
              <Skeleton className='size-8 rounded-[10px]' />
              <div className='flex-1 space-y-2'>
                <Skeleton className='h-4 w-3/4' />
                <Skeleton className='h-3 w-1/2' />
              </div>
            </div>
            <div className='mt-8 border-t border-border-divider pt-3'>
              <Skeleton className='h-3 w-28' />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
