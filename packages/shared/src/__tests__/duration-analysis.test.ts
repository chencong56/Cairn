import { describe, expect, it } from 'vitest'
import {
  detectNodeInsights,
  detectScenarioInsights,
  durationAnalysisQuerySchema,
  durationDeltaPct,
  durationPercentile,
  ratioPointsDelta,
  type DurationComparison,
  type NodeInsightStats,
  type ScenarioInsightStats,
} from '../duration-analysis.js'

const SCENARIO = { scenarioId: '33333333-3333-4333-8333-333333333333', scenarioName: '下单巡检' }
const NODE = { ...SCENARIO, nodeKey: 'step:a', nodeName: '查询订单' }

function cmp(current: number | null, base: number | null, samples = 20, deltaPct?: number | null): DurationComparison {
  return {
    current,
    base,
    deltaPct: deltaPct === undefined ? durationDeltaPct(current, base, samples, samples) : deltaPct,
    currentSamples: samples,
    baseSamples: samples,
  }
}

function scenarioStats(overrides: Partial<ScenarioInsightStats> = {}): ScenarioInsightStats {
  return {
    activeP50: cmp(10_000, 10_000),
    activeP95: 12_000,
    waitRatio: cmp(0.05, 0.05, 20, 0),
    queueP50: cmp(1_000, 1_000),
    overheadP50: cmp(2_000, 2_000),
    versionSplit: null,
    ...overrides,
  }
}

function nodeStats(overrides: Partial<NodeInsightStats> = {}): NodeInsightStats {
  return {
    p50: cmp(4_000, 4_000),
    retryRate: cmp(0, 0, 20, 0),
    assistedRate: cmp(0, 0, 20, 0),
    medianIterations: { current: 1, base: 1 },
    perIterationP50: { current: 4_000, base: 4_000 },
    ...overrides,
  }
}

const kinds = (items: Array<{ kind: string }>) => items.map((item) => item.kind)

describe('duration analysis helpers', () => {
  it('nearest-rank percentile on sorted input', () => {
    expect(durationPercentile([], 50)).toBeNull()
    expect(durationPercentile([5], 95)).toBe(5)
    const sorted = Array.from({ length: 20 }, (_, i) => (i + 1) * 100)
    expect(durationPercentile(sorted, 50)).toBe(1_000)
    expect(durationPercentile(sorted, 95)).toBe(1_900)
    expect(durationPercentile(sorted, 100)).toBe(2_000)
    expect(durationPercentile(sorted, 0)).toBe(100)
  })

  it('delta needs enough samples on both sides and a positive base', () => {
    expect(durationDeltaPct(12_000, 10_000, 10, 10)).toBe(20)
    expect(durationDeltaPct(12_000, 10_000, 9, 10)).toBeNull()
    expect(durationDeltaPct(12_000, 10_000, 10, 9)).toBeNull()
    expect(durationDeltaPct(12_000, 0, 10, 10)).toBeNull()
    expect(durationDeltaPct(null, 10_000, 10, 10)).toBeNull()
    expect(durationDeltaPct(10_333, 10_000, 10, 10)).toBe(3.3)
  })

  it('ratio delta is in percentage points', () => {
    expect(ratioPointsDelta(0.25, 0.1, 10, 10)).toBe(15)
    expect(ratioPointsDelta(0.25, 0.1, 5, 10)).toBeNull()
    expect(ratioPointsDelta(null, 0.1, 10, 10)).toBeNull()
  })

  it('query defaults and only accepts 7 / 30 / 90 days', () => {
    expect(durationAnalysisQuerySchema.parse({})).toMatchObject({ days: 30, granularity: 'day', compare: 'prev_period', trigger: 'all' })
    expect(durationAnalysisQuerySchema.parse({ days: '90' }).days).toBe(90)
    expect(durationAnalysisQuerySchema.safeParse({ days: '14' }).success).toBe(false)
  })
})

