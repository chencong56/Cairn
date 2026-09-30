import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import {
  type AuthoringNode,
  type OutcomeContract,
  type ScenarioAuthoringDocumentV2,
} from '@cairn/shared'
import {
  claimSweepBatch,
  createRunWithSnapshot,
  createScenarioWithVersion,
  createSweepBatch,
  finishSweepBatch,
  getAcceptanceCoverageOverview,
  getScenarioAcceptanceHistory,
  insertCoverageSnapshots,
  openIsolatedDb,
  pruneOldSweepSnapshots,
  publishScenarioDraft,
  renewSweepBatchLease,
  saveScenarioDraft,
  schemaFor,
  type NativeHandle as DbHandle,
} from '../test-entry.js'
import { newId } from '../id.js'
import { consoleAccounts as pg_consoleAccounts } from '../schema/console.js'
import { targets as pg_targets } from '../schema/targets.js'
import { attempts as pg_attempts, outcomeResults as pg_outcomeResults, stepRuns as pg_stepRuns } from '../schema/execution.js'
import { acceptanceSweepBatches as pg_acceptanceSweepBatches } from '../schema/acceptance.js'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_acceptance`

describe('验收意图（三期）：历史洞察与批量巡检持久化', () => {
  let handle: DbHandle
  let adminId: string
  let targetId: string

  beforeAll(async () => {
    handle = await openIsolatedDb(SCHEMA)
    adminId = newId()
    targetId = newId()

    const { db } = handle
    const { consoleAccounts } = schemaFor(db)
    await db.insert(consoleAccounts).values({
      id: adminId,
      displayName: 'admin_test',
      email: 'admin_test@test.local',
      status: 'active',
    })

    const { targets } = schemaFor(db)
    await db.insert(targets).values([
      {
        id: targetId,
        code: `target-${targetId.slice(0, 8)}`,
        name: 'Test Acceptance Target',
        entryUrl: 'https://test.local',
      },
    ])
  })

  afterAll(async () => {
    await handle?.close()
  })

  describe('批次状态机与僵尸批次自动回收', () => {
    it('正常流转：create -> claim -> renew -> finish', async () => {
      const { db } = handle
      const createRes = await createSweepBatch(db, { trigger: 'manual' })
      expect(createRes.ok).toBe(true)
      if (!createRes.ok) return

      const batch = createRes.batch
      expect(batch.status).toBe('queued')
      expect(batch.trigger).toBe('manual')

      // 重复创建活跃批次被拒绝
      const dupRes = await createSweepBatch(db, { trigger: 'periodic' })
      expect(dupRes.ok).toBe(false)

      // Worker 领取
      const claimed = await claimSweepBatch(db, { workerId: 'worker-1', leaseMinutes: 15 })
      expect(claimed).not.toBeNull()
      expect(claimed?.id).toBe(batch.id)
      expect(claimed?.status).toBe('running')
      expect(claimed?.leaseOwner).toBe('worker-1')
      expect(claimed?.leaseExpiresAt).toBeDefined()

      // 续租
      const renewed = await renewSweepBatchLease(db, { batchId: batch.id, workerId: 'worker-1', leaseMinutes: 20 })
      expect(renewed).toBe(true)

      // 完成
      const finishedOk = await finishSweepBatch(db, {
        batchId: batch.id,
        workerId: 'worker-1',
        status: 'completed',
        scenarioCount: 5,
        skippedCount: 1,
        durationMs: 3200,
      })
      expect(finishedOk).toBe(true)

      const { acceptanceSweepBatches } = schemaFor(db)
      const [finished] = await db
        .select()
        .from(acceptanceSweepBatches)
        .where(eq(acceptanceSweepBatches.id, batch.id))
      expect(finished).toBeDefined()
      if (!finished) throw new Error('finished is undefined')
      expect(finished.status).toBe('completed')
      expect(finished.leaseOwner).toBeNull()
      expect(finished.leaseExpiresAt).toBeNull()
      expect(finished.scenarioCount).toBe(5)
      expect(finished.skippedCount).toBe(1)

      // 已完结批次再次收尾被拒绝（幂等保护，不改写终态）
      const finishedAgain = await finishSweepBatch(db, {
        batchId: batch.id,
        workerId: 'worker-1',
        status: 'completed',
      })
      expect(finishedAgain).toBe(false)
    })

    it('僵尸批次自动回收：超时 running 批次在下次触发或领取时被置为 failed', async () => {
      const { db } = handle
      // 插入一条过期的 running 批次
      const zombieId = newId()
      const past = new Date(Date.now() - 30 * 60 * 1000)
      await db.insert(pg_acceptanceSweepBatches).values({
        id: zombieId,
        scope: 'platform',
        trigger: 'periodic',
        status: 'running',
        leaseOwner: 'crashed-worker',
        leaseExpiresAt: past,
        createdAt: past,
        updatedAt: past,
      })

      // 触发创建新批次，应自动回收僵尸批次并创建成功
      const createRes = await createSweepBatch(db, { trigger: 'manual' })
      expect(createRes.ok).toBe(true)

      // 检查僵尸批次已被置为 failed (WORKER_LOST)，且租约被清理
      const { acceptanceSweepBatches } = schemaFor(db)
      const [zombieRow] = await db
        .select()
        .from(acceptanceSweepBatches)
        .where(eq(acceptanceSweepBatches.id, zombieId))
      expect(zombieRow?.status).toBe('failed')
      expect(zombieRow?.error).toBe('WORKER_LOST')
      expect(zombieRow?.leaseOwner).toBeNull()
      expect(zombieRow?.leaseExpiresAt).toBeNull()

      // 失联的旧持有者不得改写已回收批次的终态
      const staleFinish = await finishSweepBatch(db, {
        batchId: zombieId,
        workerId: 'crashed-worker',
        status: 'completed',
        scenarioCount: 99,
      })
      expect(staleFinish).toBe(false)
      const [afterStale] = await db
        .select()
        .from(acceptanceSweepBatches)
        .where(eq(acceptanceSweepBatches.id, zombieId))
      expect(afterStale?.status).toBe('failed')
      expect(afterStale?.scenarioCount).toBe(0)

      // 清理新创建的批次：领取后按持有者收尾
      if (createRes.ok) {
        const claimed = await claimSweepBatch(db, { workerId: 'cleanup-worker' })
        expect(claimed?.id).toBe(createRes.batch.id)
        await finishSweepBatch(db, {
          batchId: createRes.batch.id,
          workerId: 'cleanup-worker',
          status: 'completed',
        })
      }
    })

    it('单活跃互斥：running 批次执行期间排队批次不被领取，结束后才可继续', async () => {
      const { db } = handle
      const createRes = await createSweepBatch(db, { trigger: 'manual' })
      expect(createRes.ok).toBe(true)
      if (!createRes.ok) return
      const runningId = createRes.batch.id

      const claimed = await claimSweepBatch(db, { workerId: 'worker-a', leaseMinutes: 15 })
      expect(claimed?.id).toBe(runningId)
      expect(claimed?.status).toBe('running')

      // 模拟并发创建竞态落下的第二条排队批次（绕过 API 防重直接插入）
      const queuedId = newId()
      await db.insert(pg_acceptanceSweepBatches).values({
        id: queuedId,
        scope: 'platform',
        trigger: 'periodic',
        status: 'queued',
        createdAt: new Date(),
        updatedAt: new Date(),
      })

      // running 批次持有租约期间，另一 Worker 的领取必须返回空
      const blockedClaim = await claimSweepBatch(db, { workerId: 'worker-b', leaseMinutes: 15 })
      expect(blockedClaim).toBeNull()

      // 原批次结束后，排队批次才能被领取
      await finishSweepBatch(db, {
        batchId: runningId,
        workerId: 'worker-a',
        status: 'completed',
        scenarioCount: 1,
      })
      const nextClaim = await claimSweepBatch(db, { workerId: 'worker-b', leaseMinutes: 15 })
      expect(nextClaim?.id).toBe(queuedId)
      expect(nextClaim?.status).toBe('running')

      await finishSweepBatch(db, {
        batchId: queuedId,
        workerId: 'worker-b',
        status: 'completed',
        scenarioCount: 0,
      })
    })
  })

  describe('覆盖快照落库与横向概览聚合', () => {
    it('快照写入、过期清理与横向覆盖视图聚合（ANSI SQL 聚合无 DISTINCT ON）', async () => {
      const { db } = handle
      // 创建两个场景
      const echoStep = {
        id: newId(),
        name: 'Echo',
        type: 'echo' as const,
        effectType: 'READ_ONLY' as const,
        input: { value: 'ok' },
      }
      const scenario1 = await createScenarioWithVersion(handle.db, {
        targetId,
        actor: { kind: 'console', id: adminId },
        name: 'Scenario Alpha',
        steps: [echoStep],
      })
      const scenario2 = await createScenarioWithVersion(handle.db, {
        targetId,
        actor: { kind: 'console', id: adminId },
        name: 'Scenario Beta',
        steps: [echoStep],
      })

      // 为场景 1 保存草稿
      const docV2: ScenarioAuthoringDocumentV2 = {
        authoringSchemaVersion: 2,
        schemaVersion: 1,
        inputs: [],
        nodes: [
          {
            kind: 'step',
            step: {
              id: newId(),
              name: 'Navigate',
              type: 'navigate',
              effectType: 'READ_ONLY' as const,
              input: { url: 'https://test.local' },
            },
          },
        ],
      }
      await saveScenarioDraft(handle.db, scenario1.id, {
        revision: 1,
        actor: { kind: 'console', id: adminId },
        document: docV2,
      })

      // 创建一个批次并写入快照
      const createRes = await createSweepBatch(db, { trigger: 'manual' })
      expect(createRes.ok).toBe(true)
      if (!createRes.ok) return
      const batchId = createRes.batch.id

      await insertCoverageSnapshots(db, [
        {
          batchId,
          targetId,
          scenarioId: scenario1.id,
          draftRevision: 1,
          auditedAt: new Date(),
          trigger: 'manual',
          coverage: {
            browserStepCoverage: 0.8,
            outputMetricCoverage: 1.0,
            browserStepsCount: 5,
            coveredBrowserStepsCount: 4,
            outputsCount: 1,
            coveredOutputsCount: 1,
          },
          findingsCount: 1,
          topFindings: [
            {
              code: 'SCENARIO_NO_OUTCOME',
              message: '场景无条件',
              severity: 'warning',
            },
          ],
          durationMs: 450,
        },
      ])

      // 删除场景 2 的草稿以验证无草稿场景的标识
      const { scenarioDrafts } = schemaFor(db)
      await db.delete(scenarioDrafts).where(eq(scenarioDrafts.scenarioId, scenario2.id))

      // 查询概览
      const overview = await getAcceptanceCoverageOverview(db, { targetId })
      expect(overview.totalScenarioCount).toBeGreaterThanOrEqual(2)
      expect(overview.unauditedScenarioCount).toBeGreaterThanOrEqual(1) // scenario 2 未审计且无草稿
      expect(overview.platformAverageCoverage).toBe(0.9) // (0.8 + 1.0) / 2 = 0.9

      const alphaItem = overview.scenarios.find((s) => s.scenarioId === scenario1.id)
      expect(alphaItem).toBeDefined()
      expect(alphaItem?.hasDraft).toBe(true)
      expect(alphaItem?.browserStepCoverage).toBe(0.8)
      expect(alphaItem?.findingsCount).toBe(1)

      const betaItem = overview.scenarios.find((s) => s.scenarioId === scenario2.id)
      expect(betaItem).toBeDefined()
      expect(betaItem?.hasDraft).toBe(false)
      expect(betaItem?.browserStepCoverage).toBeUndefined()

      // 测过期清理
      const pruned = await pruneOldSweepSnapshots(db, 0) // 0 天：清理全部
      expect(pruned).toBeGreaterThanOrEqual(1)
    })
  })

  describe('历史洞察聚合与调优建议', () => {
    it('末次 Attempt 去重、巡检型失败计算与断点切分', async () => {
      const { db } = handle
      const contractId = newId()
      const stepId = newId()
      const deadContractId = newId()

      const contract: OutcomeContract = {
        id: contractId,
        scope: 'step',
        meaning: '页面加载在 500ms 内完成',
        severity: 'MUST',
        onViolation: 'continue',
        provenance: 'manual',
        rule: {
          kind: 'step_duration',
          op: 'lte',
          valueMs: 500,
        },
      }

      // 场景级契约：随全部运行进入 manifest，但从不写求值结果 → 死条件
      const deadContract: OutcomeContract = {
        id: deadContractId,
        scope: 'scenario',
        meaning: '全程耗时不超过 10 秒',
        severity: 'SHOULD',
        onViolation: 'continue',
        provenance: 'manual',
        rule: {
          kind: 'run_duration',
          op: 'lte',
          valueMs: 10_000,
        },
      }

      const doc: ScenarioAuthoringDocumentV2 = {
        authoringSchemaVersion: 2,
        schemaVersion: 1,
        inputs: [],
        scenarioOutcomes: [deadContract],
        nodes: [
          {
            kind: 'step',
            step: {
              id: stepId,
              name: 'Page Load',
              type: 'navigate',
              effectType: 'READ_ONLY' as const,
              input: { url: 'https://test.local' },
            },
            outcomes: [contract],
          },
        ],
      }

      const navStep = {
        id: stepId,
        name: 'Page Load',
        type: 'navigate' as const,
        effectType: 'READ_ONLY' as const,
        input: { url: 'https://test.local' },
      }
      const scenario = await createScenarioWithVersion(handle.db, {
        targetId,
        actor: { kind: 'console', id: adminId },
        name: 'Scenario Timing',
        steps: [navStep],
      })

      const saved = await saveScenarioDraft(handle.db, scenario.id, {
        revision: scenario.draft!.revision,
        actor: { kind: 'console', id: adminId },
        document: doc,
      })
      const published = await publishScenarioDraft(handle.db, scenario.id, {
        revision: saved.draft!.revision,
        actor: { kind: 'console', id: adminId },
      })

      // 构造 10 次成功的 runThrough 运行，但耗时达到 1200ms（产生巡检型失败：verdict=FAIL and run=SUCCEEDED）
      // 其中一次运行包含两次 Attempt（模拟重试：attempt 1 失败，attempt 2 生效）
      for (let i = 0; i < 10; i++) {
        const runRes = await createRunWithSnapshot(handle.db, {
          scenarioId: scenario.id,
          scenarioVersionId: published.published!.versionId,
          debugMode: 'runThrough',
          actor: { kind: 'console', id: adminId },
        })
        const runId = runRes.detail.id

        // 将 run 状态置为 SUCCEEDED
        const { runs, stepRuns, attempts, outcomeResults } = schemaFor(db)
        await db.update(runs).set({ status: 'SUCCEEDED' }).where(eq(runs.id, runId))

        const [existingStepRun] = await db
          .select({ id: stepRuns.id })
          .from(stepRuns)
          .where(and(eq(stepRuns.runId, runId), eq(stepRuns.stepId, stepId)))
        const stepRunId = existingStepRun!.id

        if (i === 0) {
          // 模拟两次 attempt
          const att1Id = newId()
          const att2Id = newId()
          await db.insert(attempts).values([
            {
              id: att1Id,
              stepRunId,
              attemptNo: 1,
              status: 'FAILED',
              startedAt: new Date(),
            },
            {
              id: att2Id,
              stepRunId,
              attemptNo: 2,
              status: 'SUCCEEDED',
              startedAt: new Date(),
            },
          ])

          // attempt 1 写了一条暂态失败（比如基础设施故障 UNKNOWN），attempt 2 最终求值
          await db.insert(outcomeResults).values([
            {
              id: newId(),
              runId,
              stepRunId,
              attemptId: att1Id,
              contractId,
              scope: 'step',
              meaning: '页面加载在 500ms 内完成',
              severity: 'MUST',
              onViolation: 'continue',
              provenance: 'manual',
              verdict: 'UNKNOWN',
              actual: null,
              evaluatedAt: new Date(),
            },
            {
              id: newId(),
              runId,
              stepRunId,
              attemptId: att2Id,
              contractId,
              scope: 'step',
              meaning: '页面加载在 500ms 内完成',
              severity: 'MUST',
              onViolation: 'continue',
              provenance: 'manual',
              verdict: 'FAIL',
              actual: 1200,
              evaluatedAt: new Date(),
            },
          ])
        } else {
          const attId = newId()
          await db.insert(attempts).values({
            id: attId,
            stepRunId,
            attemptNo: 1,
            status: 'SUCCEEDED',
            startedAt: new Date(),
          })

          await db.insert(outcomeResults).values({
            id: newId(),
            runId,
            stepRunId,
            attemptId: attId,
            contractId,
            scope: 'step',
            meaning: '页面加载在 500ms 内完成',
            severity: 'MUST',
            onViolation: 'continue',
            provenance: 'manual',
            verdict: 'FAIL',
            actual: 1200,
            evaluatedAt: new Date(),
          })
        }
      }

      // 查询历史洞察
      const res = await getScenarioAcceptanceHistory(db, { scenarioId: scenario.id })
      expect(res.insights).toHaveLength(2)

      const insight = res.insights.find((i) => i.contractId === contractId)
      expect(insight).toBeDefined()
      if (!insight) throw new Error('insight is undefined')
      expect(insight.sampleCount).toBe(10)
      expect(insight.inspectionalFailCount).toBe(10) // 10 次巡检型失败
      expect(insight.failCount).toBe(10)
      expect(insight.actualDistribution?.p95).toBe(1200)

      // 验证调优建议：巡检型失败率 100% >= 30%，建议放宽阈值至 1500ms（1200 阶梯整 500 向上取整）
      expect(insight.suggestions).toHaveLength(1)
      const suggestion = insight.suggestions[0]!
      expect(suggestion.kind).toBe('loosen_threshold')
      expect(suggestion.fromValue).toBe(500)
      expect(suggestion.toValue).toBe(1500)
      expect(suggestion.suggestedPatch?.rule).toEqual({
        kind: 'step_duration',
        op: 'lte',
        valueMs: 1500,
      })

      // 场景级契约随 10 次运行进入 manifest 却从未求值 → 死条件
      const deadInsight = res.insights.find((i) => i.contractId === deadContractId)
      expect(deadInsight).toBeDefined()
      if (!deadInsight) throw new Error('deadInsight is undefined')
      expect(deadInsight.sampleCount).toBe(0)
      expect(deadInsight.suggestions).toHaveLength(1)
      expect(deadInsight.suggestions[0]!.kind).toBe('dead_condition')
    })

    it('新加条件不算死条件：历史运行的 manifest 中尚无该契约时不产生死条件建议', async () => {
      const { db } = handle
      const stepId = newId()
      const contractId = newId()

      // 场景先以无条件版本运行 10 次
      const scenario = await createScenarioWithVersion(handle.db, {
        targetId,
        actor: { kind: 'console', id: adminId },
        name: 'Scenario Late Contract',
        steps: [
          {
            id: stepId,
            name: 'Navigate',
            type: 'navigate' as const,
            effectType: 'READ_ONLY' as const,
            input: { url: 'https://test.local' },
          },
        ],
      })
      const published = scenario.latestVersionId
      for (let i = 0; i < 10; i++) {
        const runRes = await createRunWithSnapshot(handle.db, {
          scenarioId: scenario.id,
          scenarioVersionId: published,
          debugMode: 'runThrough',
          actor: { kind: 'console', id: adminId },
        })
        const { runs } = schemaFor(db)
        await db.update(runs).set({ status: 'SUCCEEDED' }).where(eq(runs.id, runRes.detail.id))
      }

      // 之后再往草稿加条件（无新运行）：场景运行次数 >= 10，但该契约从未出现在 manifest 中
      await saveScenarioDraft(handle.db, scenario.id, {
        revision: scenario.draft!.revision,
        actor: { kind: 'console', id: adminId },
        document: {
          authoringSchemaVersion: 2,
          schemaVersion: 1,
          inputs: [],
          nodes: [
            {
              kind: 'step',
              step: {
                id: stepId,
                name: 'Navigate',
                type: 'navigate',
                effectType: 'READ_ONLY' as const,
                input: { url: 'https://test.local' },
              },
              outcomes: [
                {
                  id: contractId,
                  scope: 'step',
                  meaning: '页面加载在 500ms 内完成',
                  severity: 'MUST',
                  onViolation: 'continue',
                  provenance: 'manual',
                  rule: { kind: 'step_duration', op: 'lte', valueMs: 500 },
                },
              ],
            },
          ],
        },
      })

      const res = await getScenarioAcceptanceHistory(db, { scenarioId: scenario.id })
      const insight = res.insights.find((i) => i.contractId === contractId)
      expect(insight).toBeDefined()
      if (!insight) throw new Error('insight is undefined')
      expect(insight.sampleCount).toBe(0)
      expect(insight.suggestions).toEqual([]) // 不误报死条件
    })
  })
})
