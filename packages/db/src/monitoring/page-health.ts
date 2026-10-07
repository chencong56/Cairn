import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import {
  MONITOR_PAGE_HEALTH_ROW_LIMIT,
  MONITOR_PAGE_HEALTH_WINDOW_MINUTES,
  isPageHealthResult,
  pageHealthFactFromResult,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { jsonHasKey, schemaFor } from '../native.js'

export type TargetPageHealth = {
  /** 接口耗时超过阈值的处数。 */
  slowCount: number
  /** 接口 4xx / 5xx / 请求失败的处数（不含耗时超阈与脚本异常）。 */
  errorCount: number
  /** 有任意页面健康违规（含脚本异常）的运行数。 */
  violatingRuns: number
  /** 带运行期约束的已结束运行数（占比的分母）。 */
  runsWithGuards: number
  /** 违规行达到聚合上限，数字是下限。 */
  truncated: boolean
}

/**
 * 近 60 分钟、按目标的页面健康聚合（监控采样、告警读数、SLA 卡片共用）。
 *
 * 只读 outcome_results 与 runs：违规行的 JSON 在应用层解析（不在 SQL 里按 JSON 字段过滤，保持可移植）；
 * 分母用「快照含 runtimeInvariantManifest 的已结束运行」。窗口内没有带约束的运行、也没有违规的目标不返回，
 * 调用方据此不写样本（没有数据不等于 0）。
 */
export async function summarizeTargetPageHealth(
  db: Db,
  asOf: Date,
  windowMinutes = MONITOR_PAGE_HEALTH_WINDOW_MINUTES,
): Promise<Map<string, TargetPageHealth>> {
  const { outcomeResults, runs } = schemaFor(db)
  const since = new Date(asOf.getTime() - windowMinutes * 60_000)

  const rows = await db
    .select({
      runId: outcomeResults.runId,
      targetId: runs.targetId,
      expected: outcomeResults.expected,
      actual: outcomeResults.actual,
    })
    .from(outcomeResults)
    .innerJoin(runs, eq(runs.id, outcomeResults.runId))
    .where(
      and(
        eq(outcomeResults.provenance, 'runtime_invariant'),
        sql`${outcomeResults.evaluatedAt} >= ${since}`,
        isNull(runs.deletedAt),
      ),
    )
    .orderBy(desc(outcomeResults.evaluatedAt))
    .limit(MONITOR_PAGE_HEALTH_ROW_LIMIT)

  const guardedRuns = await db
    .select({ targetId: runs.targetId, total: sql`count(*)` })
    .from(runs)
    .where(
      and(
        sql`${runs.createdAt} >= ${since}`,
        isNull(runs.deletedAt),
        inArray(runs.status, ['SUCCEEDED', 'FAILED']),
        jsonHasKey(db, runs.snapshot, 'runtimeInvariantManifest'),
      ),
    )
    .groupBy(runs.targetId)

  const result = new Map<string, TargetPageHealth>()
  const ensure = (targetId: string): TargetPageHealth => {
    let entry = result.get(targetId)
    if (!entry) {
      entry = { slowCount: 0, errorCount: 0, violatingRuns: 0, runsWithGuards: 0, truncated: false }
      result.set(targetId, entry)
    }
    return entry
  }
  for (const row of guardedRuns) ensure(row.targetId).runsWithGuards = Number(row.total ?? 0)

  const violatingByTarget = new Map<string, Set<string>>()
  for (const row of rows) {
    if (!isPageHealthResult(row)) continue
    const fact = pageHealthFactFromResult(row)
    if (!fact) continue
    const entry = ensure(row.targetId)
    const runs = violatingByTarget.get(row.targetId) ?? new Set<string>()
    runs.add(row.runId)
    violatingByTarget.set(row.targetId, runs)
    if (fact.kind === 'network_health') {
      const slow = fact.byClass.slow ?? 0
      entry.slowCount += slow
      entry.errorCount += Math.max(0, fact.total - slow)
    }
    if (rows.length >= MONITOR_PAGE_HEALTH_ROW_LIMIT) entry.truncated = true
  }
  for (const [targetId, runIds] of violatingByTarget) ensure(targetId).violatingRuns = runIds.size

  for (const [targetId, entry] of result) {
    if (entry.runsWithGuards === 0 && entry.violatingRuns === 0) result.delete(targetId)
  }
  return result
}

/** 页面健康违规运行占比（0–100，取整）；没有带约束的运行时为 null（不写样本）。 */
export function pageHealthRunRate(entry: Pick<TargetPageHealth, 'violatingRuns' | 'runsWithGuards'>): number | null {
  if (entry.runsWithGuards <= 0) return null
  return Math.min(100, Math.round((entry.violatingRuns / entry.runsWithGuards) * 100))
}