describe('detectScenarioInsights', () => {
  it('stable scenario has no insights', () => {
    expect(detectScenarioInsights(SCENARIO, scenarioStats())).toEqual([])
  })

  it('flags slower / faster at ±20%', () => {
    expect(kinds(detectScenarioInsights(SCENARIO, scenarioStats({ activeP50: cmp(12_000, 10_000) })))).toEqual(['slower'])
    expect(detectScenarioInsights(SCENARIO, scenarioStats({ activeP50: cmp(12_000, 10_000) }))[0]?.message).toContain('执行变慢')
    expect(detectScenarioInsights(SCENARIO, scenarioStats({ activeP50: cmp(12_000, 10_000) }))[0]?.message).not.toContain('页面或系统性能变化')
    expect(kinds(detectScenarioInsights(SCENARIO, scenarioStats({ activeP50: cmp(11_900, 10_000) })))).toEqual([])
    expect(kinds(detectScenarioInsights(SCENARIO, scenarioStats({ activeP50: cmp(8_000, 10_000) })))).toEqual(['faster'])
    // 样本不足时 deltaPct 为 null，不下结论
    expect(detectScenarioInsights(SCENARIO, scenarioStats({ activeP50: cmp(30_000, 10_000, 5) }))).toEqual([])
  })

  it('wait ratio rise of 10 points points away from the page', () => {
    const [insight] = detectScenarioInsights(SCENARIO, scenarioStats({ waitRatio: cmp(0.3, 0.1, 20, 20) }))
    expect(insight?.kind).toBe('wait_increase')
    expect(insight?.message).toContain('10% → 30%')
    expect(insight).toMatchObject({ nodeKey: null, scenarioName: '下单巡检' })
  })

  it('queue and overhead need both a relative and an absolute increase', () => {
    expect(kinds(detectScenarioInsights(SCENARIO, scenarioStats({ queueP50: cmp(60_000, 20_000) })))).toEqual(['queue_increase'])
    // 涨了 3 倍但只多 20s，不够 30s 门槛
    expect(kinds(detectScenarioInsights(SCENARIO, scenarioStats({ queueP50: cmp(30_000, 10_000) })))).toEqual([])
    expect(kinds(detectScenarioInsights(SCENARIO, scenarioStats({ overheadP50: cmp(20_000, 5_000) })))).toEqual(['overhead_increase'])
    expect(kinds(detectScenarioInsights(SCENARIO, scenarioStats({ overheadP50: cmp(20_000, 5_000, 9) })))).toEqual([])
  })

  it('volatile when P95 ≥ 3×P50 with at least 20 samples', () => {
    expect(kinds(detectScenarioInsights(SCENARIO, scenarioStats({ activeP95: 30_000 })))).toEqual(['volatile'])
    expect(kinds(detectScenarioInsights(SCENARIO, scenarioStats({ activeP95: 30_000, activeP50: cmp(10_000, 10_000, 19) })))).toEqual([])
  })

  it('version change compares before / after the latest release in window', () => {
    const versionSplit = { before: 10_000, after: 13_000, beforeSamples: 10, afterSamples: 10, versionNo: 4 }
    const [insight] = detectScenarioInsights(SCENARIO, scenarioStats({ versionSplit }))
    expect(insight?.kind).toBe('version_change')
    expect(insight?.message).toContain('v4')
    expect(detectScenarioInsights(SCENARIO, scenarioStats({ versionSplit: { ...versionSplit, afterSamples: 9 } }))).toEqual([])
    expect(detectScenarioInsights(SCENARIO, scenarioStats({ versionSplit: { ...versionSplit, after: 11_000 } }))).toEqual([])
  })
})

describe('detectNodeInsights', () => {
  it('stable node has no insights', () => {
    expect(detectNodeInsights(NODE, nodeStats())).toEqual([])
  })

  it('slower node carries its node identity', () => {
    const [insight] = detectNodeInsights(NODE, nodeStats({ p50: cmp(6_000, 4_000) }))
    expect(insight).toMatchObject({ kind: 'slower', nodeKey: 'step:a', nodeName: '查询订单' })
  })

  it('more iterations with stable per-iteration time is volume change, not slower', () => {
    const stats = nodeStats({
      p50: cmp(8_000, 4_000),
      medianIterations: { current: 20, base: 10 },
      perIterationP50: { current: 410, base: 400 },
    })
    expect(kinds(detectNodeInsights(NODE, stats))).toEqual(['volume_change'])
    // 单次迭代也变慢了：仍是变慢
    expect(kinds(detectNodeInsights(NODE, { ...stats, perIterationP50: { current: 600, base: 400 } }))).toEqual(['slower'])
  })

  it('retry and assisted-locating rates rise by 10 points', () => {
    expect(kinds(detectNodeInsights(NODE, nodeStats({ retryRate: cmp(0.2, 0.05, 20, 15) })))).toEqual(['retry_increase'])
    expect(kinds(detectNodeInsights(NODE, nodeStats({ assistedRate: cmp(0.4, 0.1, 20, 30) })))).toEqual(['assist_increase'])
    expect(detectNodeInsights(NODE, nodeStats({ retryRate: cmp(0.1, 0.05, 20, 5) }))).toEqual([])
  })

  it('单次模型 / 页面 P50 涨超 20% 才发 model_increase / page_increase', () => {
    expect(kinds(detectNodeInsights(NODE, nodeStats({ modelPerAttempt: cmp(6_000, 4_000) })))).toEqual(['model_increase'])
    expect(kinds(detectNodeInsights(NODE, nodeStats({ pagePerAttempt: cmp(3_000, 2_000) })))).toEqual(['page_increase'])
    expect(kinds(detectNodeInsights(NODE, nodeStats({ modelPerAttempt: cmp(4_400, 4_000) })))).toEqual([])
  })
})
