import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import {
  type AcceptanceCoverageOverviewResponse,
  type AcceptanceCoverageSnapshot,
  type AcceptanceSnapshotCoverage,
  type AcceptanceSnapshotFindingSummary,
  type AcceptanceSweepBatch,
  type ScenarioCoverageItem,
  type SweepBatchStatus,
  type SweepBatchTrigger,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { newId } from '../id.js'
import { atomic, locked, schemaFor } from '../native.js'
import type {
  AcceptanceCoverageSnapshotRow,
  AcceptanceSweepBatchRow,
} from '../schema/acceptance.js'

export async function createSweepBatch(
  db: Db,
  input: { scope?: string; trigger: SweepBatchTrigger },
): Promise<{ ok: true; batch: AcceptanceSweepBatchRow } | { ok: false; activeBatch: AcceptanceSweepBatchRow }> {
  const { acceptanceSweepBatches } = schemaFor(db)
  const now = new Date()

  // 1. 自动回收超时僵尸批次
  await db
    .update(acceptanceSweepBatches)
    .set({
      status: 'failed',
      error: 'WORKER_LOST',
      finishedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(acceptanceSweepBatches.status, 'running'),
        sql`${acceptanceSweepBatches.leaseExpiresAt} <= ${now}`,
      ),
    )

  // 2. 检查是否存在活跃批次（queued 或未过期的 running）
  const [activeBatch] = await db
    .select()
    .from(acceptanceSweepBatches)
    .where(
      and(
        inArray(acceptanceSweepBatches.status, ['queued', 'running']),
        or(
          isNull(acceptanceSweepBatches.leaseExpiresAt),
          sql`${acceptanceSweepBatches.leaseExpiresAt} > ${now}`,
        ),
      ),
    )
    .limit(1)

  if (activeBatch) {
    return { ok: false, activeBatch }
  }

  // 3. 写入新的 queued 批次
  const id = newId()
  await db
    .insert(acceptanceSweepBatches)
    .values({
      id,
      scope: input.scope ?? 'platform',
      trigger: input.trigger,
      status: 'queued',
      scenarioCount: 0,
      skippedCount: 0,
      createdAt: now,
      updatedAt: now,
    })

  const [batch] = await db
    .select()
    .from(acceptanceSweepBatches)
    .where(eq(acceptanceSweepBatches.id, id))
    .limit(1)

  return { ok: true, batch: batch! }
}

export async function claimSweepBatch(
  db: Db,
  input: { workerId: string; leaseMinutes?: number },
): Promise<AcceptanceSweepBatchRow | null> {
  return atomic(db, async (tx) => {
    const { acceptanceSweepBatches } = schemaFor(tx)
    const now = new Date()

    // 1. 回收超时僵尸批次
    await tx
      .update(acceptanceSweepBatches)
      .set({
        status: 'failed',
        error: 'WORKER_LOST',
        finishedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(acceptanceSweepBatches.status, 'running'),
          sql`${acceptanceSweepBatches.leaseExpiresAt} <= ${now}`,
        ),
      )

    // 2. 原子锁定并领取最早的 queued 批次
    const query = tx
      .select()
      .from(acceptanceSweepBatches)
      .where(eq(acceptanceSweepBatches.status, 'queued'))
      .orderBy(asc(acceptanceSweepBatches.createdAt))
      .limit(1)

    const rows = await locked(tx, query, true)
    if (!rows || rows.length === 0) {
      return null
    }

    const candidate = rows[0]!
    const leaseMinutes = input.leaseMinutes ?? 15
    const leaseExpiresAt = new Date(now.getTime() + leaseMinutes * 60 * 1000)

    await tx
      .update(acceptanceSweepBatches)
      .set({
        status: 'running',
        leaseOwner: input.workerId,
        leaseExpiresAt,
        startedAt: candidate.startedAt ?? now,
        updatedAt: now,
      })
      .where(eq(acceptanceSweepBatches.id, candidate.id))

    const [claimed] = await tx
      .select()
      .from(acceptanceSweepBatches)
      .where(eq(acceptanceSweepBatches.id, candidate.id))
      .limit(1)

    return claimed ?? null
  })
}

export async function renewSweepBatchLease(
  db: Db,
  input: { batchId: string; workerId: string; leaseMinutes?: number },
): Promise<boolean> {
  const { acceptanceSweepBatches } = schemaFor(db)
  const now = new Date()
  const leaseMinutes = input.leaseMinutes ?? 15
  const leaseExpiresAt = new Date(now.getTime() + leaseMinutes * 60 * 1000)

  const [target] = await db
    .select({ id: acceptanceSweepBatches.id })
    .from(acceptanceSweepBatches)
    .where(
      and(
        eq(acceptanceSweepBatches.id, input.batchId),
        eq(acceptanceSweepBatches.status, 'running'),
        eq(acceptanceSweepBatches.leaseOwner, input.workerId),
      ),
    )
    .limit(1)

  if (!target) return false

  await db
    .update(acceptanceSweepBatches)
    .set({
      leaseExpiresAt,
      updatedAt: now,
    })
    .where(eq(acceptanceSweepBatches.id, input.batchId))

  return true
}

export async function finishSweepBatch(
  db: Db,
  input: {
    batchId: string
    status: 'completed' | 'failed'
    scenarioCount?: number
    skippedCount?: number
    durationMs?: number
    error?: string | null
  },
): Promise<void> {
  const { acceptanceSweepBatches } = schemaFor(db)
  const now = new Date()

  await db
    .update(acceptanceSweepBatches)
    .set({
      status: input.status,
      leaseOwner: null,
      leaseExpiresAt: null,
      finishedAt: now,
      scenarioCount: input.scenarioCount ?? 0,
      skippedCount: input.skippedCount ?? 0,
      durationMs: input.durationMs,
      error: input.error ?? null,
      updatedAt: now,
    })
    .where(eq(acceptanceSweepBatches.id, input.batchId))
}

export interface InsertCoverageSnapshotItem {
  id?: string
  batchId: string
  targetId: string
  scenarioId: string
  draftRevision: number
  auditedAt: Date
  trigger: SweepBatchTrigger
  coverage: AcceptanceSnapshotCoverage | null
  findingsCount: number
  topFindings: AcceptanceSnapshotFindingSummary[]
  durationMs: number
}

export async function insertCoverageSnapshots(
  db: Db,
  snapshots: InsertCoverageSnapshotItem[],
): Promise<void> {
  if (snapshots.length === 0) return

  const { acceptanceCoverageSnapshots } = schemaFor(db)
  const rows = snapshots.map((s) => ({
    id: s.id ?? newId(),
    batchId: s.batchId,
    targetId: s.targetId,
    scenarioId: s.scenarioId,
    draftRevision: s.draftRevision,
    auditedAt: s.auditedAt,
    trigger: s.trigger,
    coverage: s.coverage,
    findingsCount: s.findingsCount,
    topFindings: s.topFindings,
    durationMs: s.durationMs,
    createdAt: new Date(),
  }))

  await db.insert(acceptanceCoverageSnapshots).values(rows)
}

export async function pruneOldSweepSnapshots(
  db: Db,
  retentionDays = 90,
): Promise<number> {
  const { acceptanceCoverageSnapshots } = schemaFor(db)
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)

  const rows = await db
    .select({ id: acceptanceCoverageSnapshots.id })
    .from(acceptanceCoverageSnapshots)
    .where(sql`${acceptanceCoverageSnapshots.auditedAt} < ${cutoff}`)

  if (rows.length === 0) return 0

  await db
    .delete(acceptanceCoverageSnapshots)
    .where(sql`${acceptanceCoverageSnapshots.auditedAt} < ${cutoff}`)

  return rows.length
}

