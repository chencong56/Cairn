import { previewScheduleWindows, SCHEDULE_SKIP_REASON_METAS, type ScheduleSkipReason, type AssistantSourceItem, type AssistantAnalysisFinding } from '@cairn/shared'
import { listSchedules, getSchedule, listScheduleOccurrences, assertTargetPermission, getAccountSessionDetail } from '@cairn/db'
import type { AssistantCapabilityHandlerContext } from '../registry.js'
import { analysisResult, collectionFilters } from './analyzer-common.js'
type Ctx = AssistantCapabilityHandlerContext
const source = (id: string, targetId?: string): AssistantSourceItem => ({ kind: 'schedule', id, targetId, requiredPermissions: ['schedule:read'] })

export async function analyzeScheduleWindowOverlap(ctx: Ctx) {
  const filters = collectionFilters(ctx)
  const response = await listSchedules(ctx.db, { ...filters, limit: 100 }, ctx.actor.id)
  const start = new Date(), end = new Date(start.getTime() + 86400_000)
  const sources = response.items.map((s) => source(s.scheduleId, s.targetId))
  const missing: string[] = response.nextCursor ? ['调度列表超过 100 条，未覆盖全部对象'] : []
  const windows: Array<{ id: string; name: string; start: number; end: number }> = []
  for (const schedule of response.items.filter((s) => s.enabled)) {
    const remaining = 1000 - windows.length
    if (remaining <= 0) { missing.push('达到 1000 个窗口预算'); break }
    try {
      const preview = previewScheduleWindows({ scheduleId: schedule.scheduleId, definition: schedule.definition, asOf: start, limit: remaining + 1 })
      const inRange = preview.filter((w) => w.kind === 'ok' && Date.parse(w.windowStartUtc) < end.getTime() && Date.parse(w.windowEndUtc) > start.getTime())
      if (inRange.length > remaining) missing.push(`调度「${schedule.name}」窗口超过剩余预算`)
      for (const w of inRange.slice(0, remaining)) if (w.kind === 'ok') windows.push({ id: schedule.scheduleId, name: schedule.name ?? '未命名调度',
        start: Date.parse(w.windowStartUtc), end: Date.parse(w.windowEndUtc) })
    } catch { missing.push(`调度「${schedule.name}」窗口计算失败`) }
  }
  const findings: AssistantAnalysisFinding[] = []
  const buckets = new Map<number, typeof windows>()
  for (const w of windows) { const key = Math.floor(w.start / 60000); buckets.set(key, [...(buckets.get(key) ?? []), w]) }
  for (const [minute, entries] of buckets) if (entries.length > 1) findings.push({ id: `cluster-${minute}`, code: 'SCHEDULE_START_CLUSTER',
    message: `${new Date(minute * 60000).toISOString()} 同一分钟开始 ${entries.length} 个窗口。`, citationRefs: entries.map((w) => `schedule:${w.id}`), severity: 'warning' })
  const sorted = [...windows].sort((a, b) => a.start - b.start)
  let overlaps = 0
  for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length && sorted[j]!.start < sorted[i]!.end; j++) {
    const a = sorted[i]!, b = sorted[j]!
    if (a.id === b.id) continue
    overlaps++
    if (findings.length < 100) findings.push({ id: `overlap-${i}-${j}`, code: 'SCHEDULE_WINDOW_OVERLAP_DETECTED',
      message: `「${a.name}」与「${b.name}」可准入窗口交集：${new Date(Math.max(a.start, b.start)).toISOString()} 至 ${new Date(Math.min(a.end, b.end)).toISOString()}。`,
      citationRefs: [`schedule:${a.id}`, `schedule:${b.id}`], severity: 'warning' })
  }
  if (overlaps > 100) missing.push('重叠明细超过展示预算，请缩小筛选')
  return analysisResult('schedule.window-overlap', `未来 24 小时读取 ${windows.length} 个可准入窗口，发现 ${overlaps} 对跨调度窗口交集。窗口重叠不代表实际运行同时执行。`, sources, findings,
    { missing, sampleSize: windows.length, scope: { ...filters, from: start.toISOString(), to: end.toISOString() } })
}

