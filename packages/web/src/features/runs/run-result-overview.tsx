import { useNavigate } from '@tanstack/react-router'
import { useAuthStore } from '@/stores/auth-store'
import { useMemo } from 'react'
import {
  hasPermission,
  type RunDetailDto,
  type EvidenceMetadata,
} from '@cairn/shared'
import {
  AlertTriangle,
  ArrowRight,
  Sparkles,
  Target,
  TrendingUp,
} from 'lucide-react'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Can } from '@/components/rbac/can'
import { useAssistantStore } from '@/stores/assistant-store'
import { buildStepQuote } from '@/features/assistant/quote-helper'
import { RunOutputCard } from './run-output-card'
import { OutcomeAxisSummary, OutcomeConditionList, RUN_EXECUTION_AXIS_LABELS } from './outcome-axis'
import { hasVisibleConditions, pageHealthSummaryOf } from './outcome-labels'
import { translateStepError } from './error-translator'
import { RunDurationSection } from './run-duration-section'

export type RunResultOverviewProps = {
  run: RunDetailDto
  evidenceItems: EvidenceMetadata[]
  onSelectStep: (stepRunId: string) => void
  onFocusEvidence?: (evidenceId: string) => void
}

export function RunResultOverview({
  run,
  evidenceItems,
  onSelectStep,
  onFocusEvidence,
}: RunResultOverviewProps) {
  const navigate = useNavigate()
  const authUser = useAuthStore((state) => state.auth.user)
  const canEditScenario = Boolean(authUser && hasPermission(authUser.permissions, 'workflow:write'))
  const openAssistant = useAssistantStore((state) => state.openPanel)
  const setQuote = useAssistantStore((state) => state.setQuote)

  // 1. 提取异常步骤（首个失败步骤）
  const failedStep = useMemo(() => {
    return run.stepRuns.find((s) => s.status === 'FAILED')
  }, [run.stepRuns])

  const failedAttempt = failedStep?.attempts[failedStep.attempts.length - 1]
  const failedDiagnosis = failedAttempt?.error ? translateStepError(failedAttempt.error) : null

  // 3. 提取全局上下文变量 (run.context 中的键值)
  const contextEntries = useMemo(() => {
    if (!run.context || typeof run.context !== 'object') return []
    return Object.entries(run.context).filter(([k]) => !k.startsWith('_') && !k.startsWith('$'))
  }, [run.context])

  // 没有违规的页面健康约束不算「已配置断言」，也不显示任何占位。
  const hasAssertions = hasVisibleConditions(run)
  const pageHealthSummary = pageHealthSummaryOf(run)

  return (
    <div className='flex flex-1 flex-col overflow-y-auto p-4 space-y-4'>
      {/* A. 异常直接归因卡片 (若有失败步骤) */}
      {failedStep && failedAttempt?.error ? (
        <section className='rounded-lg border border-status-error-foreground/30 bg-status-error-background/15 p-4 shadow-xs space-y-3'>
          <div className='flex flex-wrap items-start justify-between gap-3'>
            <div className='flex items-start gap-2.5 min-w-0'>
              <AlertTriangle className='size-5 text-status-error-foreground shrink-0 mt-0.5' />
              <div>
                <div className='flex items-center gap-2'>
                  <span className='font-mono font-bold text-status-error-foreground text-caption bg-status-error-background px-1.5 py-0.5 rounded'>
                    #{failedStep.ordinal + 1}
                  </span>
                  <h3 className='text-body font-semibold text-status-error-foreground truncate'>
                    运行于步骤「{failedStep.name}」中断失败
                  </h3>
                </div>
                <p className='mt-1 text-label text-foreground font-medium'>
                  {failedDiagnosis?.title || failedAttempt.error.code}: {failedDiagnosis?.description || failedAttempt.error.safeMessage}
                </p>
                {failedDiagnosis?.suggestion ? (
                  <p className='mt-1 text-caption text-muted-foreground'>
                    💡 排查建议：{failedDiagnosis.suggestion}
                  </p>
                ) : null}
              </div>
            </div>

            <div className='flex items-center gap-2 shrink-0'>
              <Can allOf={['ai:assist']}>
                <Button
                  type='button'
                  size='sm'
                  variant='outline'
                  className='h-7.5 text-label border-status-error-foreground/30 hover:bg-status-error-background/30 gap-1'
                  onClick={() => {
                    const err = `${failedAttempt.error?.code}: ${failedAttempt.error?.safeMessage}`
                    setQuote(buildStepQuote(failedStep, err))
                    openAssistant({
                      question: `分析本次运行失败原因：第 ${failedStep.ordinal + 1} 步 [${failedStep.name}] 报错 ${failedAttempt.error?.code}，如何解决？`,
                      capabilityHint: 'run.diagnose',
                      pageContext: { page: 'run', runId: run.id },
                    })
                  }}
                >
                  <Sparkles className='size-3.5 text-primary' />
                  <span>智能诊断</span>
                </Button>
              </Can>

              <Button
                type='button'
                size='sm'
                className='h-7.5 text-label gap-1'
                onClick={() => onSelectStep(failedStep.id)}
              >
                <span>查看失败现场</span>
                <ArrowRight className='size-3.5' />
              </Button>
            </div>
          </div>
        </section>
      ) : null}

      {/* B. 业务最终判定与成功条件 (Outcome & Assertions) */}
      <section className='rounded-lg border border-border-card bg-card p-4 shadow-card space-y-3'>
        <div className='flex items-center justify-between border-b border-border-card/60 pb-2.5'>
          <div className='flex items-center gap-2'>
            <Target className='size-4 text-primary' />
            <h2 className='text-body font-semibold text-foreground'>业务判定与成功条件</h2>
          </div>
          <span className='text-caption text-muted-foreground'>
            {hasAssertions ? '已配置断言规则' : '无显式断言规则'}
          </span>
        </div>

        {/* 双轴判定摘要 */}
        <OutcomeAxisSummary
          executionLabel={RUN_EXECUTION_AXIS_LABELS[run.status]}
          outcomeStatus={run.outcomeStatus}
          hasContracts={hasAssertions}
        />
        {pageHealthSummary ? (
          <p className='text-label text-status-warning-foreground' data-testid='page-health-summary'>
            页面健康：{pageHealthSummary}
          </p>
        ) : null}

        {/* 详细断言列表 */}
        {hasAssertions ? (
          <div className='pt-1'>
            <OutcomeConditionList
              runId={run.id}
              run={run}
              evidenceItems={evidenceItems}
              onFocusEvidence={onFocusEvidence}
              onOpenScenarioConfig={canEditScenario ? () => void navigate({ to: '/scenarios/$scenarioId', params: { scenarioId: run.scenarioId } }) : undefined}
            />
          </div>
        ) : (
          <p className='text-label text-muted-foreground pt-1'>
            本次运行未配置成功条件或运行期不变式规则；步骤执行结果可单独查看，业务结果未评价。
          </p>
        )}
      </section>

      {/* C. 业务产出与提取指标 (Outputs & Context Variables) */}
      {run.output ? (
        <RunOutputCard
          output={run.output}
          runStatus={run.status}
          outcomeStatus={run.outcomeStatus}
          onFocusEvidence={onFocusEvidence}
          onFocusStep={(stepOrdinal) => {
            const step = run.stepRuns.find((s) => s.ordinal === stepOrdinal)
            if (step) onSelectStep(step.id)
          }}
        />
      ) : contextEntries.length > 0 ? (
        <section className='rounded-lg border border-border-card bg-card p-4 shadow-card space-y-3'>
          <div className='flex items-center justify-between border-b border-border-card/60 pb-2.5'>
            <div className='flex items-center gap-2'>
              <TrendingUp className='size-4 text-primary' />
              <h2 className='text-body font-semibold text-foreground'>关键提取变量与产出数据</h2>
            </div>
            <span className='text-caption text-muted-foreground font-mono'>
              {contextEntries.length} 项变量
            </span>
          </div>

          <div className='grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5'>
            {contextEntries.map(([key, val]) => (
              <div
                key={key}
                className='flex flex-col justify-between rounded-md border border-border-card bg-muted/20 p-2.5 text-label'
              >
                <span className='font-mono font-medium text-muted-foreground text-caption truncate'>
                  {key}
                </span>
                <span className='font-mono font-semibold text-foreground text-body mt-1 truncate' title={String(val)}>
                  {typeof val === 'object' && val !== null ? JSON.stringify(val) : String(val)}
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : (
        <section className='rounded-lg border border-border-card bg-card p-4 shadow-card'>
          <div className='flex items-center justify-between'>
            <div className='flex items-center gap-2 text-muted-foreground text-label'>
              <TrendingUp className='size-4' />
              <span>本场景未配置数据提取或业务指标回传。</span>
            </div>
            <StatusBadge tone='neutral'>无产出指标</StatusBadge>
          </div>
        </section>
      )}

      {/* D. 耗时分布与对比：按编排节点的耗时事实，可与上次对比 */}
      <RunDurationSection run={run} onSelectStep={onSelectStep} />
    </div>
  )
}
