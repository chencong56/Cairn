import { and, eq, inArray } from 'drizzle-orm'
import {
  PAGE_WAIT_KIND,
  RUNTIME_SCHEMA_VERSION,
  isPageWaitEvidence,
  pageWaitEvidenceSchema,
  type JsonValue,
  type PageWaitReason,
} from '@cairn/shared'
import { insertIgnoreRows, schemaFor } from '../native.js'
import type { Db } from '../client.js'
import { newId } from '../id.js'

export type RecordPageWaitInput = {
  runId: string
  stepRunId: string
  attemptId: string
  reason: PageWaitReason
  startedAt: Date
  endedAt: Date
  url?: string | null
}

export type RecordPageWaitResult = { ok: true; evidenceId: string } | { ok: false }

function sanitizePageWaitUrl(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    if (!['https:', 'http:'].includes(url.protocol)) return raw.slice(0, 512)
    url.username = ''
    url.password = ''
    url.hash = ''
    url.search = ''
    return url.toString().slice(0, 512)
  } catch {
    return raw.split('?')[0]?.slice(0, 512)
  }
}

/** 写入页面等待证据与账本。账本失败不影响步骤成败，只打日志。 */
export async function recordPageWait(db: Db, input: RecordPageWaitInput): Promise<RecordPageWaitResult> {
  const startedAt = input.startedAt
  const endedAt = input.endedAt.getTime() >= startedAt.getTime() ? input.endedAt : startedAt
  const durationMs = Math.max(0, endedAt.getTime() - startedAt.getTime())
  const url = sanitizePageWaitUrl(input.url)
  const evidenceId = newId()
  const payload = pageWaitEvidenceSchema.parse({
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    kind: PAGE_WAIT_KIND,
    reason: input.reason,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs,
    attemptId: input.attemptId,
    ...(url ? { url } : {}),
  })
  const { evidences } = schemaFor(db)
  try {
    await db.insert(evidences).values({
      id: evidenceId,
      runId: input.runId,
      stepRunId: input.stepRunId,
      attemptId: input.attemptId,
      type: 'log',
      status: 'available',
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      payload: payload as JsonValue,
      createdAt: new Date(),
    })
  } catch (error) {
    console.error('[db] page_wait 证据写入失败', error instanceof Error ? error.message : error)
    return { ok: false }
  }
  try {
    const { scenarioPageWaits } = schemaFor(db)
    await insertIgnoreRows(db, scenarioPageWaits, {
      id: newId(),
      evidenceId,
      runId: input.runId,
      stepRunId: input.stepRunId,
      attemptId: input.attemptId,
      reason: input.reason,
      durationMs,
      startedAt,
      endedAt,
      url: url ?? null,
    })
  } catch (error) {
    console.error('[db] scenario_page_waits 写入失败，不影响 evidence', error instanceof Error ? error.message : error)
  }
  return { ok: true, evidenceId }
}

export async function listPageWaitsForAttempts(
  db: Db,
  attemptIds: readonly string[],
): Promise<
  Array<{
    attemptId: string
    reason: PageWaitReason
    startedAt: Date
    endedAt: Date
    durationMs: number
  }>
> {
  if (attemptIds.length === 0) return []
  const { scenarioPageWaits } = schemaFor(db)
  const rows = await db
    .select({
      attemptId: scenarioPageWaits.attemptId,
      reason: scenarioPageWaits.reason,
      startedAt: scenarioPageWaits.startedAt,
      endedAt: scenarioPageWaits.endedAt,
      durationMs: scenarioPageWaits.durationMs,
    })
    .from(scenarioPageWaits)
    .where(inArray(scenarioPageWaits.attemptId, [...attemptIds]))
  return rows
}

export async function listAiCallsForAttempts(
  db: Db,
  attemptIds: readonly string[],
): Promise<Array<{ attemptId: string | null; durationMs: number | null; startedAt: Date | null; endedAt: Date | null }>> {
  if (attemptIds.length === 0) return []
  const { scenarioAiCalls } = schemaFor(db)
  return db
    .select({
      attemptId: scenarioAiCalls.attemptId,
      durationMs: scenarioAiCalls.durationMs,
      startedAt: scenarioAiCalls.startedAt,
      endedAt: scenarioAiCalls.endedAt,
    })
    .from(scenarioAiCalls)
    .where(inArray(scenarioAiCalls.attemptId, [...attemptIds]))
}
