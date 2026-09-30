import { and, asc, eq, isNull } from 'drizzle-orm'
import type { Db } from '../client.js'
import { insertIgnoreRows, schemaFor } from '../native.js'

export interface EnqueueReliabilityReceiptInput {
  runId: string
  targetId: string
  finishedAt: Date
  ruleVersion?: number
}

/**
 * 在终态事务内原子登记 v2 待消费记录。
 * 遵循 §4.3 & §4.4：与 Run 终态写入同事务提交/回滚。
 */
export async function enqueueReliabilityReceiptTx(
  tx: Db,
  input: EnqueueReliabilityReceiptInput,
): Promise<boolean> {
  const { reliabilityCheckpoints, reliabilityRunReceipts } = schemaFor(tx)
  const ruleVersion = input.ruleVersion ?? 2

  // 检查目标检查点是否存在及是否开启 v2
  const [cp] = await tx
    .select({
      targetId: reliabilityCheckpoints.targetId,
      v2Enabled: reliabilityCheckpoints.v2Enabled,
    })
    .from(reliabilityCheckpoints)
    .where(eq(reliabilityCheckpoints.targetId, input.targetId))
    .limit(1)

  let isV2 = cp?.v2Enabled ?? false
  if (!cp) {
    const now = new Date()
    // 新建目标在接收 Run 终态前完成相同初始化
    await insertIgnoreRows(tx, reliabilityCheckpoints, {
      targetId: input.targetId,
      watermarkVector: { runCompletedSeq: 0, mapCommittedSeq: 0, validationSeq: 0 },
      fencingToken: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      v2Enabled: true,
      v2EnabledAt: now,
      runEvaluationOrdinal: 0,
      updatedAt: now,
    })
    isV2 = true
  } else if (!isV2) {
    // 存量目标自愈：终态入账时补启用 v2，避免依赖一次性迁移或人工开关
    const now = new Date()
    await tx
      .update(reliabilityCheckpoints)
      .set({ v2Enabled: true, v2EnabledAt: now, updatedAt: now })
      .where(eq(reliabilityCheckpoints.targetId, input.targetId))
    isV2 = true
  }

  // 幂等入队：(run_id, rule_version) 唯一约束保证只入队一次
  await insertIgnoreRows(tx, reliabilityRunReceipts, {
    runId: input.runId,
    ruleVersion,
    targetId: input.targetId,
    finishedAt: input.finishedAt,
    enqueuedAt: new Date(),
  })

  return true
}

export interface FetchPendingReliabilityReceiptsInput {
  targetId: string
  ruleVersion?: number
  limit?: number
}

export interface PendingReceiptRow {
  runId: string
  ruleVersion: number
  targetId: string
  finishedAt: Date
  enqueuedAt: Date
  consumedAt: Date | null
  evaluationOrdinal: number | null
}

/**
 * 抓取目标下未确认的 receipt，按 (finished_at, run_id) 稳定排序。
 */
export async function fetchPendingReliabilityReceipts(
  db: Db,
  input: FetchPendingReliabilityReceiptsInput,
): Promise<PendingReceiptRow[]> {
  const { reliabilityRunReceipts } = schemaFor(db)
  const ruleVersion = input.ruleVersion ?? 2
  const limit = input.limit ?? 50

  const rows = await db
    .select()
    .from(reliabilityRunReceipts)
    .where(
      and(
        eq(reliabilityRunReceipts.targetId, input.targetId),
        eq(reliabilityRunReceipts.ruleVersion, ruleVersion),
        isNull(reliabilityRunReceipts.consumedAt),
      ),
    )
    .orderBy(asc(reliabilityRunReceipts.finishedAt), asc(reliabilityRunReceipts.runId))
    .limit(limit)

  return rows as PendingReceiptRow[]
}

/**
 * 显式启用目标的 v2 评估模式。
 */
export async function activateTargetReliabilityV2Tx(tx: Db, targetId: string): Promise<void> {
  const { reliabilityCheckpoints } = schemaFor(tx)
  const now = new Date()
  const [existing] = await tx
    .select({ targetId: reliabilityCheckpoints.targetId, v2Enabled: reliabilityCheckpoints.v2Enabled })
    .from(reliabilityCheckpoints)
    .where(eq(reliabilityCheckpoints.targetId, targetId))
    .limit(1)

  if (!existing) {
    await tx.insert(reliabilityCheckpoints).values({
      targetId,
      watermarkVector: { runCompletedSeq: 0, mapCommittedSeq: 0, validationSeq: 0 },
      fencingToken: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      v2Enabled: true,
      v2EnabledAt: now,
      runEvaluationOrdinal: 0,
      updatedAt: now,
    })
  } else if (!existing.v2Enabled) {
    await tx
      .update(reliabilityCheckpoints)
      .set({ v2Enabled: true, v2EnabledAt: now, updatedAt: now })
      .where(eq(reliabilityCheckpoints.targetId, targetId))
  }
}
