import { and, eq, isNull } from 'drizzle-orm'
import {
  type RecordingCleansingHints,
  type RecordingDraftExclusion,
  type UpdateRecordingExclusionsBody,
} from '@cairn/shared'
import { detectLoginCleansingCandidates, detectMisfireCleansingCandidates } from '@cairn/authoring'
import type { Db } from '../client.js'
import { conflict, notFound, badRequest } from '../runs/errors.js'
import { newId } from '../id.js'
import { locked, schemaFor } from '../native.js'
import { recordAudit, type AuditActor } from '../audit/record.js'
import { assertTargetPermission } from '../console/target-authorization.js'

export async function assertRecordingDraftOwner(
  db: Db,
  id: string,
  actorId: string,
  write = false,
) {
  const { recordingDrafts, targets } = schemaFor(db)
  const query = db
    .select()
    .from(recordingDrafts)
    .where(and(eq(recordingDrafts.id, id), isNull(recordingDrafts.deletedAt)))
    .limit(1)
  const [row] = write ? await locked(db, query) : await query
  if (!row || row.createdByConsoleAccountId !== actorId) {
    throw notFound('RECORDING_NOT_FOUND', '录制草稿不存在')
  }
  await assertTargetPermission(db, actorId, row.targetId, 'workflow:write')
  await assertTargetPermission(db, actorId, row.targetId, 'target:read')
  return row
}

export async function listRecordingDraftExclusions(
  db: Db,
  recordingDraftId: string,
): Promise<RecordingDraftExclusion[]> {
  const { recordingDraftExclusions } = schemaFor(db)
  const rows = await db
    .select()
    .from(recordingDraftExclusions)
    .where(eq(recordingDraftExclusions.recordingDraftId, recordingDraftId))
    .orderBy(recordingDraftExclusions.createdAt)

  return rows.map((r) => ({
    id: r.id,
    recordingDraftId: r.recordingDraftId,
    itemId: r.itemId,
    reason: r.reason as RecordingDraftExclusion['reason'],
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }))
}

export async function updateRecordingDraftExclusions(
  db: Db,
  recordingDraftId: string,
  input: UpdateRecordingExclusionsBody,
  actor: AuditActor,
): Promise<{ exclusions: RecordingDraftExclusion[]; revision: number }> {
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db
    const { recordingDrafts, recordingDraftExclusions } = schemaFor(txDb)

    const [draftRow] = await locked(
      txDb,
      txDb
        .select()
        .from(recordingDrafts)
        .where(and(eq(recordingDrafts.id, recordingDraftId), isNull(recordingDrafts.deletedAt)))
        .limit(1),
    )
    if (!draftRow || draftRow.createdByConsoleAccountId !== actor.id) {
      throw notFound('RECORDING_NOT_FOUND', '录制草稿不存在')
    }
    await assertTargetPermission(txDb, actor.id, draftRow.targetId, 'workflow:write')

    // 乐观并发冲突校验 (方案 §3)
    if (draftRow.revision !== input.expectedRevision) {
      throw conflict('RECORDING_DRAFT_REVISION_MISMATCH', '草稿已被修改，请刷新后重试')
    }

    // 清理原有名单并批量写入新名单
    await txDb
      .delete(recordingDraftExclusions)
      .where(eq(recordingDraftExclusions.recordingDraftId, recordingDraftId))

    const now = new Date()
    const newExclusions: RecordingDraftExclusion[] = []

    if (input.exclusions.length > 0) {
      for (const item of input.exclusions) {
        const id = newId()
        await txDb.insert(recordingDraftExclusions).values({
          id,
          recordingDraftId,
          itemId: item.itemId,
          reason: item.reason,
          createdAt: now,
          updatedAt: now,
        })
        newExclusions.push({
          id,
          recordingDraftId,
          itemId: item.itemId,
          reason: item.reason,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        })
      }
    }

    const nextRevision = draftRow.revision + 1
    await txDb
      .update(recordingDrafts)
      .set({
        revision: nextRevision,
        updatedAt: now,
      })
      .where(eq(recordingDrafts.id, recordingDraftId))

    await recordAudit(
      txDb,
      actor,
      'recording.update',
      'recording',
      recordingDraftId,
      `更新草稿排除项 (共 ${input.exclusions.length} 项，版本 r${nextRevision})`,
    )

    return {
      exclusions: newExclusions,
      revision: nextRevision,
    }
  })
}

export async function loadCleansingHints(
  db: Db,
  recordingDraftId: string,
  targetId: string,
): Promise<RecordingCleansingHints | undefined> {
  const {
    targets,
    targetAuthProfiles,
    recordingDemonstrationSources,
    recordingDrafts,
  } = schemaFor(db)

  // 1. 读取草稿协议
  const [draftRow] = await db
    .select({ sourceProtocol: recordingDrafts.sourceProtocol })
    .from(recordingDrafts)
    .where(eq(recordingDrafts.id, recordingDraftId))
    .limit(1)

  if (draftRow?.sourceProtocol !== 'demonstration@1') {
    return undefined
  }

  // 2. 检查目标认证配置 (方案 §4.1)
  const [targetRow] = await db
    .select()
    .from(targets)
    .where(and(eq(targets.id, targetId), isNull(targets.deletedAt)))
    .limit(1)

  let hasActiveAuthProfile = false
  if (targetRow?.currentAuthProfileRevision) {
    const [profileRow] = await db
      .select({ id: targetAuthProfiles.id })
      .from(targetAuthProfiles)
      .where(
        and(
          eq(targetAuthProfiles.targetId, targetId),
          eq(targetAuthProfiles.revision, targetRow.currentAuthProfileRevision),
        ),
      )
      .limit(1)
    hasActiveAuthProfile = Boolean(profileRow)
  }

  // 3. 读取示教事实
  const [sourceRow] = await db
    .select()
    .from(recordingDemonstrationSources)
    .where(eq(recordingDemonstrationSources.recordingDraftId, recordingDraftId))
    .limit(1)

  if (!sourceRow?.source?.facts) {
    return undefined
  }

  const facts = sourceRow.source.facts
  const loginPrefixItemIds = detectLoginCleansingCandidates(facts, {
    hasActiveAuthProfile,
    loginUrl: targetRow?.loginUrl,
  })
  const misfireItemIds = detectMisfireCleansingCandidates(facts)

  return {
    loginPrefixItemIds,
    misfireItemIds,
  }
}
