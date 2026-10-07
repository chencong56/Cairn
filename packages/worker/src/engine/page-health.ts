import { randomUUID } from 'node:crypto'
import type { OutcomeResultInsertItem } from '@cairn/db'
import {
  MAX_PAGE_HEALTH_RECORDED_WINDOWS,
  PAGE_HEALTH_RESULT_SAMPLES,
  isPageHealthKind,
  pageHealthFactToJson,
  pageHealthSampleLine,
  type JsonValue,
  type PageHealthDrain,
  type PageHealthFact,
  type RuntimeInvariant,
  type RunSnapshot,
} from '@cairn/shared'

export function pageHealthInvariants(snapshot: RunSnapshot): RuntimeInvariant[] {
  return (snapshot.runtimeInvariantManifest?.entries ?? []).filter((item) => isPageHealthKind(item.kind))
}

/** 每次运行最多为这么多个有违规的取数逐条落结果行与证据，其余只进汇总。 */
const recordedWindows = new Map<string, { recorded: number; overflow: number }>()
const MAX_TRACKED_RUNS = 1000

function counterFor(runId: string): { recorded: number; overflow: number } {
  let counter = recordedWindows.get(runId)
  if (!counter) {
    if (recordedWindows.size >= MAX_TRACKED_RUNS) {
      const oldest = recordedWindows.keys().next().value
      if (oldest !== undefined) recordedWindows.delete(oldest)
    }
    counter = { recorded: 0, overflow: 0 }
    recordedWindows.set(runId, counter)
  }
  return counter
}

export function pageHealthOverflowOf(runId: string): number {
  return recordedWindows.get(runId)?.overflow ?? 0
}

export function clearPageHealthRun(runId: string): void {
  recordedWindows.delete(runId)
}

export type PageHealthCollected = {
  results: OutcomeResultInsertItem[]
  evidence?: { evidenceId: string; payload: JsonValue }
  /** 用户把约束调成 MUST + 停止，且确有违规。 */
  halt: boolean
}

/**
 * 把一次取数的违规落成结果行与一条 Attempt 级证据。没有违规返回空，不写 PASS。
 * 结果行锚在取数时的 StepRun / Attempt；「哪一步出的错」以样本里的发起步骤为准。
 */
export function collectPageHealthResults(input: {
  runId: string
  snapshot: RunSnapshot
  drain: PageHealthDrain | undefined
  now: Date
}): PageHealthCollected {
  const empty: PageHealthCollected = { results: [], halt: false }
  if (!input.drain) return empty
  const facts: PageHealthFact[] = [input.drain.network, input.drain.script].filter(
    (fact): fact is PageHealthFact => Boolean(fact && fact.total > 0),
  )
  if (facts.length === 0) return empty

  const counter = counterFor(input.runId)
  if (counter.recorded >= MAX_PAGE_HEALTH_RECORDED_WINDOWS) {
    counter.overflow += facts.reduce((sum, fact) => sum + fact.total, 0)
    return empty
  }
  counter.recorded += 1

  const evidenceId = randomUUID()
  const results: OutcomeResultInsertItem[] = []
  let halt = false
  for (const fact of facts) {
    const invariant = pageHealthInvariants(input.snapshot).find((item) => item.kind === fact.kind)
    if (!invariant) continue
    const shown: PageHealthFact = { ...fact, samples: fact.samples.slice(0, PAGE_HEALTH_RESULT_SAMPLES) }
    results.push({
      contractId: invariant.id,
      scope: 'scenario',
      meaning: invariant.meaning,
      severity: invariant.severity,
      onViolation: invariant.onViolation,
      provenance: 'runtime_invariant',
      verdict: 'FAIL',
      expected: { kind: fact.kind, violations: 0 },
      actual: pageHealthFactToJson(shown),
      evidenceId,
      details: {
        evaluateAt: invariant.evaluateAt,
        summaryText: fact.samples.slice(0, 3).map(pageHealthSampleLine).join('；'),
      },
      evaluatedAt: input.now,
    })
    if (invariant.onViolation === 'halt') halt = true
  }
  if (results.length === 0) return empty
  return {
    results,
    evidence: {
      evidenceId,
      payload: {
        role: 'page_health',
        facts: facts.map((fact) => pageHealthFactToJson(fact)),
        ...(input.drain.dropped > 0 ? { dropped: input.drain.dropped } : {}),
      },
    },
    halt,
  }
}

export const PAGE_HEALTH_VIOLATED = {
  code: 'PAGE_HEALTH_VIOLATED',
  category: 'VALIDATION' as const,
  retryable: false,
  safeMessage: '页面出现接口或脚本错误，运行期约束要求停止后续步骤',
}
