import { useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import type { RunStatus } from '@cairn/shared'
import { ExternalLink, Square } from 'lucide-react'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { cancelRun } from '@/lib/runs-api'
import { formatDurationMs } from '@/lib/formatters'
import { useCan } from '@/hooks/use-permissions'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { StatusBadge } from '@/components/status-badge'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { BrowserView } from '@/features/runs/browser-view'
import { PlacementHint } from '@/features/runs/placement-hint'
import { StepTimeline } from '@/features/runs/step-timeline'
import { RUN_EVIDENCE_STATUS_LABELS, runEvidenceStatusTone, runStatusTone } from '@/features/runs/labels'
import { RUN_EXECUTION_AXIS_LABELS, RUN_OUTCOME_STATUS_LABELS, runOutcomeStatusTone } from '@/features/runs/outcome-labels'
import { useRunObservation } from '@/features/runs/use-run-observation'
import { PhaseTile } from './run-task-dock'
import { isActiveRunStatus, runProgress } from './run-progress'

/**
 * 观测抽屉：不离开列表就能看执行到哪一步、受管画面在做什么；
 * 完整的步骤、断言与证据始终能一键打开运行复盘页。
 */
export function RunObservationSheet({
  runId,
  scenarioName,
  onOpenChange,
}: {
  runId: string | null
  scenarioName?: string
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Sheet open={Boolean(runId)} onOpenChange={onOpenChange}>
      <SheetContent side='right' className='w-full gap-0 rounded-s-xl p-0 sm:max-w-[min(720px,50vw)]'>
        {runId ? <SheetBody key={runId} runId={runId} scenarioName={scenarioName} /> : null}
      </SheetContent>
    </Sheet>
  )
}

function SheetBody({ runId, scenarioName }: { runId: string; scenarioName?: string }) {
  const navigate = useNavigate()
  const canCancel = useCan('run:cancel')
  const { run, evidence, eventSeq, refresh } = useRunObservation(runId)
  const progress = runProgress(run)
  const active = isActiveRunStatus(run?.status)
  const [cancelOpen, setCancelOpen] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const name = run?.scenarioName ?? scenarioName ?? '运行'
  const startedAt = run?.startedAt ?? run?.createdAt
  const elapsed =
    startedAt && run?.finishedAt ? formatDurationMs(Date.parse(run.finishedAt) - Date.parse(startedAt)) : null

  return (
    <>
      <SheetHeader className='gap-0 border-b border-border-divider px-6 pt-5 pb-4'>
        <div className='flex items-start gap-3 pr-8'>
          <PhaseTile phase={progress.phase} status={run?.status} size='lg' />
          <div className='min-w-0 flex-1'>
            <SheetTitle className='truncate text-section font-semibold'>{name}</SheetTitle>
            <SheetDescription className='sr-only'>这次运行的执行进度、受管画面与步骤</SheetDescription>
            {run ? (
              <div className='mt-2 flex flex-wrap gap-1.5'>
                <StatusBadge tone={runStatusTone(run.status as RunStatus)} hideIcon>
                  执行 · {RUN_EXECUTION_AXIS_LABELS[run.status as RunStatus]}
                </StatusBadge>
                <StatusBadge tone={runOutcomeStatusTone(run.outcomeStatus)} hideIcon>
                  结论 · {RUN_OUTCOME_STATUS_LABELS[run.outcomeStatus]}
                </StatusBadge>
                <StatusBadge tone={runEvidenceStatusTone(run.evidenceStatus, run.status as RunStatus)} hideIcon>
                  证据 · {RUN_EVIDENCE_STATUS_LABELS[run.evidenceStatus]}
                </StatusBadge>
                {elapsed ? (
                  <StatusBadge tone='neutral' hideIcon className='tabular-nums'>
                    用时 {elapsed}
                  </StatusBadge>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
        <div className='mt-3 flex flex-wrap items-center gap-2 pl-[52px]'>
          {active && canCancel ? (
            <Button
              size='sm'
              variant='ghost'
              disabled={cancelling}
              onClick={() => setCancelOpen(true)}
              className='hover:bg-status-error-background hover:text-status-error-foreground'
            >
              <Square />
              {cancelling ? '正在取消…' : '终止'}
            </Button>
          ) : null}
          <Button size='sm' variant='outline' asChild>
            <Link to='/runs/$runId' params={{ runId }}>
              <ExternalLink />
              打开完整复盘
            </Link>
          </Button>
        </div>
      </SheetHeader>
      <div className='flex-1 space-y-5 overflow-y-auto px-6 py-5'>
        {run && active ? (
          <PlacementHint placement={run.placement} targetId={run.targetId} accountId={run.targetAccountId} />
        ) : null}
        {run && active ? (
          <section aria-label='受管画面' className='space-y-2'>
            <p className='text-label font-medium text-muted-foreground'>受管画面</p>
            <BrowserView runId={runId} runStatus={run.status} eventSeq={eventSeq} onRunChanged={() => void refresh()} />
          </section>
        ) : run ? (
          <p className='rounded-md bg-surface-subtle px-3 py-2.5 text-small text-muted-foreground'>
            运行已结束。录像、截图与每一步的判断在完整复盘里查看。
          </p>
        ) : null}
        {run ? (
          <section aria-label='步骤' className='space-y-2'>
            <p className='flex items-center justify-between text-label font-medium text-muted-foreground'>
              <span>步骤</span>
              <span>
                {progress.current
                  ? `第 ${progress.current.ordinal} 步进行中`
                  : progress.failure
                    ? `第 ${progress.failure.ordinal} 步失败`
                    : null}
              </span>
            </p>
            <StepTimeline
              run={run}
              evidenceItems={evidence?.items ?? []}
              currentStepRunId={run.stepRuns.find((step) => step.status === 'RUNNING')?.id ?? null}
              onSelectStep={(stepRunId) => void navigate({ to: '/runs/$runId', params: { runId }, search: { stepRunId } })}
            />
          </section>
        ) : (
          <p className='text-small text-muted-foreground'>正在读取运行…</p>
        )}
      </div>
      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title='终止这次运行？'
        desc='已经执行的步骤不会回滚；终止要等执行节点确认后才会生效。'
        confirmText='终止'
        destructive
        handleConfirm={() => {
          setCancelOpen(false)
          setCancelling(true)
          cancelRun(runId).catch((error) => {
            setCancelling(false)
            toast.error(error instanceof ApiRequestError ? error.message : '终止失败')
          })
        }}
      />
    </>
  )
}
