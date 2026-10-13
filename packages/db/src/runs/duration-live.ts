import { and, asc, eq, inArray } from 'drizzle-orm'
import { composeAttemptDuration } from '@cairn/shared'
import type { Db } from '../client.js'
import { schemaFor } from '../native.js'
import { listAiCallsForAttempts, listPageWaitsForAttempts } from './page-wait.js'

export type LiveDurationComponents = {
  wall: number | null
  model: number | null
  page: number | null
}

export type LiveDurationStep = {
  stepId: string
  startedAt?: Date | string | null
  finishedAt?: Date | string | null
  attempts: Array<{
    id: string
    startedAt?: Date | string | null
    finishedAt?: Date | string | null
  }>
}

export type LiveDurationCall = {
  attemptId: string | null
  durationMs: number | null
  startedAt?: Date | string | null
  endedAt?: Date | string | null
}

export type LiveDurationWait = {
  attemptId: string
  reason: string
  startedAt: Date | string
  endedAt: Date | string
}

export type LiveDurationQuery = {
  sourceStepId?: string
  runTotal?: boolean
  excludeStepId?: string
  scopePath?: string | null
}

function msOf(value: Date | string | null | undefined): number | null {
  if (!value) return null
  const n = new Date(value).getTime()
  return Number.isFinite(n) ? n : null
}

export function attemptWallMs(attempt: { startedAt?: Date | string | null; finishedAt?: Date | string | null }): number | null {
  const start = msOf(attempt.startedAt)
  const end = msOf(attempt.finishedAt)
  if (start == null || end == null) return null
  return Math.max(0, end - start)
}

export function composeLiveAttempt(
  wallMs: number | null,
  calls: readonly LiveDurationCall[],
  waits: readonly LiveDurationWait[],
): LiveDurationComponents {
  const pageMarked = waits.some((wait) => wait.reason === 'collector_ready')
  const slices = composeAttemptDuration({
    activeMs: wallMs ?? 0,
    modelCalls: calls.map((call) => ({
      durationMs: call.durationMs,
      startedAt: msOf(call.startedAt ?? null),
      endedAt: msOf(call.endedAt ?? null),
    })),
    pageMarked,
    pageIntervals: waits
      .filter((wait) => wait.reason !== 'collector_ready')
      .flatMap((wait) => {
        const start = msOf(wait.startedAt)
        const end = msOf(wait.endedAt)
        return start != null && end != null && end > start ? [{ start, end }] : []
      }),
  })
  return { wall: wallMs, model: slices.modelMs, page: slices.pageMs }
}

function lastAttemptOf(step: LiveDurationStep | undefined) {
  if (!step || step.attempts.length === 0) return undefined
  return step.attempts[step.attempts.length - 1]
}

/** 检查 / 指标用的现场分段：读账本累加，不读事实表。页面无采集标记则为 null。 */
export function liveDurationOf(
  steps: readonly LiveDurationStep[],
  calls: readonly LiveDurationCall[],
  waits: readonly LiveDurationWait[],
  query: LiveDurationQuery,
): LiveDurationComponents {
  const callsByAttempt = new Map<string, LiveDurationCall[]>()
  for (const call of calls) {
    if (!call.attemptId) continue
    const list = callsByAttempt.get(call.attemptId) ?? []
    list.push(call)
    callsByAttempt.set(call.attemptId, list)
  }
  const waitsByAttempt = new Map<string, LiveDurationWait[]>()
  for (const wait of waits) {
    const list = waitsByAttempt.get(wait.attemptId) ?? []
    list.push(wait)
    waitsByAttempt.set(wait.attemptId, list)
  }
  const ofAttempt = (attempt: LiveDurationStep['attempts'][number] | undefined): LiveDurationComponents => {
    if (!attempt) return { wall: null, model: null, page: null }
    return composeLiveAttempt(attemptWallMs(attempt), callsByAttempt.get(attempt.id) ?? [], waitsByAttempt.get(attempt.id) ?? [])
  }

  if (query.runTotal) {
    const prior = steps.filter((step) => step.stepId !== query.excludeStepId)
    if (prior.length === 0) return { wall: null, model: null, page: null }
    let earliest: number | undefined
    let latest: number | undefined
    let model = 0
    let page = 0
    let pageMissing = false
    for (const step of prior) {
      const first = step.attempts[0]
      const last = lastAttemptOf(step)
      const start = msOf(first?.startedAt ?? step.startedAt)
      const end = msOf(last?.finishedAt ?? step.finishedAt)
      if (start != null) earliest = earliest === undefined ? start : Math.min(earliest, start)
      if (end != null) latest = latest === undefined ? end : Math.max(latest, end)
      const parts = ofAttempt(last)
      model += parts.model ?? 0
      if (parts.page == null) pageMissing = true
      else page += parts.page
    }
    return {
      wall: earliest != null && latest != null ? Math.max(0, latest - earliest) : null,
      model,
      page: pageMissing ? null : page,
    }
  }

  return ofAttempt(lastAttemptOf(steps.find((step) => step.stepId === query.sourceStepId)))
}

