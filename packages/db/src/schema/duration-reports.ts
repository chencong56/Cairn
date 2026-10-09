import { boolean, index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import type { DurationPeriodKind, DurationReportIssueStatus, DurationTriggerFilter } from '@cairn/shared'
import { cairnSchema, consoleAccounts } from './console.js'
import { reports } from './reports.js'
import { scenarioSuites } from './suites.js'
import { targets } from './targets.js'

/** 周期耗时报告订阅：到点为最近一期生成报告并推送到所选渠道。新建默认不启用。 */
export const durationReportSubscriptions = cairnSchema.table(
  'duration_report_subscriptions',
  {
    id: uuid('id').primaryKey(),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    suiteId: uuid('suite_id').references(() => scenarioSuites.id, { onDelete: 'restrict' }),
    periodKind: text('period_kind').notNull().$type<DurationPeriodKind>(),
    sendWeekday: integer('send_weekday').notNull().default(1),
    sendDay: integer('send_day').notNull().default(1),
    sendTime: text('send_time').notNull().default('09:00'),
    timeZone: text('time_zone').notNull(),
    triggerFilter: text('trigger_filter').notNull().$type<DurationTriggerFilter>(),
    channelIds: jsonb('channel_ids').$type<string[]>().notNull(),
    enabled: boolean('enabled').notNull().default(false),
    /** 最近一次打开的时刻：发送时刻早于它的周期不补发。 */
    enabledAt: timestamp('enabled_at', { withTimezone: true }),
    revision: integer('revision').notNull().default(1),
    createdByConsoleAccountId: uuid('created_by_console_account_id')
      .notNull()
      .references(() => consoleAccounts.id, { onDelete: 'restrict' }),
    updatedByConsoleAccountId: uuid('updated_by_console_account_id').references(() => consoleAccounts.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('duration_report_subscriptions_target_idx').on(t.targetId, t.createdAt), index('duration_report_subscriptions_enabled_idx').on(t.enabled, t.periodKind)],
)

/** 每个订阅每一期一行：保证每期只生成、只推送一次。 */
export const durationReportIssues = cairnSchema.table(
  'duration_report_issues',
  {
    id: uuid('id').primaryKey(),
    subscriptionId: uuid('duration_report_subscription_id')
      .notNull()
      .references(() => durationReportSubscriptions.id, { onDelete: 'cascade' }),
    periodStart: text('period_start').notNull(),
    status: text('status').notNull().$type<DurationReportIssueStatus>(),
    reason: text('reason'),
    reportId: uuid('report_id').references(() => reports.id, { onDelete: 'restrict' }),
    exportJobId: uuid('export_job_id'),
    outboundEventId: uuid('outbound_event_id'),
    attempts: integer('attempts').notNull().default(0),
    sendAt: timestamp('send_at', { withTimezone: true }).notNull(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex('duration_report_issues_period_idx').on(t.subscriptionId, t.periodStart), index('duration_report_issues_status_idx').on(t.status, t.nextAttemptAt)],
)
