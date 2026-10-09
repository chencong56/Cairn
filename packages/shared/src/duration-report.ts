import { z } from 'zod'
import {
  durationComparisonSchema,
  durationInsightSchema,
  suiteDurationSummarySchema,
} from './duration-analysis.js'
import { durationNodeKindSchema } from './duration-facts.js'
import { DURATION_TRIGGER_FILTERS, durationPeriodKindSchema } from './duration-period.js'
import { timeZoneSchema } from './time-zone.js'
import { entityIdSchema } from './wire.js'

/**
 * 周期耗时报告（周报 / 月报）的封存内容。报告文档里只有这一个块；
 * 控制台视图与 HTML 模板都只读它，不再回查数据库，事后补算事实不会改变已封存的报告。
 */

export const DURATION_PERIOD_REPORT_BLOCK = 'duration_period_report' as const
export const DURATION_REPORT_TOP_SCENARIOS = 5
export const DURATION_REPORT_TOP_STEPS = 10

const ms = z.number().nullable()

export const durationReportScenarioMoverSchema = z.object({
  scenarioId: entityIdSchema,
  name: z.string(),
  current: ms,
  base: ms,
  deltaPct: z.number().nullable(),
  samples: z.number().int().nonnegative(),
  baseSamples: z.number().int().nonnegative(),
  /** 两期成功运行中位数的差异归因摘要（与单次对比同一套规则）。 */
  summary: z.string(),
  /** 贡献最大的步骤与其它线索，逐条一句。 */
  causes: z.array(z.string()).max(5),
})
export type DurationReportScenarioMover = z.infer<typeof durationReportScenarioMoverSchema>

export const durationReportStepMoverSchema = z.object({
  scenarioId: entityIdSchema,
  scenarioName: z.string(),
  nodeKey: z.string(),
  name: z.string(),
  kind: durationNodeKindSchema,
  current: ms,
  base: ms,
  deltaPct: z.number().nullable(),
  samples: z.number().int().nonnegative(),
  baseSamples: z.number().int().nonnegative(),
  causes: z.array(z.string()).max(4),
})
export type DurationReportStepMover = z.infer<typeof durationReportStepMoverSchema>

export const durationReportScenarioRowSchema = z.object({
  scenarioId: entityIdSchema,
  name: z.string(),
  runs: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  samples: z.number().int().nonnegative(),
  activeP50: ms,
  activeP95: ms,
  deltaPct: z.number().nullable(),
  /** 月报的去年同月涨跌；周报为 null。 */
  yoyDeltaPct: z.number().nullable(),
  waitRatio: z.number().nullable(),
  /** 按天的执行耗时 P50，与 buckets 一一对应。 */
  series: z.array(ms),
  insightCount: z.number().int().nonnegative(),
})
export type DurationReportScenarioRow = z.infer<typeof durationReportScenarioRowSchema>

export const durationReportComparisonSchema = z.object({
  mode: z.enum(['prev_period', 'last_year']),
  label: z.string(),
  start: z.string(),
  end: z.string(),
})

export const durationPeriodReportBlockSchema = z.object({
  type: z.literal(DURATION_PERIOD_REPORT_BLOCK),
  version: z.literal(1),
  target: z.object({ id: entityIdSchema, name: z.string() }),
  suite: z.object({ id: entityIdSchema, name: z.string() }).nullable(),
  period: z.object({
    kind: durationPeriodKindSchema,
    /** 本地日期；结束日不含。 */
    start: z.string(),
    end: z.string(),
    label: z.string(),
    timeZone: z.string(),
  }),
  trigger: z.enum(DURATION_TRIGGER_FILTERS),
  /** 第一项为环比；月报第二项为同比。 */
  comparisons: z.array(durationReportComparisonSchema).min(1).max(2),
  kpis: z.object({
    runs: z.number().int().nonnegative(),
    succeeded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    activeP50: durationComparisonSchema,
    activeP50Yoy: durationComparisonSchema.nullable(),
    activeP95: durationComparisonSchema,
    waitRatio: durationComparisonSchema,
    queueP50: durationComparisonSchema,
    slower: z.number().int().nonnegative(),
    faster: z.number().int().nonnegative(),
    insightCount: z.number().int().nonnegative(),
    /** 全部可比运行按发起方计数（不受报告的发起方过滤影响）。 */
    triggers: z.object({ manual: z.number().int(), schedule: z.number().int(), service: z.number().int() }),
  }),
  conclusion: z.array(z.string()).max(6),
  slower: z.array(durationReportScenarioMoverSchema).max(DURATION_REPORT_TOP_SCENARIOS),
  faster: z.array(durationReportScenarioMoverSchema).max(DURATION_REPORT_TOP_SCENARIOS),
  slowerSteps: z.array(durationReportStepMoverSchema).max(DURATION_REPORT_TOP_STEPS),
  insights: z.array(durationInsightSchema),
  buckets: z.array(z.string()),
  scenarios: z.array(durationReportScenarioRowSchema),
  suiteSummary: suiteDurationSummarySchema.nullable(),
  gaps: z.array(z.string()),
  /** 控制台里复现同一组数字的耗时分析页地址（相对路径）。 */
  consolePath: z.string(),
})
export type DurationPeriodReportBlock = z.infer<typeof durationPeriodReportBlockSchema>