async function loadLiveDurationSteps(db: Db, runId: string, scopePath?: string | null): Promise<LiveDurationStep[]> {
  const { stepRuns, attempts } = schemaFor(db)
  const stepRows = await db
    .select({
      id: stepRuns.id,
      stepId: stepRuns.stepId,
      startedAt: stepRuns.startedAt,
      finishedAt: stepRuns.finishedAt,
    })
    .from(stepRuns)
    .where(
      scopePath === null
        ? eq(stepRuns.runId, runId)
        : and(eq(stepRuns.runId, runId), eq(stepRuns.scopePath, scopePath ?? '')),
    )
    .orderBy(asc(stepRuns.ordinal))
  if (stepRows.length === 0) return []
  const attemptRows = await db
    .select({
      id: attempts.id,
      stepRunId: attempts.stepRunId,
      startedAt: attempts.startedAt,
      finishedAt: attempts.finishedAt,
    })
    .from(attempts)
    .where(inArray(attempts.stepRunId, stepRows.map((step) => step.id)))
    .orderBy(asc(attempts.attemptNo))
  const byStep = new Map<string, LiveDurationStep['attempts']>()
  for (const attempt of attemptRows) {
    const list = byStep.get(attempt.stepRunId) ?? []
    list.push({ id: attempt.id, startedAt: attempt.startedAt, finishedAt: attempt.finishedAt })
    byStep.set(attempt.stepRunId, list)
  }
  return stepRows.map((step) => ({
    stepId: step.stepId,
    startedAt: step.startedAt,
    finishedAt: step.finishedAt,
    attempts: byStep.get(step.id) ?? [],
  }))
}

export async function loadLiveDurationComponents(db: Db, runId: string, query: LiveDurationQuery): Promise<LiveDurationComponents> {
  const steps = await loadLiveDurationSteps(db, runId, query.runTotal ? null : query.scopePath)
  const attemptIds = steps.flatMap((step) => step.attempts.map((attempt) => attempt.id))
  const [calls, waits] = await Promise.all([listAiCallsForAttempts(db, attemptIds), listPageWaitsForAttempts(db, attemptIds)])
  return liveDurationOf(steps, calls, waits, query)
}

export async function loadLiveDurationByStepId(db: Db, runId: string): Promise<Record<string, LiveDurationComponents>> {
  const steps = await loadLiveDurationSteps(db, runId, null)
  const attemptIds = steps.flatMap((step) => step.attempts.map((attempt) => attempt.id))
  const [calls, waits] = await Promise.all([listAiCallsForAttempts(db, attemptIds), listPageWaitsForAttempts(db, attemptIds)])
  const out: Record<string, LiveDurationComponents> = {}
  for (const step of steps) {
    out[step.stepId] = liveDurationOf([step], calls, waits, { sourceStepId: step.stepId })
  }
  return out
}
