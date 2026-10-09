import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import {
  SESSION_OCCUPANCY_PROTOCOL,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { clockNow, jsonArrayIncludes, jsonHasKey, schemaFor } from '../native.js'

export async function readMonitorClock(db: Db): Promise<Date> {
  return clockNow(db)
}

export function asCount(value: unknown): number {
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? n : 0
}

export function occupancyStatuses() {
  return ['CREATING', 'OPEN', 'CLOSING'] as const
}

export function claimableRunCondition(db: Db, asOf: Date): SQL {
  const { runs, suiteRunItems } = schemaFor(db)
  return and(
    inArray(runs.status, ['RECOVERING', 'QUEUED']),
    isNull(runs.deletedAt),
    isNull(runs.cancelRequestedAt),
    or(isNull(runs.deadlineAt), sql`${runs.deadlineAt} > ${asOf}`),
    sql`(
      ${runs.executionOrigin} <> 'suite_member'
      OR EXISTS (
        SELECT 1 FROM ${suiteRunItems} admitted
        WHERE admitted.child_run_id = ${runs.id}
          AND admitted.admission_status = 'ACTIVE'
      )
    )`,
  )!
}

/** 能领取运行的执行节点：声明了会话占用（调度 / 分析 / 维护节点不声明）。锁步部署下不再按快照特性区分。 */
export function workerExecutesRuns(db: Db): SQL {
  const { workers } = schemaFor(db)
  return jsonArrayIncludes(db, workers.protocolCapabilities, SESSION_OCCUPANCY_PROTOCOL)
}

export function onlineClaimerCondition(db: Db, asOf: Date): SQL {
  const { workers } = schemaFor(db)
  return and(
    eq(workers.status, 'READY'),
    sql`${workers.heartbeatExpiresAt} IS NOT NULL AND ${workers.heartbeatExpiresAt} > ${asOf}`,
  )!
}
