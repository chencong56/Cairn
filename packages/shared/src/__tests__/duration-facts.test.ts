import { describe, expect, it } from 'vitest'
import {
  attributeDurationDifference,
  formatDurationShort,
  nodeDurationFactsSchema,
  runDurationFactsSchema,
  summarizeDurationDifference,
  type DurationComparisonSide,
  type NodeDurationFacts,
} from '../duration-facts.js'

function node(partial: Partial<NodeDurationFacts> & Pick<NodeDurationFacts, 'nodeKey' | 'activeMs'>): NodeDurationFacts {
  return {
    parentKey: null,
    kind: 'step',
    name: partial.nodeKey,
    ordinal: 0,
    status: 'SUCCEEDED',
    windowMs: partial.activeMs,
    attemptCount: 1,
    iterationCount: 1,
    maxResolution: 'deterministic',
    ...partial,
  }
}

function side(facts: Partial<DurationComparisonSide['facts']>, nodes: NodeDurationFacts[]): DurationComparisonSide {
  return {
    facts: {
      totalMs: 20_000,
      activeMs: 18_000,
      authWaitMs: 0,
      requeueMs: 0,
      reviewMs: 0,
      holdMs: 0,
      unclassifiedMs: 0,
      queueMs: 1_000,
      overheadMs: 2_000,
      complete: true,
      workerLost: false,
      scenarioVersionId: 'v1',
      ...facts,
    },
    nodes,
  }
}

describe('耗时差异归因', () => {
  it('总差值拆成等待与执行，执行差值落到节点并带重试标签，摘要按模板输出', () => {
    const base = side({ totalMs: 20_000, activeMs: 18_000 }, [
      node({ nodeKey: 'step:open', name: '打开报表', activeMs: 6_000 }),
      node({ nodeKey: 'step:query', name: '查询报表', activeMs: 10_000 }),
    ])
    const target = side({ totalMs: 62_000, activeMs: 25_000, authWaitMs: 35_000 }, [
      node({ nodeKey: 'step:open', name: '打开报表', activeMs: 6_500 }),
      node({ nodeKey: 'step:query', name: '查询报表', activeMs: 16_000, attemptCount: 3 }),
    ])
    const attribution = attributeDurationDifference(base, target)
    expect(attribution.totalDeltaMs).toBe(42_000)
    expect(attribution.components.authWait.delta).toBe(35_000)
    expect(attribution.components.active.delta).toBe(7_000)
    expect(attribution.nodes[0]).toMatchObject({ nodeKey: 'step:query', deltaMs: 6_000, deltaPct: 60, tags: [{ kind: 'retries', from: 0, to: 2 }] })
    expect(summarizeDurationDifference(attribution)).toBe('本次比上次慢 42s：等待 +35s（认证等待），执行 +7.0s，其中『查询报表』+6.0s（重试 0→2 次）')
  })

  it('迭代次数变化给出单次迭代涨跌，区分数据量变化与变慢；定位层级变化单列', () => {
    const base = side({}, [node({ nodeKey: 'step:row', activeMs: 20_000, iterationCount: 20, attemptCount: 20 })])
    const target = side({}, [node({ nodeKey: 'step:row', activeMs: 45_000, iterationCount: 45, attemptCount: 45, maxResolution: 'ai' })])
    const [delta] = attributeDurationDifference(base, target).nodes
    expect(delta!.tags).toEqual([
      { kind: 'iterations', from: 20, to: 45, perIterationDeltaPct: 0 },
      { kind: 'resolution', from: 'deterministic', to: 'ai' },
    ])
  })

  it('新增 / 删除节点与版本变化被标出；缺分解时摘要注明', () => {
    const base = side({ scenarioVersionId: 'v1' }, [node({ nodeKey: 'step:old', activeMs: 3_000 })])
    const target = side({ scenarioVersionId: 'v2', complete: false, activeMs: null, totalMs: 15_000 }, [node({ nodeKey: 'step:new', activeMs: 2_000 })])
    const attribution = attributeDurationDifference(base, target)
    expect(attribution.context.versionChanged).toBe(true)
    expect(attribution.context.incomplete).toEqual({ base: false, target: true })
    expect(attribution.nodes.find((item) => item.nodeKey === 'step:new')!.tags).toEqual([{ kind: 'added' }])
    expect(attribution.nodes.find((item) => item.nodeKey === 'step:old')!.tags).toEqual([{ kind: 'removed' }])
    expect(summarizeDurationDifference(attribution)).toBe('本次比上次快 5.0s（场景版本不同；部分耗时无分解）')
  })

  it('差值不足 1 秒视为持平；可换成时间窗用语', () => {
    const attribution = attributeDurationDifference(side({ totalMs: 20_000 }, []), side({ totalMs: 20_400 }, []))
    expect(summarizeDurationDifference(attribution, { target: '本期', base: '上期' })).toBe('本期与上期耗时基本持平（+400ms）')
  })

  it('时长短文案覆盖毫秒到小时', () => {
    expect([850, 4_200, 42_000, 192_000, 3_900_000].map(formatDurationShort)).toEqual(['850ms', '4.2s', '42s', '3m12s', '1h05m'])
  })

  it('事实契约：分解可为空，节点键长度受限', () => {
    expect(
      runDurationFactsSchema.safeParse({
        runId: '00000000-0000-4000-8000-000000000001',
        targetId: '00000000-0000-4000-8000-000000000002',
        scenarioId: '00000000-0000-4000-8000-000000000003',
        scenarioVersionId: '00000000-0000-4000-8000-000000000004',
        suiteRunId: null,
        triggerSource: 'schedule',
        comparable: true,
        status: 'SUCCEEDED',
        finishedAt: '2026-10-07T08:00:00.000Z',
        totalMs: 1000,
        activeMs: null,
        authWaitMs: null,
        requeueMs: null,
        reviewMs: null,
        holdMs: null,
        unclassifiedMs: null,
        queueMs: 10,
        overheadMs: null,
        workerLost: false,
        complete: false,
        incompleteReason: 'no_events',
        calcVersion: 1,
      }).success,
    ).toBe(true)
    expect(nodeDurationFactsSchema.safeParse(node({ nodeKey: 'x'.repeat(193), activeMs: 1 })).success).toBe(false)
  })
})
