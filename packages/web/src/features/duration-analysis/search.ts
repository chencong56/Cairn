import { z } from 'zod'
import { DURATION_COMPARE_MODES, DURATION_PERIOD_KINDS, DURATION_TRIGGER_FILTERS, entityIdSchema, localDateSchema, type DurationPeriodReportSubject } from '@cairn/shared'
import type { DurationFilters } from './format'

/** 筛选条件写进地址栏，便于分享与回退。 */
export const durationSearchSchema = z.object({
  days: z.coerce
    .number()
    .refine((value) => value === 7 || value === 30 || value === 90)
    .optional()
    .catch(undefined),
  granularity: z.enum(['day', 'week']).optional().catch(undefined),
  compare: z.enum(DURATION_COMPARE_MODES).optional().catch(undefined),
  trigger: z.enum(DURATION_TRIGGER_FILTERS).optional().catch(undefined),
  period: z.enum(DURATION_PERIOD_KINDS).optional().catch(undefined),
  periodStart: localDateSchema.optional().catch(undefined),
})
export type DurationSearch = z.infer<typeof durationSearchSchema>

export const targetDurationSearchSchema = durationSearchSchema.extend({
  targetId: entityIdSchema.optional().catch(undefined),
  suiteId: entityIdSchema.optional().catch(undefined),
  sort: z.enum(['delta', 'p95', 'name']).optional().catch(undefined),
  slower: z.coerce.boolean().optional().catch(undefined),
  issues: z.coerce.boolean().optional().catch(undefined),
})
export type TargetDurationSearch = z.infer<typeof targetDurationSearchSchema>

export function filtersOf(search: DurationSearch): DurationFilters {
  const days = (search.days ?? 30) as DurationFilters['days']
  const compare = search.compare ?? 'prev_period'
  return {
    days,
    granularity: days === 7 || search.period ? 'day' : (search.granularity ?? 'day'),
    // 自然周期只支持环比与去年同期
    compare: search.period && compare !== 'last_year' ? 'prev_period' : compare,
    trigger: search.trigger ?? 'all',
    period: search.period,
    periodStart: search.period ? search.periodStart : undefined,
  }
}

/** 只把非缺省值写进地址栏。 */
export function filtersToSearch(filters: DurationFilters): DurationSearch {
  return {
    days: filters.days === 30 ? undefined : filters.days,
    granularity: filters.granularity === 'day' ? undefined : filters.granularity,
    compare: filters.compare === 'prev_period' ? undefined : filters.compare,
    trigger: filters.trigger === 'all' ? undefined : filters.trigger,
    period: filters.period,
    periodStart: filters.period ? filters.periodStart : undefined,
  }
}

/** 在耗时分析页复现报告数字的筛选条件（与报告里的 consolePath 一致）；字段与报告主体同名，可直接传主体。 */
export function consoleSearchOf(subject: Pick<DurationPeriodReportSubject, 'targetId' | 'suiteId' | 'period' | 'periodStart' | 'trigger'>): TargetDurationSearch {
  return {
    targetId: subject.targetId,
    suiteId: subject.suiteId,
    period: subject.period,
    periodStart: subject.periodStart,
    trigger: subject.trigger === 'all' ? undefined : subject.trigger,
  }
}
