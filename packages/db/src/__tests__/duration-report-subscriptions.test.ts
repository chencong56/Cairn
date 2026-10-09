import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  LOCAL_SECRET_PROVIDER,
  OUTBOUND_WORKER_PROTOCOL,
  durationReportSendAt,
  lastCompleteDurationPeriodStart,
  shiftDurationPeriod,
  shiftLocalDate,
  zonedStartOfDay,
  type DurationReportSchedule,
  type OutboundChannel,
} from '@cairn/shared'
import { DRIVERS, grantAdminScope, openContractDb } from './contract-fixture.js'
import { HOUR, durationSeeder, nodesOf } from './duration-fixture.js'
import { writeOutboundConfig } from '../outbound/config.js'
import { listOutboundEvents } from '../outbound/query.js'
import { getOrCreatePlatformConfig } from '../platform-config/store.js'
import {
  and,
  createDurationReportSubscription,
  deleteDurationReportSubscription,
  eq,
  insertIgnoreRows,
  listDurationReportSubscriptions,
  newId,
  processDurationReportSubscriptions,
  registerWorker,
  schemaFor,
  updateDurationReportSubscription,
  writeRunWithSnapshot,
} from '../test-entry.js'

const TZ = 'Asia/Shanghai'
const MINUTE = 60_000
const weekly: DurationReportSchedule = { period: 'week', sendWeekday: 1, sendDay: 1, sendTime: '09:00', timeZone: TZ }

