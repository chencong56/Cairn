import { z } from 'zod'
import { secretRefSchema } from './secret-ref.js'
import { entityIdSchema, utcInstantSchema } from './wire.js'

export const OUTBOUND_PROTOCOL = 'cairn.outbound@1' as const
export const OUTBOUND_WORKER_PROTOCOL = 'outbound-delivery@1' as const
export const RUN_OUTBOUND_PROTOCOL = 'run-outbound@1' as const
export const outboundStatusSchema = z.enum([
  'pending',
  'sending',
  'retry_wait',
  'accepted',
  'failed',
  'unknown',
  'suppressed',
])
export type OutboundStatus = z.infer<typeof outboundStatusSchema>
const uniqueIds = z
  .array(entityIdSchema)
  .refine((a) => new Set(a).size === a.length, '不能重复选择')
const label = z.string().trim().min(1).max(80)
const reason = z.string().trim().min(1).max(512)
export const outboundChannelSchema = z.strictObject({
  id: entityIdSchema,
  name: label,
  kind: z.enum(['webhook', 'email']),
  enabled: z.boolean(),
  allowAlerts: z.boolean(),
  targetIds: uniqueIds.max(100),
  version: z.number().int().positive(),
  secretRef: secretRefSchema,
  host: z.string().max(253),
  recipients: z.array(z.strictObject({ id: entityIdSchema, masked: z.string().max(320) })).max(20),
  format: z.enum(['legacy_alert@1', OUTBOUND_PROTOCOL]),
  replay: z.enum(['manual_on_unknown', 'receiver_deduplicates']),
})
export type OutboundChannel = z.infer<typeof outboundChannelSchema>
export const outboundSmtpSchema = z.strictObject({
  enabled: z.boolean(),
  version: z.number().int().positive(),
  secretRef: secretRefSchema,
  host: z.string().min(1).max(253),
})
export type OutboundSmtp = z.infer<typeof outboundSmtpSchema>
export const platformOutboundSchema = z
  .strictObject({
    enabled: z.boolean(),
    consoleBaseUrl: z.union([
      z.literal(''),
      z
        .url()
        .max(2048)
        .refine((v) => {
          const u = new URL(v)
          return (
            (u.protocol === 'https:' || u.protocol === 'http:') &&
            !u.username &&
            !u.password &&
            !u.search &&
            !u.hash
          )
        }, '控制台地址须为不含认证信息的 HTTP 或 HTTPS 地址'),
    ]),
    smtp: outboundSmtpSchema.nullable(),
    channels: z.array(outboundChannelSchema).max(16),
  })
  .superRefine((v, ctx) => {
    if (new Set(v.channels.map((c) => c.id)).size !== v.channels.length)
      ctx.addIssue({ code: 'custom', path: ['channels'], message: '渠道 ID 重复' })
  })
export type PlatformOutbound = z.infer<typeof platformOutboundSchema>
export const FACTORY_OUTBOUND: PlatformOutbound = {
  enabled: false,
  consoleBaseUrl: '',
  smtp: null,
  channels: [],
}

export const outboundPolicySchema = z
  .strictObject({
    enabled: z.boolean(),
    sourceKinds: z
      .array(z.enum(['console', 'service']))
      .min(1)
      .max(2),
    mode: z.enum(['all_finished', 'exceptions']),
    includeCancelled: z.boolean(),
    channelIds: uniqueIds.max(8),
  })
  .superRefine((v, ctx) => {
    if (v.enabled && !v.channelIds.length)
      ctx.addIssue({ code: 'custom', path: ['channelIds'], message: '请选择推送渠道' })
  })
