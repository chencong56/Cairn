import { and, asc, eq, exists, gt, inArray, lt, min } from 'drizzle-orm'
import {
  FINISHED_RUN_STATUSES,
  RUNTIME_SCHEMA_VERSION,
  parseRunEventCursor,
  persistedRunEventSchema,
  type JsonValue,
  type PersistedRunEvent,
  type RunEventType,
  type RunStreamResetReason,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { newId } from '../id.js'
import { deleteRows, locked, onCommit, schemaFor } from '../native.js'
import { publishChangeHint } from './hint.js'
import { indexRunForAnalysis } from '../analysis/sources.js'

export type RunEventDraft = {
  type: RunEventType
  payload: JsonValue
  stepRunId?: string
  attemptId?: string
  workerId?: string
  requestId?: string
}

export async function appendRunEvents(
  tx: Db,
  runId: string,
  drafts: readonly RunEventDraft[],
): Promise<number> {
  const { runEvents, runs } = schemaFor(tx)
  const [current] = await locked(
    tx,
    tx.select({ eventSeq: runs.eventSeq, targetId: runs.targetId, status: runs.status }).from(runs).where(eq(runs.id, runId)),
  )
  if (!current) return 0
  if (drafts.length === 0) return current.eventSeq
  let sequence = current.eventSeq
  const now = new Date()
  const rows = drafts.map((draft) => {
    sequence += 1
    const event = persistedRunEventSchema.parse({
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      eventId: newId(),
      type: draft.type,
      occurredAt: now.toISOString(),
      runId,
      sequence,
      payload: draft.payload,
      ...(draft.stepRunId ? { stepRunId: draft.stepRunId } : {}),
      ...(draft.attemptId ? { attemptId: draft.attemptId } : {}),
      ...(draft.workerId ? { workerId: draft.workerId } : {}),
      ...(draft.requestId ? { requestId: draft.requestId } : {}),
    })
    return {
      eventId: event.eventId,
      runId: event.runId,
      sequence: event.sequence,
      schemaVersion: event.schemaVersion,
      type: event.type,
      occurredAt: now,
      stepRunId: event.stepRunId ?? null,
      attemptId: event.attemptId ?? null,
      workerId: event.workerId ?? null,
      requestId: event.requestId ?? null,
      payload: event.payload,
    }
  })
  await tx.insert(runEvents).values(rows)
  await tx.update(runs).set({ eventSeq: sequence }).where(eq(runs.id, runId))
  if (FINISHED_RUN_STATUSES.includes(current.status as typeof FINISHED_RUN_STATUSES[number])) {
    await indexRunForAnalysis(tx, { targetId: current.targetId, runId })
  }
  const { enqueueRunOutboundIntentTx } = await import('../outbound/core.js')
  await enqueueRunOutboundIntentTx(tx, runId)
  const runControlChanged = drafts.some(
    (draft) => draft.type === 'run.cancel_requested' || (draft.type === 'run.status_changed' && !isAuthWaitBookkeeping(draft.payload)),
  )
  onCommit(tx, () => publishChangeHint({ runId, eventSeq: sequence, runControlChanged }))
  return sequence
}

/**
 * 进入认证等待、认证恢复后重新排队的状态事件只为耗时事实记账，不唤醒执行面的运行控制。
 * 执行面自己发起认证等待并在等待期间管理会话；唤醒会让取消监视看到「非 RUNNING」而打断它。
 * 这两类事件补齐之前从不带运行控制标记，这里保持原行为。
 */
function isAuthWaitBookkeeping(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false
  const { status, reason } = payload as { status?: unknown; reason?: unknown }
  return status === 'WAITING_FOR_AUTH' || (status === 'RECOVERING' && reason === 'auth_resumed')
}

export async function earliestEventSeq(db: Db, runId: string): Promise<number> {
  const { runEvents } = schemaFor(db)
  const [row] = await db
    .select({ earliest: min(runEvents.sequence) })
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
  return Number(row?.earliest ?? 0)
}

export async function loadRunEventWatermark(
  db: Db,
  runId: string,
): Promise<{ eventSeq: number; earliestEventSeq: number } | null> {
  const { runs } = schemaFor(db)
  const [row] = await db.select({ eventSeq: runs.eventSeq }).from(runs).where(eq(runs.id, runId)).limit(1)
  if (!row) return null
  return { eventSeq: row.eventSeq, earliestEventSeq: await earliestEventSeq(db, runId) }
}

export async function listRunEventWatermarks(
  db: Db,
  runIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (runIds.length === 0) return out
  const { runs } = schemaFor(db)
  const rows = await db
    .select({ id: runs.id, eventSeq: runs.eventSeq })
    .from(runs)
    .where(inArray(runs.id, runIds))
  for (const row of rows) out.set(row.id, row.eventSeq)
  return out
}

function toPersisted(row: {
  eventId: string
  runId: string
  sequence: number
  schemaVersion: number
  type: RunEventType
  occurredAt: Date
  stepRunId: string | null
  attemptId: string | null
  workerId: string | null
  requestId: string | null
  payload: JsonValue
}): PersistedRunEvent {
  return persistedRunEventSchema.parse({
    schemaVersion: row.schemaVersion,
    eventId: row.eventId,
    type: row.type,
    occurredAt: row.occurredAt.toISOString(),
    runId: row.runId,
    sequence: row.sequence,
    payload: row.payload,
    ...(row.stepRunId ? { stepRunId: row.stepRunId } : {}),
    ...(row.attemptId ? { attemptId: row.attemptId } : {}),
    ...(row.workerId ? { workerId: row.workerId } : {}),
    ...(row.requestId ? { requestId: row.requestId } : {}),
  })
}

export async function listRunEventsAfter(
  db: Db,
  runId: string,
  afterSequence: number,
  limit: number,
): Promise<PersistedRunEvent[]> {
  const { runEvents } = schemaFor(db)
  const rows = await db
    .select()
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), gt(runEvents.sequence, afterSequence)))
    .orderBy(asc(runEvents.sequence))
    .limit(limit)
  return rows.map((row) => toPersisted(row))
}

