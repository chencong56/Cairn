import { useState } from 'react'
import { useAssistantCollectionContext } from '@/features/assistant/use-assistant-context-binding'
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import type { ScheduleConsumerType, ScheduleDto } from '@cairn/shared'
import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  Eye,
  MoreHorizontal,
  Pencil,
  Play,
  PlayCircle,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import {
  deleteSchedule,
  fetchSchedules,
  setScheduleEnabled,
  triggerSchedule,
} from '@/lib/schedules-api'
import { fetchTargetAccounts, fetchTargets } from '@/lib/targets-api'
import { useCursorPage } from '@/hooks/use-cursor-page'
import { useCan } from '@/hooks/use-permissions'
import { Button } from '@/components/ui/button'
import { SelectField, SelectFieldOption } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { CollectionSummary } from '@/components/collection-summary'
import { CursorPagination } from '@/components/data-table'
import { EmptyState } from '@/components/empty-state'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { cn } from '@/lib/utils'
import { ScheduleDetailDialog } from './detail'
import { ScheduleEditorDialog } from './editor'
import { CONSUMER_LABELS, SKIP_LABELS, lastResult } from './labels'

function formatInstant(value: string | null, timeZone: string) {
  if (!value) return '—'
  return new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone })
}


export function SchedulesPage() {
  const page = useCursorPage()
  const canReadTargets = useCan('target:read')
  const canWrite = useCan('schedule:write')
  const queryClient = useQueryClient()
  const [consumerKey, setConsumerKey] = useState<ScheduleConsumerType | ''>('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<ScheduleDto | null>(null)
  const [detail, setDetail] = useState<ScheduleDto | null>(null)
  const [scheduleToDelete, setScheduleToDelete] = useState<ScheduleDto | null>(null)

  useAssistantCollectionContext('schedule', { consumerKey: consumerKey || undefined })

  const query = useQuery({
    queryKey: ['schedules', 'list', page.cursor, page.pageSize, consumerKey],
    queryFn: () =>
      fetchSchedules({
        cursor: page.cursor,
        limit: page.pageSize,
        consumerKey: consumerKey || undefined,
      }),
    placeholderData: keepPreviousData,
  })

  const targetsQuery = useQuery({
    queryKey: ['targets', 'schedule-names'],
    queryFn: () => fetchTargets({ limit: 100 }),
    enabled: canReadTargets,
  })

  const items = query.data?.items ?? []
  const targetIds = [...new Set(items.map((item) => item.targetId))].sort()
  const accountsQuery = useQuery({
    queryKey: ['targets', 'schedule-account-names', targetIds],
    queryFn: async () => {
      const lists = await Promise.all(
        targetIds.map((targetId) =>
          fetchTargetAccounts(targetId, { limit: 50 })
        )
      )
      return lists.flatMap((list) => list.items)
    },
    enabled: canReadTargets && targetIds.length > 0,
  })

  const names = new Map(
    (targetsQuery.data?.items ?? []).map((item) => [item.id, item.name])
  )
  const accountNames = new Map(
    (accountsQuery.data ?? []).map((item) => [item.id, item.displayName])
  )

  const enabledMutation = useMutation({
    mutationFn: ({ item, enabled }: { item: ScheduleDto; enabled: boolean }) =>
      setScheduleEnabled(item.scheduleId, {
        expectedRevision: item.revision,
        idempotencyKey: `list-${enabled ? 'on' : 'off'}-${Date.now()}`,
        enabled,
        cancelAdmittedJobs: false,
      }),
    onSuccess: (_, { enabled }) => {
      toast.success(enabled ? '计划已启用' : '计划已停用')
      void queryClient.invalidateQueries({ queryKey: ['schedules'] })
    },
    onError: (error) =>
      toast.error(
        error instanceof ApiRequestError ? error.message : '启停失败'
      ),
  })

  const triggerMutation = useMutation({
    mutationFn: (item: ScheduleDto) =>
      triggerSchedule(item.scheduleId, {
        idempotencyKey: `manual-${Date.now()}`,
      }),
    onSuccess: () => {
      toast.success('已写入手动触发，等待准入')
      void queryClient.invalidateQueries({ queryKey: ['schedules'] })
    },
    onError: (error) =>
      toast.error(
        error instanceof ApiRequestError ? error.message : '触发失败'
      ),
  })

  const deleteMutation = useMutation({
    mutationFn: (item: ScheduleDto) => deleteSchedule(item.scheduleId),
    onSuccess: (_, item) => {
      toast.success(`已删除调度计划「${item.name ?? item.objectLabel ?? item.scheduleId.slice(0, 8)}」`)
      setScheduleToDelete(null)
      if (detail?.scheduleId === item.scheduleId) {
        setDetail(null)
      }
      void queryClient.invalidateQueries({ queryKey: ['schedules'] })
    },
    onError: (error) => {
      toast.error(error instanceof ApiRequestError ? error.message : '删除调度失败')
    },
  })

  return (
    <Main className='flex min-w-0 flex-1 flex-col gap-6'>
      <PageHeader
        title='定时任务'
        description='统一管理场景、场景集、知识地图采集和知识分析的定时计划。新计划保存后默认停用。'
        actions={
          canWrite && (items.length > 0 || Boolean(consumerKey)) ? (
            <Button
              onClick={() => {
                setEditing(null)
                setEditorOpen(true)
              }}
            >
              新建调度
            </Button>
          ) : null
        }
      />
      {query.isPending ? (
        <PageSkeleton />
      ) : query.isError ? (
        <QueryErrorState
          title='无法加载调度计划'
          onRetry={() => void query.refetch()}
        />
      ) : (
        <>
          {items.length > 0 ? (
            <CollectionSummary
              items={[
                {
                  label: '全部调度',
                  value: items.length,
                  description: '当前受管定时任务',
                  icon: <CalendarClock className='size-4' />,
                },
                {
                  label: '运行中 (ACTIVE)',
                  value: items.filter((item) => item.enabled).length,
                  description: '按计划等待自动触发',
                  icon: <PlayCircle className='size-4' />,
                },
                {
                  label: '最近已准入',
                  value: items.filter(
                    (item) => item.lastOccurrence?.admissionStatus === 'ADMITTED'
                  ).length,
                  description: '近期成功准入执行',
                  icon: <CheckCircle2 className='size-4' />,
                },
                {
                  label: '需关注',
                  value: items.filter(
                    (item) =>
                      (item.blockReasons?.length ?? 0) > 0 ||
                      item.lastOccurrence?.admissionStatus === 'SKIPPED'
                  ).length,
                  description: '存在阻断或最近跳过',
                  icon: <AlertCircle className='size-4' />,
                },
              ]}
            />
          ) : null}

          <section
            aria-label='调度计划'
            className='min-w-0 overflow-hidden rounded-lg border border-border-card bg-card shadow-card'
          >
            <div className='flex flex-wrap items-center justify-between gap-3 border-b border-border-divider px-4 py-3 bg-surface-header/30'>
              <div className='flex items-center gap-2'>
                <label
                  className='text-small text-muted-foreground'
                  htmlFor='schedule-filter'
                >
                  任务类型
                </label>
                <SelectField
                  id='schedule-filter'
                  className='w-auto'
                  value={consumerKey}
                  onValueChange={(value) =>
                    setConsumerKey(value as ScheduleConsumerType | '')
                  }
                >
                  <SelectFieldOption value=''>全部</SelectFieldOption>
                  {Object.entries(CONSUMER_LABELS).map(([value, label]) => (
                    <SelectFieldOption key={value} value={value}>
                      {label}
                    </SelectFieldOption>
                  ))}
                </SelectField>
              </div>
              {items.length > 0 ? (
                <span className='text-small text-muted-foreground'>
                  共 {items.length} 个计划
                </span>
              ) : null}
            </div>

            {items.length === 0 ? (
              <EmptyState
                title={consumerKey ? '没有匹配的调度计划' : '还没有调度计划'}
                description={
                  consumerKey
                    ? '当前筛选的任务类型下暂无计划，可更换筛选或清除条件。'
                    : '先选任务类型和目标系统，再设置排期。新计划保存后默认停用。'
                }
                action={
                  consumerKey ? (
                    <Button variant='outline' onClick={() => setConsumerKey('')}>
                      清除筛选
                    </Button>
                  ) : canWrite ? (
                    <Button
                      onClick={() => {
                        setEditing(null)
                        setEditorOpen(true)
                      }}
                    >
                      新建调度
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <>
                <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className='w-[22%] min-w-[170px]'>任务</TableHead>
                  <TableHead className='w-[16%] min-w-[130px]'>目标 / 对象</TableHead>
                  <TableHead className='w-[14%] min-w-[120px]'>排期</TableHead>
                  <TableHead className='w-[14%] min-w-[120px]'>下次窗口</TableHead>
                  <TableHead className='w-[15%] min-w-[140px]'>最近准入</TableHead>
                  <TableHead className='w-[11%] min-w-[95px]'>状态</TableHead>
                  <TableHead className='w-[130px] min-w-[130px] text-end pr-4 sticky right-0 bg-surface-header shadow-[-4px_0_8px_-4px_rgba(0,0,0,0.06)]'>
                    操作
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.scheduleId} className='group'>
                    <TableCell className='max-w-[240px]'>
                      <div className='flex flex-col gap-1'>
                        <button
                          type='button'
                          onClick={() => setDetail(item)}
                          className='text-start text-body font-medium text-text-primary hover:text-primary transition-colors focus:outline-none focus:underline truncate'
                        >
                          {item.name ?? item.objectLabel ?? CONSUMER_LABELS[item.consumerKey]}
                        </button>
                        <div className='flex items-center gap-1.5 flex-wrap'>
                          <span className='inline-flex items-center rounded bg-muted/70 px-1.5 py-0.5 text-micro font-medium text-muted-foreground'>
                            {CONSUMER_LABELS[item.consumerKey]}
                          </span>
                          {item.name && item.objectLabel && item.name !== item.objectLabel ? (
                            <span className='text-label text-muted-foreground truncate max-w-[160px]' title={item.objectLabel}>
                              {item.objectLabel}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className='max-w-[180px]'>
                      <p className='text-body truncate' title={names.get(item.targetId) ?? item.targetId}>
                        {names.get(item.targetId) ?? item.targetId.slice(0, 8)}
                      </p>
                      <p className='text-label text-muted-foreground truncate' title={
                        item.targetAccountId
                          ? (accountNames.get(item.targetAccountId) ?? item.targetAccountId.slice(0, 8))
                          : item.consumerKey === 'map_ingest'
                            ? '由平台选择采集账号'
                            : (item.objectLabel ?? '无浏览器账号')
                      }>
                        {item.targetAccountId
                          ? (accountNames.get(item.targetAccountId) ??
                            item.targetAccountId.slice(0, 8))
                          : item.consumerKey === 'map_ingest'
                            ? '由平台选择采集账号'
                            : (item.objectLabel ?? '无浏览器账号')}
                      </p>
                    </TableCell>
                    <TableCell>
                      <div className='flex flex-col text-small'>
                        <span className='font-medium text-text-primary whitespace-nowrap'>
                          {item.definition.timeRule.kind === 'interval'
                            ? `间隔 ${Math.round(item.definition.timeRule.intervalMs / 60000)} 分钟`
                            : item.definition.timeRule.windows.length > 1
                              ? `${item.definition.timeRule.windows.length} 个时间点`
                              : `${item.definition.timeRule.windows[0].windowStart}（截止 ${item.definition.timeRule.windows[0].windowEnd}）`}
                        </span>
                        <span className='text-label text-muted-foreground whitespace-nowrap'>
                          {item.definition.timezone}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className='text-body whitespace-nowrap'>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className='cursor-default font-mono-code text-text-secondary text-small'>
                            {formatInstant(item.nextDueAt, item.definition.timezone)}
                          </span>
                        </TooltipTrigger>
                        {item.nextDueAt ? (
                          <TooltipContent className='text-small'>
                            <p>下次执行时间（时区：{item.definition.timezone}）</p>
                            <p className='text-muted-foreground font-mono'>{item.nextDueAt}</p>
                          </TooltipContent>
                        ) : null}
                      </Tooltip>
                    </TableCell>
                    <TableCell className='max-w-[200px]'>
                      <div className='flex items-start gap-1.5'>
                        {item.lastOccurrence?.admissionStatus && (
                          <span
                            className={cn(
                              'size-2 shrink-0 rounded-full mt-1.5',
                              item.lastOccurrence.admissionStatus === 'ADMITTED'
                                ? 'bg-status-success'
                                : item.lastOccurrence.admissionStatus === 'SKIPPED'
                                  ? 'bg-status-warning'
                                  : item.lastOccurrence.admissionStatus === 'FAILED'
                                    ? 'bg-status-error'
                                    : 'bg-status-info'
                            )}
                            aria-hidden
                          />
                        )}
                        <span className='text-small text-text-primary leading-snug break-words'>
                          {lastResult(
                            item.lastOccurrence?.admissionStatus,
                            item.lastOccurrence?.reason
                          )}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className='max-w-[150px]'>
                      <div className='flex flex-col gap-1'>
                        <div className='flex items-center gap-2'>
                          {canWrite ? (
                            <Switch
                              id={`schedule-switch-${item.scheduleId}`}
                              checked={item.enabled}
                              disabled={enabledMutation.isPending}
                              onCheckedChange={(checked) =>
                                enabledMutation.mutate({ item, enabled: checked })
                              }
                              aria-label={item.enabled ? '停用计划' : '启用计划'}
                            />
                          ) : null}
                          <span
                            className={cn(
                              'text-small font-medium',
                              item.enabled
                                ? 'text-status-success-foreground'
                                : 'text-muted-foreground'
                            )}
                          >
                            {item.enabled ? '已启用' : '已停用'}
                          </span>
                        </div>
                        {item.blockReasons?.length ? (
                          <p
                            className='text-label text-status-warning-foreground leading-tight break-words'
                            title={item.blockReasons
                              .map(
                                (reason) =>
                                  SKIP_LABELS[
                                    reason as keyof typeof SKIP_LABELS
                                  ] ?? reason
                              )
                              .join(' · ')}
                          >
                            {item.blockReasons
                              .map(
                                (reason) =>
                                  SKIP_LABELS[
                                    reason as keyof typeof SKIP_LABELS
                                  ] ?? reason
                              )
                              .join(' · ')}
                          </p>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className='w-[130px] min-w-[130px] text-end pr-4 sticky right-0 bg-card group-hover:bg-action-hover shadow-[-4px_0_8px_-4px_rgba(0,0,0,0.06)]'>
                      <div className='flex items-center justify-end gap-1.5'>
                        {canWrite ? (
                          <Button
                            type='button'
                            variant='outline'
                            size='sm'
                            className='h-8 gap-1 px-2 text-small shrink-0'
                            disabled={triggerMutation.isPending}
                            onClick={() => triggerMutation.mutate(item)}
                          >
                            <Play className='size-3.5' />
                            立即执行
                          </Button>
                        ) : null}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              type='button'
                              variant='ghost'
                              size='sm'
                              className='size-8 p-0 shrink-0 text-muted-foreground hover:text-text-primary'
                              aria-label='更多操作'
                            >
                              <MoreHorizontal className='size-4' />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align='end' className='w-36'>
                            <DropdownMenuItem onClick={() => setDetail(item)}>
                              <Eye className='mr-2 size-3.5' />
                              详情
                            </DropdownMenuItem>
                            {canWrite ? (
                              <>
                                <DropdownMenuItem
                                  onClick={() => {
                                    setEditing(item)
                                    setEditorOpen(true)
                                  }}
                                >
                                  <Pencil className='mr-2 size-3.5' />
                                  编辑
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  className='text-destructive focus:bg-destructive/10 focus:text-destructive'
                                  onClick={() => setScheduleToDelete(item)}
                                >
                                  <Trash2 className='mr-2 size-3.5' />
                                  删除计划
                                </DropdownMenuItem>
                              </>
                            ) : null}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className='border-t border-border-divider p-3'>
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
          </>
        )}
      </section>
    </>
  )}
      <ScheduleEditorDialog
        key={editing?.scheduleId ?? (editorOpen ? 'new' : 'closed')}
        open={editorOpen}
        onOpenChange={setEditorOpen}
        existing={editing}
      />
      <ScheduleDetailDialog
        schedule={detail}
        onOpenChange={(open) => !open && setDetail(null)}
        onTrigger={(item) => triggerMutation.mutate(item)}
        onToggleEnabled={(item) => enabledMutation.mutate({ item, enabled: !item.enabled })}
        onEdit={(item) => {
          setEditing(item)
          setEditorOpen(true)
        }}
        onDelete={(item) => setScheduleToDelete(item)}
      />
      <AlertDialog
        open={Boolean(scheduleToDelete)}
        onOpenChange={(open) => !open && setScheduleToDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className='flex items-center gap-2 text-destructive'>
              <Trash2 className='size-5' />
              确认删除调度计划？
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className='space-y-2 text-body text-text-secondary'>
                <p>
                  即将删除调度计划：
                  <strong className='text-text-primary ml-1'>
                    {scheduleToDelete?.name ?? scheduleToDelete?.objectLabel ?? scheduleToDelete?.scheduleId}
                  </strong>
                </p>
                <p className='text-small text-muted-foreground'>
                  删除此计划后，系统将立即停止未来的所有自动触发。此前已经触发生成的历史运行记录（Runs）与审计证据将被完好保留，不会受影响。
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              取消
            </AlertDialogCancel>
            <Button
              variant='destructive'
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (scheduleToDelete) {
                  deleteMutation.mutate(scheduleToDelete)
                }
              }}
            >
              {deleteMutation.isPending ? '正在删除…' : '确认删除'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Main>
  )
}
