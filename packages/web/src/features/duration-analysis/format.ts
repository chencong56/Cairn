import {
  COMMON_TIME_ZONES,
  DEFAULT_STATISTICS_TIME_ZONE,
  formatDurationShort,
  lastCompleteDurationPeriodStart,
  type DurationCompareMode,
  type DurationPeriodKind,
  type DurationTriggerFilter,
} from '@cairn/shared'

export const COMPARE_LABELS: Readonly<Record<DurationCompareMode, string>> = {
  prev_period: '环比·上一周期',
  last_week: '同比·上周同期',
  last_month: '同比·上月同期',
  last_year: '同比·去年同期',
}

export const TRIGGER_LABELS: Readonly<Record<DurationTriggerFilter, string>> = {
  all: '全部发起方',
  manual: '手动',
  schedule: '调度',
  service: '接口调用',
}

export function formatMs(ms: number | null | undefined): string {
  return ms === null || ms === undefined ? '—' : formatDurationShort(ms)
}

export function formatPct(pct: number | null | undefined, unit = '%'): string {
  if (pct === null || pct === undefined) return '—'
  return `${pct > 0 ? '+' : ''}${pct}${unit}`
}

export function formatRatio(ratio: number | null | undefined): string {
  return ratio === null || ratio === undefined ? '—' : `${Math.round(ratio * 100)}%`
}

/** 耗时涨跌：变慢标红、变快标绿，±20% 以内不着色。 */
export function deltaTone(pct: number | null | undefined): string {
  if (pct === null || pct === undefined) return 'text-text-muted'
  if (pct >= 20) return 'text-status-error'
  if (pct <= -20) return 'text-status-success'
  return 'text-text-secondary'
}

export interface DurationFilters {
  days: 7 | 30 | 90
  granularity: 'day' | 'week'
  compare: DurationCompareMode
  trigger: DurationTriggerFilter
  /** 自然周期：上周 / 上月；periodStart 缺省为最近一个已结束的周期。 */
  period?: DurationPeriodKind
  periodStart?: string
}

/** 桶标签：本地日期 YYYY-MM-DD → M/D。 */
export function bucketLabel(bucket: string): string {
  const [, m, d] = bucket.split('-')
  return `${Number(m)}/${Number(d)}`
}

/** 最近一个已结束的周期起点；时区取接口返回的统计时区，未加载时用出厂统计时区。 */
export function latestPeriodStart(kind: DurationPeriodKind, timeZone: string = DEFAULT_STATISTICS_TIME_ZONE): string {
  return lastCompleteDurationPeriodStart(kind, new Date(), timeZone)
}

/** 时区的中文说法：常用时区给名称，其它直接显示 IANA 名。 */
export function timeZoneLabel(timeZone: string): string {
  return COMMON_TIME_ZONES.find((zone) => zone.value === timeZone)?.label ?? timeZone
}