export async function getAcceptanceCoverageOverview(
  db: Db,
  query?: { targetId?: string },
): Promise<AcceptanceCoverageOverviewResponse> {
  const { scenarios, targets, scenarioDrafts, acceptanceSweepBatches, acceptanceCoverageSnapshots } = schemaFor(db)

  // 1. 查询最新批次
  const [latestBatchRow] = await db
    .select()
    .from(acceptanceSweepBatches)
    .orderBy(desc(acceptanceSweepBatches.createdAt))
    .limit(1)

  let latestBatch: AcceptanceSweepBatch | null = null
  if (latestBatchRow) {
    latestBatch = {
      id: latestBatchRow.id,
      scope: 'platform',
      trigger: latestBatchRow.trigger,
      status: latestBatchRow.status,
      leaseOwner: latestBatchRow.leaseOwner,
      leaseExpiresAt: latestBatchRow.leaseExpiresAt ? latestBatchRow.leaseExpiresAt.toISOString() : null,
      startedAt: latestBatchRow.startedAt ? latestBatchRow.startedAt.toISOString() : null,
      finishedAt: latestBatchRow.finishedAt ? latestBatchRow.finishedAt.toISOString() : null,
      scenarioCount: latestBatchRow.scenarioCount,
      skippedCount: latestBatchRow.skippedCount,
      durationMs: latestBatchRow.durationMs ?? undefined,
      error: latestBatchRow.error,
      createdAt: latestBatchRow.createdAt.toISOString(),
    }
  }

  // 2. 查询活跃场景列表
  const scenarioRows = await db
    .select({
      scenarioId: scenarios.id,
      scenarioName: scenarios.name,
      targetId: scenarios.targetId,
      targetName: targets.name,
      draftRevision: scenarioDrafts.revision,
    })
    .from(scenarios)
    .innerJoin(targets, eq(scenarios.targetId, targets.id))
    .leftJoin(scenarioDrafts, eq(scenarios.id, scenarioDrafts.scenarioId))
    .where(
      and(
        isNull(scenarios.deletedAt),
        query?.targetId ? eq(scenarios.targetId, query.targetId) : undefined,
      ),
    )
    .orderBy(asc(scenarios.name))

  // 3. 跨库可移植聚合：使用 MAX(audited_at) GROUP BY scenario_id 子查询联结，禁止 DISTINCT ON
  const maxAuditedSubquery = db
    .select({
      scenarioId: acceptanceCoverageSnapshots.scenarioId,
      maxAuditedAt: sql<Date>`max(${acceptanceCoverageSnapshots.auditedAt})`.as('max_audited_at'),
    })
    .from(acceptanceCoverageSnapshots)
    .groupBy(acceptanceCoverageSnapshots.scenarioId)
    .as('latest_snap_group')

  const latestSnapshots = await db
    .select({
      scenarioId: acceptanceCoverageSnapshots.scenarioId,
      draftRevision: acceptanceCoverageSnapshots.draftRevision,
      auditedAt: acceptanceCoverageSnapshots.auditedAt,
      trigger: acceptanceCoverageSnapshots.trigger,
      coverage: acceptanceCoverageSnapshots.coverage,
      findingsCount: acceptanceCoverageSnapshots.findingsCount,
      topFindings: acceptanceCoverageSnapshots.topFindings,
    })
    .from(acceptanceCoverageSnapshots)
    .innerJoin(
      maxAuditedSubquery,
      and(
        eq(acceptanceCoverageSnapshots.scenarioId, maxAuditedSubquery.scenarioId),
        eq(acceptanceCoverageSnapshots.auditedAt, maxAuditedSubquery.maxAuditedAt),
      ),
    )

  const snapshotMap = new Map<string, (typeof latestSnapshots)[number]>()
  for (const snap of latestSnapshots) {
    if (!snapshotMap.has(snap.scenarioId)) {
      snapshotMap.set(snap.scenarioId, snap)
    }
  }

  // 4. 组装场景覆盖行并统计概览
  let unauditedScenarioCount = 0
  let coverageScoreSum = 0
  let scoredScenarioCount = 0

  const scenarioItems: ScenarioCoverageItem[] = []

  for (const s of scenarioRows) {
    const hasDraft = s.draftRevision !== null && s.draftRevision !== undefined
    const snap = snapshotMap.get(s.scenarioId)

    if (!hasDraft || !snap) {
      unauditedScenarioCount += 1
    }

    if (snap?.coverage) {
      const avg = (snap.coverage.browserStepCoverage + snap.coverage.outputMetricCoverage) / 2
      coverageScoreSum += avg
      scoredScenarioCount += 1
    }

    scenarioItems.push({
      scenarioId: s.scenarioId,
      scenarioName: s.scenarioName,
      targetId: s.targetId,
      targetName: s.targetName,
      hasDraft,
      draftRevision: s.draftRevision ?? undefined,
      latestAuditedAt: snap?.auditedAt ? snap.auditedAt.toISOString() : undefined,
      trigger: snap?.trigger,
      browserStepCoverage: snap?.coverage?.browserStepCoverage,
      outputMetricCoverage: snap?.coverage?.outputMetricCoverage,
      findingsCount: snap ? snap.findingsCount : undefined,
      topFindings: snap?.topFindings,
    })
  }

  const platformAverageCoverage =
    scoredScenarioCount > 0 ? Number((coverageScoreSum / scoredScenarioCount).toFixed(2)) : 0

  return {
    platformAverageCoverage,
    unauditedScenarioCount,
    totalScenarioCount: scenarioRows.length,
    latestBatch,
    scenarios: scenarioItems,
  }
}

export interface AuditableScenarioItem {
  id: string
  name: string
  targetId: string
  draftRevision: number
  draftDocument: unknown
}

export async function listScenariosForAcceptanceSweep(db: Db): Promise<AuditableScenarioItem[]> {
  const { scenarios, scenarioDrafts } = schemaFor(db)
  const rows = await db
    .select({
      id: scenarios.id,
      name: scenarios.name,
      targetId: scenarios.targetId,
      draftRevision: scenarioDrafts.revision,
      draftDocument: scenarioDrafts.document,
    })
    .from(scenarios)
    .innerJoin(scenarioDrafts, eq(scenarios.id, scenarioDrafts.scenarioId))
    .where(isNull(scenarios.deletedAt))
    .orderBy(asc(scenarios.targetId), asc(scenarios.name))

  return rows
}
