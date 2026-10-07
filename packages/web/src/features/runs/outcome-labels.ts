import {
  isPageHealthKind,
  isPageHealthResult,
  pageHealthCountsText,
  pageHealthFactFromResult,
  type OutcomeStatus,
  type RunDetailDto,
  type RunStatus,
} from '@cairn/shared'
import type { StatusTone } from '@/components/status-badge'

export const RUN_OUTCOME_STATUS_LABELS: Record<OutcomeStatus, string> = {
  PASS: '业务通过',
  WARN: '业务告警',
  FAIL: '业务异常',
  UNKNOWN: '业务未知',
  NOT_EVALUATED: '未评价业务结果',
}

export const RUN_OUTCOME_STATUS_HINTS: Record<OutcomeStatus, string> = {
  PASS: '已求值的必须与应当条件都成立。',
  WARN: '应当成立的条件未满足，必须条件已通过。',
  FAIL: '必须成立的条件未满足。',
  UNKNOWN: '有必须条件没能求值，不能据此判断业务成败。',
  NOT_EVALUATED: '这次运行没有成功条件，或历史运行尚未纳入结果轴。',
}

export const RUN_EXECUTION_AXIS_LABELS: Record<RunStatus, string> = {
  QUEUED: '等待执行',
  RUNNING: '正在执行',
  RECOVERING: '正在恢复执行',
  WAITING_FOR_AUTH: '执行等待登录',
  HOLDING: '执行挂起',
  SUCCEEDED: '执行完成',
  FAILED: '执行失败',
  CANCELLED: '执行已取消',
  NEEDS_REVIEW: '执行待核查',
}

export function runOutcomeStatusTone(status: OutcomeStatus | 'NOT_APPLICABLE'): StatusTone {
  if (status === 'PASS') return 'success'
  if (status === 'FAIL') return 'error'
  if (status === 'WARN' || status === 'UNKNOWN') return 'warning'
  return 'neutral'
}

export type PageHealthIgnoreRule = { kind: 'network_health' | 'script_errors'; value: string }

type ConditionsRun = Pick<RunDetailDto, 'snapshot' | 'outcomeResults'>

/** 页面健康违规的汇总文案，如「3 处接口错误 · 1 处脚本异常」；没有违规返回空串（此时界面什么都不显示）。 */
export function pageHealthSummaryOf(run: Pick<RunDetailDto, 'outcomeResults'>): string {
  const facts = (run.outcomeResults ?? [])
    .filter((item) => isPageHealthResult(item) && (item.verdict === 'FAIL' || item.verdict === 'WARN'))
    .map((item) => pageHealthFactFromResult(item))
    .filter((fact): fact is NonNullable<typeof fact> => Boolean(fact))
  return pageHealthCountsText(facts)
}

/** 有没有可显示的成功条件 / 运行期约束：没有违规的页面健康约束不算。 */
export function hasVisibleConditions(run: ConditionsRun): boolean {
  if (run.snapshot.outcomeManifest?.entries.length) return true
  const violated = new Set(
    (run.outcomeResults ?? []).filter((item) => item.verdict === 'FAIL' || item.verdict === 'WARN').map((item) => item.contractId),
  )
  return (run.snapshot.runtimeInvariantManifest?.entries ?? []).some(
    (entry) => !isPageHealthKind(entry.kind) || violated.has(entry.id),
  )
}

/** 按发起步骤统计页面健康违规：stepId → { 接口错误数, 脚本异常数 }。没有违规返回空 Map。 */
export function pageHealthCountsByStep(
  outcomeResults: Pick<RunDetailDto, 'outcomeResults'>['outcomeResults'],
): Map<string, { net: number; script: number }> {
  const byStep = new Map<string, { net: number; script: number }>()
  for (const item of outcomeResults ?? []) {
    if (!isPageHealthResult(item) || (item.verdict !== 'FAIL' && item.verdict !== 'WARN')) continue
    for (const sample of pageHealthFactFromResult(item)?.samples ?? []) {
      if (!sample.stepId) continue
      const entry = byStep.get(sample.stepId) ?? { net: 0, script: 0 }
      if (sample.type === 'script_error') entry.script += sample.count
      else entry.net += sample.count
      byStep.set(sample.stepId, entry)
    }
  }
  return byStep
}
