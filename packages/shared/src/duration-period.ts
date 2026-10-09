import { z } from 'zod'

/**
 * 自然周期（周 / 月）：周期报告与耗时分析页「上周 / 上月」共用的日历换算。
 * 周以周一为起点；边界、周号一律按指定时区的本地日历日计算，与服务器时区无关。
 */

/** 发起方过滤（耗时分析与周期报告共用）。放在这里而不是 duration-analysis，是为了让报告契约引用它时不牵出运行契约，避免循环引用。 */
export const DURATION_TRIGGER_FILTERS = ['all', 'manual', 'schedule', 'service'] as const
export type DurationTriggerFilter = (typeof DURATION_TRIGGER_FILTERS)[number]

export const DURATION_PERIOD_KINDS = ['week', 'month'] as const
export type DurationPeriodKind = (typeof DURATION_PERIOD_KINDS)[number]
export const durationPeriodKindSchema = z.enum(DURATION_PERIOD_KINDS)

/** 本地日期 YYYY-MM-DD。 */
export const localDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD')
  .refine((value) => {
    const [y, m, d] = value.split('-').map(Number)
    const date = new Date(Date.UTC(y!, m! - 1, d!))
    return date.getUTCFullYear() === y && date.getUTCMonth() === m! - 1 && date.getUTCDate() === d
  }, '不是有效的日期')

const DAY_MS = 24 * 60 * 60 * 1000

function parts(day: string): [number, number, number] {
  const [y, m, d] = day.split('-').map(Number)
  return [y!, m!, d!]
}

function format(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** 本地日期按日历日加减。 */
export function shiftLocalDate(day: string, days: number): string {
  const [y, m, d] = parts(day)
  return format(Date.UTC(y, m - 1, d) + days * DAY_MS)
}

/** 每月 1 日按月加减。 */
export function shiftLocalMonth(day: string, months: number): string {
  const [y, m] = parts(day)
  return format(Date.UTC(y, m - 1 + months, 1))
}

const dayFormatters = new Map<string, Intl.DateTimeFormat>()
/** 某一时刻在时区内的本地日期。 */
export function localDateOf(instant: Date, timeZone: string): string {
  let formatter = dayFormatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    dayFormatters.set(timeZone, formatter)
  }
  return formatter.format(instant)
}

const offsetFormatters = new Map<string, Intl.DateTimeFormat>()
function offsetMs(instant: number, timeZone: string): number {
  let formatter = offsetFormatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    offsetFormatters.set(timeZone, formatter)
  }
  const values = Object.fromEntries(formatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]))
  const asUtc = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour) % 24, Number(values.minute), Number(values.second))
  return asUtc - Math.floor(instant / 1000) * 1000
}

/** 本地日期 00:00 在该时区对应的 UTC 时刻（处理夏令时：按当天实际偏移修正一次）。 */
export function zonedStartOfDay(day: string, timeZone: string): Date {
  const [y, m, d] = parts(day)
  const guess = Date.UTC(y, m - 1, d)
  const first = guess - offsetMs(guess, timeZone)
  return new Date(guess - offsetMs(first, timeZone))
}

/** 周一 = 1 … 周日 = 7。 */
function isoWeekday(day: string): number {
  const [y, m, d] = parts(day)
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  return weekday === 0 ? 7 : weekday
}

/** ISO 8601 周号：周四所在的年份即该周的年份。 */
export function isoWeekOf(day: string): { year: number; week: number } {
  const thursday = shiftLocalDate(day, 4 - isoWeekday(day))
  const [year] = parts(thursday)
  const jan4 = `${year}-01-04`
  const firstThursday = shiftLocalDate(jan4, 4 - isoWeekday(jan4))
  const [ty, tm, td] = parts(thursday)
  const [fy, fm, fd] = parts(firstThursday)
  return { year, week: Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / (7 * DAY_MS)) + 1 }
}

export function isDurationPeriodStart(kind: DurationPeriodKind, day: string): boolean {
  return kind === 'week' ? isoWeekday(day) === 1 : day.endsWith('-01')
}

/** 周期结束日（不含）。 */
export function durationPeriodEnd(kind: DurationPeriodKind, start: string): string {
  return kind === 'week' ? shiftLocalDate(start, 7) : shiftLocalMonth(start, 1)
}