export type OutboundPolicy = z.infer<typeof outboundPolicySchema>
export const DEFAULT_OUTBOUND_POLICY: OutboundPolicy = {
  enabled: false,
  sourceKinds: ['console'],
  mode: 'exceptions',
  includeCancelled: false,
  channelIds: [],
}
export const frozenOutboundBindingSchema = z.strictObject({
  channel: outboundChannelSchema,
  // Keep old captured metadata parseable, but new Run snapshots carry only the immutable reference.
  smtp: outboundSmtpSchema
    .omit({ host: true })
    .extend({ host: z.string().optional() })
    .nullable(),
  controls: z.record(z.string().max(180), z.number().int().nonnegative()),
})
export type FrozenOutboundBinding = z.infer<typeof frozenOutboundBindingSchema>
export const frozenOutboundPolicySchema = z.strictObject({
  protocol: z.literal(RUN_OUTBOUND_PROTOCOL),
  enabled: z.boolean(),
  reason: z.string().max(64),
  policyRevision: z.number().int().nonnegative(),
  policy: outboundPolicySchema,
  configRevision: z.number().int().nonnegative(),
  source: z.enum(['console', 'service']),
  scenarioName: z.string().max(128),
  targetName: z.string().max(128),
  consoleBaseUrl: z.string().max(2048),
  bindings: z.array(frozenOutboundBindingSchema).max(8),
  templateVersion: z.literal(1),
})
export type FrozenOutboundPolicy = z.infer<typeof frozenOutboundPolicySchema>

export const outboundPayloadSchema = z.strictObject({
  title: z.string().max(256),
  summaryStage: z.enum(['settled', 'evidence_pending']).optional(),
  scenarioName: z.string().max(128).optional(),
  targetName: z.string().max(128).optional(),
  scenarioVersionId: entityIdSchema.optional(),
  source: z.enum(['console', 'service']).optional(),
  status: z.enum(['SUCCEEDED', 'FAILED', 'CANCELLED']).optional(),
  outcomeStatus: z.enum(['PASS', 'WARN', 'FAIL', 'UNKNOWN', 'NOT_EVALUATED']).optional(),
  evidenceStatus: z.enum(['PENDING', 'COMPLETE', 'INCOMPLETE']).optional(),
  startedAt: utcInstantSchema.nullable().optional(),
  finishedAt: utcInstantSchema.optional(),
  durationMs: z.number().nonnegative().nullable().optional(),
  reasons: z.array(z.string().max(64)).max(8).optional(),
  // Exact whitelist of the previous alert webhook payload, never raw exceptions.
  alert: z
    .strictObject({
      kind: z.enum(['firing', 'resolved', 'interrupted']),
      alertId: entityIdSchema,
      ruleId: z.string().max(64),
      ruleName: z.string().max(128),
      scope: z.enum(['platform', 'worker', 'api', 'target']),
      scopeId: z.string().max(256),
      /** 作用对象的名称（目前只有目标系统），写事件时冻结；旧事件没有。 */
      scopeName: z.string().max(128).nullable().optional(),
      severity: z.enum(['warning', 'critical']),
      metricKey: z.string().max(128).nullable(),
      source: z.string().max(64).nullable(),
      value: z.number().nullable(),
      threshold: z.number().nullable(),
      comparator: z.string().max(16).nullable(),
      occurredAt: utcInstantSchema,
      consolePath: z.literal('/monitoring'),
    })
    .optional(),
  // 周期耗时报告：只放标题、周期、要点与控制台路径，不含报告原始数据
  report: z
    .strictObject({
      reportId: entityIdSchema,
      title: z.string().max(256),
      periodLabel: z.string().max(64),
      targetName: z.string().max(128),
      highlights: z.array(z.string().max(256)).max(5),
      consolePath: z.string().max(512),
    })
    .optional(),
  takeover: z
    .strictObject({
      targetId: entityIdSchema,
      targetAccountId: entityIdSchema,
      targetName: z.string().max(128),
      accountDisplayName: z.string().max(128),
      takeoverUrl: z.string().max(2048),
      expiresAt: utcInstantSchema,
      reason: z.string().max(256),
    })
    .optional(),
})
export type OutboundPayload = z.infer<typeof outboundPayloadSchema>
export function outboundReasons(
  policy: OutboundPolicy,
  value: {
    status: string
    outcomeStatus: string
    evidenceStatus: string
  },
): string[] {
  if (policy.mode === 'all_finished') return ['all_finished']
  if (value.status === 'CANCELLED') return policy.includeCancelled ? ['cancelled'] : []
  return [
    ...(value.status === 'FAILED' ? ['execution_failed'] : []),
    ...(['WARN', 'FAIL', 'UNKNOWN'].includes(value.outcomeStatus)
      ? [`outcome_${value.outcomeStatus.toLowerCase()}`]
      : []),
    ...(value.evidenceStatus !== 'COMPLETE'
      ? [`evidence_${value.evidenceStatus.toLowerCase()}`]
      : []),
  ]
}

