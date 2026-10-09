import { and, asc, desc, eq, inArray, lte } from 'drizzle-orm'
import {
  DURATION_REPORT_OUTBOUND_TYPE,
  createDurationReportSubscriptionBodySchema,
  durationPeriodLabel,
  durationPeriodReportOf,
  durationReportSendAt,
  durationReportSubscriptionDtoSchema,
  durationReportSubscriptionListSchema,
  latestDueDurationReportPeriod,
  lastCompleteDurationPeriodStart,
  nextDurationReportSendAt,
  outboundPayloadSchema,
  shiftDurationPeriod,
  updateDurationReportSubscriptionBodySchema,
  type CreateDurationReportSubscriptionBody,
  type DurationPeriodReportSubject,
  type DurationReportSchedule,
  type DurationReportSubscriptionDto,
  type DurationReportSubscriptionList,
  type PlatformConfigDocument,
  type ReportDto,
  type UpdateDurationReportSubscriptionBody,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { recordAudit } from '../audit/record.js'
import { assertTargetPermission, lockConsoleAuthorization } from '../console/target-authorization.js'
import { newId } from '../id.js'
import { atomic, clockNow, insertIgnoreRows, locked, schemaFor } from '../native.js'
import { freezeOutboundBindings, lockOutboundDispatch, materializeOutboundDeliveries } from '../outbound/core.js'
import { getOrCreatePlatformConfig } from '../platform-config/store.js'
import { DomainError, badRequest, conflict, notFound } from '../runs/errors.js'
import { pendingFactRunsInPeriod } from '../runs/duration-report.js'
import { statisticsTimeZone } from '../runs/duration-rollup.js'
import { createReport, enqueueReportExport, loadReportRevisionDocument } from './reports.js'

/**
 * 周期耗时报告订阅：到点为最近一期生成报告并推送。
 * 每期一行 duration_report_issues（订阅 + 周期唯一），状态 pending → generated → delivered，或 skipped / failed，
 * 保证多实例、重启、重复扫描下每期只生成、只推送一次。报告以订阅创建人的身份生成，权限被收回时该期失败并写明原因。
 */

const FACTS_WAIT_MS = 30 * 60_000
const RENDER_WAIT_MS = 10 * 60_000
const RETRY_MS = 5 * 60_000
const MAX_ATTEMPTS = 3
const MAX_MISSED_RECORDS = 24

type SubscriptionRow = typeof import('../schema/duration-reports.js').durationReportSubscriptions.$inferSelect
type IssueRow = typeof import('../schema/duration-reports.js').durationReportIssues.$inferSelect

function scheduleOf(row: SubscriptionRow): DurationReportSchedule {
  return { period: row.periodKind, sendWeekday: row.sendWeekday, sendDay: row.sendDay, sendTime: row.sendTime, timeZone: row.timeZone }
}

function subjectOf(row: SubscriptionRow, periodStart: string): DurationPeriodReportSubject {
  return {
    kind: 'DURATION_PERIOD',
    targetId: row.targetId,
    ...(row.suiteId ? { suiteId: row.suiteId } : {}),
    period: row.periodKind,
    periodStart,
    timeZone: row.timeZone,
    trigger: row.triggerFilter,
  }
}

async function toDtos(db: Db, rows: SubscriptionRow[], now: Date): Promise<DurationReportSubscriptionDto[]> {
  if (rows.length === 0) return []
  const { scenarioSuites, consoleAccounts, durationReportIssues: i } = schemaFor(db)
  const suiteIds = [...new Set(rows.map((r) => r.suiteId).filter((id): id is string => id !== null))]
  const suites = suiteIds.length ? await db.select({ id: scenarioSuites.id, name: scenarioSuites.name }).from(scenarioSuites).where(inArray(scenarioSuites.id, suiteIds)) : []
  const accounts = await db
    .select({ id: consoleAccounts.id, name: consoleAccounts.displayName })
    .from(consoleAccounts)
    .where(inArray(consoleAccounts.id, [...new Set(rows.map((r) => r.createdByConsoleAccountId))]))
  const issues = await db
    .select()
    .from(i)
    .where(inArray(i.subscriptionId, rows.map((r) => r.id)))
    .orderBy(desc(i.periodStart))
  const latest = new Map<string, IssueRow>()
  for (const issue of issues) if (!latest.has(issue.subscriptionId)) latest.set(issue.subscriptionId, issue)
  return rows.map((row) => {
    const issue = latest.get(row.id)
    return durationReportSubscriptionDtoSchema.parse({
      id: row.id,
      targetId: row.targetId,
      suiteId: row.suiteId,
      suiteName: suites.find((s) => s.id === row.suiteId)?.name ?? null,
      period: row.periodKind,
      sendWeekday: row.sendWeekday,
      sendDay: row.sendDay,
      sendTime: row.sendTime,
      timeZone: row.timeZone,
      trigger: row.triggerFilter,
      channelIds: row.channelIds,
      enabled: row.enabled,
      revision: row.revision,
      nextSendAt: row.enabled ? nextDurationReportSendAt(scheduleOf(row), now).toISOString() : null,
      lastIssue: issue
        ? {
            periodStart: issue.periodStart,
            periodLabel: durationPeriodLabel(row.periodKind, issue.periodStart),
            status: issue.status,
            reason: issue.reason,
            reportId: issue.reportId,
            outboundEventId: issue.outboundEventId,
            updatedAt: issue.updatedAt.toISOString(),
          }
        : null,
      createdByName: accounts.find((a) => a.id === row.createdByConsoleAccountId)?.name ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })
  })
}

export async function listDurationReportSubscriptions(db: Db, targetId: string, actorId: string): Promise<DurationReportSubscriptionList> {
  await assertTargetPermission(db, actorId, targetId, 'report:read')
  const { durationReportSubscriptions: s } = schemaFor(db)
  const rows = await db.select().from(s).where(eq(s.targetId, targetId)).orderBy(asc(s.createdAt), asc(s.id))
  return durationReportSubscriptionListSchema.parse({ items: await toDtos(db, rows, await clockNow(db)) })
}

async function getSubscriptionDto(db: Db, id: string): Promise<DurationReportSubscriptionDto> {
  const { durationReportSubscriptions: s } = schemaFor(db)
  const [row] = await db.select().from(s).where(eq(s.id, id)).limit(1)
  if (!row) throw notFound('DURATION_SUBSCRIPTION_NOT_FOUND', '订阅不存在')
  return (await toDtos(db, [row], await clockNow(db)))[0]!
}

/** 写入前的校验：目标系统与场景集可用且可读、渠道授权给该目标系统、启用时须有渠道、同组合至多一条启用订阅。 */
async function validate(
  tx: Db,
  actorId: string,
  value: { targetId: string; suiteId: string | null; periodKind: 'week' | 'month'; triggerFilter: string; channelIds: string[]; enabled: boolean },
  selfId: string | null,
) {
  const { targets, scenarioSuites, durationReportSubscriptions: s } = schemaFor(tx)
  await assertTargetPermission(tx, actorId, value.targetId, 'report:export')
  await assertTargetPermission(tx, actorId, value.targetId, 'run:read')
  // 锁目标系统行：并发创建 / 启用同一组合时串行化，保证「至多一条启用订阅」
  const [target] = await locked(tx, tx.select().from(targets).where(eq(targets.id, value.targetId)))
  if (!target || target.deletedAt) throw notFound('TARGET_NOT_FOUND', '目标系统不存在')
  if (value.suiteId) {
    const [suite] = await tx.select().from(scenarioSuites).where(eq(scenarioSuites.id, value.suiteId)).limit(1)
    if (!suite || suite.deletedAt || suite.targetId !== value.targetId) throw notFound('SUITE_NOT_FOUND', '场景集不存在或不属于该目标系统')
    await assertTargetPermission(tx, actorId, value.targetId, 'suite:read')
  }
  const document = (await getOrCreatePlatformConfig(tx)).document
  for (const id of value.channelIds) {
    const channel = document.outbound.channels.find((c) => c.id === id)
    if (!channel || !channel.targetIds.includes(value.targetId)) throw badRequest('DURATION_SUBSCRIPTION_CHANNEL_INVALID', '所选渠道不存在或未授权给该目标系统')
  }
  if (value.enabled && value.channelIds.length === 0) throw badRequest('DURATION_SUBSCRIPTION_CHANNEL_REQUIRED', '启用前请选择推送渠道')
  if (value.enabled) {
    const peers = await tx
      .select({ id: s.id, suiteId: s.suiteId })
      .from(s)
      .where(and(eq(s.targetId, value.targetId), eq(s.periodKind, value.periodKind), eq(s.triggerFilter, value.triggerFilter as SubscriptionRow['triggerFilter']), eq(s.enabled, true)))
    if (peers.some((peer) => peer.id !== selfId && peer.suiteId === value.suiteId)) {
      throw conflict('DURATION_SUBSCRIPTION_DUPLICATE', '同一目标系统、场景集、周期与发起方已有启用中的订阅')
    }
  }
}

export async function createDurationReportSubscription(db: Db, body: CreateDurationReportSubscriptionBody, actorId: string): Promise<DurationReportSubscriptionDto> {
  const input = createDurationReportSubscriptionBodySchema.parse(body)
  const id = await atomic(db, async (tx) => {
    await lockConsoleAuthorization(tx, actorId)
    await validate(tx, actorId, { targetId: input.targetId, suiteId: input.suiteId ?? null, periodKind: input.period, triggerFilter: input.trigger, channelIds: input.channelIds, enabled: input.enabled }, null)
    const { durationReportSubscriptions: s } = schemaFor(tx)
    const now = await clockNow(tx)
    const id = newId()
    await tx.insert(s).values({
      id,
      targetId: input.targetId,
      suiteId: input.suiteId ?? null,
      periodKind: input.period,
      sendWeekday: input.sendWeekday,
      sendDay: input.sendDay,
      sendTime: input.sendTime,
      // 没指定时按平台统计时区：与耗时分析的按天汇总同一切法
      timeZone: input.timeZone ?? (await statisticsTimeZone(tx)),
      triggerFilter: input.trigger,
      channelIds: input.channelIds,
      enabled: input.enabled,
      enabledAt: input.enabled ? now : null,
      createdByConsoleAccountId: actorId,
      updatedByConsoleAccountId: actorId,
      createdAt: now,
      updatedAt: now,
    })
    await recordAudit(tx, { id: actorId }, 'report.subscription.save', 'duration_report_subscription', id, `新建${input.period === 'week' ? '周报' : '月报'}订阅${input.enabled ? '（已启用）' : '（未启用）'}`)
    return id
  })
  return getSubscriptionDto(db, id)
}

export async function updateDurationReportSubscription(db: Db, id: string, body: UpdateDurationReportSubscriptionBody, actorId: string): Promise<DurationReportSubscriptionDto> {
  const input = updateDurationReportSubscriptionBodySchema.parse(body)
  await atomic(db, async (tx) => {
    await lockConsoleAuthorization(tx, actorId)
    const { durationReportSubscriptions: s } = schemaFor(tx)
    const [row] = await locked(tx, tx.select().from(s).where(eq(s.id, id)))
    if (!row) throw notFound('DURATION_SUBSCRIPTION_NOT_FOUND', '订阅不存在')
    await assertTargetPermission(tx, actorId, row.targetId, 'report:export')
    if (row.revision !== input.expectedRevision) throw conflict('DURATION_SUBSCRIPTION_REVISION_CONFLICT', '订阅已被修改，请刷新后再试')
    const next = {
      suiteId: input.suiteId !== undefined ? input.suiteId : row.suiteId,
      periodKind: input.period ?? row.periodKind,
      sendWeekday: input.sendWeekday ?? row.sendWeekday,
      sendDay: input.sendDay ?? row.sendDay,
      sendTime: input.sendTime ?? row.sendTime,
      timeZone: input.timeZone ?? row.timeZone,
      triggerFilter: input.trigger ?? row.triggerFilter,
      channelIds: input.channelIds ?? row.channelIds,
      enabled: input.enabled ?? row.enabled,
    }
    await validate(tx, actorId, { targetId: row.targetId, ...next }, row.id)
    const now = await clockNow(tx)
    await tx
      .update(s)
      .set({
        ...next,
        // 重新打开时从现在起算：停用期间的周期不补发
        enabledAt: next.enabled ? (row.enabled ? row.enabledAt : now) : row.enabledAt,
        revision: row.revision + 1,
        updatedByConsoleAccountId: actorId,
        updatedAt: now,
      })
      .where(eq(s.id, id))
    const change = input.enabled === undefined || input.enabled === row.enabled ? '修改' : input.enabled ? '启用' : '停用'
    await recordAudit(tx, { id: actorId }, 'report.subscription.save', 'duration_report_subscription', id, `${change}周期报告订阅`)
  })
  return getSubscriptionDto(db, id)
}

export async function deleteDurationReportSubscription(db: Db, id: string, actorId: string): Promise<{ id: string; deleted: true }> {
  return atomic(db, async (tx) => {
    await lockConsoleAuthorization(tx, actorId)
    const { durationReportSubscriptions: s } = schemaFor(tx)
    const [row] = await locked(tx, tx.select().from(s).where(eq(s.id, id)))
    if (!row) throw notFound('DURATION_SUBSCRIPTION_NOT_FOUND', '订阅不存在')
    await assertTargetPermission(tx, actorId, row.targetId, 'report:export')
    // 每期记录随订阅级联删除；已生成的报告保留在报告列表
    await tx.delete(s).where(eq(s.id, id))
    await recordAudit(tx, { id: actorId }, 'report.subscription.delete', 'duration_report_subscription', id, '删除周期报告订阅')
    return { id, deleted: true as const }
  })
}

/** 立即为最近一个已结束的周期生成报告（以当前账号身份，不推送）：用来在启用前确认内容。 */
export async function previewDurationReportSubscription(db: Db, id: string, actorId: string): Promise<ReportDto> {
  const { durationReportSubscriptions: s } = schemaFor(db)
  const [row] = await db.select().from(s).where(eq(s.id, id)).limit(1)
  if (!row) throw notFound('DURATION_SUBSCRIPTION_NOT_FOUND', '订阅不存在')
  const periodStart = lastCompleteDurationPeriodStart(row.periodKind, await clockNow(db), row.timeZone)
  return createReport(db, { subject: subjectOf(row, periodStart), scope: 'duration_period', stage: 'final', idempotencyKey: `duration-preview-${newId()}` }, { kind: 'console', id: actorId })
}

// ---------------------------------------------------------------------------
// 到点处理（Worker analyst 每分钟一轮）
// ---------------------------------------------------------------------------

export interface DurationReportTickResult {
  planned: number
  generated: number
  delivered: number
  skipped: number
  failed: number
  lastError?: string
}

/** 为每个启用的订阅登记「最近一期」；停机期间错过的更早周期记为 skipped，不连发旧报告。 */
async function planIssues(db: Db, now: Date, result: DurationReportTickResult) {
  const { durationReportSubscriptions: s, durationReportIssues: i } = schemaFor(db)
  const subscriptions = await db.select().from(s).where(eq(s.enabled, true))
  for (const sub of subscriptions) {
    const schedule = scheduleOf(sub)
    const due = latestDueDurationReportPeriod(schedule, now)
    const dueSendAt = durationReportSendAt(schedule, due)
    // 启用之前就已过发送时刻的周期不补
    if (!sub.enabledAt || dueSendAt.getTime() < sub.enabledAt.getTime()) continue
    const [existing] = await db.select({ id: i.id }).from(i).where(and(eq(i.subscriptionId, sub.id), eq(i.periodStart, due))).limit(1)
    if (existing) continue
    const [last] = await db.select({ periodStart: i.periodStart }).from(i).where(eq(i.subscriptionId, sub.id)).orderBy(desc(i.periodStart)).limit(1)
    const rows: Array<typeof i.$inferInsert> = []
    let missed = shiftDurationPeriod(sub.periodKind, due, -1)
    for (let n = 0; n < MAX_MISSED_RECORDS && (!last || missed > last.periodStart); n += 1) {
      const sendAt = durationReportSendAt(schedule, missed)
      if (sendAt.getTime() < sub.enabledAt.getTime()) break
      rows.push({ id: newId(), subscriptionId: sub.id, periodStart: missed, status: 'skipped', reason: 'missed_send_window', sendAt, nextAttemptAt: sendAt, createdAt: now, updatedAt: now })
      result.skipped += 1
      missed = shiftDurationPeriod(sub.periodKind, missed, -1)
    }
    rows.push({ id: newId(), subscriptionId: sub.id, periodStart: due, status: 'pending', sendAt: dueSendAt, nextAttemptAt: now, createdAt: now, updatedAt: now })
    result.planned += await insertIgnoreRows(db, i, rows.at(-1)!)
    if (rows.length > 1) await insertIgnoreRows(db, i, rows.slice(0, -1))
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof DomainError) return error.message
  return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)
}

