import { describe, expect, it } from 'vitest'
import { createRuntimeInvariant, defaultPageHealthInvariants, type RunSnapshot } from '@cairn/shared'
import { clearPageHealthRun, collectPageHealthResults, pageHealthOverflowOf } from './page-health.js'

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