/** 截至 now 最近一个已结束的周期起点。 */
export function lastCompleteDurationPeriodStart(kind: DurationPeriodKind, now: Date, timeZone: string): string {
  const today = localDateOf(now, timeZone)
  if (kind === 'week') return shiftLocalDate(today, 1 - isoWeekday(today) - 7)
  return shiftLocalMonth(`${today.slice(0, 7)}-01`, -1)
}

export type DurationPeriodCompare = 'prev_period' | 'last_year'

/** 对比周期起点：环比为上一个周期；同比周报往前 364 天（星期对齐），月报取去年同月。 */
export function durationPeriodBaseStart(kind: DurationPeriodKind, start: string, compare: DurationPeriodCompare): string {
  if (kind === 'week') return shiftLocalDate(start, compare === 'last_year' ? -364 : -7)
  return shiftLocalMonth(start, compare === 'last_year' ? -12 : -1)
}

function shortRange(start: string, endExclusive: string): string {
  const last = shiftLocalDate(endExclusive, -1)
  const [, sm, sd] = parts(start)
  const [, em, ed] = parts(last)
  return `${sm}/${sd}–${em}/${ed}`
}

/** 周期名称：「2026 年第 41 周（10/5–10/11）」「2026 年 9 月」。 */
export function durationPeriodLabel(kind: DurationPeriodKind, start: string): string {
  if (kind === 'week') {
    const { year, week } = isoWeekOf(start)
    return `${year} 年第 ${week} 周（${shortRange(start, durationPeriodEnd('week', start))}）`
  }
  const [y, m] = parts(start)
  return `${y} 年 ${m} 月`
}

export function durationPeriodBaseLabel(kind: DurationPeriodKind, compare: DurationPeriodCompare): string {
  if (kind === 'week') return compare === 'last_year' ? '去年同周' : '上周'
  return compare === 'last_year' ? '去年同月' : '上月'
}

/** 「本周 / 本月」式的称呼，用于摘要句。 */
export function durationPeriodSelfLabel(kind: DurationPeriodKind): string {
  return kind === 'week' ? '本周' : '本月'
}

/** 周期按个数平移（周 ±7 天，月 ±1 月）。 */
export function shiftDurationPeriod(kind: DurationPeriodKind, start: string, count: number): string {
  return kind === 'week' ? shiftLocalDate(start, count * 7) : shiftLocalMonth(start, count)
}

/** 周期报告的发送安排：周报在周期结束后那一周的第 sendWeekday 天（1 = 周一），月报在下个月的第 sendDay 天，sendTime 为本地时刻。 */
export interface DurationReportSchedule {
  period: DurationPeriodKind
  sendWeekday: number
  sendDay: number
  sendTime: string
  timeZone: string
}

/** 某一期报告的发送时刻。 */
export function durationReportSendAt(schedule: DurationReportSchedule, periodStart: string): Date {
  const end = durationPeriodEnd(schedule.period, periodStart)
  const day = schedule.period === 'week' ? shiftLocalDate(end, schedule.sendWeekday - 1) : `${end.slice(0, 8)}${String(schedule.sendDay).padStart(2, '0')}`
  const [hour, minute] = schedule.sendTime.split(':').map(Number)
  return new Date(zonedStartOfDay(day, schedule.timeZone).getTime() + ((hour ?? 0) * 60 + (minute ?? 0)) * 60_000)
}

/** 截至 now 已到发送时刻的最近一期（只补这一期，更早的错过就错过）。 */
export function latestDueDurationReportPeriod(schedule: DurationReportSchedule, now: Date): string {
  const last = lastCompleteDurationPeriodStart(schedule.period, now, schedule.timeZone)
  return durationReportSendAt(schedule, last).getTime() <= now.getTime() ? last : shiftDurationPeriod(schedule.period, last, -1)
}

/** 下一次发送时刻。 */
export function nextDurationReportSendAt(schedule: DurationReportSchedule, now: Date): Date {
  const last = lastCompleteDurationPeriodStart(schedule.period, now, schedule.timeZone)
  const candidate = durationReportSendAt(schedule, last)
  return candidate.getTime() > now.getTime() ? candidate : durationReportSendAt(schedule, shiftDurationPeriod(schedule.period, last, 1))
}
