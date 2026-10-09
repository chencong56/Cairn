import { describe, expect, it } from 'vitest'
import {
  durationReportSendAt,
  latestDueDurationReportPeriod,
  nextDurationReportSendAt,
  durationPeriodBaseLabel,
  durationPeriodBaseStart,
  durationPeriodEnd,
  durationPeriodLabel,
  isDurationPeriodStart,
  isoWeekOf,
  lastCompleteDurationPeriodStart,
  localDateOf,
  localDateSchema,
  shiftLocalDate,
  shiftLocalMonth,
  zonedStartOfDay,
} from '../duration-period.js'
import { durationPeriodReportSubjectSchema, reportSubjectSchema } from '../reports.js'
import { createDurationReportSubscriptionBodySchema, durationPeriodReportOf } from '../duration-report.js'
import { buildDurationReportImCard, imCardProviderOfHost, outboundPayloadSchema } from '../outbound.js'

describe('natural periods', () => {
  it('shifts local dates by calendar days and months', () => {
    expect(shiftLocalDate('2026-02-27', 2)).toBe('2026-03-01')
    expect(shiftLocalDate('2024-02-28', 1)).toBe('2024-02-29')
    expect(shiftLocalDate('2026-01-01', -1)).toBe('2025-12-31')
    expect(shiftLocalMonth('2026-01-01', -1)).toBe('2025-12-01')
    expect(shiftLocalMonth('2026-12-01', 1)).toBe('2027-01-01')
  })

  it('local midnight maps to the right UTC instant, including DST days', () => {
    expect(zonedStartOfDay('2026-10-05', 'Asia/Shanghai').toISOString()).toBe('2026-10-04T16:00:00.000Z')
    expect(zonedStartOfDay('2026-10-05', 'UTC').toISOString()).toBe('2026-10-05T00:00:00.000Z')
    // 纽约 2026-03-08 凌晨 2 点进入夏令时：当天 00:00 仍是 EST（-5），次日为 EDT（-4）
    expect(zonedStartOfDay('2026-03-08', 'America/New_York').toISOString()).toBe('2026-03-08T05:00:00.000Z')
    expect(zonedStartOfDay('2026-03-09', 'America/New_York').toISOString()).toBe('2026-03-09T04:00:00.000Z')
    expect(localDateOf(new Date('2026-10-04T16:30:00Z'), 'Asia/Shanghai')).toBe('2026-10-05')
  })

  it('ISO week numbers across year boundaries', () => {
    expect(isoWeekOf('2026-09-28')).toEqual({ year: 2026, week: 40 })
    expect(isoWeekOf('2026-01-01')).toEqual({ year: 2026, week: 1 })
    expect(isoWeekOf('2025-12-29')).toEqual({ year: 2026, week: 1 })
    expect(isoWeekOf('2027-01-01')).toEqual({ year: 2026, week: 53 })
    expect(isoWeekOf('2021-01-03')).toEqual({ year: 2020, week: 53 })
  })

  it('period starts, ends and the latest completed period', () => {
    expect(isDurationPeriodStart('week', '2026-09-28')).toBe(true)
    expect(isDurationPeriodStart('week', '2026-09-29')).toBe(false)
    expect(isDurationPeriodStart('month', '2026-09-01')).toBe(true)
    expect(isDurationPeriodStart('month', '2026-09-02')).toBe(false)
    expect(durationPeriodEnd('week', '2026-09-28')).toBe('2026-10-05')
    expect(durationPeriodEnd('month', '2024-02-01')).toBe('2024-03-01')
    // 2026-10-07 周三（上海）：上周为 9/28 起，上月为 9 月
    const now = new Date('2026-10-07T03:00:00Z')
    expect(lastCompleteDurationPeriodStart('week', now, 'Asia/Shanghai')).toBe('2026-09-28')
    expect(lastCompleteDurationPeriodStart('month', now, 'Asia/Shanghai')).toBe('2026-09-01')
    // 周一当天，上周就是刚结束的那一周
    expect(lastCompleteDurationPeriodStart('week', new Date('2026-10-05T01:00:00Z'), 'Asia/Shanghai')).toBe('2026-09-28')
    // 时区决定日期：UTC 10/4 18:00 在上海已是周一 10/5
    expect(lastCompleteDurationPeriodStart('week', new Date('2026-10-04T18:00:00Z'), 'Asia/Shanghai')).toBe('2026-09-28')
    expect(lastCompleteDurationPeriodStart('week', new Date('2026-10-04T18:00:00Z'), 'UTC')).toBe('2026-09-21')
  })

  it('comparison periods: previous, and same period last year (364 days for weeks)', () => {
    expect(durationPeriodBaseStart('week', '2026-09-28', 'prev_period')).toBe('2026-09-21')
    expect(durationPeriodBaseStart('week', '2026-09-28', 'last_year')).toBe('2025-09-29')
    expect(isDurationPeriodStart('week', durationPeriodBaseStart('week', '2026-09-28', 'last_year'))).toBe(true)
    expect(durationPeriodBaseStart('month', '2026-03-01', 'prev_period')).toBe('2026-02-01')
    expect(durationPeriodBaseStart('month', '2026-03-01', 'last_year')).toBe('2025-03-01')
  })

  it('labels', () => {
    expect(durationPeriodLabel('week', '2026-09-28')).toBe('2026 年第 40 周（9/28–10/4）')
    expect(durationPeriodLabel('month', '2026-09-01')).toBe('2026 年 9 月')
    expect(durationPeriodBaseLabel('week', 'prev_period')).toBe('上周')
    expect(durationPeriodBaseLabel('month', 'last_year')).toBe('去年同月')
  })

  it('local date schema rejects impossible dates', () => {
    expect(localDateSchema.safeParse('2024-02-29').success).toBe(true)
    expect(localDateSchema.safeParse('2026-02-29').success).toBe(false)
    expect(localDateSchema.safeParse('2026-9-1').success).toBe(false)
  })
})