const writeBase = { expectedRevision: z.number().int().positive(), reason }
export const outboundChannelWriteSchema = z.strictObject({
  ...writeBase,
  id: entityIdSchema.optional(),
  name: label,
  kind: z.enum(['webhook', 'email']),
  enabled: z.boolean(),
  allowAlerts: z.boolean(),
  targetIds: uniqueIds.max(100),
  format: z.enum(['legacy_alert@1', OUTBOUND_PROTOCOL]),
  replay: z.enum(['manual_on_unknown', 'receiver_deduplicates']),
  url: z.url().max(2048).optional(),
  token: z
    .string()
    .max(4096)
    .regex(/^[^\r\n]*$/)
    .optional(),
  signingKey: z.string().max(4096).optional(),
  emails: z.array(z.email().max(320)).min(1).max(20).optional(),
})
export type OutboundChannelWrite = z.infer<typeof outboundChannelWriteSchema>
export const outboundSmtpWriteSchema = z.strictObject({
  ...writeBase,
  enabled: z.boolean(),
  host: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^[a-zA-Z0-9.-]+$/),
  port: z.number().int().min(1).max(65535),
  tls: z.enum(['tls', 'starttls']),
  username: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(4096).optional(),
  from: z.email().max(320),
})
export type OutboundSmtpWrite = z.infer<typeof outboundSmtpWriteSchema>
export const outboundSmtpSecretSchema = outboundSmtpWriteSchema
  .omit({ expectedRevision: true, reason: true, enabled: true })
  .extend({ password: z.string().min(1).max(4096) })
export const outboundChannelSecretSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('webhook'),
    url: z.url(),
    token: z.string().optional(),
    signingKey: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal('email'),
    recipients: z
      .array(z.strictObject({ id: entityIdSchema, email: z.email() }))
      .min(1)
      .max(20),
  }),
])
export const outboundSettingsWriteSchema = z.strictObject({
  ...writeBase,
  enabled: z.boolean(),
  consoleBaseUrl: platformOutboundSchema.shape.consoleBaseUrl,
})
export const outboundPolicyWriteSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  policy: outboundPolicySchema,
  cancelPrevious: z.boolean().default(false),
  reason,
})
export const outboundActionSchema = z.strictObject({
  idempotencyKey: z.string().regex(/^[a-zA-Z0-9._:-]{8,128}$/),
  reason,
  confirmUnknown: z.boolean().default(false),
})
export const outboundChannelStateSchema = z
  .strictObject({
    ...writeBase,
    enabled: z.boolean().optional(),
    revokeVersion: z.number().int().positive().optional(),
  })
  .refine((v) => v.enabled !== undefined || v.revokeVersion !== undefined, '请选择操作')
export const outboundListQuerySchema = z.object({
  search: z.string().trim().max(128).optional(),
  type: z.enum(['run', 'alert', 'test', 'report']).optional(),
  status: outboundStatusSchema.optional(),
  targetId: entityIdSchema.optional(),
  scenarioId: entityIdSchema.optional(),
  runId: entityIdSchema.optional(),
  alertId: entityIdSchema.optional(),
  from: utcInstantSchema.optional(),
  to: utcInstantSchema.optional(),
  cursor: z.string().max(4096).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})
