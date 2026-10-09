import { ACTIVE_RUN_STATUSES, runHealthBucket, type RunDetailDto } from '@cairn/shared'
import { translateStepError } from '@/features/runs/error-translator'

export type RunPhase = 'running' | 'waiting' | 'passed' | 'attention' | 'failed' | 'cancelled'
export type TrackNode = 'done' | 'live' | 'failed' | 'skipped' | 'pending'

const ACTIVE = new Set<string>(ACTIVE_RUN_STATUSES)
const WAITING = new Set<string>(['WAITING_FOR_AUTH', 'HOLDING', 'NEEDS_REVIEW'])

export function isActiveRunStatus(status: string | undefined): boolean {
  return !status || ACTIVE.has(status)
}

/** 任务条与抽屉共用的进度视图：阶段、当前步、执行轨迹与失败摘要。 */
export function runProgress(run: RunDetailDto | undefined) {
  if (!run) {
    return { phase: 'running' as RunPhase, current: null, nodes: [] as TrackNode[], failure: null, evidenceIncomplete: false }
  }
  const steps = [...run.stepRuns].sort((a, b) => a.ordinal - b.ordinal)
  const bucket = runHealthBucket(run)
  const phase: RunPhase =
    bucket === 'running'
      ? WAITING.has(run.status)
        ? 'waiting'
        : 'running'
      : bucket === 'failing'
        ? 'failed'
        : bucket === 'cancelled'
          ? 'cancelled'
          : bucket === 'warning'
            ? 'attention'
            : 'passed'
  const live = ACTIVE.has(run.status)
  const currentStep =
    steps.find((step) => step.status === 'RUNNING') ?? (live ? steps.find((step) => step.status === 'PENDING') : undefined)
  const failedStep = steps.find((step) => step.status === 'FAILED')
  const failedAttempt = failedStep?.attempts[failedStep.attempts.length - 1]
  const nodes: TrackNode[] = steps.map((step) => {
    if (step.status === 'SUCCEEDED') return 'done'
    if (step.status === 'FAILED') return 'failed'
    if (step.status === 'SKIPPED') return 'skipped'
    if (step.status === 'RUNNING' || (live && step.id === currentStep?.id)) return 'live'
    return 'pending'
  })
  return {
    phase,
    // 有循环与条件分支时总步数不固定，只报「第 N 步」与步骤名，不报分母。
    current: currentStep ? { ordinal: currentStep.ordinal + 1, name: currentStep.name } : null,
    nodes,
    failure: failedStep
      ? {
          ordinal: failedStep.ordinal + 1,
          name: failedStep.name,
          reason: translateStepError(failedAttempt?.error ?? undefined).title,
        }
      : null,
    evidenceIncomplete: run.evidenceStatus === 'INCOMPLETE',
  }
}