/**
 * 生成：等本期耗时事实追平（最多 30 分钟），以订阅创建人的身份生成报告并排队渲染 HTML。
 * 先在短事务里占住这一期（把下次可处理时刻推后，作为租约），在事务外生成——报告创建与导出都按每期固定的幂等键，
 * 重试或多实例重复执行只会拿到同一份报告——最后再回写状态。不在持锁事务里生成：嵌套事务没有保存点，生成失败会废掉外层事务。
 */
async function generateIssue(db: Db, issueId: string, now: Date, result: DurationReportTickResult) {
  const claimed = await atomic(db, async (tx) => {
    const { durationReportIssues: i, durationReportSubscriptions: s } = schemaFor(tx)
    const [issue] = await locked(tx, tx.select().from(i).where(eq(i.id, issueId)))
    if (!issue || issue.status !== 'pending' || issue.nextAttemptAt > now) return null
    const [sub] = await tx.select().from(s).where(eq(s.id, issue.subscriptionId)).limit(1)
    if (!sub || !sub.enabled) {
      await tx.update(i).set({ status: 'skipped', reason: 'subscription_disabled', updatedAt: now }).where(eq(i.id, issueId))
      result.skipped += 1
      return null
    }
    const subject = subjectOf(sub, issue.periodStart)
    if ((await pendingFactRunsInPeriod(tx, subject)) > 0 && now.getTime() < issue.sendAt.getTime() + FACTS_WAIT_MS) {
      await tx.update(i).set({ reason: 'waiting_for_facts', nextAttemptAt: new Date(now.getTime() + 60_000), updatedAt: now }).where(eq(i.id, issueId))
      return null
    }
    await tx.update(i).set({ attempts: issue.attempts + 1, nextAttemptAt: new Date(now.getTime() + RETRY_MS), updatedAt: now }).where(eq(i.id, issueId))
    return { issue: { ...issue, attempts: issue.attempts + 1 }, subject, actor: { kind: 'console' as const, id: sub.createdByConsoleAccountId } }
  })
  if (!claimed) return
  const { issue, subject, actor } = claimed
  let outcome: { reportId: string; exportJobId: string } | { error: unknown }
  try {
    const report = await createReport(db, { subject, scope: 'duration_period', stage: 'final', idempotencyKey: `duration-subscription-${issue.id}` }, actor)
    const job = await enqueueReportExport(db, report.id, report.currentRevision!.id, ['html'], actor, `duration-subscription-export-${issue.id}`)
    outcome = { reportId: report.id, exportJobId: job.id }
  } catch (error) {
    outcome = { error }
  }
  await atomic(db, async (tx) => {
    const { durationReportIssues: i } = schemaFor(tx)
    const [current] = await locked(tx, tx.select().from(i).where(eq(i.id, issueId)))
    if (!current || current.status !== 'pending') return
    if ('reportId' in outcome) {
      await tx.update(i).set({ status: 'generated', reason: null, reportId: outcome.reportId, exportJobId: outcome.exportJobId, nextAttemptAt: now, updatedAt: now }).where(eq(i.id, issueId))
      result.generated += 1
      return
    }
    const message = errorMessage(outcome.error)
    result.lastError = message
    // 权限、来源不存在等确定性错误不再重试；其它错误最多试三次
    const permanent = outcome.error instanceof DomainError && outcome.error.kind !== 'conflict'
    if (permanent || issue.attempts >= MAX_ATTEMPTS) {
      await tx.update(i).set({ status: 'failed', reason: `generate_failed: ${message}`, updatedAt: now }).where(eq(i.id, issueId))
      result.failed += 1
    } else {
      await tx.update(i).set({ reason: `generate_failed: ${message}`, updatedAt: now }).where(eq(i.id, issueId))
    }
  })
}

