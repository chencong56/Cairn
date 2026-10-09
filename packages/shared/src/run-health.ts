import { z } from 'zod'
import { ACTIVE_RUN_STATUSES } from './run.js'

/**
 * 场景健康度：按最近一次正式运行把场景归入一个分组。
 * 执行状态优先（未结束一律算运行中），其次看业务结论；证据完整性单独表达，不改变分组。
 */
export const RUN_HEALTH_BUCKETS = ['failing', 'warning', 'running', 'passing', 'cancelled', 'never'] as const
export type RunHealthBucket = (typeof RUN_HEALTH_BUCKETS)[number]
export const runHealthBucketSchema = z.enum(RUN_HEALTH_BUCKETS)

/** 各分组对应的状态集合；Web 判定与 DB 筛选、计数共用这一份，不另写映射。 */
export const RUN_HEALTH_RULES = {
  runningStatuses: ACTIVE_RUN_STATUSES,
  failingStatuses: ['FAILED'],
  failingOutcomes: ['FAIL'],
  cancelledStatuses: ['CANCELLED'],
  /** 仅对 SUCCEEDED 生效。 */
  warningOutcomes: ['WARN', 'UNKNOWN'],
} as const

export function runHealthBucket(
  run: { status: string; outcomeStatus?: string | null } | null | undefined,
): RunHealthBucket {
  if (!run) return 'never'
  if ((RUN_HEALTH_RULES.runningStatuses as readonly string[]).includes(run.status)) return 'running'
  if (
    (RUN_HEALTH_RULES.failingStatuses as readonly string[]).includes(run.status) ||
    (RUN_HEALTH_RULES.failingOutcomes as readonly string[]).includes(run.outcomeStatus ?? '')
  ) {
    return 'failing'
  }
  if ((RUN_HEALTH_RULES.cancelledStatuses as readonly string[]).includes(run.status)) return 'cancelled'
  if ((RUN_HEALTH_RULES.warningOutcomes as readonly string[]).includes(run.outcomeStatus ?? '')) return 'warning'
  return 'passing'
}