export const outboundAttemptSchema = z.object({
  id: entityIdSchema,
  attemptNo: z.number(),
  origin: z.enum(['auto', 'manual']),
  startedAt: utcInstantSchema,
  submittedAt: utcInstantSchema.nullable(),
  finishedAt: utcInstantSchema.nullable(),
  result: outboundStatusSchema.nullable(),
  errorCode: z.string().nullable(),
  responseCode: z.number().nullable(),
})
export const outboundDeliverySchema = z.object({
  id: entityIdSchema,
  channelId: entityIdSchema,
  channelName: z.string(),
  kind: z.enum(['email', 'webhook']),
  recipientLabel: z.string(),
  status: outboundStatusSchema,
  reason: z.string().nullable(),
  automaticAttemptCount: z.number(),
  nextAttemptAt: utcInstantSchema.nullable(),
  closedAt: utcInstantSchema.nullable(),
  attempts: z.array(outboundAttemptSchema).optional(),
})
export const outboundEventSchema = z.object({
  id: entityIdSchema,
  type: z.string(),
  runId: entityIdSchema.nullable(),
  targetId: entityIdSchema.nullable(),
  scenarioId: entityIdSchema.nullable(),
  alertId: entityIdSchema.nullable(),
  state: z.enum(['waiting_result', 'ready', 'filtered', 'suppressed']),
  reason: z.string().nullable(),
  occurredAt: utcInstantSchema,
  observedAt: utcInstantSchema.nullable(),
  payload: outboundPayloadSchema.nullable(),
  consoleUrl: z.string().nullable(),
  deliveries: z.array(outboundDeliverySchema),
})
export const outboundEventListSchema = z.object({
  items: z.array(outboundEventSchema),
  nextCursor: z.string().nullable(),
})
export type OutboundEventDto = z.infer<typeof outboundEventSchema>
export const outboundPolicyResponseSchema = z.object({
  revision: z.number(),
  policy: outboundPolicySchema,
})
export const outboundChannelSummarySchema = outboundChannelSchema
  .omit({ secretRef: true, recipients: true })
  .extend({ recipientCount: z.number(), revoked: z.boolean() })
export const outboundChannelsResponseSchema = z.object({
  revision: z.number(),
  enabled: z.boolean(),
  consoleBaseUrl: z.string(),
  smtp: outboundSmtpSchema
    .omit({ secretRef: true })
    .extend({ revoked: z.boolean() })
    .nullable(),
  channels: z.array(outboundChannelSummarySchema),
})

import { computeSuiteHealthScore, HEALTH_GRADE_LABELS, type SuiteSummaryBlock } from './reports.js'

function hasCurrentSuiteClassification(summary: SuiteSummaryBlock): boolean {
  // 已排队的旧消息卡直接带历史 summary，可能没有新字段；不能将旧 NORMAL 重播为健康。
  return Number.isInteger(summary.undeterminedCount) && summary.undeterminedCount >= 0
}

function suiteBusinessScoreText(summary: SuiteSummaryBlock): string {
  if (!hasCurrentSuiteClassification(summary)) return '未评分（历史分类未核验）'
  const score = computeSuiteHealthScore({
    totalCount: summary.totalCount,
    normalCount: summary.normalCount,
    warningCount: summary.warningCount,
    anomalousCount: summary.anomalousCount,
    undeterminedCount: summary.undeterminedCount ?? 0,
    skippedCount: summary.skippedCount,
  })
  if (summary.healthScore == null || summary.healthGrade == null || score.healthScore == null || score.healthGrade == null) {
    return '未评分（业务结果未完整判定）'
  }
  return `${score.healthScore}分（${HEALTH_GRADE_LABELS[score.healthGrade]}）`
}

function suiteInspectionStatusText(summary: SuiteSummaryBlock): string {
  if (!hasCurrentSuiteClassification(summary)) {
    return summary.anomalousCount > 0
      ? `⚠️ 历史分类未核验；旧摘要记录 ${summary.anomalousCount} 项异常，请核对成员业务结果`
      : '⚪ 历史分类未核验；请核对成员业务结果'
  }
  const undeterminedCount = summary.undeterminedCount ?? 0
  const signal = summary.totalCount <= 0 ? '⚪ 无可判定项目' :
    summary.anomalousCount > 0 ? '⚠️ 发现异常' :
    undeterminedCount > 0 || summary.skippedCount > 0 ? '⚪ 无法完整判断' :
      summary.warningCount > 0 ? '⚠️ 有警告' : '✅ 全部通过'
  return `${signal}；正常 ${summary.normalCount}、警告 ${summary.warningCount}、异常 ${summary.anomalousCount}、未判定 ${undeterminedCount}、跳过 ${summary.skippedCount}`
}