describe('duration period report subject', () => {
  const subject = {
    kind: 'DURATION_PERIOD',
    targetId: '11111111-1111-4111-8111-111111111111',
    period: 'week',
    periodStart: '2026-09-28',
    timeZone: 'Asia/Shanghai',
    trigger: 'schedule',
  } as const

  it('is a report subject and stays strict', () => {
    expect(reportSubjectSchema.parse(subject)).toEqual(subject)
    expect(durationPeriodReportSubjectSchema.safeParse({ ...subject, runId: subject.targetId }).success).toBe(false)
    expect(durationPeriodReportSubjectSchema.safeParse({ ...subject, period: 'day' }).success).toBe(false)
  })

  it('reads the report block back from a sealed document', () => {
    expect(durationPeriodReportOf({ sections: [{ blocks: [{ type: 'summary' }] }] })).toBeNull()
    expect(durationPeriodReportOf({ sections: [{ blocks: [{ type: 'duration_period_report', version: 1 }] }] })).toBeNull()
  })
})

describe('duration report schedule', () => {
  const weekly = { period: 'week' as const, sendWeekday: 1, sendDay: 1, sendTime: '09:00', timeZone: 'Asia/Shanghai' }
  const monthly = { period: 'month' as const, sendWeekday: 1, sendDay: 3, sendTime: '08:30', timeZone: 'Asia/Shanghai' }

  it('send time for a period: the weekday after the week / the day of next month, local time', () => {
    expect(durationReportSendAt(weekly, '2026-09-28').toISOString()).toBe('2026-10-05T01:00:00.000Z')
    expect(durationReportSendAt({ ...weekly, sendWeekday: 5, sendTime: '18:15' }, '2026-09-28').toISOString()).toBe('2026-10-09T10:15:00.000Z')
    expect(durationReportSendAt(monthly, '2026-09-01').toISOString()).toBe('2026-10-03T00:30:00.000Z')
    expect(durationReportSendAt(monthly, '2026-12-01').toISOString()).toBe('2027-01-03T00:30:00.000Z')
  })

  it('latest due period only counts periods whose send time has passed', () => {
    // 周一 08:00（上海）：上周的报告 09:00 才发，最近一期仍是上上周
    expect(latestDueDurationReportPeriod(weekly, new Date('2026-10-05T00:00:00Z'))).toBe('2026-09-21')
    expect(latestDueDurationReportPeriod(weekly, new Date('2026-10-05T01:00:00Z'))).toBe('2026-09-28')
    expect(latestDueDurationReportPeriod(monthly, new Date('2026-10-02T00:00:00Z'))).toBe('2026-08-01')
    expect(latestDueDurationReportPeriod(monthly, new Date('2026-10-07T00:00:00Z'))).toBe('2026-09-01')
  })

  it('next send time', () => {
    expect(nextDurationReportSendAt(weekly, new Date('2026-10-05T00:00:00Z')).toISOString()).toBe('2026-10-05T01:00:00.000Z')
    expect(nextDurationReportSendAt(weekly, new Date('2026-10-07T00:00:00Z')).toISOString()).toBe('2026-10-12T01:00:00.000Z')
    expect(nextDurationReportSendAt(monthly, new Date('2026-10-07T00:00:00Z')).toISOString()).toBe('2026-11-03T00:30:00.000Z')
  })
})

