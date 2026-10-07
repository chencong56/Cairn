import { eq, inArray, or } from 'drizzle-orm'
import type { OccupancyActor } from '@cairn/shared'
import type { Db } from '../client.js'
import { schemaFor } from '../native.js'
import type { SessionLeaseRow } from '../records.js'
import { accountDisplayNames } from './manual-control.js'

type LeaseOwner = Pick<SessionLeaseRow, 'id' | 'runId' | 'operationId'>

/**
 * 解析租约持有方的展示归属。
 * 只有交互运行（控制台账号直接发起）和用户发起的会话操作会落成 `user`；
 * 调度、套件、批量、服务调用的运行一律不指向任何人，调用方不得把它们当作「本人」。
 */
export async function resolveOccupancyActors(
  db: Db,
  leases: readonly LeaseOwner[],
): Promise<Map<string, OccupancyActor>> {
  const result = new Map<string, OccupancyActor>()
  const runIds = [...new Set(leases.map((l) => l.runId).filter((id): id is string => Boolean(id)))]
  const opIds = [...new Set(leases.map((l) => l.operationId).filter((id): id is string => Boolean(id)))]
  const { runs, sessionOperations, scheduleOccurrences, schedules } = schemaFor(db)

  const runRows = runIds.length
    ? await db
        .select({
          id: runs.id,
          createdBy: runs.createdByConsoleAccountId,
          serviceCallerId: runs.serviceCallerId,
          executionOrigin: runs.executionOrigin,
          suiteRunId: runs.suiteRunId,
        })
        .from(runs)
        .where(inArray(runs.id, runIds))
    : []
  const suiteRunIds = [...new Set(runRows.map((r) => r.suiteRunId).filter((id): id is string => Boolean(id)))]
  const occurrenceRows =
    runIds.length || suiteRunIds.length
      ? await db
          .select({
            runId: scheduleOccurrences.runId,
            suiteRunId: scheduleOccurrences.suiteRunId,
            scheduleName: schedules.name,
            scheduleId: schedules.id,
          })
          .from(scheduleOccurrences)
          .innerJoin(schedules, eq(schedules.id, scheduleOccurrences.scheduleId))
          .where(
            or(
              runIds.length ? inArray(scheduleOccurrences.runId, runIds) : undefined,
              suiteRunIds.length ? inArray(scheduleOccurrences.suiteRunId, suiteRunIds) : undefined,
            ),
          )
      : []
  const opRows = opIds.length
    ? await db
        .select({ id: sessionOperations.id, origin: sessionOperations.origin, kindParams: sessionOperations.kindParams })
        .from(sessionOperations)
        .where(inArray(sessionOperations.id, opIds))
    : []

  const userIds = [
    ...runRows.map((r) => r.createdBy).filter((id): id is string => Boolean(id)),
    ...opRows.map((o) => o.kindParams?.requestedBy).filter((id): id is string => typeof id === 'string'),
  ]
  const names = await accountDisplayNames(db, userIds)

  const scheduleByRun = new Map<string, { id: string; name: string | null }>()
  for (const occ of occurrenceRows) {
    const info = { id: occ.scheduleId, name: occ.scheduleName ?? '调度计划' }
    if (occ.runId) scheduleByRun.set(occ.runId, info)
    if (occ.suiteRunId) {
      for (const run of runRows) if (run.suiteRunId === occ.suiteRunId) scheduleByRun.set(run.id, info)
    }
  }
  const runById = new Map(runRows.map((r) => [r.id, r]))
  const opById = new Map(opRows.map((o) => [o.id, o]))

  for (const lease of leases) {
    if (lease.runId) {
      const run = runById.get(lease.runId)
      if (!run) continue
      const schedule = scheduleByRun.get(run.id)
      if (schedule) result.set(lease.id, { kind: 'schedule', id: schedule.id, name: schedule.name })
      else if (run.serviceCallerId) result.set(lease.id, { kind: 'service', id: run.serviceCallerId, name: null })
      else if (run.executionOrigin === 'suite_member') result.set(lease.id, { kind: 'suite', id: run.suiteRunId, name: null })
      else if (run.executionOrigin === 'batch_item') result.set(lease.id, { kind: 'batch', id: null, name: null })
      else if (run.createdBy) result.set(lease.id, { kind: 'user', id: run.createdBy, name: names.get(run.createdBy) ?? null })
      else result.set(lease.id, { kind: 'system', id: null, name: null })
    } else if (lease.operationId) {
      const op = opById.get(lease.operationId)
      const requester = typeof op?.kindParams?.requestedBy === 'string' ? op.kindParams.requestedBy : null
      if (requester) result.set(lease.id, { kind: 'user', id: requester, name: names.get(requester) ?? null })
      else result.set(lease.id, { kind: 'system', id: null, name: null })
    }
  }
  return result
}