describe.each(DRIVERS)('%s 周期报告订阅', { timeout: 120_000 }, (driver) => {
  let handle: Awaited<ReturnType<typeof openContractDb>>
  let actorId: string
  let seeder: ReturnType<typeof durationSeeder>
  let channel: OutboundChannel
  const lastWeek = lastCompleteDurationPeriodStart('week', new Date(), TZ)
  const sendAt = durationReportSendAt(weekly, lastWeek)

  async function writeConfig(extra: Omit<Parameters<typeof writeOutboundConfig>[1], 'actorId' | 'expectedRevision' | 'reason'>) {
    const current = await getOrCreatePlatformConfig(handle.db)
    return writeOutboundConfig(handle.db, { actorId, expectedRevision: current.revision, reason: '订阅测试', ...extra })
  }

  async function authorize(targetId: string) {
    channel = { ...channel, version: channel.version + 1, targetIds: [...new Set([...channel.targetIds, targetId])] }
    await writeConfig({ channel })
  }

  /** 新建并启用一条订阅，把「启用时刻」挪到 enabledAt（模拟早就开好的订阅）。 */
  async function enabledSubscription(targetId: string, enabledAt: Date, overrides: Record<string, unknown> = {}) {
    await authorize(targetId)
    const created = await createDurationReportSubscription(handle.db, { targetId, period: 'week', timeZone: TZ, channelIds: [channel.id], enabled: true, ...overrides }, actorId)
    const { durationReportSubscriptions } = schemaFor(handle.db)
    await handle.db.update(durationReportSubscriptions).set({ enabledAt }).where(eq(durationReportSubscriptions.id, created.id))
    return created
  }

  async function issuesOf(subscriptionId: string) {
    const { durationReportIssues } = schemaFor(handle.db)
    return handle.db.select().from(durationReportIssues).where(eq(durationReportIssues.subscriptionId, subscriptionId))
  }

  beforeAll(async () => {
    handle = await openContractDb(driver, `duration_report_subscriptions_${driver}`)
    actorId = newId()
    const { consoleAccounts } = schemaFor(handle.db)
    await handle.db.insert(consoleAccounts).values({ id: actorId, displayName: '订阅人', email: `duration-sub-${actorId}@example.com`, status: 'active' })
    await grantAdminScope(handle.db, actorId)
    // 测试库的 admin 角色夹具不含推送权限，与 outbound.test 一样补上
    const { consoleRoles, consoleRolePermissions } = schemaFor(handle.db)
    const [admin] = await handle.db.select().from(consoleRoles).where(eq(consoleRoles.key, 'admin'))
    for (const permission of ['outbound:read', 'report:read', 'report:export']) await insertIgnoreRows(handle.db, consoleRolePermissions, { consoleRoleId: admin!.id, permission })
    seeder = durationSeeder(handle.db, actorId)
    await registerWorker(handle.db, { workerId: `w-${newId().slice(-12)}`, instanceId: newId(), capacity: 1, lostAfterSeconds: 3600, protocolCapabilities: [OUTBOUND_WORKER_PROTOCOL] })
    channel = {
      id: newId(),
      name: '管理群',
      kind: 'webhook',
      enabled: true,
      allowAlerts: false,
      targetIds: [],
      version: 1,
      secretRef: { provider: LOCAL_SECRET_PROVIDER, secretId: newId() },
      host: 'hooks.example.com',
      recipients: [],
      format: 'cairn.outbound@1',
      replay: 'manual_on_unknown',
    }
    await writeConfig({ channel })
    await writeConfig({ settings: { enabled: true, consoleBaseUrl: 'https://console.example.com' } })
  })

  afterAll(async () => {
    await handle?.close()
  })

  it('订阅的增改删与校验：新建默认不启用，启用须有授权渠道，同组合至多一条启用，乐观锁', async () => {
    const targetId = await seeder.newTarget('订阅校验')
    const draft = await createDurationReportSubscription(handle.db, { targetId, period: 'week' }, actorId)
    expect(draft).toMatchObject({ enabled: false, nextSendAt: null, sendWeekday: 1, sendTime: '09:00', trigger: 'schedule', channelIds: [], revision: 1, createdByName: '订阅人' })
    await expect(updateDurationReportSubscription(handle.db, draft.id, { expectedRevision: 1, enabled: true }, actorId)).rejects.toMatchObject({ code: 'DURATION_SUBSCRIPTION_CHANNEL_REQUIRED' })
    await expect(updateDurationReportSubscription(handle.db, draft.id, { expectedRevision: 1, channelIds: [channel.id] }, actorId)).rejects.toMatchObject({ code: 'DURATION_SUBSCRIPTION_CHANNEL_INVALID' })

    await authorize(targetId)
    const enabled = await updateDurationReportSubscription(handle.db, draft.id, { expectedRevision: 1, channelIds: [channel.id], enabled: true }, actorId)
    expect(enabled).toMatchObject({ enabled: true, revision: 2 })
    expect(new Date(enabled.nextSendAt!).getTime()).toBeGreaterThan(Date.now())
    await expect(createDurationReportSubscription(handle.db, { targetId, period: 'week', channelIds: [channel.id], enabled: true }, actorId)).rejects.toMatchObject({ code: 'DURATION_SUBSCRIPTION_DUPLICATE' })
    const monthly = await createDurationReportSubscription(handle.db, { targetId, period: 'month', sendDay: 3, channelIds: [channel.id], enabled: true }, actorId)
    expect(monthly.nextSendAt).not.toBeNull()
    await expect(updateDurationReportSubscription(handle.db, draft.id, { expectedRevision: 1, sendTime: '10:00' }, actorId)).rejects.toMatchObject({ code: 'DURATION_SUBSCRIPTION_REVISION_CONFLICT' })

    expect((await listDurationReportSubscriptions(handle.db, targetId, actorId)).items.map((s) => s.period)).toEqual(['week', 'month'])
    await deleteDurationReportSubscription(handle.db, monthly.id, actorId)
    expect((await listDurationReportSubscriptions(handle.db, targetId, actorId)).items).toHaveLength(1)
  })

  it('到点为最近一期生成报告，HTML 就绪（或等待超时）后推送；重复处理不重复生成、不重复推送', async () => {
    const targetId = await seeder.newTarget('订阅推送')
    const scenario = await seeder.newScenario(targetId, '订单巡检')
    for (let i = 0; i < 3; i += 1) {
      await seeder.seedRun({ scenario, targetId, finishedAt: new Date(zonedStartOfDay(shiftLocalDate(lastWeek, i), TZ).getTime() + 10 * HOUR), activeMs: 12_000, nodes: nodesOf(4_000, 8_000) })
    }
    const sub = await enabledSubscription(targetId, new Date(sendAt.getTime() - 24 * HOUR))
    const now = new Date(sendAt.getTime() + MINUTE)

    const first = await processDurationReportSubscriptions(handle.db, { now })
    expect(first).toMatchObject({ planned: 1, generated: 1, delivered: 0 })
    const [generated] = await issuesOf(sub.id)
    expect(generated).toMatchObject({ periodStart: lastWeek, status: 'generated', attempts: 1 })
    expect(generated!.reportId).not.toBeNull()
    expect(generated!.exportJobId).not.toBeNull()
    const { reports, outboundEvents, outboundDeliveries } = schemaFor(handle.db)
    const [report] = await handle.db.select().from(reports).where(eq(reports.id, generated!.reportId!))
    expect(report).toMatchObject({ subjectKind: 'DURATION_PERIOD', targetId, periodKind: 'week', periodStart: lastWeek, triggerFilter: 'schedule', createdByConsoleAccountId: actorId })

    // HTML 还在排队：不推送；同一时刻重复处理也不会多生成
    expect(await processDurationReportSubscriptions(handle.db, { now })).toMatchObject({ planned: 0, generated: 0, delivered: 0 })
    const later = new Date(now.getTime() + 11 * MINUTE)
    expect(await processDurationReportSubscriptions(handle.db, { now: later })).toMatchObject({ delivered: 1 })
    const [delivered] = await issuesOf(sub.id)
    expect(delivered).toMatchObject({ status: 'delivered' })
    const [event] = await handle.db.select().from(outboundEvents).where(eq(outboundEvents.id, delivered!.outboundEventId!))
    expect(event).toMatchObject({ type: 'report.duration_period', targetId, state: 'ready', consoleUrl: `https://console.example.com/reports/${report!.id}` })
    expect(event!.payload?.report).toMatchObject({ reportId: report!.id, targetName: '订阅推送', consolePath: `/reports/${report!.id}` })
    expect(event!.payload?.report?.highlights.length).toBeGreaterThan(0)
    expect(event!.payload?.title).toContain('耗时周报')
    const deliveries = await handle.db.select().from(outboundDeliveries).where(eq(outboundDeliveries.eventId, event!.id))
    expect(deliveries.map((d) => [d.channelId, d.status])).toEqual([[channel.id, 'pending']])

    expect(await processDurationReportSubscriptions(handle.db, { now: new Date(later.getTime() + HOUR) })).toMatchObject({ planned: 0, generated: 0, delivered: 0 })
    expect(await handle.db.select().from(outboundEvents).where(and(eq(outboundEvents.targetId, targetId), eq(outboundEvents.type, 'report.duration_period')))).toHaveLength(1)

    const visible = await listOutboundEvents(handle.db, actorId, { type: 'report' })
    expect(visible.items.map((item) => item.id)).toContain(event!.id)
    const listed = await listDurationReportSubscriptions(handle.db, targetId, actorId)
    expect(listed.items[0]?.lastIssue).toMatchObject({ periodStart: lastWeek, status: 'delivered', reportId: report!.id, outboundEventId: event!.id })
  })

  it('停机错过发送：只补最近一期，更早的周期记为跳过；启用之前的周期不补', async () => {
    const targetId = await seeder.newTarget('订阅补发')
    const enabledAt = new Date(Date.now() - 35 * 24 * HOUR)
    const sub = await enabledSubscription(targetId, enabledAt)
    const result = await processDurationReportSubscriptions(handle.db, { now: new Date(sendAt.getTime() + MINUTE) })
    let expectedSkipped = 0
    for (let k = 1; durationReportSendAt(weekly, shiftDurationPeriod('week', lastWeek, -k)).getTime() >= enabledAt.getTime(); k += 1) expectedSkipped += 1
    expect(expectedSkipped).toBeGreaterThan(0)
    expect(result.skipped).toBe(expectedSkipped)
    const issues = await issuesOf(sub.id)
    expect(issues.filter((issue) => issue.status === 'skipped').every((issue) => issue.reason === 'missed_send_window')).toBe(true)
    expect(issues.filter((issue) => issue.status !== 'skipped').map((issue) => issue.periodStart)).toEqual([lastWeek])
  })

  it('推送未启用、渠道撤销授权、订阅停用时不推送并写明原因', async () => {
    const targetId = await seeder.newTarget('订阅受阻')
    const sub = await enabledSubscription(targetId, new Date(sendAt.getTime() - 24 * HOUR))
    const { durationReportIssues } = schemaFor(handle.db)
    const run = async () => {
      await processDurationReportSubscriptions(handle.db, { now: new Date(sendAt.getTime() + MINUTE) })
      await processDurationReportSubscriptions(handle.db, { now: new Date(sendAt.getTime() + 12 * MINUTE) })
      const [issue] = await issuesOf(sub.id)
      await handle.db.delete(durationReportIssues).where(eq(durationReportIssues.subscriptionId, sub.id))
      return issue!
    }

    await writeConfig({ settings: { enabled: false, consoleBaseUrl: 'https://console.example.com' } })
    const paused = await run()
    expect(paused).toMatchObject({ status: 'skipped', reason: 'outbound_paused' })
    expect(paused.reportId).not.toBeNull()
    await writeConfig({ settings: { enabled: true, consoleBaseUrl: 'https://console.example.com' } })

    const granted = channel.targetIds
    channel = { ...channel, version: channel.version + 1, targetIds: granted.filter((id) => id !== targetId) }
    await writeConfig({ channel })
    expect(await run()).toMatchObject({ status: 'skipped', reason: 'no_destination' })
    channel = { ...channel, version: channel.version + 1, targetIds: granted }
    await writeConfig({ channel })

    // 已登记、尚未生成时被停用
    await processDurationReportSubscriptions(handle.db, { now: new Date(sendAt.getTime() - HOUR) })
    const { durationReportSubscriptions } = schemaFor(handle.db)
    await handle.db.insert(durationReportIssues).values({ id: newId(), subscriptionId: sub.id, periodStart: lastWeek, status: 'pending', sendAt, nextAttemptAt: sendAt, createdAt: new Date(), updatedAt: new Date() })
    await handle.db.update(durationReportSubscriptions).set({ enabled: false }).where(eq(durationReportSubscriptions.id, sub.id))
    await processDurationReportSubscriptions(handle.db, { now: new Date(sendAt.getTime() + MINUTE) })
    const [disabled] = await issuesOf(sub.id)
    expect(disabled).toMatchObject({ status: 'skipped', reason: 'subscription_disabled', reportId: null })
  })

  it('本期还有运行的耗时没算完时先等，最多等 30 分钟', async () => {
    const targetId = await seeder.newTarget('订阅等待')
    const scenario = await seeder.newScenario(targetId, '首页巡检')
    const { runId } = await writeRunWithSnapshot(handle.db, { scenarioId: scenario.id, scenarioVersionId: scenario.latestVersionId, actor: { kind: 'console', id: actorId }, triggerSource: 'schedule' })
    const finishedAt = new Date(zonedStartOfDay(shiftLocalDate(lastWeek, 6), TZ).getTime() + 23 * HOUR)
    const { runs } = schemaFor(handle.db)
    await handle.db.update(runs).set({ status: 'SUCCEEDED', startedAt: new Date(finishedAt.getTime() - 5_000), finishedAt }).where(eq(runs.id, runId))
    const sub = await enabledSubscription(targetId, new Date(sendAt.getTime() - 24 * HOUR))

    await processDurationReportSubscriptions(handle.db, { now: new Date(sendAt.getTime() + 5 * MINUTE) })
    expect((await issuesOf(sub.id))[0]).toMatchObject({ status: 'pending', reason: 'waiting_for_facts', reportId: null })
    await processDurationReportSubscriptions(handle.db, { now: new Date(sendAt.getTime() + 31 * MINUTE) })
    expect((await issuesOf(sub.id))[0]).toMatchObject({ status: 'generated' })
  })

  it('订阅创建人失去权限后该期失败并写明原因，不再重试', async () => {
    const targetId = await seeder.newTarget('订阅失权')
    const owner = newId()
    const { consoleAccounts, consoleAccountRoles, durationReportSubscriptions } = schemaFor(handle.db)
    await handle.db.insert(consoleAccounts).values({ id: owner, displayName: '离职同事', email: `duration-owner-${owner}@example.com`, status: 'active' })
    await grantAdminScope(handle.db, owner)
    await authorize(targetId)
    const sub = await createDurationReportSubscription(handle.db, { targetId, period: 'week', timeZone: TZ, channelIds: [channel.id], enabled: true }, owner)
    await handle.db.update(durationReportSubscriptions).set({ enabledAt: new Date(sendAt.getTime() - 24 * HOUR) }).where(eq(durationReportSubscriptions.id, sub.id))
    await handle.db.delete(consoleAccountRoles).where(eq(consoleAccountRoles.consoleAccountId, owner))

    const result = await processDurationReportSubscriptions(handle.db, { now: new Date(sendAt.getTime() + MINUTE) })
    expect(result.failed).toBe(1)
    const [issue] = await issuesOf(sub.id)
    expect(issue!.status).toBe('failed')
    expect(issue!.reason).toMatch(/^generate_failed: /)
    expect(await processDurationReportSubscriptions(handle.db, { now: new Date(sendAt.getTime() + HOUR) })).toMatchObject({ generated: 0, failed: 0 })
  })
})