describe('duration report subscriptions and push', () => {
  it('new subscriptions default to disabled with weekly Monday 09:00 and scheduled runs only', () => {
    const parsed = createDurationReportSubscriptionBodySchema.parse({ targetId: '11111111-1111-4111-8111-111111111111', period: 'week' })
    expect(parsed).toMatchObject({ enabled: false, sendWeekday: 1, sendDay: 1, sendTime: '09:00', trigger: 'schedule', channelIds: [] })
    // 不传时区：由服务端按平台统计时区填
    expect(parsed.timeZone).toBeUndefined()
    expect(createDurationReportSubscriptionBodySchema.safeParse({ targetId: '11111111-1111-4111-8111-111111111111', period: 'month', sendDay: 29 }).success).toBe(false)
    expect(createDurationReportSubscriptionBodySchema.safeParse({ targetId: '11111111-1111-4111-8111-111111111111', period: 'week', sendTime: '9:00' }).success).toBe(false)
    expect(createDurationReportSubscriptionBodySchema.safeParse({ targetId: '11111111-1111-4111-8111-111111111111', period: 'week', timeZone: 'Mars/Base' }).success).toBe(false)
  })

  it('push payload carries only title, period, highlights and console path', () => {
    const report = { reportId: '22222222-2222-4222-8222-222222222222', title: '商城 耗时周报 · 2026 年第 40 周（9/28–10/4）', periodLabel: '2026 年第 40 周（9/28–10/4）', targetName: '商城', highlights: ['本周整体执行耗时 P50 为 13s。'], consolePath: '/reports/22222222-2222-4222-8222-222222222222' }
    expect(outboundPayloadSchema.parse({ title: report.title, report }).report).toEqual(report)
    expect(outboundPayloadSchema.safeParse({ title: report.title, report: { ...report, block: {} } }).success).toBe(false)
  })

  it('IM cards by webhook host', () => {
    expect(imCardProviderOfHost('qyapi.weixin.qq.com')).toBe('wechat_work')
    expect(imCardProviderOfHost('open.feishu.cn')).toBe('feishu')
    expect(imCardProviderOfHost('open.larksuite.com')).toBe('feishu')
    expect(imCardProviderOfHost('oapi.dingtalk.com')).toBe('dingtalk')
    expect(imCardProviderOfHost('hooks.example.com')).toBeNull()
    const input = { title: '商城 耗时周报', periodLabel: '2026 年第 40 周', highlights: ['慢了 30%', '等待持平'], viewUrl: 'https://console.example.com/reports/r1' }
    const wechat = buildDurationReportImCard('wechat_work', input) as { msgtype: string; markdown: { content: string } }
    expect(wechat.msgtype).toBe('markdown')
    expect(wechat.markdown.content).toContain('- 慢了 30%')
    expect(wechat.markdown.content).toContain('(https://console.example.com/reports/r1)')
    const feishu = buildDurationReportImCard('feishu', { ...input, viewUrl: null }) as { msg_type: string; card: { elements: unknown[] } }
    expect(feishu.msg_type).toBe('interactive')
    expect(feishu.card.elements).toHaveLength(1)
    const ding = buildDurationReportImCard('dingtalk', input) as { msgtype: string; actionCard: { singleURL: string } }
    expect(ding).toMatchObject({ msgtype: 'actionCard', actionCard: { singleURL: 'https://console.example.com/reports/r1' } })
  })
})
