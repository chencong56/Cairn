import { and, eq, inArray, isNull } from 'drizzle-orm'
import { DEFAULT_VISITOR_DISPLAY_NAME, isUsableIdentity, type ScheduleConsumer } from '@cairn/shared'
import type { Db } from '../client.js'
import { newId } from '../id.js'
import { schemaFor } from '../native.js'
import { DomainError, failure } from '../runs/errors.js'

/**
 * 访客与默认账号的领域规则（方案 §5.1）：
 * - 访客是每个目标至多一个、不带凭据的账号；「是否开启访客」只看它是否启用。
 * - 可用身份从 1 个变成 2 个时，原来那个自动成为默认；只剩 1 个时清空默认。
 * - 停用或删除默认账号时，剩余可用身份仍有 2 个及以上则要求先改选默认。
 */
export type IdentityRow = {
  id: string
  displayName: string
  identityKind: 'credential' | 'visitor'
  status: 'active' | 'disabled'
  usage: 'business' | 'map' | 'both'
  deletedAt: Date | null
}

export async function loadTargetIdentities(tx: Db, targetId: string): Promise<IdentityRow[]> {
  const { targetAccounts } = schemaFor(tx)
  return tx
    .select({
      id: targetAccounts.id,
      displayName: targetAccounts.displayName,
      identityKind: targetAccounts.identityKind,
      status: targetAccounts.status,
      usage: targetAccounts.usage,
      deletedAt: targetAccounts.deletedAt,
    })
    .from(targetAccounts)
    .where(and(eq(targetAccounts.targetId, targetId), isNull(targetAccounts.deletedAt)))
}

export function usableIdentityIds(rows: readonly IdentityRow[]): string[] {
  return rows.filter(isUsableIdentity).map((row) => row.id)
}

/** 启用或新建访客账号；已存在（含停用）就复用，保证每个目标至多一个。 */
export async function ensureVisitorAccount(tx: Db, targetId: string, now: Date): Promise<{ id: string; changed: boolean }> {
  const { targetAccounts } = schemaFor(tx)
  const [existing] = await tx
    .select({ id: targetAccounts.id, status: targetAccounts.status })
    .from(targetAccounts)
    .where(
      and(
        eq(targetAccounts.targetId, targetId),
        eq(targetAccounts.identityKind, 'visitor'),
        isNull(targetAccounts.deletedAt),
      ),
    )
    .limit(1)
  if (existing) {
    if (existing.status === 'active') return { id: existing.id, changed: false }
    await tx
      .update(targetAccounts)
      .set({ status: 'active', updatedAt: now })
      .where(eq(targetAccounts.id, existing.id))
    return { id: existing.id, changed: true }
  }
  const id = newId()
  await tx.insert(targetAccounts).values({
    id,
    targetId,
    displayName: DEFAULT_VISITOR_DISPLAY_NAME,
    username: null,
    identityKind: 'visitor',
    visitorGuard: 'Y',
    status: 'active',
    usage: 'business',
    mapUsageGuard: null,
    maxConcurrentSessions: 1,
    createdAt: now,
    updatedAt: now,
  })
  return { id, changed: true }
}

export async function findVisitorAccountId(tx: Db, targetId: string): Promise<string | undefined> {
  const { targetAccounts } = schemaFor(tx)
  const [row] = await tx
    .select({ id: targetAccounts.id })
    .from(targetAccounts)
    .where(
      and(
        eq(targetAccounts.targetId, targetId),
        eq(targetAccounts.identityKind, 'visitor'),
        isNull(targetAccounts.deletedAt),
      ),
    )
    .limit(1)
  return row?.id
}

function consumerUsesAccount(consumer: ScheduleConsumer | null | undefined, accountId: string): boolean {
  if (!consumer) return false
  switch (consumer.type) {
    case 'scenario_run':
      return consumer.accountBinding?.targetAccountId === accountId
    case 'suite_run':
      return (
        consumer.defaultTargetAccountId === accountId ||
        consumer.members.some((member) => member.targetAccountId === accountId)
      )
    case 'map_ingest':
      return consumer.targetAccountId === accountId
    default:
      return false
  }
}