/** 推送：HTML 渲染完成（或等待超时）后冻结渠道绑定并写推送事件；邮件会附上这份 HTML。 */
async function deliverIssue(db: Db, issueId: string, now: Date, result: DurationReportTickResult) {
  const { durationReportIssues: i0, exportJobs } = schemaFor(db)
  const [peek] = await db.select().from(i0).where(eq(i0.id, issueId)).limit(1)
  if (!peek || peek.status !== 'generated') return
  if (peek.exportJobId) {
    const [job] = await db.select({ status: exportJobs.status }).from(exportJobs).where(eq(exportJobs.id, peek.exportJobId)).limit(1)
    const settled = !job || !['queued', 'running'].includes(job.status)
    if (!settled && now.getTime() < peek.updatedAt.getTime() + RENDER_WAIT_MS) return
  }
  await atomic(db, async (tx) => {
    const { durationReportIssues: i, durationReportSubscriptions: s, outboundEvents: e, targets } = schemaFor(tx)
    const [issue] = await locked(tx, tx.select().from(i).where(eq(i.id, issueId)))
    if (!issue || issue.status !== 'generated' || !issue.reportId) return
    const [sub] = await tx.select().from(s).where(eq(s.id, issue.subscriptionId)).limit(1)
    if (!sub || !sub.enabled) {
      await tx.update(i).set({ status: 'skipped', reason: 'subscription_disabled', updatedAt: now }).where(eq(i.id, issueId))
      result.skipped += 1
      return
    }
    await lockOutboundDispatch(tx)
    const document: PlatformConfigDocument = (await getOrCreatePlatformConfig(tx)).document
    if (!document.outbound.enabled) {
      await tx.update(i).set({ status: 'skipped', reason: 'outbound_paused', updatedAt: now }).where(eq(i.id, issueId))
      result.skipped += 1
      return
    }
    const usable = sub.channelIds.filter((id) => {
      const channel = document.outbound.channels.find((c) => c.id === id)
      return channel?.enabled && channel.targetIds.includes(sub.targetId)
    })
    const bindings = await freezeOutboundBindings(tx, document, usable, sub.targetId)
    if (bindings.length === 0) {
      await tx.update(i).set({ status: 'skipped', reason: 'no_destination', updatedAt: now }).where(eq(i.id, issueId))
      result.skipped += 1
      return
    }
    const revisionId = await currentRevisionId(tx, issue.reportId)
    if (!revisionId) {
      await tx.update(i).set({ status: 'failed', reason: 'generate_failed: 报告修订不存在', updatedAt: now }).where(eq(i.id, issueId))
      result.failed += 1
      return
    }
    const { revision } = await loadReportRevisionDocument(tx, revisionId)
    const block = revision.document ? durationPeriodReportOf(revision.document) : null
    const [target] = await tx.select({ name: targets.name }).from(targets).where(eq(targets.id, sub.targetId)).limit(1)
    const baseUrl = document.outbound.consoleBaseUrl.replace(/\/$/, '')
    const payload = outboundPayloadSchema.parse({
      title: revision.title.slice(0, 256),
      report: {
        reportId: issue.reportId,
        title: revision.title.slice(0, 256),
        periodLabel: (block?.period.label ?? durationPeriodLabel(sub.periodKind, issue.periodStart)).slice(0, 64),
        targetName: (target?.name ?? '').slice(0, 128),
        highlights: (block?.conclusion ?? []).slice(0, 5).map((line) => line.slice(0, 256)),
        consolePath: `/reports/${issue.reportId}`,
      },
    })
    const eventId = newId()
    await insertIgnoreRows(tx, e, {
      id: eventId,
      sourceKey: `duration-report:${issue.id}`,
      type: DURATION_REPORT_OUTBOUND_TYPE,
      targetId: sub.targetId,
      sourceSequence: 1,
      state: 'ready',
      payload,
      bindings,
      occurredAt: now,
      observedAt: now,
      nextPrepareAt: now,
      consoleUrl: baseUrl ? `${baseUrl}/reports/${issue.reportId}` : null,
    })
    await materializeOutboundDeliveries(tx, eventId)
    await tx.update(i).set({ status: 'delivered', reason: null, outboundEventId: eventId, updatedAt: now }).where(eq(i.id, issueId))
    result.delivered += 1
  })
}

