import { and, eq, inArray, or } from 'drizzle-orm'
import type { Db } from '../client.js'
import { schemaFor, updateRows } from '../native.js'
import { appendSessionEvent } from './session-events.js'
import { loadAccountGrants, scopeFromGrants } from '../console/target-authorization.js'
import { conflict } from '../runs/errors.js'
import type { SessionOperationRow } from '../records.js'

/** 破坏性会话操作：会关闭、替换或清空正在使用的浏览器实例。 */
export const DESTRUCTIVE_OPERATION_KINDS = ['CLOSE', 'RESTART', 'RESET_PROFILE'] as const

export function isDestructiveOperationKind(kind: string): boolean {
  return (DESTRUCTIVE_OPERATION_KINDS as readonly string[]).includes(kind)
}

/** 建立类操作：目的是让账号拿到一个可看的就绪实例，后来者可以直接跟随。 */
export const BUILD_OPERATION_KINDS = ['PREPARE', 'LOGIN', 'VERIFY_AUTH', 'RENEW_AUTH', 'SETTLE_LANDING'] as const

export function isBuildOperationKind(kind: string): boolean {
  return (BUILD_OPERATION_KINDS as readonly string[]).includes(kind)
}

export type ManualControlFacts = {
  authControlActorId: string | null
  authControlExpiresAt: Date | null
}

/** 直连会话上他人持有的有效手动操作权（调用方保证没有活动租约，或自行排除）。 */
export function manualControlHeldByOther(
  session: ManualControlFacts,
  actorId: string | null | undefined,
  now: Date,
): boolean {
  return Boolean(
    session.authControlActorId &&
      session.authControlExpiresAt &&
      session.authControlExpiresAt.getTime() > now.getTime() &&
      session.authControlActorId !== (actorId ?? null),
  )
}

export function manualControlLive(session: ManualControlFacts, now: Date): boolean {
  return manualControlHeldByOther(session, null, now)
}

export async function accountDisplayNames(db: Db, ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))]
  const names = new Map<string, string>()
  if (unique.length === 0) return names
  const { consoleAccounts } = schemaFor(db)
  const rows = await db
    .select({ id: consoleAccounts.id, displayName: consoleAccounts.displayName })
    .from(consoleAccounts)
    .where(inArray(consoleAccounts.id, unique))
  for (const row of rows) names.set(row.id, row.displayName)
  return names
}

export async function accountDisplayName(db: Db, id: string): Promise<string> {
  return (await accountDisplayNames(db, [id])).get(id) ?? '其他用户'
}

/** 该实例上已受理（排队或执行中）的破坏性操作。 */
export async function findPendingDestructiveOperation(
  db: Db,
  input: { targetAccountId: string; sessionId: string },
): Promise<SessionOperationRow | null> {
  const { sessionOperations } = schemaFor(db)
  const [row] = await db
    .select()
    .from(sessionOperations)
    .where(
      and(
        eq(sessionOperations.targetAccountId, input.targetAccountId),
        eq(sessionOperations.expectedSessionId, input.sessionId),
        inArray(sessionOperations.status, ['QUEUED', 'RUNNING']),
        inArray(sessionOperations.kind, [...DESTRUCTIVE_OPERATION_KINDS]),
      ),
    )
    .limit(1)
  return row ?? null
}

export function operationRequestedBy(operation: Pick<SessionOperationRow, 'kindParams'>): string | null {
  const value = operation.kindParams?.requestedBy
  return typeof value === 'string' ? value : null
}

/** 取消会话操作的资格：发起人，或有该目标 `session:dispose` 的人。 */
export async function canCancelSessionOperation(
  db: Db,
  input: { actorId: string; operation: Pick<SessionOperationRow, 'kindParams' | 'targetId'> },
): Promise<boolean> {
  if (operationRequestedBy(input.operation) === input.actorId) return true
  const scope = scopeFromGrants(await loadAccountGrants(db, input.actorId), 'session:dispose')
  return scope.all || scope.ids.includes(input.operation.targetId)
}

export function assertNotHeldByOther(
  session: ManualControlFacts,
  actorId: string | null | undefined,
  now: Date,
  holderName: string,
  message?: string,
): void {
  if (manualControlHeldByOther(session, actorId, now)) {
    throw conflict('AUTH_CONTROL_HELD', message ?? `${holderName} 正在手动操作，不能关闭或重启`, {
      actorId: session.authControlActorId,
    })
  }
}

/**
 * 领取方对应的「本人」：只有控制台账号直接发起的交互运行，或用户发起的会话操作才算。
 * 调度、套件、批量、服务调用的运行一律返回 null，不会触发持有人的「本人」例外。
 */
export async function resolveClaimerActorId(
  db: Db,
  owner: { kind: 'RUN'; runId: string } | { kind: 'SESSION_OPERATION'; operationId: string },
): Promise<string | null> {
  const { runs, sessionOperations, scheduleOccurrences } = schemaFor(db)
  if (owner.kind === 'SESSION_OPERATION') {
    const [op] = await db
      .select({ origin: sessionOperations.origin, kindParams: sessionOperations.kindParams })
      .from(sessionOperations)
      .where(eq(sessionOperations.id, owner.operationId))
      .limit(1)
    const requester = op?.kindParams?.requestedBy
    return op && op.origin !== 'BACKGROUND' && typeof requester === 'string' ? requester : null
  }
  const [run] = await db
    .select({
      createdBy: runs.createdByConsoleAccountId,
      serviceCallerId: runs.serviceCallerId,
      executionOrigin: runs.executionOrigin,
      suiteRunId: runs.suiteRunId,
    })
    .from(runs)
    .where(eq(runs.id, owner.runId))
    .limit(1)
  if (!run || !run.createdBy || run.serviceCallerId || run.executionOrigin !== 'standalone') return null
  const [scheduled] = await db
    .select({ id: scheduleOccurrences.id })
    .from(scheduleOccurrences)
    .where(
      or(
        eq(scheduleOccurrences.runId, owner.runId),
        run.suiteRunId ? eq(scheduleOccurrences.suiteRunId, run.suiteRunId) : undefined,
      ),
    )
    .limit(1)
  return scheduled ? null : run.createdBy
}

/**
 * 收回直连会话上的手动操作权：清空持有人、令牌与活动时间，epoch + 1 使旧令牌的输入一律被拒。
 * 必须在已锁住账号与实例行的事务里调用；同一事务写 auth.control_changed，界面据此刷新。
 */
export async function revokeManualControl(
  db: Db,
  session: { id: string; targetId: string; targetAccountId: string; generation: number; authControlEpoch: number; authControlActorId: string | null },
  reason: 'idle' | 'own_run_started' | 'instance_closed',
): Promise<void> {
  const { browserSessions } = schemaFor(db)
  const nextEpoch = session.authControlEpoch + 1
  await updateRows(
    db,
    browserSessions,
    {
      authControlEpoch: nextEpoch,
      authControlActorId: null,
      authControlTokenHash: null,
      authControlExpiresAt: null,
      authControlPageId: null,
      authControlLastActivityAt: null,
      updatedAt: new Date(),
    },
    eq(browserSessions.id, session.id),
  )
  await appendSessionEvent(db, {
    key: { targetId: session.targetId, targetAccountId: session.targetAccountId },
    sessionId: session.id,
    generation: session.generation,
    type: 'auth.control_changed',
    payload: { phase: 'revoked', epoch: nextEpoch, reason, actorId: session.authControlActorId ?? undefined },
  })
}