export async function analyzeScheduleSkipSummary(ctx: Ctx, scheduleId?: string) {
  const filters = collectionFilters(ctx)
  const response = scheduleId ? { items: [await getSchedule(ctx.db, scheduleId, ctx.actor.id)], nextCursor: undefined } :
    await listSchedules(ctx.db, { ...filters, limit: 100 }, ctx.actor.id)
  const from = Date.now() - 7 * 86400_000, asOf = Date.now()
  const sources = response.items.map((s) => source(s.scheduleId, s.targetId))
  const missing: string[] = response.nextCursor ? ['调度列表超过预算'] : []
  const counts = new Map<string, number>(), reasons = new Map<string, number>()
  let scanned = 0, manual = 0
  for (const schedule of response.items) {
    let cursor: string | undefined
    do {
      if (scanned >= 1000) { missing.push('触发记录达到 1000 条预算，统计不完整'); break }
      const page = await listScheduleOccurrences(ctx.db, schedule.scheduleId, { limit: Math.min(100, 1000 - scanned), cursor })
      scanned += page.items.length
      for (const occurrence of page.items) {
        const time = Date.parse(occurrence.createdAt)
        if (time < from || time > asOf) continue
        sources.push({ kind: 'scheduleOccurrence', id: occurrence.occurrenceId, targetId: schedule.targetId, requiredPermissions: ['schedule:read'] })
        if (occurrence.source !== 'scheduled') { manual++; continue }
        counts.set(occurrence.admissionStatus, (counts.get(occurrence.admissionStatus) ?? 0) + 1)
        if (occurrence.admissionStatus === 'SKIPPED') reasons.set(occurrence.reason ?? 'UNKNOWN', (reasons.get(occurrence.reason ?? 'UNKNOWN') ?? 0) + 1)
      }
      cursor = page.nextCursor
      if (page.items.at(-1) && Date.parse(page.items.at(-1)!.createdAt) < from) cursor = undefined
    } while (cursor)
  }
  const names: Record<string, string> = { SKIPPED: '跳过', FAILED: '失败', PENDING: '等待准入', ADMITTED: '已准入' }
  return analysisResult('schedule.skip-summary', `近 7 天计划触发：${['ADMITTED', 'SKIPPED', 'FAILED', 'PENDING'].map((key) => `${names[key]} ${counts.get(key) ?? 0} 次`).join('，')}；手工触发 ${manual} 次单列。没有触发记录不计作跳过。`, sources,
    [...reasons].map(([reason, count], i) => ({ id: `skip-${i}`, code: 'SCHEDULE_SKIP_REASON', message: `${SCHEDULE_SKIP_REASON_METAS[reason as ScheduleSkipReason]?.label ?? '未记录明确原因'}：${count} 次`, citationRefs: response.items.map((s) => `schedule:${s.scheduleId}`) })),
    { missing, scope: { ...filters, from: new Date(from).toISOString(), to: new Date(asOf).toISOString() }, sampleSize: scanned })
}

export async function analyzeScheduleResourceContention(ctx: Ctx, id: string) {
  const schedule = await getSchedule(ctx.db, id, ctx.actor.id)
  const sources = [source(id, schedule.targetId)]
  const missing: string[] = []
  let summary = `「${schedule.name}」账号资源检查。`
  if (schedule.targetAccountId) {
    await assertTargetPermission(ctx.db, ctx.actor.id, schedule.targetId, 'session:read')
    const detail = await getAccountSessionDetail(ctx.db, { targetId: schedule.targetId, targetAccountId: schedule.targetAccountId })
    sources.push({ kind: 'account', id: schedule.targetAccountId, targetId: schedule.targetId, requiredPermissions: ['session:read'] })
    const occupied = detail.instances.filter((s) => s.occupancy).length
    summary += `账号容量 ${detail.effectiveCap}，当前活会话 ${detail.liveCount}，其中 ${occupied} 个被占用。`
    if (occupied >= detail.effectiveCap) summary += '当前占用达到账号容量，新任务可能需要等待。'
  } else missing.push('此调度没有单一固定账号，需展开场景集成员或核对动态账号绑定后判断竞争')
  return analysisResult('schedule.resource-contention', `${summary}当前快照不预测未来占用。`, sources, [], { missing })
}