async function currentRevisionId(db: Db, reportId: string): Promise<string | null> {
  const { reportRevisions } = schemaFor(db)
  const [row] = await db
    .select({ id: reportRevisions.id })
    .from(reportRevisions)
    .where(eq(reportRevisions.reportId, reportId))
    .orderBy(desc(reportRevisions.revisionNo))
    .limit(1)
  return row?.id ?? null
}

export async function processDurationReportSubscriptions(db: Db, options: { now?: Date; limit?: number } = {}): Promise<DurationReportTickResult> {
  const now = options.now ?? (await clockNow(db))
  const limit = options.limit ?? 10
  const result: DurationReportTickResult = { planned: 0, generated: 0, delivered: 0, skipped: 0, failed: 0 }
  const { durationReportIssues: i } = schemaFor(db)
  await planIssues(db, now, result)
  const pending = await db.select({ id: i.id }).from(i).where(and(eq(i.status, 'pending'), lte(i.nextAttemptAt, now))).orderBy(asc(i.nextAttemptAt)).limit(limit)
  for (const row of pending) {
    try {
      await generateIssue(db, row.id, now, result)
    } catch (error) {
      result.lastError = errorMessage(error)
    }
  }
  const generated = await db.select({ id: i.id }).from(i).where(eq(i.status, 'generated')).orderBy(asc(i.updatedAt)).limit(limit)
  for (const row of generated) {
    try {
      await deliverIssue(db, row.id, now, result)
    } catch (error) {
      result.lastError = errorMessage(error)
    }
  }
  return result
}
