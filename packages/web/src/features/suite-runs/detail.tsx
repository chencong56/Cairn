import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { suiteRunObservationSchema, TERMINAL_SUITE_RUN_STATUSES } from '@cairn/shared'
import {
  ArrowLeft,
  Clock,
  Copy,
  FileText,
  Globe,
  Info,
  Layers,
  MoreHorizontal,
  RotateCcw,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { copyToClipboard } from '@/lib/clipboard'
import { subscribeObservation } from '@/lib/observation-stream'
import {
  cancelSuiteRun,
  deleteSuiteRun,
  fetchSuite,
  fetchSuiteRun,
  previewDeleteSuiteRun,
  rerunSuiteItem,
} from '@/lib/suites-api'
import { fetchReports, fetchReportRevision } from '@/lib/reports-api'
import { fetchTarget, fetchTargetAccounts } from '@/lib/targets-api'
import { useCan } from '@/hooks/use-permissions'
import { useBreadcrumb } from '@/stores/breadcrumb-store'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Main } from '@/components/layout/main'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { ResourceDeleteDialog } from '@/components/resource-delete-dialog'
import { Can } from '@/components/rbac/can'
import { StatusBadge } from '@/components/status-badge'
import { ReportPanel } from '@/features/reports/panel'
import { SuiteReportView } from '@/features/reports/suite-report-view'
import { RUN_STATUS_LABELS, runStatusTone } from '@/features/runs/labels'
import {
  RUN_OUTCOME_STATUS_LABELS,
  runOutcomeStatusTone,
} from '@/features/runs/outcome-labels'
import {
  SUITE_ADMISSION_LABELS,
  SUITE_RUN_STATUS_LABELS,
  SUITE_VERDICT_LABELS,
  suiteRunStatusTone,
  suiteVerdictTone,
} from '@/features/suites/labels'