/** 从封存文档里取出周期报告块；不是周期报告或解析失败时返回 null。 */
export function durationPeriodReportOf(document: { sections: Array<{ blocks: Array<Record<string, unknown>> }> }): DurationPeriodReportBlock | null {
  for (const section of document.sections) {
    for (const block of section.blocks) {
      if (block.type !== DURATION_PERIOD_REPORT_BLOCK) continue
      const parsed = durationPeriodReportBlockSchema.safeParse(block)
      return parsed.success ? parsed.data : null
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 订阅：到点生成并推送
// ---------------------------------------------------------------------------

export const DURATION_REPORT_ISSUE_STATUSES = ['pending', 'generated', 'delivered', 'skipped', 'failed'] as const
export type DurationReportIssueStatus = (typeof DURATION_REPORT_ISSUE_STATUSES)[number]

/** 每期记录的原因码与说明（界面与审计共用）。 */
export const DURATION_REPORT_ISSUE_REASONS: Readonly<Record<string, string>> = Object.freeze({
  missed_send_window: '错过发送窗口（执行节点停机期间），只补最近一期',
  subscription_disabled: '订阅已停用',
  waiting_for_facts: '等待本期运行的耗时计算完成',
  outbound_paused: '消息推送未启用',
  no_destination: '没有可用的推送渠道（渠道停用或不再授权给该目标系统）',
  generate_failed: '生成报告失败',
})

const sendTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '时间格式应为 HH:MM')
const channelIdsSchema = z
  .array(entityIdSchema)
  .max(8)
  .refine((ids) => new Set(ids).size === ids.length, '渠道不能重复选择')

export const createDurationReportSubscriptionBodySchema = z.strictObject({
  targetId: entityIdSchema,
  suiteId: entityIdSchema.optional(),
  period: durationPeriodKindSchema,
  sendWeekday: z.number().int().min(1).max(7).default(1),
  sendDay: z.number().int().min(1).max(28).default(1),
  sendTime: sendTimeSchema.default('09:00'),
  /** 缺省取平台统计时区。 */
  timeZone: timeZoneSchema.optional(),
  trigger: z.enum(DURATION_TRIGGER_FILTERS).default('schedule'),
  channelIds: channelIdsSchema.default([]),
  /** 新建默认不启用：确认渠道与时间后再打开。 */
  enabled: z.boolean().default(false),
})
export type CreateDurationReportSubscriptionBody = z.input<typeof createDurationReportSubscriptionBodySchema>

export const updateDurationReportSubscriptionBodySchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  suiteId: entityIdSchema.nullable().optional(),
  period: durationPeriodKindSchema.optional(),
  sendWeekday: z.number().int().min(1).max(7).optional(),
  sendDay: z.number().int().min(1).max(28).optional(),
  sendTime: sendTimeSchema.optional(),
  timeZone: timeZoneSchema.optional(),
  trigger: z.enum(DURATION_TRIGGER_FILTERS).optional(),
  channelIds: channelIdsSchema.optional(),
  enabled: z.boolean().optional(),
})
export type UpdateDurationReportSubscriptionBody = z.input<typeof updateDurationReportSubscriptionBodySchema>

export const durationReportIssueDtoSchema = z.object({
  periodStart: z.string(),
  periodLabel: z.string(),
  status: z.enum(DURATION_REPORT_ISSUE_STATUSES),
  reason: z.string().nullable(),
  reportId: entityIdSchema.nullable(),
  outboundEventId: entityIdSchema.nullable(),
  updatedAt: z.string(),
})
export type DurationReportIssueDto = z.infer<typeof durationReportIssueDtoSchema>

export const durationReportSubscriptionDtoSchema = z.object({
  id: entityIdSchema,
  targetId: entityIdSchema,
  suiteId: entityIdSchema.nullable(),
  suiteName: z.string().nullable(),
  period: durationPeriodKindSchema,
  sendWeekday: z.number().int(),
  sendDay: z.number().int(),
  sendTime: z.string(),
  timeZone: z.string(),
  trigger: z.enum(DURATION_TRIGGER_FILTERS),
  channelIds: z.array(entityIdSchema),
  enabled: z.boolean(),
  revision: z.number().int().positive(),
  /** 启用时的下一次发送时刻；停用为 null。 */
  nextSendAt: z.string().nullable(),
  lastIssue: durationReportIssueDtoSchema.nullable(),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type DurationReportSubscriptionDto = z.infer<typeof durationReportSubscriptionDtoSchema>

export const durationReportSubscriptionListSchema = z.object({ items: z.array(durationReportSubscriptionDtoSchema) })
export type DurationReportSubscriptionList = z.infer<typeof durationReportSubscriptionListSchema>
