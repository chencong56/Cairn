import { and, eq, sql } from 'drizzle-orm'
import type { PlatformSessionScheduling, RunPlacement, RunStatus } from '@cairn/shared'
import type { Db } from '../client.js'
import { clockNow, databaseNow, schemaFor } from '../native.js'
import { accountDisplayName, manualControlLive, resolveClaimerActorId } from './manual-control.js'
import {
  assignMinFreeSlot,
  decideAccountSessionClaim,
  loadLiveAccountSessions,
  profileKeyFrom,
  readAccountSessionCap,
} from './account-session-concurrency.js'
import { countUnclosedForWorker as countWorkerSessions } from './occupancy-lease.js'
import { leaseWaitFacts, readSessionScheduling, type PlacementFacts } from './occupancy-read.js'
import { evaluateProfileAffinity, getSessionProfile } from './occupancy-profile.js'

export async function evaluateRunSessionEligibility(
  db: Db,
  input: {
    run: {
      id: string
      createdAt: Date
      targetId: string
      targetAccountId: string | null
      isolation?: 'SHARED' | 'DEDICATED' | null
      sessionPolicy?: unknown
    }
    workerId: string
    instanceId: string
    maxSessions: number
    scheduling: PlatformSessionScheduling
    roles?: readonly string[] | null
  },
): Promise<{ eligible: boolean; fallback: boolean; facts: PlacementFacts }> {
  const empty: PlacementFacts = {
    waitReason: null,
    occupyingRunId: null,
    occupyingOperationId: null,
    targetWorkerId: null,
    profileAffinityUntil: null,
  }
  if (!input.run.targetAccountId) return { eligible: true, fallback: false, facts: empty }
  const key = { targetId: input.run.targetId, targetAccountId: input.run.targetAccountId }
  const { lives, leases } = await loadLiveAccountSessions(db, key)
  const occupied = await countWorkerSessions(db, input.workerId)
  const { workers } = schemaFor(db)
  const [worker] = input.roles
    ? [{ roles: input.roles }]
    : await db.select({ roles: workers.roles }).from(workers).where(eq(workers.id, input.workerId)).limit(1)
  const claimerActorId = await resolveClaimerActorId(db, { kind: 'RUN', runId: input.run.id })
  const decision = await decideAccountSessionClaim(db, {
    key,
    lives,
    leases,
    holderWorkerId: input.workerId,
    holderInstanceId: input.instanceId,
    holderMaxSessions: input.maxSessions,
    holderOccupied: occupied,
    holderRoles: worker?.roles,
    purpose: 'EXECUTION',
    pickIdle: 'oldest',
    claimerActorId,
  })
  if (decision.action === 'reuse') {
    return { eligible: true, fallback: false, facts: empty }
  }
  if (decision.action === 'reject') {
    const lease = lives[0] ? leases.get(lives[0].id) : null
    const wait = lease ? leaseWaitFacts(lease) : null
    return {
      eligible: false,
      fallback: false,
      facts: {
        ...empty,
        ...(wait ?? {}),
        waitReason: decision.waitReason ?? wait?.waitReason ?? null,
        targetWorkerId: decision.waitReason === 'WORKER_SESSION_CAPACITY' ? input.workerId : null,
      },
    }
  }

  // SHARED 模式登录态在数据库，不做 Profile 亲和等待与位置转移（§4.5）
  const runWithPolicy = input.run as {
    id: string
    createdAt: Date
    targetId: string
    targetAccountId: string | null
    isolation?: 'SHARED' | 'DEDICATED' | null
    sessionPolicy?: unknown
  }
  let isShared: boolean | null = null
  if (runWithPolicy.isolation === 'SHARED') isShared = true
  else if (runWithPolicy.isolation === 'DEDICATED') isShared = false

  if (isShared === null && runWithPolicy.sessionPolicy && typeof runWithPolicy.sessionPolicy === 'object') {
    const sp = runWithPolicy.sessionPolicy as Record<string, unknown>
    if (sp.browserIsolation === 'SHARED') isShared = true
    else if (sp.browserIsolation === 'DEDICATED') isShared = false
  }

  if (isShared === null) {
    const { targets } = schemaFor(db)
    const [target] = await db
      .select({ sessionPolicy: targets.sessionPolicy })
      .from(targets)
      .where(eq(targets.id, input.run.targetId))
      .limit(1)
    if (
      target?.sessionPolicy &&
      (target.sessionPolicy as Record<string, unknown>).browserIsolation === 'SHARED'
    ) {
      isShared = true
    } else {
      isShared = false
    }
  }
  if (isShared) {
    return { eligible: true, fallback: false, facts: empty }
  }

  const affinity = await evaluateProfileAffinity(db, {
    key: profileKeyFrom(key, decision.accountSlot),
    workerId: input.workerId,
    since: input.run.createdAt,
    waitSeconds: input.scheduling.profileAffinityWaitSeconds,
  })
  if (affinity.kind === 'wait') {
    return {
      eligible: false,
      fallback: false,
      facts: {
        ...empty,
        waitReason: 'PROFILE_AFFINITY_WAIT',
        targetWorkerId: affinity.targetWorkerId,
        profileAffinityUntil: affinity.until.toISOString(),
      },
    }
  }
  return { eligible: true, fallback: affinity.kind === 'fallback', facts: empty }
}