export function buildWechatWorkCard(options: {
  summary: SuiteSummaryBlock
  suiteName: string
  viewUrl?: string
}): { msgtype: 'markdown'; markdown: { content: string } } {
  const { summary, suiteName, viewUrl } = options
  const lines: string[] = [
    `### 🔔 [识途巡检推送] ${suiteName}`,
    `> **巡检状态**：${suiteInspectionStatusText(summary)}`,
    `> **业务检查得分**：${suiteBusinessScoreText(summary)}`,
    `> **巡检耗时**：${(summary.wallClockMs / 1000).toFixed(1)} 秒`,
  ]

  if (summary.aggregatedFindings.length > 0) {
    lines.push('', '【核心异常概览】')
    for (const f of summary.aggregatedFindings.slice(0, 5)) {
      lines.push(`❌ **${f.displayName}**：${f.title}${f.detail ? ` (${f.detail})` : ''}`)
    }
  }

  if (viewUrl) {
    lines.push('', `[👉 点击在手机上查阅完整巡检总报告](${viewUrl})`)
  }

  return {
    msgtype: 'markdown',
    markdown: {
      content: lines.join('\n'),
    },
  }
}

export function buildFeishuCard(options: {
  summary: SuiteSummaryBlock
  suiteName: string
  viewUrl?: string
}): { msg_type: 'interactive'; card: Record<string, any> } {
  const { summary, suiteName, viewUrl } = options
  const template = summary.anomalousCount > 0 ? 'red' : !hasCurrentSuiteClassification(summary) ? 'blue' : summary.warningCount > 0 ? 'orange' :
    summary.totalCount <= 0 || (summary.undeterminedCount ?? 0) > 0 || summary.skippedCount > 0 ? 'blue' : 'green'
  const elements: any[] = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**巡检状态**：${suiteInspectionStatusText(summary)}\n**业务检查得分**：${suiteBusinessScoreText(summary)}\n**巡检耗时**：${(summary.wallClockMs / 1000).toFixed(1)} 秒`,
      },
    },
  ]

  if (summary.aggregatedFindings.length > 0) {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**【核心异常概览】**\n` + summary.aggregatedFindings.slice(0, 5).map((f) => `❌ **${f.displayName}**：${f.title}${f.detail ? ` (${f.detail})` : ''}`).join('\n'),
      },
    })
  }

  if (viewUrl) {
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '👉 查阅完整巡检总报告' },
          type: 'primary',
          url: viewUrl,
        },
      ],
    })
  }

  return {
    msg_type: 'interactive',
    card: {
      header: {
        title: { tag: 'plain_text', content: `🔔 [识途巡检] ${suiteName}` },
        template,
      },
      elements,
    },
  }
}

export function buildDingTalkCard(options: {
  summary: SuiteSummaryBlock
  suiteName: string
  viewUrl?: string
}): { msgtype: 'actionCard'; actionCard: Record<string, any> } {
  const { summary, suiteName, viewUrl } = options
  const lines: string[] = [
    `### 🔔 [识途巡检推送] ${suiteName}`,
    `- **巡检状态**：${suiteInspectionStatusText(summary)}`,
    `- **业务检查得分**：${suiteBusinessScoreText(summary)}`,
    `- **巡检耗时**：${(summary.wallClockMs / 1000).toFixed(1)} 秒`,
  ]

  if (summary.aggregatedFindings.length > 0) {
    lines.push('', '#### 【核心异常概览】')
    for (const f of summary.aggregatedFindings.slice(0, 5)) {
      lines.push(`- ❌ **${f.displayName}**：${f.title}${f.detail ? ` (${f.detail})` : ''}`)
    }
  }

  return {
    msgtype: 'actionCard',
    actionCard: {
      title: `[识途巡检] ${suiteName}`,
      text: lines.join('\n\n'),
      singleTitle: '👉 查阅完整巡检总报告',
      singleURL: viewUrl ?? '',
    },
  }
}

