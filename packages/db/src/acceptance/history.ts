import { and, desc, eq, gte, inArray, isNull } from 'drizzle-orm'
import {
  OUTCOME_TUNING_RULES,
  walkAuthoringNodes,
  type AcceptanceHistoryInsight,
  type ActualDistribution,
  type AuthoringStepNode,
  type OutcomeContract,
  type OutcomeVerdict,
  type ScenarioAcceptanceHistoryResponse,
  type ScenarioAuthoringDocumentV2,
} from '@cairn/shared'
import { suggestOutcomeTuning } from '@cairn/authoring'
import type { Db } from '../client.js'
import { schemaFor } from '../native.js'
import { notFound } from '../runs/errors.js'

function computePercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))
  return sorted[index]!
}

export async function getScenarioAcceptanceHistory(
  db: Db,
  input: { scenarioId: string; limit?: number; since?: Date },
): Promise<ScenarioAcceptanceHistoryResponse> {
  const { scenarios, scenarioDrafts, runs, outcomeResults, attempts } = schemaFor(db)

  // 1. 确认场景存在且未软删除
  const [scenario] = await db
    .select({ id: scenarios.id })
    .from(scenarios)
    .where(and(eq(scenarios.id, input.scenarioId), isNull(scenarios.deletedAt)))
    .limit(1)

  if (!scenario) {
    throw notFound('SCENARIO_NOT_FOUND', `场景「${input.scenarioId}」不存在或已被删除`)
  }

  // 2. 从草稿提取当前配置的条件契约
  const [draft] = await db
    .select({ document: scenarioDrafts.document })
    .from(scenarioDrafts)
    .where(eq(scenarioDrafts.scenarioId, input.scenarioId))
    .limit(1)

  const contractsMap = new Map<string, OutcomeContract>()

  if (draft?.document) {
    const doc = draft.document as ScenarioAuthoringDocumentV2
    if (doc.scenarioOutcomes && Array.isArray(doc.scenarioOutcomes)) {
      for (const contract of doc.scenarioOutcomes) {
        contractsMap.set(contract.id, contract)
      }
    }
    const walked = walkAuthoringNodes(doc)
    for (const entry of walked) {
      if (entry.node.kind === 'step') {
        const stepNode = entry.node as AuthoringStepNode
        if (stepNode.outcomes && Array.isArray(stepNode.outcomes)) {
          for (const contract of stepNode.outcomes) {
            contractsMap.set(contract.id, contract)
          }
        }
      }
    }
  }

  // 3. 查询近期已完成的 runThrough 运行（窗口：最近 WINDOW_MAX 次；不足时仅保留近 WINDOW_DAYS 天）
  const windowLimit = Math.min(50, Math.max(1, input.limit ?? OUTCOME_TUNING_RULES.WINDOW_MAX))
  let recentRuns = await db
    .select({
      id: runs.id,
      status: runs.status,
      debugMode: runs.debugMode,
      executionOrigin: runs.executionOrigin,
      serviceCallerId: runs.serviceCallerId,
      createdByConsoleAccountId: runs.createdByConsoleAccountId,
      snapshot: runs.snapshot,
      createdAt: runs.createdAt,
    })
    .from(runs)
    .where(
      and(
        eq(runs.scenarioId, input.scenarioId),
        eq(runs.debugMode, 'runThrough'),
        inArray(runs.status, ['SUCCEEDED', 'FAILED']),
        isNull(runs.deletedAt),
        input.since ? gte(runs.createdAt, input.since) : undefined,
      ),
    )
    .orderBy(desc(runs.createdAt))
    .limit(windowLimit)

  if (!input.since && recentRuns.length < OUTCOME_TUNING_RULES.WINDOW_MAX) {
    const cutoff = new Date(Date.now() - OUTCOME_TUNING_RULES.WINDOW_DAYS * 24 * 60 * 60 * 1000)
    recentRuns = recentRuns.filter((run) => run.createdAt >= cutoff)
  }

  // 若草稿无契约，尝试从最新 Run 的 snapshot.outcomeManifest 兜底提取契约
  if (contractsMap.size === 0 && recentRuns.length > 0) {
    const latestRun = recentRuns[0]!
    const entries = latestRun.snapshot?.outcomeManifest?.entries ?? []
    for (const e of entries) {
      contractsMap.set(e.contractId, {
        id: e.contractId,
        scope: e.scope,
        meaning: e.meaning,
        severity: e.severity,
        onViolation: e.onViolation,
        provenance: e.provenance,
        rule: e.rule,
      })
    }
  }

  const contracts = Array.from(contractsMap.values())
  if (contracts.length === 0) {
    return {
      scenarioId: input.scenarioId,
      insights: [],
    }
  }

  // 4. 查询涉及这批 Run 的所有 outcomeResults，并左连 attempts 获取 attemptNo
  const runIds = recentRuns.map((r) => r.id)
  type OutcomeEval = {
    verdict: OutcomeVerdict
    actual: unknown
    expected: unknown
  }

  // runId -> stepRunId -> contractId -> best attempt eval
  const runStepContractEvalMap = new Map<string, Map<string, Map<string, { attemptNo: number; eval: OutcomeEval }>>>()

  if (runIds.length > 0) {
    const outcomeRows = await db
      .select({
        runId: outcomeResults.runId,
        stepRunId: outcomeResults.stepRunId,
        contractId: outcomeResults.contractId,
        verdict: outcomeResults.verdict,
        actual: outcomeResults.actual,
        expected: outcomeResults.expected,
        attemptNo: attempts.attemptNo,
      })
      .from(outcomeResults)
      .leftJoin(attempts, eq(outcomeResults.attemptId, attempts.id))
      .where(inArray(outcomeResults.runId, runIds))

    for (const row of outcomeRows) {
      let stepMap = runStepContractEvalMap.get(row.runId)
      if (!stepMap) {
        stepMap = new Map()
        runStepContractEvalMap.set(row.runId, stepMap)
      }
      let contractMap = stepMap.get(row.stepRunId)
      if (!contractMap) {
        contractMap = new Map()
        stepMap.set(row.stepRunId, contractMap)
      }

      const existing = contractMap.get(row.contractId)
      const attemptNo = row.attemptNo ?? 1
      if (!existing || attemptNo > existing.attemptNo) {
        contractMap.set(row.contractId, {
          attemptNo,
          eval: {
            verdict: row.verdict as OutcomeVerdict,
            actual: row.actual,
            expected: row.expected,
          },
        })
      }
    }
  }

  // 辅助函数：获取某次 Run 中某契约的所有生效评估（跨步骤去重后）
  function getRunEvaluationsForContract(runId: string, contractId: string): OutcomeEval[] {
    const stepMap = runStepContractEvalMap.get(runId)
    if (!stepMap) return []
    const evals: OutcomeEval[] = []
    for (const contractMap of stepMap.values()) {
      const match = contractMap.get(contractId)
      if (match) {
        evals.push(match.eval)
      }
    }
    return evals
  }

  // 5. 逐契约对比 manifest 切分统计断点并聚合
  const insights: AcceptanceHistoryInsight[] = []

  for (const contract of contracts) {
    // 寻找最新出现的同 contractId 运行定义
    let baselineDefKey: string | null = null
    for (const run of recentRuns) {
      const entries = run.snapshot?.outcomeManifest?.entries ?? []
      const found = entries.find((e) => e.contractId === contract.id)
      if (found) {
        baselineDefKey = JSON.stringify({ rule: found.rule, severity: found.severity })
        break
      }
    }

    if (!baselineDefKey) {
      baselineDefKey = JSON.stringify({ rule: contract.rule, severity: contract.severity })
    }

    let breakpointHit = false
    let priorSegmentSampleCount = 0
    let manifestRunCount = 0

    let sampleCount = 0
    let passCount = 0
    let failCount = 0
    let unknownCount = 0
    let inspectionalFailCount = 0
    const sampleBreakdown: Record<string, number> = {}
    const actualNumbers: number[] = []

    for (const run of recentRuns) {
      const entries = run.snapshot?.outcomeManifest?.entries ?? []
      const entry = entries.find((e) => e.contractId === contract.id)

      if (entry) {
        manifestRunCount += 1
        const runDefKey = JSON.stringify({ rule: entry.rule, severity: entry.severity })
        if (runDefKey !== baselineDefKey) {
          breakpointHit = true
        }
      }

      const evals = getRunEvaluationsForContract(run.id, contract.id)
      if (evals.length === 0) {
        // 本次运行未求值该契约
        continue
      }

      if (breakpointHit) {
        priorSegmentSampleCount += 1
        continue
      }

      // 当前序列有效样本
      sampleCount += 1

      // 样本来源分类
      let source = 'other'
      if (run.executionOrigin === 'suite_member') {
        source = 'suite'
      } else if (run.executionOrigin === 'batch_item') {
        source = 'batch'
      } else if (run.serviceCallerId) {
        source = 'api'
      } else if (run.createdByConsoleAccountId) {
        source = 'manual'
      }
      sampleBreakdown[source] = (sampleBreakdown[source] ?? 0) + 1

      // 聚合判定：循环内任一迭代 FAIL 则该 Run 记 FAIL；任一 UNKNOWN 记 UNKNOWN；全 PASS 记 PASS
      const hasFail = evals.some((e) => e.verdict === 'FAIL')
      const hasUnknown = evals.some((e) => e.verdict === 'UNKNOWN')

      if (hasFail) {
        failCount += 1
        if (run.status === 'SUCCEEDED') {
          inspectionalFailCount += 1
        }
      } else if (hasUnknown) {
        unknownCount += 1
      } else {
        passCount += 1
      }

      // 收集数值/耗时类 actual 序列
      for (const e of evals) {
        if (typeof e.actual === 'number' && !Number.isNaN(e.actual)) {
          actualNumbers.push(e.actual)
        } else if (typeof e.actual === 'string' && e.actual.trim() !== '' && !Number.isNaN(Number(e.actual))) {
          actualNumbers.push(Number(e.actual))
        }
      }
    }

    let actualDistribution: ActualDistribution | undefined
    if (actualNumbers.length > 0) {
      actualNumbers.sort((a, b) => a - b)
      const isDuration = contract.rule.kind === 'step_duration' || contract.rule.kind === 'run_duration'
      actualDistribution = {
        min: actualNumbers[0]!,
        max: actualNumbers[actualNumbers.length - 1]!,
        p50: computePercentile(actualNumbers, 0.5),
        p95: computePercentile(actualNumbers, 0.95),
        unitHint: isDuration ? 'ms' : undefined,
      }
    }

    const suggestions = suggestOutcomeTuning(contract, {
      sampleCount,
      passCount,
      failCount,
      unknownCount,
      inspectionalFailCount,
      actualDistribution,
      manifestRunCount,
    })

    insights.push({
      contractId: contract.id,
      meaning: contract.meaning,
      scope: contract.scope,
      sampleCount,
      sampleBreakdown,
      passCount,
      failCount,
      unknownCount,
      inspectionalFailCount,
      actualDistribution,
      priorSegmentSampleCount: priorSegmentSampleCount > 0 ? priorSegmentSampleCount : undefined,
      suggestions,
    })
  }

  return {
    scenarioId: input.scenarioId,
    insights,
  }
}