export function SuiteRunDetailPage() {
  const { suiteRunId } = useParams({
    from: '/_authenticated/suite-runs/$suiteRunId/',
  })
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [rerunningMember, setRerunningMember] = useState<string | null>(null)

  const canCancel = useCan('run:cancel')
  const canDeleteRun = useCan('run:delete')

  const query = useQuery({
    queryKey: ['suite-run', suiteRunId],
    queryFn: () => fetchSuiteRun(suiteRunId),
  })
  const run = query.data

  const suiteQuery = useQuery({
    queryKey: ['suite', run?.suiteId],
    queryFn: () => fetchSuite(run!.suiteId),
    enabled: Boolean(run?.suiteId),
  })

  const targetQuery = useQuery({
    queryKey: ['target', run?.targetId],
    queryFn: () => fetchTarget(run!.targetId),
    enabled: Boolean(run?.targetId),
  })

  const accountsQuery = useQuery({
    queryKey: ['target-accounts', run?.targetId],
    queryFn: () => fetchTargetAccounts(run!.targetId),
    enabled: Boolean(run?.targetId),
  })

  const accountMap = useMemo(() => {
    return new Map((accountsQuery.data?.items ?? []).map((a) => [a.id, a.displayName]))
  }, [accountsQuery.data?.items])

  useBreadcrumb({
    entityId: suiteRunId,
    title: run ? `${suiteQuery.data?.name ?? '场景集运行'} #${run.id.slice(0, 8)}` : undefined,
  })

  useEffect(() => {
    if (!query.isSuccess) return
    const controller = new AbortController()
    void subscribeObservation({
      path: `/api/suite-runs/${suiteRunId}/events`,
      schema: suiteRunObservationSchema,
      signal: controller.signal,
      onObservation: (value) =>
        queryClient.setQueryData(['suite-run', suiteRunId], value),
      isFinished: (value) =>
        ['COMPLETED', 'CANCELLED', 'FAILED'].includes(value.status) &&
        value.evidenceStatus !== 'PENDING' &&
        value.automaticReport?.status !== 'pending',
    }).catch((error: Error) => {
      if (!controller.signal.aborted) toast.error(error.message)
    })
    return () => controller.abort()
  }, [suiteRunId, queryClient, query.isSuccess])

  useEffect(() => {
    if (run?.automaticReport?.status === 'created') {
      void queryClient.invalidateQueries({ queryKey: ['reports'] })
    }
  }, [run?.automaticReport?.status, queryClient])

  const reportsQuery = useQuery({
    queryKey: ['reports', { scope: 'suite_summary', suiteRunId }],
    queryFn: () => fetchReports({ scope: 'suite_summary', suiteRunId }),
    enabled: Boolean(suiteRunId),
  })
  const latestReport = reportsQuery.data?.items[0]
  const latestRevisionId = latestReport?.currentRevision?.id
  const reportRevisionQuery = useQuery({
    queryKey: ['report-revision', latestReport?.id, latestRevisionId],
    queryFn: () => fetchReportRevision(latestReport!.id, latestRevisionId!),
    enabled: Boolean(latestReport?.id && latestRevisionId),
  })

  async function handleRerun(memberId: string) {
    setRerunningMember(memberId)
    try {
      const res = await rerunSuiteItem(suiteRunId, { memberId })
      toast.success('已启动单项重跑')
      queryClient.setQueryData(['suite-run', suiteRunId], res.suiteRun)
      void query.refetch()
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '重跑失败')
    } finally {
      setRerunningMember(null)
    }
  }

  async function handleCancel() {
    try {
      await cancelSuiteRun(suiteRunId)
      toast.success('已请求取消')
      void query.refetch()
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '取消失败')
    }
  }

  const copySuiteRunId = async () => {
    const ok = await copyToClipboard(suiteRunId)
    if (ok) {
      toast.success('已复制场景集运行 ID')
    } else {
      toast.error('复制失败，请手动复制')
    }
  }

  const failedItems = run?.items.filter(
    (i) => i.runStatus === 'FAILED' || i.outcomeStatus === 'FAIL' || i.runStatus === 'CANCELLED',
  ) ?? []

  const isTerminal = run ? (TERMINAL_SUITE_RUN_STATUSES as readonly string[]).includes(run.status) : false

  return (
    <Main className='flex min-w-0 flex-1 flex-col gap-6'>
      {query.isPending ? (
        <PageSkeleton />
      ) : query.isError || !run ? (
        <QueryErrorState
          title='无法加载集合运行'
          onRetry={() => void query.refetch()}
        />
      ) : (
        <>
          {/* Apple-design Hero Header */}
          <div className='flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between border-b border-border-divider pb-5'>
            <div className='space-y-1.5 min-w-0'>
              <Link
                to='/suite-runs'
                className='inline-flex items-center gap-1.5 text-label text-muted-foreground hover:text-foreground transition-colors'
              >
                <ArrowLeft className='size-3.5' />
                <span>返回场景集运行</span>
              </Link>
              <div className='flex flex-wrap items-center gap-2.5 pt-0.5'>
                <h1 className='text-title font-semibold text-foreground truncate max-w-md sm:max-w-xl'>
                  {run.suiteId ? (
                    <Link
                      to='/suites/$suiteId'
                      params={{ suiteId: run.suiteId }}
                      className='hover:text-primary hover:underline'
                    >
                      {suiteQuery.data?.name ?? '场景集运行'}
                    </Link>
                  ) : (
                    suiteQuery.data?.name ?? '场景集运行'
                  )}
                </h1>
                <button
                  type='button'
                  onClick={copySuiteRunId}
                  className='inline-flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 font-mono text-caption text-muted-foreground hover:bg-muted hover:text-foreground transition-colors'
                  title={`完整 ID: ${suiteRunId} (点击复制)`}
                >
                  <span>#{suiteRunId.slice(0, 8)}</span>
                  <Copy className='size-3 opacity-70' />
                </button>
              </div>

              {/* Secondary metadata row */}
              <div className='flex flex-wrap items-center gap-2 text-label text-muted-foreground'>
                {targetQuery.data?.name ? (
                  <span className='inline-flex items-center gap-1'>
                    <Globe className='size-3 text-muted-foreground/80' />
                    <Link
                      to='/targets/$targetId'
                      params={{ targetId: run.targetId }}
                      className='hover:text-primary hover:underline'
                    >
                      {targetQuery.data.name}
                    </Link>
                  </span>
                ) : null}
                <span className='text-muted-foreground/40'>·</span>
                <span className='inline-flex items-center gap-1'>
                  <Layers className='size-3 text-muted-foreground/80' />
                  <span>
                    {run.executionMode === 'sequential'
                      ? '严格串行'
                      : `受控并发 (上限 ${run.maxConcurrency ?? 3})`}
                  </span>
                </span>
                {run.startedAt ? (
                  <>
                    <span className='text-muted-foreground/40'>·</span>
                    <span className='inline-flex items-center gap-1'>
                      <Clock className='size-3 text-muted-foreground/80' />
                      <span>{new Date(run.startedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</span>
                    </span>
                  </>
                ) : null}
                {run.wallClockMs != null ? (
                  <>
                    <span className='text-muted-foreground/40'>·</span>
                    <span className='font-mono'>
                      耗时 {(run.wallClockMs / 1000).toFixed(1)}s
                      {run.childDurationMs != null && run.childDurationMs > run.wallClockMs ? (
                        <span className='ml-1 text-label font-normal text-status-success-foreground'>
                          (节约 {(((run.childDurationMs - run.wallClockMs) / run.childDurationMs) * 100).toFixed(0)}%)
                        </span>
                      ) : null}
                    </span>
                  </>
                ) : null}
              </div>
            </div>

            {/* Header actions */}
            <div className='flex flex-wrap items-center gap-2 shrink-0 pt-1 sm:pt-0'>
              <StatusBadge tone={suiteRunStatusTone(run.status)}>
                {SUITE_RUN_STATUS_LABELS[run.status]}
              </StatusBadge>
              {run.verdict ? (
                <StatusBadge tone={suiteVerdictTone(run.verdict)}>
                  {SUITE_VERDICT_LABELS[run.verdict]}
                </StatusBadge>
              ) : null}

              {isTerminal && failedItems.length > 0 ? (
                <Can permission='run:execute'>
                  <Button
                    variant='outline'
                    disabled={rerunningMember !== null}
                    onClick={() => {
                      if (failedItems[0]) void handleRerun(failedItems[0].memberId)
                    }}
                  >
                    <RotateCcw className='size-4 mr-1.5' />
                    {failedItems.length === 1 ? '只重跑失败项' : `只重跑失败项 (${failedItems.length})`}
                  </Button>
                </Can>
              ) : null}

              {!isTerminal && canCancel ? (
                <Button
                  variant='outline'
                  className='text-destructive hover:bg-destructive/10 hover:text-destructive'
                  onClick={handleCancel}
                >
                  取消整集
                </Button>
              ) : null}

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant='outline' size='icon' aria-label='更多操作'>
                    <MoreHorizontal className='size-4' />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align='end' className='w-48'>
                  <DropdownMenuItem onClick={copySuiteRunId}>
                    <Copy className='size-4 mr-2' />
                    复制完整编号
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link to='/evidence' search={{ suiteRunId, tab: 'search' }}>
                      <FileText className='size-4 mr-2' />
                      在结果与报告中查看
                    </Link>
                  </DropdownMenuItem>
                  {canDeleteRun && isTerminal ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className='text-destructive focus:bg-destructive/10 focus:text-destructive'
                        onClick={() => setDeleteDialogOpen(true)}
                      >
                        <Trash2 className='size-4 mr-2' />
                        删除场景集运行
                      </DropdownMenuItem>
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* Segmented Tabs */}
          <Tabs defaultValue='execution' className='space-y-4'>
            <TabsList className='grid w-full max-w-xs grid-cols-2'>
              <TabsTrigger value='execution'>
                执行明细
                {failedItems.length > 0 ? (
                  <span className='ml-1.5 rounded-full bg-status-danger-background px-1.5 py-0.2 text-caption text-status-danger-foreground font-mono'>
                    {failedItems.length}
                  </span>
                ) : null}
              </TabsTrigger>
              <TabsTrigger value='report'>
                综合报表
                {run.automaticReport?.status === 'pending' ? (
                  <span className='ml-1.5 flex h-2 w-2 rounded-full bg-primary animate-pulse' />
                ) : null}
              </TabsTrigger>
            </TabsList>

            {/* Tab 1: Execution Details */}
            <TabsContent value='execution' className='space-y-4 focus-visible:outline-none'>
              {/* Single set of KPI cards */}
              <section className='grid gap-3 rounded-lg border border-border-card bg-card p-4 shadow-card sm:grid-cols-5'>
                <div>
                  <p className='text-label text-muted-foreground'>计划成员</p>
                  <p className='text-title'>{run.counts.planned}</p>
                </div>
                <div>
                  <p className='text-label text-muted-foreground'>执行模式</p>
                  <p className='text-title'>
                    {run.executionMode === 'sequential'
                      ? '严格串行'
                      : `受控并发 (上限 ${run.maxConcurrency ?? 3})`}
                  </p>
                </div>
                <div>
                  <p className='text-label text-muted-foreground'>
                    成功 / 失败 / 跳过
                  </p>
                  <p className='text-title'>
                    {run.counts.succeeded} / {run.counts.failed} / {run.counts.skipped}
                  </p>
                </div>
                <div>
                  <p className='text-label text-muted-foreground'>
                    进行中 / 待开始
                  </p>
                  <p className='text-title'>
                    {run.counts.active} / {run.counts.pending}
                  </p>
                </div>
                <div>
                  <p className='text-label text-muted-foreground'>耗时度量</p>
                  <p className='text-title'>
                    {run.wallClockMs != null
                      ? `${(run.wallClockMs / 1000).toFixed(1)}s`
                      : '执行中'}
                    {run.childDurationMs != null && run.wallClockMs != null && run.childDurationMs > run.wallClockMs ? (
                      <span className='ml-1 text-label font-normal text-status-success-foreground'>
                        (节约 {(((run.childDurationMs - run.wallClockMs) / run.childDurationMs) * 100).toFixed(0)}%)
                      </span>
                    ) : null}
                  </p>
                </div>
              </section>

              {/* Inline Notice */}
              <div className='flex items-center gap-2 rounded-lg border border-border-default/60 bg-muted/30 px-3.5 py-2.5 text-label text-muted-foreground'>
                <Info className='size-4 shrink-0 text-muted-foreground' />
                <span>
                  成员间隙不预留账号，调度期间同一账号可能被并发运行借调。快照读取于 {new Date(run.readAt).toLocaleString()}。
                </span>
              </div>

              {/* Members Table */}
              <section className='overflow-hidden rounded-lg border border-border-card bg-card shadow-card'>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>成员</TableHead>
                      <TableHead>目标账号</TableHead>
                      <TableHead>放行状态</TableHead>
                      <TableHead>子运行</TableHead>
                      <TableHead>业务结果</TableHead>
                      <TableHead className='w-44 text-end'>操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {run.items.map((item) => {
                      const accountDisplayName = item.targetAccountId
                        ? accountMap.get(item.targetAccountId)
                        : null

                      return (
                        <TableRow key={item.memberId}>
                          <TableCell>
                            <div className='flex items-center gap-2'>
                              <span className='font-medium'>{item.displayName}</span>
                              {item.stageId ? (
                                <Badge variant='outline' className='font-mono text-label'>
                                  Stage {item.stageOrdinal != null ? item.stageOrdinal + 1 : item.stageId}
                                </Badge>
                              ) : null}
                              {item.rerunCount && item.rerunCount > 0 ? (
                                <Badge
                                  variant='secondary'
                                  className='text-label bg-status-warning-background text-status-warning-foreground border border-border-default'
                                >
                                  重跑第 {item.rerunCount} 次
                                </Badge>
                              ) : null}
                            </div>
                            <div className='text-label text-muted-foreground'>
                              {item.memberId}
                            </div>
                          </TableCell>
                          <TableCell>
                            {accountDisplayName ? (
                              <span className='text-label font-medium text-foreground' title={item.targetAccountId ?? undefined}>
                                {accountDisplayName}
                              </span>
                            ) : item.targetAccountId ? (
                              <span className='font-mono text-label text-muted-foreground' title={item.targetAccountId}>
                                账号 #{item.targetAccountId.slice(0, 8)}
                              </span>
                            ) : (
                              <span className='text-label text-muted-foreground'>默认</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <div>{SUITE_ADMISSION_LABELS[item.admission]}</div>
                            {item.skipReason ? (
                              <div className='text-small text-muted-foreground'>{item.skipReason}</div>
                            ) : null}
                          </TableCell>
                          <TableCell>
                            <StatusBadge tone={runStatusTone(item.runStatus)}>
                              {RUN_STATUS_LABELS[item.runStatus]}
                            </StatusBadge>
                          </TableCell>
                          <TableCell>
                            <StatusBadge tone={runOutcomeStatusTone(item.outcomeStatus)}>
                              {RUN_OUTCOME_STATUS_LABELS[item.outcomeStatus]}
                            </StatusBadge>
                          </TableCell>
                          <TableCell className='text-end'>
                            <div className='flex items-center justify-end gap-1.5'>
                              {isTerminal ? (
                                <Can permission='run:execute'>
                                  <Button
                                    variant='outline'
                                    size='sm'
                                    disabled={rerunningMember !== null}
                                    onClick={() => void handleRerun(item.memberId)}
                                  >
                                    <RotateCcw className='size-3.5 mr-1' />
                                    重跑
                                  </Button>
                                </Can>
                              ) : null}
                              {item.childRunId ? (
                                <Button variant='ghost' size='sm' asChild>
                                  <Link
                                    to='/runs/$runId'
                                    params={{ runId: item.childRunId }}
                                  >
                                    打开子运行
                                  </Link>
                                </Button>
                              ) : !isTerminal ? (
                                <span className='text-muted-foreground text-caption'>—</span>
                              ) : null}
                            </div>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </section>
            </TabsContent>

            {/* Tab 2: Report */}
            <TabsContent value='report' className='space-y-4 focus-visible:outline-none'>
              {run.automaticReport ? (
                <div className='flex items-center gap-2 rounded-lg border border-border-default/60 bg-muted/30 px-3.5 py-2.5 text-label text-muted-foreground'>
                  <Info className='size-4 shrink-0 text-muted-foreground' />
                  <span>
                    {run.automaticReport.status === 'pending'
                      ? '已启用自动报告，等待集合结束及证据收尾。'
                      : run.automaticReport.status === 'created'
                        ? '自动报告已生成。'
                        : `自动报告${run.automaticReport.status === 'skipped' ? '已跳过' : '生成失败'}：${run.automaticReport.reason ?? '请手动创建报告或联系管理员检查权限。'}`}
                  </span>
                </div>
              ) : null}

              {reportRevisionQuery.data?.document ? (
                <section className='space-y-4'>
                  <div className='flex items-center justify-between'>
                    <h2 className='text-title font-semibold'>综合巡检总报表</h2>
                    {latestReport ? (
                      <Link
                        to='/reports/$reportId'
                        params={{ reportId: latestReport.id }}
                        className='text-body text-link hover:underline'
                      >
                        在独立页查看完整报告
                      </Link>
                    ) : null}
                  </div>
                  <SuiteReportView document={reportRevisionQuery.data.document} />
                </section>
              ) : (
                <div className='rounded-lg border border-dashed border-border-default p-8 text-center text-label text-muted-foreground'>
                  暂无综合报告。场景集结束后将自动生成，或在下方报告面板中手动发起。
                </div>
              )}

              <div className='pt-2'>
                <ReportPanel subject={{ kind: 'SUITE_RUN', suiteRunId }} />
              </div>
            </TabsContent>
          </Tabs>

          {/* Delete Dialog */}
          {deleteDialogOpen ? (
            <ResourceDeleteDialog
              open={deleteDialogOpen}
              onOpenChange={setDeleteDialogOpen}
              resourceId={suiteRunId}
              resourceName={`场景集运行 #${suiteRunId.slice(0, 8)}（${suiteQuery.data?.name ?? '场景集'}）`}
              resourceType='suite_run'
              previewFn={() => previewDeleteSuiteRun(suiteRunId)}
              deleteFn={(body) => deleteSuiteRun(suiteRunId, body)}
              onSuccess={() => void navigate({ to: '/suite-runs' })}
            />
          ) : null}
        </>
      )}
    </Main>
  )
}
