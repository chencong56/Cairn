import type { ScenarioHealthFilter } from '@cairn/shared'

export type ScheduleFilter = 'scheduled' | 'unscheduled'

export const HEALTH_FILTER_LABELS: Record<ScenarioHealthFilter, string> = {
  failing: '异常',
  warning: '需关注',
  running: '运行中',
  passing: '正常',
  never: '从未运行',
}

export const HEALTH_FILTER_HINTS: Record<ScenarioHealthFilter, string> = {
  failing: '执行失败或检查未通过',
  warning: '有警告或结果不确定',
  running: '还没结束，含等待登录与待核查',
  passing: '通过或已完成',
  never: '还没有正式运行',
}

export const SCHEDULE_FILTER_LABELS: Record<ScheduleFilter, string> = {
  scheduled: '有定时调度',
  unscheduled: '无定时调度',
}

/** 创建时间范围，URL 里存本地日期（yyyy-MM-dd，含两端）；查询时按浏览器时区换算成时刻。 */
export type CreatedRange = { from?: string; to?: string }

const pad = (value: number) => String(value).padStart(2, '0')

export function dateKey(date: Date | undefined): string | undefined {
  if (!date) return undefined
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function dateFromKey(key: string | undefined): Date | undefined {
  if (!key) return undefined
  const [year, month, day] = key.split('-').map(Number)
  if (!year || !month || !day) return undefined
  return new Date(year, month - 1, day)
}

/** 含今天在内的最近 N 天。 */
export function recentDaysRange(days: number, now = new Date()): CreatedRange {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1))
  return { from: dateKey(start), to: dateKey(now) }
}

/** 本地日期范围 → 查询用的 [起点, 终点) 时刻：终点取结束日的次日零点。 */
export function createdRangeInstants(range: CreatedRange): { createdFrom?: string; createdTo?: string } {
  const from = dateFromKey(range.from)
  const to = dateFromKey(range.to)
  return {
    createdFrom: from?.toISOString(),
    createdTo: to ? new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1).toISOString() : undefined,
  }
}

export function createdRangeLabel(range: CreatedRange): string {
  if (range.from && range.to && range.from !== range.to) return `${range.from} ~ ${range.to}`
  if (range.from && (!range.to || range.to === range.from)) return range.to ? range.from : `${range.from} 起`
  return range.to ? `${range.to} 及以前` : ''
}
