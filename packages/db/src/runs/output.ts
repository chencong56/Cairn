import { eq, inArray } from 'drizzle-orm'
import {
  assembleRunOutput,
  isFinishedRunStatus,
  type RunOutput,
  type RunSnapshot,
} from '@cairn/shared'
import type { Db, DbHandle } from '../client.js'
import { schemaFor } from '../native.js'
import { appendRunEvents } from '../observe/events.js'
import type { RunRow } from '../schema/execution.js'
import { liveDurationOf } from './duration-live.js'
import { listAiCallsForAttempts, listPageWaitsForAttempts } from './page-wait.js'

export async function settleRunOutput(
  db: DbHandle | Db,
  runId: string,
  runRow?: RunRow | null,
): Promise<RunOutput | null> {
  const underlyingDb = 'db' in db ? db.db : db
  const { runs, stepRuns, attempts, outcomeResults } = schemaFor(underlyingDb)

  let row = runRow
  if (!row) {
    const [found] = await underlyingDb.select().from(runs).where(eq(runs.id, runId)).limit(1)
    row = found
  }
  if (!row || !isFinishedRunStatus(row.status)) {
    return null
  }

  // 幂等：若已落库 output，直接返回
  if (row.output) {
    return row.output as RunOutput
  }

  const stepRows = await underlyingDb
    .select()
    .from(stepRuns)
    .where(eq(stepRuns.runId, runId))

  const attemptRows =
    stepRows.length === 0
      ? []
      : await underlyingDb
          .select()
          .from(attempts)
          .where(
            inArray(
              attempts.stepRunId,
              stepRows.map((step) => step.id),
            ),
          )

  const attemptsByStepRunId = new Map<string, typeof attemptRows>()
  for (const a of attemptRows) {
    const list = attemptsByStepRunId.get(a.stepRunId) ?? []
    list.push(a)
    attemptsByStepRunId.set(a.stepRunId, list)
  }

  const enrichedStepRuns = stepRows.map((sr) => ({
    id: sr.id,
    stepId: sr.stepId,
    ordinal: sr.ordinal,
    name: sr.name,
    status: sr.status,
    outcomeStatus: sr.outcomeStatus,
    startedAt: sr.startedAt ? new Date(sr.startedAt).toISOString() : undefined,
    finishedAt: sr.finishedAt ? new Date(sr.finishedAt).toISOString() : undefined,
    attempts: (attemptsByStepRunId.get(sr.id) ?? []).map((a) => ({
      status: a.status,
      startedAt: a.startedAt ? new Date(a.startedAt).toISOString() : undefined,
      finishedAt: a.finishedAt ? new Date(a.finishedAt).toISOString() : undefined,
      error: a.error as any,
    })),
  }))

  const outcomeRows = await underlyingDb
    .select()
    .from(outcomeResults)
    .where(eq(outcomeResults.runId, runId))

  const snapshot = row.snapshot as RunSnapshot

  const failedAttempt = attemptRows.find((a) => a.status === 'FAILED')
  const error = failedAttempt?.error as { safeMessage?: string; message?: string; code?: string } | undefined
  const attemptIds = attemptRows.map((attempt) => attempt.id)
  const [durationCalls, durationWaits] = await Promise.all([
    listAiCallsForAttempts(underlyingDb, attemptIds),
    listPageWaitsForAttempts(underlyingDb, attemptIds),
  ])
  const durationByStepId = Object.fromEntries(
    stepRows.map((step) => [
      step.stepId,
      liveDurationOf(
        [
          {
            stepId: step.stepId,
            startedAt: step.startedAt,
            finishedAt: step.finishedAt,
            attempts: (attemptsByStepRunId.get(step.id) ?? []).map((attempt) => ({
              id: attempt.id,
              startedAt: attempt.startedAt,
              finishedAt: attempt.finishedAt,
            })),
          },
        ],
        durationCalls,
        durationWaits,
        { sourceStepId: step.stepId },
      ),
    ]),
  )

  const output = assembleRunOutput({
    definition: {
      steps: snapshot.steps,
      outputs: (snapshot as any).outputs,
    },
    context: row.context as any,
    outcomeResults: outcomeRows as any,
    stepRuns: enrichedStepRuns,
    status: row.status,
    outcomeStatus: row.outcomeStatus,
    error,
    now: row.finishedAt ?? new Date(),
    runStartedAt: row.startedAt,
    durationComponents: { byStepId: durationByStepId },
  })

  await underlyingDb.transaction(async (tx) => {
    await tx
      .update(runs)
      .set({ output, updatedAt: new Date() })
      .where(eq(runs.id, runId))

    await appendRunEvents(tx as unknown as Db, runId, [
      {
        type: 'run.output_settled',
        payload: {
          status: output.status,
          summary: output.summary,
        },
      },
    ])
  })

  return output
}
