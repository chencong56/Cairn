import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import { grantScopedPermissions } from '../testing.js'
import type { DbHandle } from '../client.js'
import { schemaFor } from '../native.js'
import { newId } from '../id.js'
import { claimReliabilityEvaluation } from '../reliability/evaluations.js'
import { enqueueReliabilityReceiptTx } from '../reliability/receipts.js'
import { evaluateReliabilityBatch } from '../reliability/v2-evaluator.js'

interface AttemptSpec {
  status: 'SUCCEEDED' | 'FAILED'
  error?: unknown
  decision?: {
    decisionKind: 'deterministic' | 'map' | 'ai' | 'failed'
    reasonCode?: string
    rungs?: Array<{ rung: 'D' | 'M' | 'A'; outcome: string; outcomeClass?: string; spentMs: number }>
  }
  businessRejection?: boolean
}

interface StepSpec {
  stepId: string
  scopePath?: string
  status: 'SUCCEEDED' | 'FAILED'
  attempts: AttemptSpec[]
}

interface RunSpec {
  status: 'SUCCEEDED' | 'FAILED'
  steps: StepSpec[]
  authUnrecoverable?: boolean
  finishedAt: Date
}

describe.each(DRIVERS)('%s reliability v2 evaluator (receipts / signals / incidents / decay)', (driver) => {
  let handle: DbHandle
  let ctx: {
    targetId: string
    scenarioId: string
    versionId: string
    consoleAccountId: string
    accountId: string | null
  }

  beforeAll(async () => {
    handle = await openContractDb(driver)
  })

  async function seedTarget(withAccount = false) {
    const t = schemaFor(handle.db)
    const targetId = newId()
    const scenarioId = newId()
    const versionId = newId()
    const consoleAccountId = newId()
    let accountId: string | null = null

    await handle.db.insert(t.consoleAccounts).values({
      id: consoleAccountId,
      email: `reliability-v2-${targetId}@example.com`,
      displayName: '管理员',
      status: 'active',
    })
    await grantScopedPermissions(handle.db, consoleAccountId, ['target:read', 'reliability:read'])

    await handle.db.insert(t.targets).values({
      id: targetId,
      code: `relv2-${targetId}`,
      name: `可靠性v2测试目标-${targetId.slice(0, 6)}`,
      entryUrl: 'https://example.com',
      status: 'active',
    })

    if (withAccount) {
      accountId = newId()
      await handle.db.insert(t.targetAccounts).values({
        id: accountId,
        targetId,
        displayName: '业务账号',
        username: 'ops@example.com',
        status: 'active',
      })
    }

    await handle.db.insert(t.scenarios).values({
      id: scenarioId,
      targetId,
      name: `可靠性v2场景-${scenarioId.slice(0, 6)}`,
      createdByConsoleAccountId: consoleAccountId,
    })
    await handle.db.insert(t.scenarioVersions).values({
      id: versionId,
      scenarioId,
      versionNo: 1,
      definition: { schemaVersion: 1, inputs: [], steps: [] } as never,
      createdByConsoleAccountId: consoleAccountId,
      sourceDigest: `v2-eval-${versionId}`,
      kind: 'published',
    })

    ctx = { targetId, scenarioId, versionId, consoleAccountId, accountId }
    return ctx
  }

  async function insertTerminalRun(spec: RunSpec): Promise<string> {
    const t = schemaFor(handle.db)
    const runId = newId()
    const startedAt = new Date(spec.finishedAt.getTime() - 60_000)

    await handle.db.insert(t.runs).values({
      id: runId,
      targetId: ctx.targetId,
      scenarioId: ctx.scenarioId,
      scenarioVersionId: ctx.versionId,
      status: spec.status,
      snapshot: { runId, targetId: ctx.targetId, scenarioId: ctx.scenarioId, scenarioVersionId: ctx.versionId, steps: [] } as never,
      snapshotDigest: `v2eval-${runId}`,
      context: {},
      createdByConsoleAccountId: ctx.consoleAccountId,
      targetAccountId: ctx.accountId,
      startedAt,
      finishedAt: spec.finishedAt,
      createdAt: startedAt,
      updatedAt: spec.finishedAt,
    })

    let ordinal = 0
    for (const step of spec.steps) {
      const stepRunId = newId()
      await handle.db.insert(t.stepRuns).values({
        id: stepRunId,
        runId,
        stepId: step.stepId,
        name: `step-${step.stepId.slice(0, 6)}`,
        ordinal: ordinal++,
        scopePath: step.scopePath ?? '',
        status: step.status,
        startedAt,
        finishedAt: spec.finishedAt,
      })

      let attemptNo = 0
      for (const att of step.attempts) {
        attemptNo++
        const attemptId = newId()
        const attStart = new Date(startedAt.getTime() + attemptNo * 10_000)
        await handle.db.insert(t.attempts).values({
          id: attemptId,
          stepRunId,
          attemptNo,
          status: att.status,
          startedAt: attStart,
          finishedAt: new Date(attStart.getTime() + 5_000),
          error: (att.error ?? null) as never,
        })

        if (att.decision) {
          await handle.db.insert(t.resolutionDecisions).values({
            id: newId(),
            runId,
            stepRunId,
            attemptId,
            stepId: step.stepId,
            effectivePolicy: 'prefer_deterministic',
            decisionKind: att.decision.decisionKind,
            reasonCode: att.decision.reasonCode as never,
            rungsJson: (att.decision.rungs ?? []) as never,
            evidenceRefs: [] as never,
            payloadJson: {} as never,
          })
        }

        if (att.businessRejection) {
          await handle.db.insert(t.outcomeResults).values({
            id: newId(),
            runId,
            stepRunId,
            attemptId,
            contractId: newId(),
            scope: 'step',
            meaning: '业务校验',
            severity: 'MUST',
            onViolation: 'halt',
            provenance: 'manual',
            verdict: 'FAIL',
            evaluatedAt: new Date(),
          })
        }
      }
    }

    if (spec.authUnrecoverable) {
      await handle.db.insert(t.runEvents).values({
        eventId: newId(),
        runId,
        sequence: 1,
        type: 'run.auth_unrecoverable',
        occurredAt: spec.finishedAt,
        payload: {},
      })
    }

    await enqueueReliabilityReceiptTx(handle.db as never, {
      runId,
      targetId: ctx.targetId,
      finishedAt: spec.finishedAt,
    })
    return runId
  }

  async function runEvaluation(): Promise<Awaited<ReturnType<typeof evaluateReliabilityBatch>>> {
    const claimed = await claimReliabilityEvaluation(handle.db, {
      workerId: 'v2-evaluator-test-worker',
      targetId: ctx.targetId,
    })
    expect(claimed).not.toBeNull()
    return evaluateReliabilityBatch(handle.db, {
      workerId: 'v2-evaluator-test-worker',
      targetId: ctx.targetId,
      fencingToken: claimed!.fencingToken,
    })
  }

  async function signalsOf(targetId: string) {
    const t = schemaFor(handle.db)
    return handle.db
      .select()
      .from(t.reliabilitySignals)
      .where(eq(t.reliabilitySignals.targetId, targetId))
  }

  async function incidentsOf(targetId: string) {
    const t = schemaFor(handle.db)
    return handle.db
      .select()
      .from(t.reliabilityIncidents)
      .where(eq(t.reliabilityIncidents.targetId, targetId))
  }

  it('为无 checkpoint 的目标自动启用 v2 并幂等入队', async () => {
    const { targetId, scenarioId, versionId, consoleAccountId } = await seedTarget()
    const t = schemaFor(handle.db)
    const runId = newId()
    const finishedAt = new Date()

    await handle.db.insert(t.runs).values({
      id: runId,
      targetId,
      scenarioId,
      scenarioVersionId: versionId,
      status: 'SUCCEEDED',
      snapshot: { runId, targetId: ctx.targetId, scenarioId: ctx.scenarioId, scenarioVersionId: ctx.versionId, steps: [] } as never,
      snapshotDigest: `act-${runId}`,
      context: {},
      createdByConsoleAccountId: consoleAccountId,
      startedAt: finishedAt,
      finishedAt,
    })

    await enqueueReliabilityReceiptTx(handle.db as never, { runId, targetId, finishedAt })
    await enqueueReliabilityReceiptTx(handle.db as never, { runId, targetId, finishedAt })

    const [cp] = await handle.db
      .select()
      .from(t.reliabilityCheckpoints)
      .where(eq(t.reliabilityCheckpoints.targetId, targetId))
    expect(cp?.v2Enabled).toBe(true)

    const receipts = await handle.db
      .select()
      .from(t.reliabilityRunReceipts)
      .where(eq(t.reliabilityRunReceipts.targetId, targetId))
    expect(receipts).toHaveLength(1)
  })

  it('不可比运行（如地图作业场景）的耗时样本标为不可比，不进耗时基线；可比运行照常', async () => {
    await seedTarget()
    const t = schemaFor(handle.db)
    const stepId = '00000000-0000-0040-8040-0000000000c1'
    const comparableRun = await insertTerminalRun({
      status: 'SUCCEEDED',
      finishedAt: new Date(),
      steps: [{ stepId, status: 'SUCCEEDED', attempts: [{ status: 'SUCCEEDED' }] }],
    })
    await runEvaluation()
    await handle.db.update(t.scenarios).set({ purpose: 'map_job' }).where(eq(t.scenarios.id, ctx.scenarioId))
    const nonComparableRun = await insertTerminalRun({
      status: 'SUCCEEDED',
      finishedAt: new Date(),
      steps: [{ stepId, status: 'SUCCEEDED', attempts: [{ status: 'SUCCEEDED' }] }],
    })
    await runEvaluation()

    const samples = await handle.db
      .select({ runId: t.reliabilityRunSamples.runId, scopeKind: t.reliabilityRunSamples.scopeKind, isComparable: t.reliabilityRunSamples.isComparable })
      .from(t.reliabilityRunSamples)
      .where(eq(t.reliabilityRunSamples.targetId, ctx.targetId))
    const of = (runId: string, scopeKind: string) => samples.find((row) => row.runId === runId && row.scopeKind === scopeKind)?.isComparable
    expect(of(comparableRun, 'scenario_step')).toBe(true)
    expect(of(comparableRun, 'scenario')).toBe(true)
    expect(of(nonComparableRun, 'scenario_step')).toBe(false)
    expect(of(nonComparableRun, 'scenario')).toBe(false)
  })

  it('单次失败仅记录信号，绝不生成事件', async () => {
    await seedTarget()
    const failedError = { code: 'ELEMENT_NOT_FOUND', message: '元素未找到' }
    await insertTerminalRun({
      status: 'FAILED',
      finishedAt: new Date(),
      steps: [
        {
          stepId: '00000000-0000-0040-8040-000000000001',
          status: 'FAILED',
          attempts: [
            { status: 'FAILED', error: failedError },
            { status: 'FAILED', error: failedError },
          ],
        },
      ],
    })

    const result = await runEvaluation()
    expect(result.receiptsCount).toBe(1)

    const signals = await signalsOf(ctx.targetId)
    const kinds = signals.map((s) => s.kind).sort()
    // 多信号正交：重试 + 失败并存
    expect(kinds).toEqual(['step_failed', 'step_retried'])

    const failed = signals.find((s) => s.kind === 'step_failed')!
    expect(failed.sourceKind).toBe('attempt')
    expect(failed.errorFamily).toBe('ELEMENT_NOT_FOUND')
    expect(failed.occurredAt.getTime()).toBeGreaterThan(0)

    const incidents = await incidentsOf(ctx.targetId)
    expect(incidents).toHaveLength(0)
  })

  it('同一 Run 内多次循环失败仅计 1 次 Run 故障，跨 3 次 Run 才建 P3 事件', async () => {
    await seedTarget()
    const stepId = '00000000-0000-0040-8040-000000000002'
    const failedError = { code: 'TIMEOUT', message: '超时' }
    const base = Date.now()

    // Run 1：单次迭代失败
    await insertTerminalRun({
      status: 'FAILED',
      finishedAt: new Date(base - 30_000),
      steps: [{ stepId, status: 'FAILED', attempts: [{ status: 'FAILED', error: failedError }] }],
    })
    // Run 2：三次循环迭代全部失败（scopePath 不同）
    await insertTerminalRun({
      status: 'FAILED',
      finishedAt: new Date(base - 20_000),
      steps: ['L2#0', 'L2#1', 'L2#2'].map((scopePath) => ({
        stepId,
        scopePath,
        status: 'FAILED' as const,
        attempts: [{ status: 'FAILED' as const, error: failedError }],
      })),
    })
    // Run 3：失败 → 达到连续 3 次 Run 门槛
    await insertTerminalRun({
      status: 'FAILED',
      finishedAt: new Date(base - 10_000),
      steps: [{ stepId, status: 'FAILED', attempts: [{ status: 'FAILED', error: failedError }] }],
    })

    await runEvaluation()

    const t = schemaFor(handle.db)
    const scopeSamples = await handle.db
      .select()
      .from(t.reliabilityRunSamples)
      .where(
        and(
          eq(t.reliabilityRunSamples.targetId, ctx.targetId),
          eq(t.reliabilityRunSamples.scopeKind, 'scenario_step'),
        ),
      )
    // 3 条 Run → 3 个步骤域样本（循环迭代合并不膨胀）
    expect(scopeSamples).toHaveLength(3)

    const incidents = await incidentsOf(ctx.targetId)
    expect(incidents).toHaveLength(1)
    const incident = incidents[0]!
    expect(incident.ruleVersion).toBe(2)
    expect(incident.severity).toBe('P3')
    expect(incident.groupingKey).toBe(
      `v2:target:${ctx.targetId}:scene:${ctx.scenarioId}:step:${stepId}:kind:step_failed:err:TIMEOUT`,
    )
    expect(incident.assetKind).toBe('scenario')
    expect(incident.assetId).toBe(ctx.scenarioId)
    expect(incident.stepId).toBe(stepId)
    expect(incident.memberCount).toBe(3)
    expect(incident.actionRequiredReason).toBe('threshold_breached')

    const members = await handle.db
      .select()
      .from(t.reliabilityIncidentMembers)
      .where(eq(t.reliabilityIncidentMembers.incidentId, incident.id))
    expect(members).toHaveLength(3)
    for (const m of members) {
      expect(m.memberRef).toMatch(/^run:[0-9a-f-]{36}$/)
    }
  })

  it('真实梯级记录判定回退与疑似漂移，原生首选与业务拒绝不计入', async () => {
    await seedTarget()
    await insertTerminalRun({
      status: 'SUCCEEDED',
      finishedAt: new Date(),
      steps: [
        // A：首选 D 未命中，备用 M 命中 → locator_fallback
        {
          stepId: '00000000-0000-0040-8040-0000000000a1',
          status: 'SUCCEEDED',
          attempts: [
            {
              status: 'SUCCEEDED',
              decision: {
                decisionKind: 'map',
                rungs: [
                  { rung: 'D', outcome: 'NO_MATCH', outcomeClass: 'miss', spentMs: 10 },
                  { rung: 'M', outcome: 'FOUND', spentMs: 20 },
                ],
              },
            },
          ],
        },
        // B：原生首选 M 直接命中 → 不算回退
        {
          stepId: '00000000-0000-0040-8040-0000000000b2',
          status: 'SUCCEEDED',
          attempts: [
            {
              status: 'SUCCEEDED',
              decision: {
                decisionKind: 'map',
                rungs: [{ rung: 'M', outcome: 'FOUND', spentMs: 15 }],
              },
            },
          ],
        },
        // C：最终决策失败且原因在白名单 → locator_drift_suspected
        {
          stepId: '00000000-0000-0040-8040-0000000000c3',
          status: 'FAILED',
          attempts: [
            {
              status: 'FAILED',
              error: { message: 'AI 未找到目标' },
              decision: { decisionKind: 'failed', reasonCode: 'AI_NOT_FOUND', rungs: [] },
            },
          ],
        },
        // D：原因在排除名单 → 不判漂移
        {
          stepId: '00000000-0000-0040-8040-0000000000d4',
          status: 'FAILED',
          attempts: [
            {
              status: 'FAILED',
              error: { message: '框架不支持' },
              decision: { decisionKind: 'failed', reasonCode: 'FRAME_UNSUPPORTED', rungs: [] },
            },
          ],
        },
        // E：执行失败但业务断言拒绝 → 不计 step_failed
        {
          stepId: '00000000-0000-0040-8040-0000000000e5',
          status: 'FAILED',
          attempts: [{ status: 'FAILED', error: { message: 'x' }, businessRejection: true }],
        },
      ],
    })

    await runEvaluation()

    const signals = await signalsOf(ctx.targetId)
    const byKind = signals.reduce<Record<string, number>>((acc, s) => {
      acc[s.kind] = (acc[s.kind] ?? 0) + 1
      return acc
    }, {})
    expect(byKind['locator_fallback']).toBe(1)
    expect(byKind['locator_drift_suspected']).toBe(1)
    expect(byKind['step_failed']).toBe(2) // C 与 D（D 不判漂移但仍属执行失败；E 业务拒绝不计）
    const drift = signals.find((s) => s.kind === 'locator_drift_suspected')!
    expect(drift.errorFamily).toBe('RES_AI_NOT_FOUND')

    const incidents = await incidentsOf(ctx.targetId)
    expect(incidents).toHaveLength(0)
  })

  it('run.auth_unrecoverable 即时生成 P2 会话故障事件', async () => {
    await seedTarget(true)
    await insertTerminalRun({
      status: 'FAILED',
      finishedAt: new Date(),
      steps: [],
      authUnrecoverable: true,
    })

    await runEvaluation()

    const signals = await signalsOf(ctx.targetId)
    const fault = signals.find((s) => s.kind === 'session_fault')
    expect(fault).toBeDefined()
    expect(fault!.severity).toBe('ERROR')

    const incidents = await incidentsOf(ctx.targetId)
    expect(incidents).toHaveLength(1)
    expect(incidents[0]!.severity).toBe('P2')
    expect(incidents[0]!.groupingKey).toBe(
      `v2:target:${ctx.targetId}:account:${ctx.accountId}:kind:session_fault`,
    )
  })

  it('健康反例将事件转入观察期，复发转回待处理，观察期满自动归档', async () => {
    await seedTarget()
    const stepId = '00000000-0000-0040-8040-000000000003'
    const failedError = { code: 'TIMEOUT', message: '超时' }
    const base = Date.now()

    for (let i = 0; i < 3; i++) {
      await insertTerminalRun({
        status: 'FAILED',
        finishedAt: new Date(base - 100_000 + i * 1_000),
        steps: [{ stepId, status: 'FAILED', attempts: [{ status: 'FAILED', error: failedError }] }],
      })
    }
    await runEvaluation()
    let incidents = await incidentsOf(ctx.targetId)
    expect(incidents).toHaveLength(1)
    const incidentId = incidents[0]!.id

    // 5 次连续健康 Run 即进入观察期（不叠加 30 次窗口异常率：该口径下低频场景需约 30 次连续健康才收敛，已废除）
    for (let i = 0; i < 5; i++) {
      await insertTerminalRun({
        status: 'SUCCEEDED',
        finishedAt: new Date(base - 50_000 + i * 1_000),
        steps: [{ stepId, status: 'SUCCEEDED', attempts: [{ status: 'SUCCEEDED' }] }],
      })
    }
    await runEvaluation()
    incidents = await incidentsOf(ctx.targetId)
    expect(incidents[0]!.status).toBe('OBSERVING')
    expect(incidents[0]!.observingStartedAt).not.toBeNull()

    // 观察期复发 → ACTION_REQUIRED
    await insertTerminalRun({
      status: 'FAILED',
      finishedAt: new Date(base - 5_000),
      steps: [{ stepId, status: 'FAILED', attempts: [{ status: 'FAILED', error: failedError }] }],
    })
    await runEvaluation()
    incidents = await incidentsOf(ctx.targetId)
    expect(incidents[0]!.status).toBe('ACTION_REQUIRED')
    expect(incidents[0]!.actionRequiredReason).toBe('recurrence_during_observation')
    // 3 个失败成员 + 1 个复发成员
    expect(incidents[0]!.memberCount).toBe(4)

    // 观察期回拨 15 天再转入 → sweep 自动 RESOLVED
    const t = schemaFor(handle.db)
    await handle.db
      .update(t.reliabilityIncidents)
      .set({ status: 'OBSERVING', observingStartedAt: new Date(base - 20 * 86400_000), lastSeenAt: new Date(base - 20 * 86400_000) })
      .where(eq(t.reliabilityIncidents.id, incidentId))
    const sweepResult = await runEvaluation()
    expect(sweepResult.reconciledCount).toBeGreaterThanOrEqual(1)
    incidents = await incidentsOf(ctx.targetId)
    expect(incidents[0]!.status).toBe('RESOLVED')
    expect(incidents[0]!.dismissedReason).toBe('decayed_no_recurrence')
    expect(incidents[0]!.closedAt).not.toBeNull()
  })

  it('v1 存量事件超 30 天被批量收敛，重放同一 Run 不增生记录', async () => {
    await seedTarget()
    const t = schemaFor(handle.db)

    // 直接落一条 v1 存量事件（模拟历史遗留）
    await handle.db.insert(t.reliabilityIncidents).values({
      id: newId(),
      targetId: ctx.targetId,
      groupingKey: 'legacyv1fingerprint0000000000000000000000',
      scopeDigest: `target:${ctx.targetId}`,
      severity: 'P3',
      status: 'DETECTED',
      firstSeenAt: new Date(Date.now() - 40 * 86400_000),
      lastSeenAt: new Date(Date.now() - 40 * 86400_000),
      title: '旧规则事件',
      summary: '旧规则事件',
      evidenceScores: { supportingScore: 0, counterScore: 0, supportingFactors: [], counterFactors: [] },
      ruleVersion: 1,
    })

    const stepId = '00000000-0000-0040-8040-000000000004'
    const failedError = { code: 'TIMEOUT', message: '超时' }
    const runId = await insertTerminalRun({
      status: 'FAILED',
      finishedAt: new Date(),
      steps: [{ stepId, status: 'FAILED', attempts: [{ status: 'FAILED', error: failedError }] }],
    })

    const first = await runEvaluation()
    expect(first.receiptsCount).toBe(1)
    expect(first.reconciledCount).toBe(1)

    const incidents = await incidentsOf(ctx.targetId)
    const legacy = incidents.find((i) => i.ruleVersion === 1)!
    expect(legacy.status).toBe('RESOLVED')
    expect(legacy.dismissedReason).toBe('legacy_rule_retired')

    const signalsAfterFirst = (await signalsOf(ctx.targetId)).length
    const samplesAfterFirst = await handle.db
      .select()
      .from(t.reliabilityRunSamples)
      .where(eq(t.reliabilityRunSamples.targetId, ctx.targetId))

    // 重放：同一 Run 再次入账被唯一约束拒绝，再评估无新增
    await enqueueReliabilityReceiptTx(handle.db as never, {
      runId,
      targetId: ctx.targetId,
      finishedAt: new Date(),
    })
    await runEvaluation()

    expect((await signalsOf(ctx.targetId)).length).toBe(signalsAfterFirst)
    const samplesAfterReplay = await handle.db
      .select()
      .from(t.reliabilityRunSamples)
      .where(eq(t.reliabilityRunSamples.targetId, ctx.targetId))
    expect(samplesAfterReplay).toHaveLength(samplesAfterFirst.length)
  })
})
