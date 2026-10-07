import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import {
  canonicalJson,
  syncSha256,
  formatIncidentMemberRef,
  formatModuleIncidentGroupingKey,
  formatScenarioIncidentGroupingKey,
  formatAccountIncidentGroupingKey,
  normalizeErrorFamily,
  RELIABILITY_ERROR_CODES,
  type EvidenceScores,
  type IncidentSeverity,
  type IncidentStatus,
  type ReliabilityPolicyDto,
  type ReliabilitySignalDto,
  type ResolutionRungRecord,
  type RunSnapshot,
  DEFAULT_RELIABILITY_POLICY,
  isPageHealthResult,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { newId } from '../id.js'
import { atomic, clockNow, insertIgnoreRows, schemaFor } from '../native.js'
import { conflict } from '../runs/errors.js'
import { fetchPendingReliabilityReceipts, type PendingReceiptRow } from './receipts.js'

// 定位未命中/漂移白名单
const LOCATOR_DRIFT_WHITELIST = new Set([
  'TARGET_NOT_FOUND',
  'TARGET_AMBIGUOUS',
  'AI_NOT_FOUND',
  'AI_AMBIGUOUS_POINT',
])

// 排除项：不能作为漂移证据的原因码
const LOCATOR_DRIFT_EXCLUSIONS = new Set([
  'SKIPPED',
  'FRAME_UNSUPPORTED',
  'CEILING_CLOSED',
  'AI_DISABLED',
  'AI_CONFIG_INVALID',
  'WAIT_KIND_UNAVAILABLE',
  'CAPABILITY_MISSING',
  'CANCELLED',
  'LEASE_LOST',
  'SURFACE_LOST',
  'BUDGET_EXHAUSTED',
  'AI_HUNG',
  'AI_CALL_FAILED',
  'PERSISTENCE_FAILED',
  'CROSS_CHECK_FAILED',
  'CROSS_CHECK_NOT_APPLICABLE',
])

export interface EvaluateReliabilityBatchInput {
  workerId: string
  targetId: string
  fencingToken: number
  batchLimit?: number
  policy?: ReliabilityPolicyDto
}

export interface EvaluateReliabilityBatchResult {
  processed: boolean
  targetId: string
  receiptsCount: number
  signalsCount: number
  samplesCount: number
  incidentsCreated: number
  incidentsUpdated: number
  reconciledCount: number
}

function computeBasisDigest(stepType: string, implementationKey?: string | null): string {
  return syncSha256(canonicalJson({ type: stepType, impl: implementationKey ?? null })).slice(0, 32)
}

function computeEvidenceScoresForScope(
  anomalousRunsCount: number,
  counterEvidenceCount: number,
  hasBusinessRejection = false,
): EvidenceScores {
  let supportingScore = 0
  let counterScore = 0
  const supportingFactors: string[] = []
  const counterFactors: string[] = []

  if (anomalousRunsCount > 0) {
    const pts = Math.min(70, 20 + anomalousRunsCount * 10)
    supportingScore += pts
    supportingFactors.push(`收集到 ${anomalousRunsCount} 次独立 Run 同源异常事实`)
  }

  if (hasBusinessRejection) {
    counterScore += 40
    counterFactors.push('存在业务结果断言拒绝记录')
  }

  if (counterEvidenceCount > 0) {
    const pts = Math.min(50, counterEvidenceCount * 5)
    counterScore += pts
    counterFactors.push(`收集到 ${counterEvidenceCount} 次正常成功执行反例`)
  }

  return {
    supportingScore: Math.min(100, supportingScore),
    counterScore: Math.min(100, counterScore),
    supportingFactors,
    counterFactors,
  }
}

/**
 * 执行 v2 自动化维护评估批次（单事务原子提交/回滚）。
 */
export async function evaluateReliabilityBatch(
  db: Db,
  input: EvaluateReliabilityBatchInput,
): Promise<EvaluateReliabilityBatchResult> {
  return atomic(db, async (tx) => {
    const {
      reliabilityCheckpoints,
      reliabilityRunReceipts,
      reliabilityRunSamples,
      reliabilitySignals,
      featureWindows,
      baselineRevisions,
      reliabilityIncidents,
      reliabilityIncidentMembers,
      runs,
      runEvents,
      stepRuns,
      attempts,
      resolutionDecisions,
      outcomeResults,
    } = schemaFor(tx)

    const now = await clockNow(tx)
    const policy = input.policy ?? DEFAULT_RELIABILITY_POLICY
    const batchLimit = input.batchLimit ?? 50

    // 1. 严格校验目标租约与 fencing token
    const [checkpoint] = await tx
      .select()
      .from(reliabilityCheckpoints)
      .where(eq(reliabilityCheckpoints.targetId, input.targetId))
      .limit(1)

    if (
      !checkpoint ||
      Number(checkpoint.fencingToken) !== input.fencingToken ||
      checkpoint.leaseOwner !== input.workerId ||
      !checkpoint.leaseExpiresAt ||
      checkpoint.leaseExpiresAt.getTime() <= now.getTime()
    ) {
      throw conflict(RELIABILITY_ERROR_CODES.EVALUATION_LEASE_EXPIRED, '评估租约已失效、过期或被抢占')
    }

    // 2. 抓取该目标下 pending 的 receipts (按 finished_at, run_id 严格排序)
    const pendingReceipts = await fetchPendingReliabilityReceipts(tx, {
      targetId: input.targetId,
      ruleVersion: 2,
      limit: batchLimit,
    })

    // 3. 执行状态机 sweep 任务
    let reconciledCount = 0

    // a) v2 观察满 14 天且无新复发 -> 自动 RESOLVED
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 3600 * 1000)
    const observingIncidents = await tx
      .select()
      .from(reliabilityIncidents)
      .where(
        and(
          eq(reliabilityIncidents.targetId, input.targetId),
          eq(reliabilityIncidents.ruleVersion, 2),
          eq(reliabilityIncidents.status, 'OBSERVING'),
        ),
      )

    for (const inc of observingIncidents) {
      const start = inc.observingStartedAt ?? inc.lastSeenAt
      const last = inc.lastSeenAt
      const latestPoint = start.getTime() > last.getTime() ? start : last
      if (latestPoint.getTime() <= fourteenDaysAgo.getTime()) {
        await tx
          .update(reliabilityIncidents)
          .set({
            status: 'RESOLVED',
            dismissedReason: 'decayed_no_recurrence',
            closedAt: now,
            closedEvaluationOrdinal: Number(checkpoint.runEvaluationOrdinal),
            revision: inc.revision + 1,
            updatedAt: now,
          })
          .where(eq(reliabilityIncidents.id, inc.id))
        reconciledCount++
      }
    }

    // b) v1 存量事件 > 30 天未见 -> 自动 RESOLVED (legacy_rule_retired)
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 3600 * 1000)
    const legacyHanging = await tx
      .select()
      .from(reliabilityIncidents)
      .where(
        and(
          eq(reliabilityIncidents.targetId, input.targetId),
          eq(reliabilityIncidents.ruleVersion, 1),
          lte(reliabilityIncidents.lastSeenAt, thirtyDaysAgo),
        ),
      )

    for (const inc of legacyHanging) {
      if (inc.status !== 'RESOLVED' && inc.status !== 'DISMISSED') {
        await tx
          .update(reliabilityIncidents)
          .set({
            status: 'RESOLVED',
            dismissedReason: 'legacy_rule_retired',
            closedAt: now,
            revision: inc.revision + 1,
            updatedAt: now,
          })
          .where(eq(reliabilityIncidents.id, inc.id))
        reconciledCount++
      }
    }

    if (pendingReceipts.length === 0) {
      // 无回执也完成了 sweep；释放租约避免目标空占 60s
      await tx
        .update(reliabilityCheckpoints)
        .set({ leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
        .where(eq(reliabilityCheckpoints.targetId, input.targetId))
      return {
        processed: false,
        targetId: input.targetId,
        receiptsCount: 0,
        signalsCount: 0,
        samplesCount: 0,
        incidentsCreated: 0,
        incidentsUpdated: 0,
        reconciledCount,
      }
    }

    // 4. 批量加载该批次 Run 的完整执行事实
    const runIds = pendingReceipts.map((r) => r.runId)

    const runRows = await tx.select().from(runs).where(inArray(runs.id, runIds))
    const runMap = new Map(runRows.map((r) => [r.id, r]))

    const authEvents = await tx
      .select()
      .from(runEvents)
      .where(and(inArray(runEvents.runId, runIds), eq(runEvents.type, 'run.auth_unrecoverable')))

    const authEventsByRun = new Map<string, typeof authEvents>()
    for (const evt of authEvents) {
      const list = authEventsByRun.get(evt.runId) ?? []
      list.push(evt)
      authEventsByRun.set(evt.runId, list)
    }

    const stepRunRows = await tx.select().from(stepRuns).where(inArray(stepRuns.runId, runIds))
    const stepRunsByRun = new Map<string, typeof stepRunRows>()
    const stepRunIds: string[] = []
    for (const sr of stepRunRows) {
      stepRunIds.push(sr.id)
      const list = stepRunsByRun.get(sr.runId) ?? []
      list.push(sr)
      stepRunsByRun.set(sr.runId, list)
    }

    const attemptRows = stepRunIds.length > 0
      ? await tx
          .select()
          .from(attempts)
          .where(inArray(attempts.stepRunId, stepRunIds))
          .orderBy(asc(attempts.attemptNo))
      : []

    const attemptsByStepRun = new Map<string, typeof attemptRows>()
    const attemptIds: string[] = []
    for (const att of attemptRows) {
      attemptIds.push(att.id)
      const list = attemptsByStepRun.get(att.stepRunId) ?? []
      list.push(att)
      attemptsByStepRun.set(att.stepRunId, list)
    }

    const decisionRows = attemptIds.length > 0
      ? await tx.select().from(resolutionDecisions).where(inArray(resolutionDecisions.attemptId, attemptIds))
      : []
    const decisionByAttempt = new Map(decisionRows.map((d) => [d.attemptId, d]))

    const outcomeRows = attemptIds.length > 0
      ? await tx.select().from(outcomeResults).where(inArray(outcomeResults.attemptId, attemptIds))
      : []
    const outcomesByAttempt = new Map<string, typeof outcomeRows>()
    for (const o of outcomeRows) {
      const list = outcomesByAttempt.get(o.attemptId) ?? []
      list.push(o)
      outcomesByAttempt.set(o.attemptId, list)
    }

    // 5. 依次消费每一条 Receipt
    let currentOrdinal = Number(checkpoint.runEvaluationOrdinal)
    let totalSignals = 0
    let totalSamples = 0
    let totalIncidentsCreated = 0
    let totalIncidentsUpdated = 0

    for (const receipt of pendingReceipts) {
      const run = runMap.get(receipt.runId)
      if (!run) continue

      currentOrdinal += 1
      const receiptOrdinal = currentOrdinal

      const thisRunSteps = stepRunsByRun.get(run.id) ?? []
      const thisAuthEvents = authEventsByRun.get(run.id) ?? []

      // 收集本次 Run 实际执行过的步骤与作用域
      type GeneratedSignal = {
        kind: ReliabilitySignalDto['kind']
        severity: 'INFO' | 'WARN' | 'ERROR'
        subjectRef: Record<string, unknown>
        sourceRef: Record<string, unknown>
        sourceKind: string
        sourceId: string
        errorFamily: string
        occurredAt: Date
        scopeDigest: string
        groupingKey: string
        metadata?: Record<string, unknown>
      }

      const generatedSignals: GeneratedSignal[] = []

      // a) 账号故障 session_fault: 每 Run 至多 1 条
      if (thisAuthEvents.length > 0) {
        const firstEvt = thisAuthEvents[0]!
        const payload = (firstEvt.payload ?? {}) as Record<string, unknown>
        const errorFamily = normalizeErrorFamily('session_fault', payload.errorCode ?? payload.code ?? 'SESSION_AUTH_UNRECOVERABLE')
        const accountId = run.targetAccountId ?? null
        const groupingKey = formatAccountIncidentGroupingKey({ targetId: input.targetId, accountId: accountId ?? null })
        const scopeDigest = `target:${input.targetId}:account:${accountId ?? 'NONE'}`

        generatedSignals.push({
          kind: 'session_fault',
          severity: 'ERROR',
          subjectRef: { kind: 'run', id: run.id, accountId },
          sourceRef: { kind: 'run', runId: run.id, eventIds: thisAuthEvents.map((e) => e.eventId) },
          sourceKind: 'run',
          sourceId: run.id,
          errorFamily,
          occurredAt: firstEvt.occurredAt,
          scopeDigest,
          groupingKey,
          metadata: { accountId, eventsCount: thisAuthEvents.length },
        })
      }

      // b) 步骤级信号判定
      // 聚合相同作用域的 StepRun，确保一 Run 一票
      type ExecutedStepScope = {
        scopeDigest: string
        scopeKind: 'scenario_step' | 'module_step'
        stepId: string
        scenarioId?: string
        moduleId?: string
        implementationKey?: string
        internalStepId?: string
        stepName: string
        hasSuccess: boolean
        hasFailure: boolean
        hasCancel: boolean
        isComparable: boolean
        durationMs?: number
        basisDigest: string
        stepRunIds: string[]
        attemptIds: string[]
        hasBusinessRejection: boolean
        lastOccurredAt: Date
      }

      const executedStepScopes = new Map<string, ExecutedStepScope>()

      for (const sr of thisRunSteps) {
        const isModule = Boolean(sr.moduleId && sr.implementationKey && sr.internalStepId)
        const scopeKind = isModule ? ('module_step' as const) : ('scenario_step' as const)
        const scopeDigest = isModule
          ? `target:${input.targetId}:module:${sr.moduleId}:impl:${sr.implementationKey}:step:${sr.internalStepId}`
          : `target:${input.targetId}:scene:${run.scenarioId}:step:${sr.stepId}`

        const attList = attemptsByStepRun.get(sr.id) ?? []
        const hasRetry = attList.length > 1
        const lastAtt = attList.length > 0 ? attList[attList.length - 1]! : null

        let hasBusinessRejection = false
        for (const att of attList) {
          const ots = outcomesByAttempt.get(att.id) ?? []
          // 页面健康警告不是业务拒绝，不能压掉执行失败事件。
          if (ots.some((o) => o.verdict === 'FAIL' && !isPageHealthResult(o))) {
            hasBusinessRejection = true
            break
          }
        }

        // 1. step_retried 判定
        if (hasRetry && lastAtt) {
          const groupingKey = isModule
            ? formatModuleIncidentGroupingKey({
                targetId: input.targetId,
                moduleId: sr.moduleId!,
                implementationKey: sr.implementationKey!,
                internalStepId: sr.internalStepId!,
                signalKind: 'step_retried',
                errorFamily: 'NONE',
              })
            : formatScenarioIncidentGroupingKey({
                targetId: input.targetId,
                scenarioId: run.scenarioId,
                stepId: sr.stepId,
                signalKind: 'step_retried',
                errorFamily: 'NONE',
              })

          generatedSignals.push({
            kind: 'step_retried',
            severity: 'INFO',
            subjectRef: isModule
              ? { kind: 'module_step', id: sr.stepId, moduleId: sr.moduleId, implementationKey: sr.implementationKey, internalStepId: sr.internalStepId }
              : { kind: 'scenario_step', id: sr.stepId, scenarioId: run.scenarioId, stepId: sr.stepId },
            sourceRef: { kind: 'step_run', runId: run.id, stepRunId: sr.id, attemptsCount: attList.length },
            sourceKind: 'step_run',
            sourceId: sr.id,
            errorFamily: 'NONE',
            occurredAt: lastAtt.finishedAt ?? sr.finishedAt ?? now,
            scopeDigest,
            groupingKey,
          })
        }

        // 2. step_failed 判定
        // 条件：StepRun 最终状态为 FAILED，且无后续成功；不转译取消或业务断言失败
        const isExecutionFailed =
          sr.status === 'FAILED' ||
          (lastAtt !== null && lastAtt.status === 'FAILED' && !attList.some((a) => a.status === 'SUCCEEDED'))

        if (isExecutionFailed && !hasBusinessRejection && run.status !== 'CANCELLED') {
          const errObj = lastAtt?.error as Record<string, unknown> | null
          const errorFamily = normalizeErrorFamily('step_failed', errObj)
          const groupingKey = isModule
            ? formatModuleIncidentGroupingKey({
                targetId: input.targetId,
                moduleId: sr.moduleId!,
                implementationKey: sr.implementationKey!,
                internalStepId: sr.internalStepId!,
                signalKind: 'step_failed',
                errorFamily,
              })
            : formatScenarioIncidentGroupingKey({
                targetId: input.targetId,
                scenarioId: run.scenarioId,
                stepId: sr.stepId,
                signalKind: 'step_failed',
                errorFamily,
              })

          generatedSignals.push({
            kind: 'step_failed',
            severity: 'ERROR',
            subjectRef: isModule
              ? { kind: 'module_step', id: sr.stepId, moduleId: sr.moduleId, implementationKey: sr.implementationKey, internalStepId: sr.internalStepId }
              : { kind: 'scenario_step', id: sr.stepId, scenarioId: run.scenarioId, stepId: sr.stepId },
            sourceRef: lastAtt
              ? { kind: 'attempt', runId: run.id, stepRunId: sr.id, attemptId: lastAtt.id }
              : { kind: 'step_run', runId: run.id, stepRunId: sr.id },
            sourceKind: lastAtt ? 'attempt' : 'step_run',
            sourceId: lastAtt?.id ?? sr.id,
            errorFamily,
            occurredAt: lastAtt?.finishedAt ?? sr.finishedAt ?? now,
            scopeDigest,
            groupingKey,
          })
        }

        // 3. 定位决策：locator_fallback 与 locator_drift_suspected
        for (let i = 0; i < attList.length; i++) {
          const att = attList[i]!
          const decision = decisionByAttempt.get(att.id)
          if (!decision) continue

          const rungs = (decision.rungsJson ?? []) as ResolutionRungRecord[]
          const executedRungs = rungs.filter((r) => r.outcome !== 'SKIPPED')

          // locator_fallback: 先前真实执行路线有 miss/ambiguous，后续备用路线记录 FOUND
          let hadEarlierMiss = false
          let hasFallbackHit = false
          for (let rIdx = 0; rIdx < executedRungs.length; rIdx++) {
            const r = executedRungs[rIdx]!
            if (r.outcome === 'FOUND') {
              if (hadEarlierMiss) {
                hasFallbackHit = true
              }
              break
            } else if (
              r.outcomeClass === 'miss' ||
              r.outcomeClass === 'ambiguous' ||
              LOCATOR_DRIFT_WHITELIST.has(r.outcome)
            ) {
              hadEarlierMiss = true
            }
          }

          if (hasFallbackHit) {
            const groupingKey = isModule
              ? formatModuleIncidentGroupingKey({
                  targetId: input.targetId,
                  moduleId: sr.moduleId!,
                  implementationKey: sr.implementationKey!,
                  internalStepId: sr.internalStepId!,
                  signalKind: 'locator_fallback',
                  errorFamily: 'NONE',
                })
              : formatScenarioIncidentGroupingKey({
                  targetId: input.targetId,
                  scenarioId: run.scenarioId,
                  stepId: sr.stepId,
                  signalKind: 'locator_fallback',
                  errorFamily: 'NONE',
                })

            generatedSignals.push({
              kind: 'locator_fallback',
              severity: 'WARN',
              subjectRef: isModule
                ? { kind: 'module_step', id: sr.stepId, moduleId: sr.moduleId, implementationKey: sr.implementationKey, internalStepId: sr.internalStepId }
                : { kind: 'scenario_step', id: sr.stepId, scenarioId: run.scenarioId, stepId: sr.stepId },
              sourceRef: { kind: 'attempt', runId: run.id, stepRunId: sr.id, attemptId: att.id, decisionId: decision.id },
              sourceKind: 'attempt',
              sourceId: att.id,
              errorFamily: 'NONE',
              occurredAt: att.finishedAt ?? now,
              scopeDigest,
              groupingKey,
            })
          }

          // locator_drift_suspected:
          // 仅对该 StepRun 的最终有效 Attempt 判定；
          // 决策失败，属于白名单，无排除项，且无业务拒绝
          const isFinalAttempt = i === attList.length - 1
          if (
            isFinalAttempt &&
            decision.decisionKind === 'failed' &&
            decision.reasonCode &&
            LOCATOR_DRIFT_WHITELIST.has(decision.reasonCode) &&
            !LOCATOR_DRIFT_EXCLUSIONS.has(decision.reasonCode) &&
            !hasBusinessRejection
          ) {
            const errorFamily = normalizeErrorFamily('locator_drift_suspected', undefined, decision.reasonCode)
            const groupingKey = isModule
              ? formatModuleIncidentGroupingKey({
                  targetId: input.targetId,
                  moduleId: sr.moduleId!,
                  implementationKey: sr.implementationKey!,
                  internalStepId: sr.internalStepId!,
                  signalKind: 'locator_drift_suspected',
                  errorFamily,
                })
              : formatScenarioIncidentGroupingKey({
                  targetId: input.targetId,
                  scenarioId: run.scenarioId,
                  stepId: sr.stepId,
                  signalKind: 'locator_drift_suspected',
                  errorFamily,
                })

            generatedSignals.push({
              kind: 'locator_drift_suspected',
              severity: 'WARN',
              subjectRef: isModule
                ? { kind: 'module_step', id: sr.stepId, moduleId: sr.moduleId, implementationKey: sr.implementationKey, internalStepId: sr.internalStepId }
                : { kind: 'scenario_step', id: sr.stepId, scenarioId: run.scenarioId, stepId: sr.stepId },
              sourceRef: { kind: 'attempt', runId: run.id, stepRunId: sr.id, attemptId: att.id, decisionId: decision.id },
              sourceKind: 'attempt',
              sourceId: att.id,
              errorFamily,
              occurredAt: att.finishedAt ?? now,
              scopeDigest,
              groupingKey,
            })
          }
        }

        // 计算耗时与可比较性
        let durationMs: number | undefined
        if (sr.startedAt && sr.finishedAt) {
          let totalAttemptMs = 0
          let hasValidAttempts = false
          for (const a of attList) {
            if (a.startedAt && a.finishedAt) {
              totalAttemptMs += a.finishedAt.getTime() - a.startedAt.getTime()
              hasValidAttempts = true
            }
          }
          durationMs = hasValidAttempts ? totalAttemptMs : sr.finishedAt.getTime() - sr.startedAt.getTime()
        }

        const isComparable = sr.status === 'SUCCEEDED' && durationMs !== undefined && durationMs >= 0
        const basisDigest = computeBasisDigest(sr.name ?? 'action', sr.implementationKey)

        const existingScope = executedStepScopes.get(scopeDigest)
        if (!existingScope) {
          executedStepScopes.set(scopeDigest, {
            scopeDigest,
            scopeKind,
            stepId: sr.stepId,
            scenarioId: run.scenarioId,
            moduleId: sr.moduleId ?? undefined,
            implementationKey: sr.implementationKey ?? undefined,
            internalStepId: sr.internalStepId ?? undefined,
            stepName: sr.name ?? 'step',
            hasSuccess: sr.status === 'SUCCEEDED',
            hasFailure: isExecutionFailed,
            hasCancel: sr.status === 'CANCELLED',
            isComparable,
            durationMs,
            basisDigest,
            stepRunIds: [sr.id],
            attemptIds: attList.map((a) => a.id),
            hasBusinessRejection,
            lastOccurredAt: lastAtt?.finishedAt ?? sr.finishedAt ?? now,
          })
        } else {
          existingScope.hasSuccess = existingScope.hasSuccess || sr.status === 'SUCCEEDED'
          existingScope.hasFailure = existingScope.hasFailure || isExecutionFailed
          existingScope.hasCancel = existingScope.hasCancel || sr.status === 'CANCELLED'
          existingScope.stepRunIds.push(sr.id)
          existingScope.attemptIds.push(...attList.map((a) => a.id))
          if (durationMs !== undefined) {
            existingScope.durationMs = existingScope.durationMs !== undefined
              ? (existingScope.durationMs + durationMs) / 2
              : durationMs
          }
          if (lastAtt?.finishedAt && lastAtt.finishedAt > existingScope.lastOccurredAt) {
            existingScope.lastOccurredAt = lastAtt.finishedAt
          }
        }
      }

      // c) 耗时基线比较与 latency_regression 判定 (§3.4)
      for (const [scopeDigest, scopeData] of executedStepScopes) {
        if (!scopeData.isComparable || scopeData.durationMs === undefined) continue

        const [latestRevision] = await tx
          .select()
          .from(baselineRevisions)
          .where(
            and(
              eq(baselineRevisions.targetId, input.targetId),
              eq(baselineRevisions.scopeDigest, scopeDigest),
              eq(baselineRevisions.baselineKind, 'behavioral'),
            ),
          )
          // 同一事务可能创建多版基线（createdAt 相同），以单调递增的评估序号决胜
          .orderBy(desc(baselineRevisions.revisionOrdinal), desc(baselineRevisions.createdAt))
          .limit(1)

        const revStats = (latestRevision?.stats ?? {}) as Record<string, any>
        const isClean =
          scopeData.hasSuccess &&
          !scopeData.hasFailure &&
          !generatedSignals.some((s) => s.scopeDigest === scopeDigest)

        if (!latestRevision || latestRevision.status === 'insufficient') {
          // 冷启动积累
          if (isClean) {
            const cleanSamples: string[] = revStats.trainingRunIds ?? []
            cleanSamples.push(run.id)

            if (cleanSamples.length < 10) {
              // 尚不足 10 条
              const updatedStats = {
                ...revStats,
                basisDigest: scopeData.basisDigest,
                cleanSampleCount: cleanSamples.length,
                trainingRunIds: cleanSamples,
              }
              if (latestRevision) {
                await tx
                  .update(baselineRevisions)
                  .set({ stats: updatedStats })
                  .where(eq(baselineRevisions.id, latestRevision.id))
              } else {
                await tx.insert(baselineRevisions).values({
                  id: newId(),
                  targetId: input.targetId,
                  scopeDigest,
                  baselineKind: 'behavioral',
                  algorithmVersion: '1.0',
                  sampleFloor: 10,
                  revisionOrdinal: receiptOrdinal,
                  stats: updatedStats,
                  status: 'insufficient',
                  createdAt: now,
                })
              }
            } else if (cleanSamples.length === 10) {
              // 达到第 10 条：计算初版 EWMA (以首条为初值)，发布第一版 ready 基线
              // 仅从下一个样本开始用于检测，本次不拿自己检测自己
              const baselineValue = scopeData.durationMs
              await tx.insert(baselineRevisions).values({
                id: newId(),
                targetId: input.targetId,
                scopeDigest,
                baselineKind: 'behavioral',
                algorithmVersion: '1.0',
                sampleFloor: 10,
                revisionOrdinal: receiptOrdinal,
                stats: {
                  basisDigest: scopeData.basisDigest,
                  baselineLatencyMs: baselineValue,
                  observedEwmaMs: baselineValue,
                  cleanSampleCount: 10,
                  consecutiveCleanSinceRevision: 0,
                  isFrozen: false,
                  trainingRunIds: cleanSamples,
                },
                status: 'ready',
                createdAt: now,
              })
            }
          }
        } else if (latestRevision.status === 'ready') {
          // 已有 ready 基线 B：先检测，后学习
          const B = Number(revStats.baselineLatencyMs ?? 0)
          const prevE = Number(revStats.observedEwmaMs ?? B)
          const x_n = scopeData.durationMs
          const E_n = 0.2 * x_n + 0.8 * prevE

          const threshold = B * 1.5
          const isLatencyBreach = E_n > threshold

          if (isLatencyBreach) {
            const groupingKey = scopeData.scopeKind === 'module_step'
              ? formatModuleIncidentGroupingKey({
                  targetId: input.targetId,
                  moduleId: scopeData.moduleId!,
                  implementationKey: scopeData.implementationKey!,
                  internalStepId: scopeData.internalStepId!,
                  signalKind: 'latency_regression',
                  errorFamily: 'NONE',
                })
              : formatScenarioIncidentGroupingKey({
                  targetId: input.targetId,
                  scenarioId: scopeData.scenarioId!,
                  stepId: scopeData.stepId,
                  signalKind: 'latency_regression',
                  errorFamily: 'NONE',
                })

            generatedSignals.push({
              kind: 'latency_regression',
              severity: 'WARN',
              subjectRef: scopeData.scopeKind === 'module_step'
                ? { kind: 'module_step', id: scopeData.stepId, moduleId: scopeData.moduleId, implementationKey: scopeData.implementationKey, internalStepId: scopeData.internalStepId }
                : { kind: 'scenario_step', id: scopeData.stepId, scenarioId: scopeData.scenarioId, stepId: scopeData.stepId },
              sourceRef: { kind: 'window_sample', runId: run.id, sampleOrdinal: receiptOrdinal },
              sourceKind: 'run',
              sourceId: run.id,
              errorFamily: 'NONE',
              occurredAt: scopeData.lastOccurredAt,
              scopeDigest,
              groupingKey,
              metadata: {
                baselineRevisionId: latestRevision.id,
                baselineLatencyMs: B,
                observedLatencyMs: x_n,
                observedEwmaMs: E_n,
                threshold,
              },
            })
          }

          // 学习冻结控制：首次 x_n > 1.5*B 或 E_n > 1.5*B 即冻结
          let isFrozen = revStats.isFrozen ?? false
          if (x_n > threshold || E_n > threshold) {
            isFrozen = true
          }

          let consecutiveClean = revStats.consecutiveCleanSinceRevision ?? 0
          if (isClean && !isFrozen) {
            consecutiveClean += 1
            if (consecutiveClean >= 30) {
              // 连续 30 次健康，发布新基线修订
              await tx.insert(baselineRevisions).values({
                id: newId(),
                targetId: input.targetId,
                scopeDigest,
                baselineKind: 'behavioral',
                algorithmVersion: '1.0',
                sampleFloor: 10,
                revisionOrdinal: receiptOrdinal,
                stats: {
                  basisDigest: scopeData.basisDigest,
                  baselineLatencyMs: E_n,
                  observedEwmaMs: E_n,
                  cleanSampleCount: 30,
                  consecutiveCleanSinceRevision: 0,
                  isFrozen: false,
                  trainingRunIds: [run.id],
                },
                status: 'ready',
                createdAt: now,
              })
              consecutiveClean = 0
            }
          }

          await tx
            .update(baselineRevisions)
            .set({
              stats: {
                ...revStats,
                observedEwmaMs: E_n,
                isFrozen,
                consecutiveCleanSinceRevision: consecutiveClean,
              },
            })
            .where(eq(baselineRevisions.id, latestRevision.id))
        }
      }

      // d) 写入信号到 reliability_signals
      for (const sig of generatedSignals) {
        await insertIgnoreRows(tx as unknown as Db, reliabilitySignals, {
          id: newId(),
          targetId: input.targetId,
          kind: sig.kind,
          severity: sig.severity,
          subjectRef: sig.subjectRef,
          sourceRef: sig.sourceRef,
          sourceKind: sig.sourceKind,
          sourceId: sig.sourceId,
          errorFamily: sig.errorFamily,
          occurredAt: sig.occurredAt,
          scopeDigest: sig.scopeDigest,
          groupingKey: sig.groupingKey,
          metadata: sig.metadata ?? {},
          createdAt: now,
        })
        totalSignals++
      }

      // e) 写入可靠性样本到 reliability_run_samples
      // 1. 写入步骤域样本
      for (const [scopeDigest, scopeData] of executedStepScopes) {
        const scopeSignals = generatedSignals
          .filter((s) => s.scopeDigest === scopeDigest)
          .map((s) => ({ kind: s.kind, errorFamily: s.errorFamily, severity: s.severity }))

        const executionConclusion = scopeData.hasFailure
          ? 'FAILED'
          : scopeData.hasSuccess
          ? 'SUCCEEDED'
          : scopeData.hasCancel
          ? 'CANCELLED'
          : 'UNKNOWN'

        await insertIgnoreRows(tx as unknown as Db, reliabilityRunSamples, {
          id: newId(),
          ruleVersion: 2,
          targetId: input.targetId,
          runId: run.id,
          scopeDigest,
          scopeKind: scopeData.scopeKind,
          evaluationOrdinal: receiptOrdinal,
          executionConclusion,
          signals: scopeSignals,
          isComparable: scopeData.isComparable,
          durationMs: scopeData.durationMs ?? null,
          sourceRef: {
            runId: run.id,
            stepRunIds: scopeData.stepRunIds,
            attemptIds: scopeData.attemptIds,
          },
          comparisons: {},
          assetKind: scopeData.scopeKind === 'module_step' ? 'action_module' : 'scenario',
          assetId: scopeData.scopeKind === 'module_step' ? scopeData.moduleId : scopeData.scenarioId,
          moduleId: scopeData.moduleId ?? null,
          implementationKey: scopeData.implementationKey ?? null,
          stepId: scopeData.stepId,
          internalStepId: scopeData.internalStepId ?? null,
          occurredAt: scopeData.lastOccurredAt,
          createdAt: now,
        })

        totalSamples++
      }

      // 2. 写入账号域样本 (若有 targetAccountId)
      if (run.targetAccountId) {
        const accountScopeDigest = `target:${input.targetId}:account:${run.targetAccountId}`
        const accountSignals = generatedSignals
          .filter((s) => s.scopeDigest === accountScopeDigest)
          .map((s) => ({ kind: s.kind, errorFamily: s.errorFamily, severity: s.severity }))

        const hasAccountFault = accountSignals.length > 0
        const executionConclusion = hasAccountFault ? 'FAILED' : run.status === 'SUCCEEDED' ? 'SUCCEEDED' : run.status

        await insertIgnoreRows(tx as unknown as Db, reliabilityRunSamples, {
          id: newId(),
          ruleVersion: 2,
          targetId: input.targetId,
          runId: run.id,
          scopeDigest: accountScopeDigest,
          scopeKind: 'account',
          evaluationOrdinal: receiptOrdinal,
          executionConclusion,
          signals: accountSignals,
          isComparable: true,
          sourceRef: { runId: run.id },
          accountId: run.targetAccountId,
          occurredAt: receipt.finishedAt,
          createdAt: now,
        })

        totalSamples++
      }

      // 3. 写入场景资产样本
      const scenarioScopeDigest = `target:${input.targetId}:scenario:${run.scenarioId}`
      await insertIgnoreRows(tx as unknown as Db, reliabilityRunSamples, {
        id: newId(),
        ruleVersion: 2,
        targetId: input.targetId,
        runId: run.id,
        scopeDigest: scenarioScopeDigest,
        scopeKind: 'scenario',
        evaluationOrdinal: receiptOrdinal,
        executionConclusion: run.status,
        signals: [],
        isComparable: run.status === 'SUCCEEDED' || run.status === 'FAILED',
        durationMs: run.startedAt && run.finishedAt ? run.finishedAt.getTime() - run.startedAt.getTime() : null,
        sourceRef: { runId: run.id },
        assetKind: 'scenario',
        assetId: run.scenarioId,
        occurredAt: receipt.finishedAt,
        createdAt: now,
      })

      // f) 健康重评与事件生命周期状态迁移 (§3.2)
      // 收集本次执行的所有需重评的基础作用域 (步骤域 + 账号域)
      const scopesToEvaluate = new Set<string>()
      for (const [scopeDigest] of executedStepScopes) {
        scopesToEvaluate.add(scopeDigest)
      }
      if (run.targetAccountId) {
        scopesToEvaluate.add(`target:${input.targetId}:account:${run.targetAccountId}`)
      }

      for (const scopeDigest of scopesToEvaluate) {
        // 读取本作用域最近 30 个独立有效 Run 样本
        const recentSamples = await tx
          .select()
          .from(reliabilityRunSamples)
          .where(
            and(
              eq(reliabilityRunSamples.targetId, input.targetId),
              eq(reliabilityRunSamples.scopeDigest, scopeDigest),
              eq(reliabilityRunSamples.ruleVersion, 2),
            ),
          )
          .orderBy(desc(reliabilityRunSamples.evaluationOrdinal))
          .limit(30)

        if (recentSamples.length === 0) continue

        // 收集该作用域下需要评估的 groupingKeys：
        // 包括当前已有活跃事件的 groupingKey 以及本次新信号的 groupingKey
        const activeIncidents = await tx
          .select()
          .from(reliabilityIncidents)
          .where(
            and(
              eq(reliabilityIncidents.targetId, input.targetId),
              eq(reliabilityIncidents.scopeDigest, scopeDigest),
              eq(reliabilityIncidents.ruleVersion, 2),
              inArray(reliabilityIncidents.status, ['DETECTED', 'DIAGNOSING', 'ACTION_REQUIRED', 'VERIFYING', 'OBSERVING']),
            ),
          )

        const activeIncidentByKey = new Map(activeIncidents.map((inc) => [inc.groupingKey, inc]))
        const groupingKeysToCheck = new Set<string>(activeIncidents.map((inc) => inc.groupingKey))

        for (const sig of generatedSignals) {
          if (sig.scopeDigest === scopeDigest) {
            groupingKeysToCheck.add(sig.groupingKey)
          }
        }

        // 针对每个 groupingKey 评估窗口健康度
        for (const groupingKey of groupingKeysToCheck) {
          const isSessionFault = groupingKey.includes('kind:session_fault')
          const existingIncident = activeIncidentByKey.get(groupingKey)

          // 提取该分组 key 的 signalKind 和 errorFamily
          let targetKind = 'step_failed'
          let targetErrorFamily = 'NONE'
          if (isSessionFault) {
            targetKind = 'session_fault'
            targetErrorFamily = 'NONE'
          } else {
            const kindMatch = groupingKey.match(/kind:([a-z_]+)/)
            const errMatch = groupingKey.match(/err:([A-Za-z0-9_]+)/)
            if (kindMatch) targetKind = kindMatch[1]!
            if (errMatch) targetErrorFamily = errMatch[1]!
          }

          // 统计窗口中每个 Run 是否存在同类异常
          // Run 去重：同一 Run 只算一次
          let anomalousRunsCount = 0
          let counterEvidenceCount = 0
          let consecutiveHealthy = 0
          let consecutiveAnomalous = 0
          let countingConsecutive = true
          let countingAnomalousConsecutive = true

          const supportingRunIds: string[] = []

          for (const s of recentSamples) {
            const sampleSignals = (s.signals ?? []) as Array<{ kind: string; errorFamily: string }>
            const hasThisAnomaly = sampleSignals.some(
              (sig) => sig.kind === targetKind && (isSessionFault || sig.errorFamily === targetErrorFamily),
            )

            if (hasThisAnomaly) {
              anomalousRunsCount++
              supportingRunIds.push(s.runId)
              countingConsecutive = false
              if (countingAnomalousConsecutive) {
                consecutiveAnomalous++
              }
            } else {
              countingAnomalousConsecutive = false
              if (countingConsecutive) {
                consecutiveHealthy++
              }
              if (s.executionConclusion === 'SUCCEEDED') {
                counterEvidenceCount++
              }
            }
          }

          const totalEffectiveRuns = recentSamples.length
          const failureRate = totalEffectiveRuns > 0 ? anomalousRunsCount / totalEffectiveRuns : 0
          const evidenceScores = computeEvidenceScoresForScope(anomalousRunsCount, counterEvidenceCount)

          // 1. 新建事件判定 (§3.2: 最新连续 3 个 Run 异常 OR (样本数 >= 10 且异常率 > 15%))
          // session_fault 例外：即时单次 P2
          const meetsCreationThreshold =
            isSessionFault
              ? anomalousRunsCount > 0
              : consecutiveAnomalous >= 3 || (totalEffectiveRuns >= 10 && failureRate > 0.15)

          if (!existingIncident) {
            if (meetsCreationThreshold) {
              const incidentId = newId()
              const severity: IncidentSeverity = isSessionFault ? 'P2' : 'P3'
              const status: IncidentStatus = 'ACTION_REQUIRED'

              let title = `[稳定性异常] ${scopeDigest}`
              let summary = `检测到同源异常频发 (${targetKind})`
              if (targetKind === 'step_failed') {
                title = `步骤执行失败 (错误族: ${targetErrorFamily})`
                summary = `基础作用域近期出现步骤执行失败`
              } else if (targetKind === 'step_retried') {
                title = `步骤重试频繁`
                summary = `基础作用域近期步骤出现重试`
              } else if (targetKind === 'locator_fallback') {
                title = `定位使用备用路线`
                summary = `首选定位未命中，频繁触发备用定位回退`
              } else if (targetKind === 'locator_drift_suspected') {
                title = `疑似定位漂移`
                summary = `定位决策失败且未命中，疑似结构漂移`
              } else if (targetKind === 'latency_regression') {
                title = `执行耗时异常上升`
                summary = `平滑执行耗时超过基线 1.5 倍`
              } else if (targetKind === 'session_fault') {
                title = `会话凭据不可恢复故障`
                summary = `运行出现认证凭据不可恢复故障`
              }

              // 查找匹配的 asset 属性
              const firstSample = recentSamples[0]!
              await tx.insert(reliabilityIncidents).values({
                id: incidentId,
                targetId: input.targetId,
                groupingKey,
                scopeDigest,
                severity,
                status,
                actionRequiredReason: 'threshold_breached',
                memberCount: supportingRunIds.length,
                firstSeenAt: now,
                lastSeenAt: now,
                title,
                summary,
                evidenceScores,
                ruleVersion: 2,
                assetKind: (firstSample.assetKind as 'scenario' | 'action_module' | null) ?? null,
                assetId: firstSample.assetId ?? null,
                stepId: firstSample.stepId ?? null,
                implementationKey: firstSample.implementationKey ?? null,
                accountId: firstSample.accountId ?? null,
                revision: 1,
                createdAt: now,
                updatedAt: now,
              })

              // 添加窗口内全部支持成员
              for (const supRunId of supportingRunIds) {
                const memberRef = formatIncidentMemberRef({ runId: supRunId })
                await insertIgnoreRows(tx, reliabilityIncidentMembers, [
                  {
                    id: newId(),
                    incidentId,
                    memberRef,
                    memberType: 'run',
                    joinedAt: now,
                  },
                ])
              }

              totalIncidentsCreated++
            }
          } else {
            // 已有活跃事件：更新状态机迁移
            const isObserving = existingIncident.status === 'OBSERVING'
            const hasNewAnomalyThisRun = generatedSignals.some(
              (s) => s.groupingKey === groupingKey && s.sourceRef.runId === run.id,
            )

            if (isObserving) {
              // 在 OBSERVING 状态下：
              // 若接纳新的同源异常事实，且发生时间晚于 observingStartedAt -> 回到 ACTION_REQUIRED
              if (hasNewAnomalyThisRun) {
                const addedMember = await insertIgnoreRows(tx, reliabilityIncidentMembers, [
                  {
                    id: newId(),
                    incidentId: existingIncident.id,
                    memberRef: formatIncidentMemberRef({ runId: run.id }),
                    memberType: 'run',
                    joinedAt: now,
                  },
                ])
                await tx
                  .update(reliabilityIncidents)
                  .set({
                    status: 'ACTION_REQUIRED',
                    actionRequiredReason: 'recurrence_during_observation',
                    observingStartedAt: null,
                    observingStartedOrdinal: null,
                    lastSeenAt: now,
                    memberCount: sql`${reliabilityIncidents.memberCount} + ${addedMember}`,
                    evidenceScores,
                    revision: existingIncident.revision + 1,
                    updatedAt: now,
                  })
                  .where(eq(reliabilityIncidents.id, existingIncident.id))

                totalIncidentsUpdated++
              }
            } else {
              // 在 ACTION_REQUIRED / DETECTED / DIAGNOSING / VERIFYING 状态下：
              // 条件：最新连续 5 个样本健康 -> 进入 OBSERVING
              // 不叠加窗口异常率：30 次窗口下 <5% 实际要求约 30 次连续健康，与 14 天观察期的
              // 安全网叠加过度保守，低频场景修复后事件要挂一个多月才收敛；复发会立刻打回。
              // 注意：账号为 NONE 的 session_fault 因无法证明同账号恢复，不自动衰减
              const canRecover = !isSessionFault || (existingIncident.accountId !== null && existingIncident.accountId !== 'NONE')
              if (canRecover && consecutiveHealthy >= 5) {
                await tx
                  .update(reliabilityIncidents)
                  .set({
                    status: 'OBSERVING',
                    observingStartedAt: now,
                    observingStartedOrdinal: receiptOrdinal,
                    evidenceScores,
                    revision: existingIncident.revision + 1,
                    updatedAt: now,
                  })
                  .where(eq(reliabilityIncidents.id, existingIncident.id))

                totalIncidentsUpdated++
              } else if (hasNewAnomalyThisRun) {
                // 有新异常，更新 lastSeenAt 与成员（成员真正新增才累加计数，重放不膨胀）
                const addedMember = await insertIgnoreRows(tx, reliabilityIncidentMembers, [
                  {
                    id: newId(),
                    incidentId: existingIncident.id,
                    memberRef: formatIncidentMemberRef({ runId: run.id }),
                    memberType: 'run',
                    joinedAt: now,
                  },
                ])
                if (addedMember > 0) {
                  await tx
                    .update(reliabilityIncidents)
                    .set({
                      lastSeenAt: now,
                      memberCount: sql`${reliabilityIncidents.memberCount} + ${addedMember}`,
                      evidenceScores,
                      revision: existingIncident.revision + 1,
                      updatedAt: now,
                    })
                    .where(eq(reliabilityIncidents.id, existingIncident.id))
                  totalIncidentsUpdated++
                }
              }
            }
          }
        }

        // g) 更新 feature_windows 窗口摘要投影
        const windowStart = recentSamples[recentSamples.length - 1]!.occurredAt
        const windowEnd = recentSamples[0]!.occurredAt
        const startOrdinal = recentSamples[recentSamples.length - 1]!.evaluationOrdinal
        const endOrdinal = recentSamples[0]!.evaluationOrdinal

        let successCount = 0
        let retryCount = 0
        let fallbackCount = 0
        const latencies: number[] = []

        for (const s of recentSamples) {
          if (s.executionConclusion === 'SUCCEEDED') successCount++
          const sSigs = (s.signals ?? []) as Array<{ kind: string }>
          if (sSigs.some((x) => x.kind === 'step_retried')) retryCount++
          if (sSigs.some((x) => x.kind === 'locator_fallback')) fallbackCount++
          if (s.durationMs !== null && s.durationMs !== undefined) latencies.push(s.durationMs)
        }

        const successRate = recentSamples.length > 0 ? successCount / recentSamples.length : 1.0
        const avgLatency = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0

        const [existingWindow] = await tx
          .select()
          .from(featureWindows)
          .where(
            and(
              eq(featureWindows.targetId, input.targetId),
              eq(featureWindows.scopeDigest, scopeDigest),
              eq(featureWindows.windowType, 'sliding_30_runs'),
            ),
          )
          .limit(1)

        if (existingWindow) {
          await tx
            .update(featureWindows)
            .set({
              windowStart,
              windowEnd,
              startOrdinal,
              endOrdinal,
              sampleCount: recentSamples.length,
              primaryHitCount: recentSamples.length - fallbackCount,
              fallbackCount,
              retryStepCount: retryCount,
              ewmaLatencyMs: avgLatency,
              ewmaSuccessRate: successRate,
              stats: {
                successCount,
                sampleCount: recentSamples.length,
                successRate,
                avgLatency,
              },
              updatedAt: now,
            })
            .where(eq(featureWindows.id, existingWindow.id))
        } else {
          await insertIgnoreRows(tx, featureWindows, [
            {
              id: newId(),
              targetId: input.targetId,
              scopeDigest,
              windowType: 'sliding_30_runs',
              windowStart,
              windowEnd,
              startOrdinal,
              endOrdinal,
              sampleCount: recentSamples.length,
              primaryHitCount: recentSamples.length - fallbackCount,
              fallbackCount,
              retryStepCount: retryCount,
              ewmaLatencyMs: avgLatency,
              ewmaSuccessRate: successRate,
              stats: {
                successCount,
                sampleCount: recentSamples.length,
                successRate,
                avgLatency,
              },
              createdAt: now,
              updatedAt: now,
            },
          ])
        }
      }

      // h) 确认 Receipt 消费完成
      await tx
        .update(reliabilityRunReceipts)
        .set({
          consumedAt: now,
          evaluationOrdinal: receiptOrdinal,
        })
        .where(
          and(
            eq(reliabilityRunReceipts.runId, receipt.runId),
            eq(reliabilityRunReceipts.ruleVersion, 2),
          ),
        )
    }

    // 6. 更新 Checkpoint 序号与时间，并释放本次租约（与 v1 writeReliabilityEvaluation 口径一致）
    await tx
      .update(reliabilityCheckpoints)
      .set({
        runEvaluationOrdinal: currentOrdinal,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where(eq(reliabilityCheckpoints.targetId, input.targetId))

    return {
      processed: true,
      targetId: input.targetId,
      receiptsCount: pendingReceipts.length,
      signalsCount: totalSignals,
      samplesCount: totalSamples,
      incidentsCreated: totalIncidentsCreated,
      incidentsUpdated: totalIncidentsUpdated,
      reconciledCount,
    }
  })
}
