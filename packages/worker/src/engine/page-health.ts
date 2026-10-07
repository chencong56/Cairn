import { randomUUID } from 'node:crypto'
import type { OutcomeResultInsertItem } from '@cairn/db'
import {
  DEFAULT_PAGE_REQUEST_GRACE_MS,
  MAX_PAGE_HEALTH_RECORDED_WINDOWS,
  describePageRequestRule,
  evaluatePageRequestRule,
  pageRequestEntriesOf,
  type WatchedRequest,
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

// ---------------------------------------------------------------------------
// 成功条件 page_request：步骤尝试结束时按采集到的请求求值
// ---------------------------------------------------------------------------

export type PageRequestCollected = {
  results: OutcomeResultInsertItem[]
  evidence?: { evidenceId: string; payload: JsonValue }
  /** 有不满足的条件且配置为「违反即停止」。 */
  halt: boolean
}

const PAGE_REQUEST_POLL_MS = 100
const PAGE_REQUEST_SAMPLES = 10

/** 该步骤上的 page_request 条件（下标 = 采集器关注清单下标，即快照里 page_request 条件的顺序）。 */
export function pageRequestEntriesForStep(snapshot: RunSnapshot, stepId: string) {
  return pageRequestEntriesOf(snapshot.outcomeManifest)
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.stepId === stepId)
}

function requestSample(request: WatchedRequest): JsonValue {
  return JSON.parse(
    JSON.stringify({
      method: request.method,
      url: request.url,
      status: request.status,
      ...(request.durationMs !== undefined ? { durationMs: request.durationMs } : {}),
      ...(request.failed ? { failed: true } : {}),
    }),
  ) as JsonValue
}

/**
 * 求值本步骤上的页面请求条件。规则带宽限期（默认 3 秒）：只要还有条件没满足就轮询等待，到期仍不满足才判不通过。
 * 采集器不可用（没挂上 / 会话重建丢了监听）时判「无法判断」，不能判失败。
 */
export async function evaluatePageRequests(input: {
  snapshot: RunSnapshot
  stepId: string
  now: () => Date
  peek: () => WatchedRequest[] | undefined
  signal?: AbortSignal
  sleep?: (ms: number) => Promise<void>
}): Promise<PageRequestCollected> {
  const entries = pageRequestEntriesForStep(input.snapshot, input.stepId)
  if (entries.length === 0) return { results: [], halt: false }
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const graceMs = Math.max(...entries.map(({ entry }) => entry.rule.graceMs ?? DEFAULT_PAGE_REQUEST_GRACE_MS))
  const evaluateAll = () => {
    const requests = input.peek()
    if (requests === undefined) return undefined
    return entries.map(({ entry, index }) =>
      evaluatePageRequestRule(entry.rule, requests.filter((request) => request.rules?.includes(index)), { prematched: true }),
    )
  }
  let evaluations = evaluateAll()
  let waited = 0
  while (evaluations?.some((item) => item.verdict === 'FAIL') && waited < graceMs && !input.signal?.aborted) {
    const step = Math.min(PAGE_REQUEST_POLL_MS, graceMs - waited)
    await sleep(step)
    waited += step
    evaluations = evaluateAll()
  }

  const evidenceId = randomUUID()
  const now = input.now()
  const results: OutcomeResultInsertItem[] = []
  let halt = false
  const evidenceEntries: JsonValue[] = []
  entries.forEach(({ entry }, position) => {
    const evaluation = evaluations?.[position]
    const verdict = evaluation ? evaluation.verdict : 'UNKNOWN'
    const reason = evaluation?.reason ?? (evaluation ? undefined : '请求采集器不可用，无法判断')
    const matched = (evaluation?.matched ?? []).slice(-PAGE_REQUEST_SAMPLES).map(requestSample)
    results.push({
      contractId: entry.contractId,
      scope: entry.scope,
      meaning: entry.meaning,
      severity: entry.severity,
      onViolation: entry.onViolation,
      provenance: entry.provenance,
      verdict,
      expected: describePageRequestRule(entry.rule),
      actual: {
        matchedCount: evaluation?.matched.length ?? 0,
        satisfied: evaluation?.satisfied ?? 0,
        ...(reason ? { reason } : {}),
        samples: matched,
      } as unknown as JsonValue,
      evidenceId,
      details: { ...(reason ? { reason } : {}), waitedMs: waited },
      evaluatedAt: now,
    })
    evidenceEntries.push({ contractId: entry.contractId, verdict, ...(reason ? { reason } : {}), requests: matched })
    if (verdict === 'FAIL' && entry.onViolation === 'halt') halt = true
  })
  return {
    results,
    evidence: { evidenceId, payload: { role: 'page_requests', entries: evidenceEntries } },
    halt,
  }
}
