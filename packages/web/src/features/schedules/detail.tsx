import { useEffect, useMemo, useState } from 'react'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import {
  scheduleDtoSchema,
  SCHEDULE_SKIP_REASON_METAS,
  resolveSkipReasonAction,
  type ScheduleDto,
  type ScheduleSkipReason,
} from '@cairn/shared'
import { fetchScheduleEvents, fetchScheduleOccurrences } from '@/lib/schedules-api'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { subscribeObservation } from '@/lib/observation-stream'
import { AnalysisDetailDialog } from './analysis-detail'
import { useCan } from '@/hooks/use-permissions'
import { useAssistantContextBinding } from '@/features/assistant/use-assistant-context-binding'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  AlertTriangle,
  Clock,
  History,
  Pencil,
  Play,
  RotateCcw,
  Sliders,
  Trash2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { ADMISSION_LABELS, CONSUMER_LABELS, MODE_LABELS, SKIP_LABELS, lastResult } from './labels'

export function ScheduleDetailDialog({
  schedule: selectedSchedule,
  onOpenChange,
  onTrigger,
  onToggleEnabled,
  onEdit,
  onDelete,
}: {
  schedule: ScheduleDto | null
  onOpenChange: (open: boolean) => void
  onTrigger?: (schedule: ScheduleDto) => void
  onToggleEnabled?: (schedule: ScheduleDto) => void
  onEdit?: (schedule: ScheduleDto) => void
  onDelete?: (schedule: ScheduleDto) => void
}) {
  const client = useQueryClient()
  const [latestSchedule, setLatestSchedule] = useState<ScheduleDto | null>(null)
  const schedule = latestSchedule?.scheduleId === selectedSchedule?.scheduleId ? latestSchedule : selectedSchedule
  const [analysisJobId, setAnalysisJobId] = useState<string | null>(null)
  const [streamError, setStreamError] = useState('')
  const [realtime, setRealtime] = useState(true)
  const canAnalyze = useCan('map:analyze')
  const canReadSchedule = useCan('schedule:read')
  const canWrite = useCan('schedule:write')

  useAssistantContextBinding(
    schedule && canReadSchedule
      ? {
          page: 'schedule',
          entityId: schedule.scheduleId,
          summaryText: `调度: ${schedule.name ?? schedule.objectLabel ?? CONSUMER_LABELS[schedule.consumerKey]}`,
          statusLabel: schedule.enabled ? '已启用' : '已停用',
          statusTone: schedule.enabled ? 'success' : 'neutral',
        }
      : null,
  )

  const occurrences = useInfiniteQuery({
    queryKey: ['schedules', schedule?.scheduleId, 'occurrences'],
    queryFn: ({ pageParam }) => fetchScheduleOccurrences(schedule!.scheduleId, { limit: 20, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.nextCursor,
    enabled: Boolean(schedule),
  })
  const events = useInfiniteQuery({
    queryKey: ['schedules', schedule?.scheduleId, 'events'],
    queryFn: ({ pageParam }) => fetchScheduleEvents(schedule!.scheduleId, { limit: 20, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.nextCursor,
    enabled: Boolean(schedule),
  })
  const scheduleId = schedule?.scheduleId
  useEffect(() => {
    if (!scheduleId) return
    const controller = new AbortController()
    void subscribeObservation({
      path: `/api/schedules/${scheduleId}/observe`,
      schema: scheduleDtoSchema,
      event: 'schedule',
      signal: controller.signal,
      onObservation: setLatestSchedule,
      onRealtime: setRealtime,
      onEvent: () => { void client.invalidateQueries({ queryKey: ['schedules', scheduleId] }) },
      isFinished: () => false,
    }).catch((error: Error) => { if (!controller.signal.aborted) setStreamError(error.message) })
    return () => controller.abort()
  }, [scheduleId, client])

  const recentOccurrences = occurrences.data?.pages[0]?.items ?? []
  const summary = useMemo(() => {
    if (recentOccurrences.length === 0) return null
    let admitted = 0
    let skipped = 0
    let failed = 0
    const skipCounts = new Map<ScheduleSkipReason, number>()

    for (const item of recentOccurrences) {
      if (item.admissionStatus === 'ADMITTED') admitted++
      else if (item.admissionStatus === 'SKIPPED') {
        skipped++
        if (item.reason) {
          skipCounts.set(item.reason, (skipCounts.get(item.reason) ?? 0) + 1)
        }
      } else if (item.admissionStatus === 'FAILED') failed++
    }

    let topSkipReason: ScheduleSkipReason | null = null
    let topSkipCount = 0
    for (const [r, count] of skipCounts.entries()) {
      if (count > topSkipCount) {
        topSkipCount = count
        topSkipReason = r
      }
    }

    return {
      total: recentOccurrences.length,
      admitted,
      skipped,
      failed,
      topSkipReason,
      topSkipCount,
      topSkipRate: skipped > 0 ? Math.round((topSkipCount / skipped) * 100) : 0,
    }
  }, [recentOccurrences])

  if (!schedule) return null
  const consumer = schedule.definition.consumer

  return (
    <>
      <Sheet open={Boolean(schedule)} onOpenChange={onOpenChange}>
        <SheetContent side='right' className='sm:max-w-2xl w-full flex flex-col p-0 gap-0 overflow-hidden bg-card'>
          <SheetHeader className='border-b border-border-divider px-6 py-4 space-y-1.5 bg-surface-header/80 backdrop-blur-sm'>
            <div className='flex items-center gap-2'>
              <span className='inline-flex items-center rounded bg-primary/10 px-2 py-0.5 text-micro font-medium text-primary'>
                {CONSUMER_LABELS[schedule.consumerKey]}
              </span>
              <span className='text-micro text-muted-foreground font-mono'>
                修订 r{schedule.revision}
              </span>
              <div className='ml-auto flex items-center gap-1.5 text-micro text-muted-foreground mr-6'>
                {realtime ? (
                  <span className='flex items-center gap-1 text-status-success-foreground'>
                    <span className='size-1.5 rounded-full bg-status-success animate-pulse' />
                    实时同步
                  </span>
                ) : (
                  <span className='flex items-center gap-1 text-muted-foreground'>
                    <Clock className='size-3' />
                    轮询同步
                  </span>
                )}
              </div>
            </div>
            <SheetTitle className='text-section font-semibold text-text-primary text-start truncate'>
              {schedule.name ?? schedule.objectLabel ?? CONSUMER_LABELS[schedule.consumerKey]}
            </SheetTitle>
            <SheetDescription className='text-small text-muted-foreground text-start'>
              {schedule.objectLabel ? `关联对象：${schedule.objectLabel}` : '定时调度计划检视器'}
            </SheetDescription>
          </SheetHeader>

          {/* Action Toolbar */}
          <div className='flex items-center justify-between border-b border-border-divider bg-surface-card px-6 py-2.5'>
            <div className='flex items-center gap-2'>
              {canWrite && onToggleEnabled ? (
                <div className='flex items-center gap-2'>
                  <Switch
                    id='detail-switch'
                    checked={schedule.enabled}
                    onCheckedChange={() => onToggleEnabled(schedule)}
                  />
                  <span className={cn('text-small font-medium', schedule.enabled ? 'text-status-success-foreground' : 'text-muted-foreground')}>
                    {schedule.enabled ? '已启用' : '已停用'}
                  </span>
                </div>
              ) : (
                <span className={cn('text-small font-medium', schedule.enabled ? 'text-status-success-foreground' : 'text-muted-foreground')}>
                  {schedule.enabled ? '已启用' : '已停用'}
                </span>
              )}
            </div>
            <div className='flex items-center gap-2'>
              {canWrite && onTrigger ? (
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  className='h-8 gap-1.5 px-3 text-small'
                  onClick={() => onTrigger(schedule)}
                >
                  <Play className='size-3.5' />
                  立即执行
                </Button>
              ) : null}
              {canWrite && onEdit ? (
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  className='h-8 gap-1.5 px-3 text-small'
                  onClick={() => onEdit(schedule)}
                >
                  <Pencil className='size-3.5' />
                  编辑
                </Button>
              ) : null}
              {canWrite && onDelete ? (
                <Button
                  type='button'
                  variant='ghost'
                  size='sm'
                  className='h-8 gap-1 px-2.5 text-small text-destructive hover:bg-destructive/10 hover:text-destructive'
                  onClick={() => onDelete(schedule)}
                >
                  <Trash2 className='size-3.5' />
                  删除
                </Button>
              ) : null}
            </div>
          </div>

          {/* Scrollable Content */}
          <div className='overflow-y-auto px-6 py-5 space-y-6 flex-1 text-body'>
            {/* 1. Configuration & Rules */}
            <section className='space-y-3'>
              <h3 className='text-section font-semibold text-text-primary flex items-center gap-2'>
                <Sliders className='size-4 text-primary' />
                配置与策略
              </h3>
              <div className='rounded-lg border border-border-card bg-surface-card p-4 shadow-subtle space-y-3'>
                <div className='grid grid-cols-2 gap-3 text-small'>
                  <div>
                    <span className='text-muted-foreground'>调度对象：</span>
                    <span className='font-medium text-text-primary ml-1'>{schedule.objectLabel ?? '—'}</span>
                  </div>
                  <div>
                    <span className='text-muted-foreground'>任务类型：</span>
                    <span className='font-medium text-text-primary ml-1'>{CONSUMER_LABELS[schedule.consumerKey]}</span>
                  </div>
                  {consumer.type === 'scenario_run' ? (
                    <div>
                      <span className='text-muted-foreground'>场景版本：</span>
                      <span className='font-mono font-medium text-text-primary ml-1'>{consumer.scenarioVersionId.slice(0, 8)}</span>
                    </div>
                  ) : null}
                  {consumer.type === 'suite_run' ? (
                    <div>
                      <span className='text-muted-foreground'>集合版本：</span>
                      <span className='font-medium text-text-primary ml-1'>{consumer.suiteVersionId.slice(0, 8)}（{consumer.members.length} 个成员）</span>
                    </div>
                  ) : null}
                  {consumer.type === 'knowledge_analysis' ? (
                    <div className='col-span-2'>
                      <span className='text-muted-foreground'>分析模式：</span>
                      <span className='font-medium text-text-primary ml-1'>
                        {MODE_LABELS[consumer.mode]} · {consumer.budget.useAi ? 'AI 模型辅助' : '确定性统计'} · 单批上限 {consumer.budget.maxItems}
                      </span>
                    </div>
                  ) : null}
                  <div className='col-span-2 border-t border-border-divider pt-2 flex items-center justify-between'>
                    <span className='text-muted-foreground'>排期规则：</span>
                    <span className='font-medium text-text-primary'>
                      {schedule.definition.timeRule.kind === 'interval'
                        ? `每隔 ${Math.round(schedule.definition.timeRule.intervalMs / 60000)} 分钟循环触发`
                        : `${schedule.definition.timezone} ${schedule.definition.timeRule.windows.map((w) => `${w.windowStart}–${w.windowEnd}`).join('、')}`}
                    </span>
                  </div>
                </div>

                {schedule.blockReasons?.length ? (
                  <div className='flex items-start gap-2 rounded-md bg-status-warning/10 p-2.5 text-small text-status-warning-foreground border border-status-warning/20'>
                    <AlertTriangle className='size-4 shrink-0 mt-0.5' />
                    <div>
                      <p className='font-medium'>计划当前受到配置阻断：</p>
                      <p className='text-label'>
                        {schedule.blockReasons
                          .map((reason) => SKIP_LABELS[reason as keyof typeof SKIP_LABELS] ?? reason)
                          .join(' · ')}
                      </p>
                    </div>
                  </div>
                ) : null}
              </div>
            </section>

            {/* 2. Occurrences / Trigger History */}
            <section className='space-y-3'>
              <h3 className='text-section font-semibold text-text-primary flex items-center gap-2'>
                <RotateCcw className='size-4 text-primary' />
                触发记录
              </h3>
              {streamError ? <p role='alert' className='text-destructive text-small'>{streamError}</p> : null}
              {!realtime ? <p role='status' className='text-muted-foreground text-small'>实时通知未启用，当前约每 30 秒同步一次记录。</p> : null}
              {occurrences.isPending ? <p role='status' className='text-small text-muted-foreground'>正在加载触发记录…</p> : null}
              {occurrences.isError ? <p role='alert' className='text-destructive text-small'>触发记录读取失败：{occurrences.error.message}</p> : null}
              {occurrences.data?.pages[0].items.length === 0 ? <p className='text-muted-foreground text-small'>尚未触发。</p> : null}

              {summary ? (
                <div
                  className='rounded-md border border-border-default/60 bg-muted/40 p-3 text-label grid gap-1.5'
                  data-testid='schedule-admission-summary'
                >
                  <div className='flex items-center gap-3 font-medium flex-wrap'>
                    <span>最近 {summary.total} 次触发统计：</span>
                    <span className='text-status-success-foreground font-semibold'>已准入 {summary.admitted} 次</span>
                    <span className='text-status-warning-foreground font-semibold'>已跳过 {summary.skipped} 次</span>
                    {summary.failed > 0 ? (
                      <span className='text-destructive font-semibold'>准入失败 {summary.failed} 次</span>
                    ) : null}
                  </div>
                  {summary.topSkipReason ? (
                    <div className='text-muted-foreground'>
                      主要跳过原因：<span className='font-medium text-foreground'>{SCHEDULE_SKIP_REASON_METAS[summary.topSkipReason]?.label ?? summary.topSkipReason}</span>
                      （占跳过记录的 {summary.topSkipRate}%）
                    </div>
                  ) : null}
                </div>
              ) : null}

              <p className='text-label text-muted-foreground'>
                最近结果：{lastResult(schedule.lastOccurrence?.admissionStatus, schedule.lastOccurrence?.reason)}
              </p>

              <ul className='grid gap-2'>
                {(occurrences.data?.pages.flatMap(page => page.items) ?? []).map((item) => {
                  const meta = item.reason ? SCHEDULE_SKIP_REASON_METAS[item.reason] : null
                  const action = item.reason
                    ? resolveSkipReasonAction(item.reason, {
                        targetId: schedule.targetId,
                        runId: item.runId,
                        scheduleId: schedule.scheduleId,
                      })
                    : null

                  return (
                    <li
                      key={item.occurrenceId}
                      className='text-label rounded-lg border border-border-card p-3 grid gap-1.5 bg-surface-card shadow-subtle'
                      data-testid='schedule-occurrence-row'
                    >
                      <div className='flex items-center gap-2 flex-wrap'>
                        <span className='font-medium text-text-primary'>{item.localStartDate}</span>
                        <span className='text-muted-foreground'>·</span>
                        <span
                          className={cn(
                            'font-medium',
                            item.admissionStatus === 'SKIPPED'
                              ? 'text-status-warning-foreground'
                              : item.admissionStatus === 'FAILED'
                                ? 'text-destructive'
                                : 'text-status-success-foreground',
                          )}
                        >
                          {ADMISSION_LABELS[item.admissionStatus]}
                        </span>
                        {item.reason ? (
                          <span className='text-muted-foreground'>· {meta?.label ?? item.reason}</span>
                        ) : null}
                        {item.runId ? (
                          <Button variant='link' className='h-auto p-0 text-primary font-normal' asChild>
                            <a href={`/runs/${item.runId}`}>查看运行</a>
                          </Button>
                        ) : null}
                        {item.suiteRunId ? (
                          <Button variant='link' className='h-auto p-0 text-primary font-normal' asChild>
                            <a href={`/suite-runs/${item.suiteRunId}`}>查看集合运行</a>
                          </Button>
                        ) : null}
                        {item.jobId ? (
                          <Button variant='link' className='h-auto p-0 text-primary font-normal' asChild>
                            <a href={`/targets/${schedule.targetId}/map`}>查看地图作业</a>
                          </Button>
                        ) : null}
                        {item.analysisJobId && canAnalyze ? (
                          <Button variant='link' className='h-auto p-0 text-primary font-normal' onClick={() => setAnalysisJobId(item.analysisJobId ?? null)}>
                            查看分析结果
                          </Button>
                        ) : null}
                        {action ? (
                          <Button variant='outline' size='sm' className='h-6 px-2 text-micro ml-auto text-primary' asChild>
                            <a href={action.href}>{action.label}</a>
                          </Button>
                        ) : null}
                      </div>
                      {item.admissionStatus === 'SKIPPED' && meta?.explanation ? (
                        <p className='text-label text-muted-foreground leading-normal'>{meta.explanation}</p>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
              {occurrences.hasNextPage ? (
                <Button
                  variant='outline'
                  size='sm'
                  className='w-full'
                  disabled={occurrences.isFetchingNextPage}
                  onClick={() => void occurrences.fetchNextPage()}
                >
                  更多触发记录
                </Button>
              ) : null}
            </section>

            {/* 3. Operation Audit History */}
            <section className='space-y-3 border-t border-border-divider pt-4'>
              <h3 className='text-section font-semibold text-text-primary flex items-center gap-2'>
                <History className='size-4 text-primary' />
                操作历史
              </h3>
              <ul className='grid gap-1.5'>
                {(events.data?.pages.flatMap(page => page.items) ?? []).map((item) => (
                  <li key={item.eventId} className='text-label text-muted-foreground flex items-center gap-2'>
                    <span className='size-1.5 rounded-full bg-border-control' />
                    <span>{item.createdAt}</span>
                    <span>·</span>
                    <span className='font-medium text-text-primary'>{item.eventType}</span>
                  </li>
                ))}
              </ul>
              {events.isError ? <p role='alert' className='text-destructive text-small'>操作历史读取失败：{events.error.message}</p> : null}
              {events.hasNextPage ? (
                <Button
                  variant='outline'
                  size='sm'
                  className='w-full'
                  disabled={events.isFetchingNextPage}
                  onClick={() => void events.fetchNextPage()}
                >
                  更多操作历史
                </Button>
              ) : null}
            </section>
          </div>
        </SheetContent>
      </Sheet>
      {analysisJobId ? <AnalysisDetailDialog jobId={analysisJobId} onClose={() => setAnalysisJobId(null)} /> : null}
    </>
  )
}