/** 启用中的调度会用到该账号时列出它们（单场景调度冻结的账号，或场景集调度里成员冻结的账号）。 */
export async function enabledSchedulesUsingAccount(
  tx: Db,
  targetId: string,
  accountId: string,
): Promise<Array<{ id: string; name: string | null }>> {
  const { schedules, scheduleVersions } = schemaFor(tx)
  const rows = await tx
    .select({
      id: schedules.id,
      name: schedules.name,
      columnAccountId: schedules.targetAccountId,
      consumer: scheduleVersions.consumer,
    })
    .from(schedules)
    .innerJoin(scheduleVersions, eq(scheduleVersions.id, schedules.currentVersionId))
    .where(and(eq(schedules.targetId, targetId), eq(schedules.enabled, 1), isNull(schedules.deletedAt)))
  return rows
    .filter((row) => row.columnAccountId === accountId || consumerUsesAccount(row.consumer, accountId))
    .map((row) => ({ id: row.id, name: row.name }))
}

export async function assertVisitorDisableAllowed(tx: Db, targetId: string, visitorId: string): Promise<void> {
  const inUse = await enabledSchedulesUsingAccount(tx, targetId, visitorId)
  if (inUse.length > 0) {
    const names = inUse.slice(0, 5).map((row) => `「${row.name ?? row.id.slice(0, 8)}」`).join('、')
    throw new DomainError(
      'conflict',
      'TARGET_VISITOR_IN_USE',
      `仍有 ${inUse.length} 个启用中的调度使用访客（${names}${inUse.length > 5 ? ' 等' : ''}），请先停用或改选账号`,
      { scheduleIds: inUse.map((row) => row.id) },
    )
  }
}

/** 停用、删除默认账号或把它改为仅知识采集前调用。 */
export async function assertDefaultRemovable(tx: Db, targetId: string, accountId: string): Promise<void> {
  const { targets } = schemaFor(tx)
  const [target] = await tx
    .select({ defaultAccountId: targets.defaultAccountId })
    .from(targets)
    .where(eq(targets.id, targetId))
    .limit(1)
  if (target?.defaultAccountId !== accountId) return
  const remaining = usableIdentityIds(await loadTargetIdentities(tx, targetId)).filter((id) => id !== accountId)
  if (remaining.length >= 2) {
    throw failure('conflict', {
      code: 'TARGET_DEFAULT_ACCOUNT_IN_USE',
      message: '这是目标的默认账号，请先把默认账号改选为其他账号',
    })
  }
}

/**
 * 可用身份变化后收敛默认账号。previousUsable 是变化前的可用身份。
 * 返回自动设为默认的账号 id（若有），便于审计。
 */
export async function reconcileTargetDefault(
  tx: Db,
  targetId: string,
  previousUsable: readonly string[],
  now: Date,
): Promise<string | undefined> {
  const { targets } = schemaFor(tx)
  const [target] = await tx
    .select({ defaultAccountId: targets.defaultAccountId })
    .from(targets)
    .where(eq(targets.id, targetId))
    .limit(1)
  if (!target) return undefined
  const usable = usableIdentityIds(await loadTargetIdentities(tx, targetId))
  let next = target.defaultAccountId
  if (next && (!usable.includes(next) || usable.length <= 1)) next = null
  let autoDefault: string | undefined
  if (!next && usable.length >= 2 && previousUsable.length === 1 && usable.includes(previousUsable[0]!)) {
    next = previousUsable[0]!
    autoDefault = next
  }
  if (next !== target.defaultAccountId) {
    await tx.update(targets).set({ defaultAccountId: next, updatedAt: now }).where(eq(targets.id, targetId))
  }
  return autoDefault
}

/** 目标默认账号、场景运行账号只能指向本目标下启用、可用于业务的账号（含访客）。 */
export async function assertRunAccountChoice(tx: Db, targetId: string, accountId: string): Promise<void> {
  const rows = await loadTargetIdentities(tx, targetId)
  const row = rows.find((item) => item.id === accountId)
  if (!row || !isUsableIdentity(row)) {
    throw failure('bad_request', {
      code: 'TARGET_DEFAULT_ACCOUNT_INVALID',
      message: '只能选择本目标下启用、可用于跑场景的账号',
    })
  }
}

/** 账号删除后，指定它为运行账号的场景改回「跟随目标默认」。返回受影响的场景 id。 */
export async function resetScenarioRunAccounts(tx: Db, accountIds: readonly string[], now: Date): Promise<string[]> {
  if (accountIds.length === 0) return []
  const { scenarios } = schemaFor(tx)
  const rows = await tx
    .select({ id: scenarios.id })
    .from(scenarios)
    .where(inArray(scenarios.runAccountId, [...accountIds]))
  if (rows.length === 0) return []
  await tx
    .update(scenarios)
    .set({ runAccountId: null, updatedAt: now })
    .where(inArray(scenarios.runAccountId, [...accountIds]))
  return rows.map((row) => row.id)
}
