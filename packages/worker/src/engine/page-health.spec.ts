import { describe, expect, it } from 'vitest'
import { createRuntimeInvariant, defaultPageHealthInvariants, type RunSnapshot } from '@cairn/shared'
import { clearPageHealthRun, collectPageHealthResults, evaluatePageRequests, pageHealthOverflowOf } from './page-health.js'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const snapshotOf = (entries = defaultPageHealthInvariants(() => id(1))) =>
  ({ runtimeInvariantManifest: { entries } }) as unknown as RunSnapshot
const drainWith = (total: number) => ({
  dropped: 0,
  network: {
    kind: 'network_health' as const,
    total,
    byClass: { '5xx': total },
    samples: [{ type: 'http' as const, method: 'GET', url: 'https://a/x', status: 500, count: total, stepId: id(5) }],
  },
})

describe('collectPageHealthResults', () => {
  it('无违规不产生任何行或证据', () => {
    expect(collectPageHealthResults({ runId: 'r0', snapshot: snapshotOf(), drain: { dropped: 0 }, now: new Date() })).toEqual({ results: [], halt: false })
    expect(collectPageHealthResults({ runId: 'r0', snapshot: snapshotOf(), drain: undefined, now: new Date() }).results).toEqual([])
  })

  it('有违规：FAIL 行指向同一条证据，SHOULD 默认不停止', () => {
    const collected = collectPageHealthResults({ runId: 'r1', snapshot: snapshotOf(), drain: drainWith(2), now: new Date() })
    expect(collected.results).toHaveLength(1)
    expect(collected.results[0]).toMatchObject({ verdict: 'FAIL', severity: 'SHOULD', onViolation: 'continue', provenance: 'runtime_invariant' })
    expect(collected.results[0]!.evidenceId).toBe(collected.evidence!.evidenceId)
    expect(collected.halt).toBe(false)
    clearPageHealthRun('r1')
  })

  it('调成 MUST + 停止时 halt', () => {
    const must = { ...createRuntimeInvariant('network_health', id(2)), severity: 'MUST' as const, onViolation: 'halt' as const }
    expect(collectPageHealthResults({ runId: 'r2', snapshot: snapshotOf([must]), drain: drainWith(1), now: new Date() }).halt).toBe(true)
    clearPageHealthRun('r2')
  })

  it('每次运行最多逐条落 50 次，其余只计入汇总', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(collectPageHealthResults({ runId: 'r3', snapshot: snapshotOf(), drain: drainWith(1), now: new Date() }).results).toHaveLength(1)
    }
    const over = collectPageHealthResults({ runId: 'r3', snapshot: snapshotOf(), drain: drainWith(3), now: new Date() })
    expect(over.results).toEqual([])
    expect(over.evidence).toBeUndefined()
    expect(pageHealthOverflowOf('r3')).toBe(3)
    clearPageHealthRun('r3')
  })
})

describe('evaluatePageRequests', () => {
  const entry = (rule: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    contractId: id(50), scope: 'step', meaning: '提交后必须调用下单接口', severity: 'MUST', onViolation: 'halt', provenance: 'manual',
    stepId: id(60), rule: { kind: 'page_request', status: '2xx', ...rule }, ...extra,
  })
  const snapshot = (entries: unknown[]) => ({ outcomeManifest: { entries } }) as unknown as RunSnapshot
  const hit = (over: Record<string, unknown> = {}) => ({ method: 'POST', url: 'https://a/api/order/*', status: 200, durationMs: 80, rules: [0], stepId: id(60), ...over })
  const instant = async () => undefined

  it('已满足：立即通过，不等宽限期', async () => {
    let sleeps = 0
    const out = await evaluatePageRequests({
      snapshot: snapshot([entry({ match: '/api/order/*', method: 'POST' })]), stepId: id(60), now: () => new Date(),
      peek: () => [hit()] as never, sleep: async () => { sleeps += 1 },
    })
    expect(out.results[0]).toMatchObject({ verdict: 'PASS', provenance: 'manual', scope: 'step' })
    expect(out.results[0]!.evidenceId).toBe(out.evidence!.evidenceId)
    expect(out.halt).toBe(false)
    expect(sleeps).toBe(0)
  })

  it('宽限期内请求才出现：等到了就通过；一直没有则到期判失败并按配置停止', async () => {
    let calls = 0
    const late = await evaluatePageRequests({
      snapshot: snapshot([entry({ match: '/api/order/*', graceMs: 1000 })]), stepId: id(60), now: () => new Date(),
      peek: () => (++calls < 4 ? [] : [hit()]) as never, sleep: instant,
    })
    expect(late.results[0]!.verdict).toBe('PASS')
    const never = await evaluatePageRequests({
      snapshot: snapshot([entry({ match: '/api/order/*', graceMs: 300 })]), stepId: id(60), now: () => new Date(),
      peek: () => [] as never, sleep: instant,
    })
    expect(never.results[0]).toMatchObject({ verdict: 'FAIL' })
    expect((never.results[0]!.actual as { reason: string }).reason).toBe('步骤期间没有出现该请求')
    expect(never.halt).toBe(true)
    const soft = await evaluatePageRequests({
      snapshot: snapshot([entry({ match: '/api/order/*', graceMs: 0 }, { severity: 'SHOULD', onViolation: 'continue' })]), stepId: id(60), now: () => new Date(),
      peek: () => [] as never, sleep: instant,
    })
    expect(soft.halt).toBe(false)
  })

  it('采集器不可用判无法判断，不判失败；只处理本步骤的条件', async () => {
    const out = await evaluatePageRequests({
      snapshot: snapshot([entry({ match: '/a' }), entry({ match: '/b' }, { contractId: id(51), stepId: id(61) })]), stepId: id(60), now: () => new Date(),
      peek: () => undefined, sleep: instant,
    })
    expect(out.results).toHaveLength(1)
    expect(out.results[0]).toMatchObject({ contractId: id(50), verdict: 'UNKNOWN' })
    expect(out.halt).toBe(false)
    expect((await evaluatePageRequests({ snapshot: snapshot([]), stepId: id(60), now: () => new Date(), peek: () => [] as never })).results).toEqual([])
  })
})