export function diagnoseRunEventCursor(input: {
  runId: string
  lastEventId?: string
  eventSeq: number
  earliestEventSeq: number
}): { ok: true; after: number } | { ok: false; reason: RunStreamResetReason } {
  if (!input.lastEventId) {
    const after = input.earliestEventSeq > 0 ? input.earliestEventSeq - 1 : 0
    return { ok: true, after }
  }
  const parsed = parseRunEventCursor(input.lastEventId)
  if (!parsed) return { ok: false, reason: 'cursor_invalid' }
  if (parsed.runId !== input.runId) return { ok: false, reason: 'cursor_run_mismatch' }
  if (parsed.sequence > input.eventSeq) return { ok: false, reason: 'cursor_ahead' }
  if (input.earliestEventSeq > 0 && parsed.sequence + 1 < input.earliestEventSeq) {
    return { ok: false, reason: 'cursor_expired' }
  }
  return { ok: true, after: parsed.sequence }
}

export async function purgeExpiredRunEvents(db: Db, retainDays: number): Promise<number> {
  const { runEvents, runs, runDurationFacts } = schemaFor(db)
  const cutoff = new Date(Date.now() - retainDays * 24 * 60 * 60 * 1000)
  // 耗时事实从运行事件重建状态时间线；事实落库前不得清理该运行的事件。
  const hasDurationFacts = exists(
    db.select({ runId: runDurationFacts.runId }).from(runDurationFacts).where(eq(runDurationFacts.runId, runs.id)),
  )
  const eligible = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(inArray(runs.status, [...FINISHED_RUN_STATUSES]), eq(runs.evidenceStatus, 'COMPLETE'), hasDurationFacts))
  const incomplete = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(inArray(runs.status, [...FINISHED_RUN_STATUSES]), eq(runs.evidenceStatus, 'INCOMPLETE'), hasDurationFacts))
  const runIds = [...eligible, ...incomplete].map((row) => row.id)
  if (runIds.length === 0) return 0
  const deleted = await deleteRows(
    db,
    runEvents,
    and(lt(runEvents.occurredAt, cutoff), inArray(runEvents.runId, runIds)),
    { eventId: runEvents.eventId },
  )
  return deleted.length
}