/** 周期耗时报告的推送事件类型。 */
export const DURATION_REPORT_OUTBOUND_TYPE = 'report.duration_period' as const

export type ImCardProvider = 'wechat_work' | 'feishu' | 'dingtalk'

/** 按 webhook 主机识别常见 IM 机器人；其它地址走通用 cairn.outbound@1 JSON。 */
export function imCardProviderOfHost(host: string): ImCardProvider | null {
  const h = host.toLowerCase()
  if (h === 'qyapi.weixin.qq.com') return 'wechat_work'
  if (h === 'open.feishu.cn' || h.endsWith('.feishu.cn') || h === 'open.larksuite.com' || h.endsWith('.larksuite.com')) return 'feishu'
  if (h === 'oapi.dingtalk.com') return 'dingtalk'
  return null
}

/** 告警的 IM 卡片：标题 + 读数要点 + 去监控页链接；严重告警用红色。 */
export function buildAlertImCard(
  provider: ImCardProvider,
  alert: { title: string; severity: 'warning' | 'critical'; lines: readonly string[]; viewUrl?: string | null },
): Record<string, unknown> {
  const icon = alert.severity === 'critical' ? '🔴' : '🟠'
  const lines = alert.lines.slice(0, 6)
  if (provider === 'wechat_work') {
    const content = [`### ${icon} ${alert.title}`, ...lines.map((line) => `> ${line}`)]
    if (alert.viewUrl) content.push('', `[去监控页查看](${alert.viewUrl})`)
    return { msgtype: 'markdown', markdown: { content: content.join('\n') } }
  }
  if (provider === 'feishu') {
    const elements: unknown[] = [{ tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } }]
    if (alert.viewUrl) {
      elements.push({ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '去监控页查看' }, type: 'primary', url: alert.viewUrl }] })
    }
    return {
      msg_type: 'interactive',
      card: { header: { title: { tag: 'plain_text', content: `${icon} ${alert.title}` }, template: alert.severity === 'critical' ? 'red' : 'orange' }, elements },
    }
  }
  return {
    msgtype: 'actionCard',
    actionCard: {
      title: alert.title,
      text: [`### ${icon} ${alert.title}`, ...lines.map((line) => `- ${line}`)].join('\n\n'),
      singleTitle: '去监控页查看',
      singleURL: alert.viewUrl ?? '',
    },
  }
}

/** 周期耗时报告的 IM 卡片：标题 + 周期 + 要点 + 查看报告链接。 */
export function buildDurationReportImCard(
  provider: ImCardProvider,
  report: { title: string; periodLabel: string; highlights: readonly string[]; viewUrl?: string | null },
): Record<string, unknown> {
  const highlights = report.highlights.slice(0, 5)
  if (provider === 'wechat_work') {
    const lines = [`### 📊 ${report.title}`, `> 周期：${report.periodLabel}`, '', ...highlights.map((line) => `- ${line}`)]
    if (report.viewUrl) lines.push('', `[查看完整报告](${report.viewUrl})`)
    return { msgtype: 'markdown', markdown: { content: lines.join('\n') } }
  }
  if (provider === 'feishu') {
    const elements: unknown[] = [
      { tag: 'div', text: { tag: 'lark_md', content: [`**周期**：${report.periodLabel}`, ...highlights.map((line) => `• ${line}`)].join('\n') } },
    ]
    if (report.viewUrl) {
      elements.push({ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '查看完整报告' }, type: 'primary', url: report.viewUrl }] })
    }
    return { msg_type: 'interactive', card: { header: { title: { tag: 'plain_text', content: `📊 ${report.title}` }, template: 'blue' }, elements } }
  }
  return {
    msgtype: 'actionCard',
    actionCard: {
      title: report.title,
      text: [`### 📊 ${report.title}`, `- 周期：${report.periodLabel}`, ...highlights.map((line) => `- ${line}`)].join('\n\n'),
      singleTitle: '查看完整报告',
      singleURL: report.viewUrl ?? '',
    },
  }
}