export async function computeOccupancyPlacement(
  db: Db,
  run: {
    status: RunStatus
    createdAt: Date
    targetId: string
    targetAccountId: string | null
    hasActiveLease: boolean
  },
): Promise<RunPlacement> {
  const base = {
    sessionId: null as string | null,
    ownerWorkerId: null as string | null,
    sessionStatus: null as RunPlacement['sessionStatus'],
    waitReason: null as RunPlacement['waitReason'],
    occupyingRunId: null as string | null,
    occupyingOperationId: null as string | null,
    targetWorkerId: null as string | null,
    profileAffinityUntil: null as string | null,
    generation: null as number | null,
    acquireReason: null as RunPlacement['acquireReason'],
    profileFallback: null as boolean | null,
    manualControlActor: null as RunPlacement['manualControlActor'],
  }
  if (
    run.status === 'SUCCEEDED' ||
    run.status === 'FAILED' ||
    run.status === 'CANCELLED' ||
    run.status === 'NEEDS_REVIEW' ||
    run.status === 'WAITING_FOR_AUTH' ||
    !run.targetAccountId
  ) {
    return { state: 'not_applicable', ...base }
  }
  if (run.hasActiveLease) return { state: 'claimed', ...base }

  const key = { targetId: run.targetId, targetAccountId: run.targetAccountId }
  const { lives, leases } = await loadLiveAccountSessions(db, key)
  const cap = await readAccountSessionCap(db, key)
  const nowForControl = await clockNow(db)
  // 有人在手动操作的实例不算空闲：运行不能把他的浏览器领走。
  const localIdle = lives.find(
    (session) =>
      session.status === 'OPEN' &&
      session.health !== 'UNHEALTHY' &&
      !leases.has(session.id) &&
      !manualControlLive(session, nowForControl),
  )
  if (localIdle) {
    const withSession = {
      ...base,
      sessionId: localIdle.id,
      ownerWorkerId: localIdle.ownerWorkerId,
      sessionStatus: localIdle.status,
      generation: localIdle.generation,
    }
    const { workers, runLeases } = schemaFor(db)
    const [owner] = await db
      .select({ capacity: workers.capacity, status: workers.status })
      .from(workers)
      .where(eq(workers.id, localIdle.ownerWorkerId))
      .limit(1)
    if (owner?.status === 'READY') {
      const [held] = await db
        .select({ n: sql<number>`count(*)` })
        .from(runLeases)
        .where(
          and(
            eq(runLeases.holderWorkerId, localIdle.ownerWorkerId),
            eq(runLeases.status, 'ACTIVE'),
            sql`${runLeases.expiresAt} > ${databaseNow(db)}`,
          ),
        )
      if (Number(held?.n ?? 0) >= (owner.capacity ?? 0)) {
        return {
          state: 'owner_at_capacity',
          ...withSession,
          waitReason: 'WORKER_SESSION_CAPACITY',
          targetWorkerId: localIdle.ownerWorkerId,
        }
      }
    }
    return { state: 'owner_required', ...withSession }
  }

  const lost = lives.filter((row) => row.status === 'LOST')
  if (cap.effectiveCap === 1 && lost.length === 1) {
    const live = lost[0]!
    return {
      state: 'session_lost',
      ...base,
      sessionId: live.id,
      ownerWorkerId: live.ownerWorkerId,
      sessionStatus: live.status,
      generation: live.generation,
      waitReason: 'SESSION_LOST',
    }
  }
  if (lives.length >= cap.effectiveCap) {
    const allLost = lives.every((row) => row.status === 'LOST')
    const busy = lives.find((row) => leases.has(row.id))
    const lease = busy ? leases.get(busy.id) : null
    const wait = leaseWaitFacts(lease ?? null)
    const manual = lives.find((row) => !leases.has(row.id) && manualControlLive(row, nowForControl))
    if (!busy && manual && !allLost) {
      const actorId = manual.authControlActorId!
      return {
        state: 'owner_required',
        ...base,
        sessionId: manual.id,
        ownerWorkerId: manual.ownerWorkerId,
        sessionStatus: manual.status,
        generation: manual.generation,
        waitReason: cap.effectiveCap === 1 ? 'SESSION_IN_MANUAL_CONTROL' : 'SESSION_ACCOUNT_AT_CAPACITY',
        manualControlActor: { id: actorId, name: await accountDisplayName(db, actorId) },
      }
    }
    return {
      state: 'owner_required',
      ...base,
      sessionId: busy?.id ?? lives[0]?.id ?? null,
      ownerWorkerId: busy?.ownerWorkerId ?? lives[0]?.ownerWorkerId ?? null,
      sessionStatus: busy?.status ?? lives[0]?.status ?? null,
      generation: busy?.generation ?? lives[0]?.generation ?? null,
      waitReason: allLost
        ? 'SESSION_LOST'
        : cap.effectiveCap === 1
          ? wait?.waitReason ?? 'SESSION_IN_USE_BY_RUN'
          : 'SESSION_ACCOUNT_AT_CAPACITY',
      occupyingRunId: wait?.occupyingRunId ?? lease?.runId ?? null,
      occupyingOperationId: wait?.occupyingOperationId ?? lease?.operationId ?? null,
    }
  }

  let scheduling: PlatformSessionScheduling
  try {
    ;({ scheduling } = await readSessionScheduling(db))
  } catch {
    return { state: 'claimable', ...base, waitReason: 'NO_ELIGIBLE_WORKER' }
  }
  const nextSlot = assignMinFreeSlot(lives, cap.effectiveCap)
  if (nextSlot == null) {
    return {
      state: 'owner_required',
      ...base,
      waitReason: 'SESSION_ACCOUNT_AT_CAPACITY',
    }
  }
  const profile = await getSessionProfile(db, profileKeyFrom(key, nextSlot))
  if (profile?.state === 'PRESENT' && profile.locationWorkerId) {
    const { workers } = schemaFor(db)
    const [origin] = await db.select().from(workers).where(eq(workers.id, profile.locationWorkerId)).limit(1)
    if (origin?.status === 'READY') {
      const until = new Date(run.createdAt.getTime() + scheduling.profileAffinityWaitSeconds * 1000)
      const now = await clockNow(db)
      if (now.getTime() < until.getTime()) {
        return {
          state: 'owner_required',
          ...base,
          ownerWorkerId: profile.locationWorkerId,
          targetWorkerId: profile.locationWorkerId,
          waitReason: 'PROFILE_AFFINITY_WAIT',
          profileAffinityUntil: until.toISOString(),
        }
      }
    }
  }
  const { workers } = schemaFor(db)
  const ready = await db.select({ id: workers.id }).from(workers).where(eq(workers.status, 'READY')).limit(1)
  if (!ready.length) return { state: 'claimable', ...base, waitReason: 'NO_ELIGIBLE_WORKER' }
  return { state: 'claimable', ...base }
}
