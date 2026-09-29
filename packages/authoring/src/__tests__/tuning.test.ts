import { describe, expect, it } from 'vitest'
import type { OutcomeContract } from '@cairn/shared'
import { suggestOutcomeTuning, type OutcomeHistoricalStats } from '../tuning.js'

describe('suggestOutcomeTuning (表驱动历史驱动条件调优规则测试)', () => {
  const durationContract: OutcomeContract = {
    id: '01910000-0000-7000-8000-000000000001',
    scope: 'scenario',
    meaning: '全程耗时不超过 3000ms',
    rule: { kind: 'run_duration', op: 'lte', valueMs: 3_000 },
    severity: 'SHOULD',
    onViolation: 'continue',
    provenance: 'manual',
  }

  const numericContract: OutcomeContract = {
    id: '01910000-0000-7000-8000-000000000002',
    scope: 'step',
    meaning: '数值差值不超过 0',
    rule: {
      kind: 'context',
      key: 'diff',
      expect: { kind: 'number_compare', op: 'eq', value: 0 },
    },
    severity: 'MUST',
    onViolation: 'continue',
    provenance: 'ai_compiled',
  }

  const textContract: OutcomeContract = {
    id: '01910000-0000-7000-8000-000000000003',
    scope: 'step',
    meaning: '页面包含成功标识',
    rule: {
      kind: 'deterministic',
      expect: { kind: 'text_contains', value: 'Success' },
    },
    severity: 'MUST',
    onViolation: 'continue',
    provenance: 'manual',
  }

  it('样本数不足 10 次不产生建议（避免小样本噪声）', () => {
    const stats: OutcomeHistoricalStats = {
      sampleCount: 8,
      passCount: 4,
      failCount: 4,
      unknownCount: 0,
      inspectionalFailCount: 4, // 50% 失败率但样本不足 10
      actualDistribution: { p50: 3200, p95: 4500, min: 2800, max: 5000 },
    }
    const suggestions = suggestOutcomeTuning(durationContract, stats)
    expect(suggestions).toEqual([])
  })

  it('规则 1 (误报放宽)：耗时类巡检型失败率 >= 30% 且 P95 > 阈值时建议阶梯放宽阈值', () => {
    const stats: OutcomeHistoricalStats = {
      sampleCount: 20,
      passCount: 12,
      failCount: 8,
      unknownCount: 0,
      inspectionalFailCount: 8, // 8 / 20 = 40% >= 30%
      actualDistribution: { p50: 2800, p95: 4200, min: 2000, max: 4800 },
    }
    const suggestions = suggestOutcomeTuning(durationContract, stats)
    expect(suggestions).toHaveLength(1)
    const sug = suggestions[0]!
    expect(sug.kind).toBe('loosen_threshold')
    expect(sug.ruleName).toBe('误报放宽')
    expect(sug.fromValue).toBe(3000)
    // 4200 落在 1s~10s 区间，向上整 500 => 4500
    expect(sug.toValue).toBe(4500)
    expect(sug.suggestedPatch?.rule).toEqual({
      kind: 'run_duration',
      op: 'lte',
      valueMs: 4500,
    })
  })

  it('规则 1 (误报放宽)：数值一致类 context 容差建议调整为 P95 向上取整并将 eq 调整为 lte', () => {
    const stats: OutcomeHistoricalStats = {
      sampleCount: 15,
      passCount: 9,
      failCount: 6,
      unknownCount: 0,
      inspectionalFailCount: 6, // 40%
      actualDistribution: { p50: 2.1, p95: 5.4, min: 0, max: 6 },
    }
    const suggestions = suggestOutcomeTuning(numericContract, stats)
    expect(suggestions).toHaveLength(1)
    const sug = suggestions[0]!
    expect(sug.kind).toBe('loosen_threshold')
    expect(sug.fromValue).toBe(0)
    expect(sug.toValue).toBe(6) // ceil(5.4) = 6
    expect(sug.suggestedPatch?.rule).toEqual({
      kind: 'context',
      key: 'diff',
      expect: { kind: 'number_compare', op: 'lte', value: 6 },
    })
  })

  it('规则 1 (降严重度)：非阈值类 MUST 条件误报率高时建议降级为 SHOULD', () => {
    const stats: OutcomeHistoricalStats = {
      sampleCount: 10,
      passCount: 6,
      failCount: 4,
      unknownCount: 0,
      inspectionalFailCount: 4, // 40%
    }
    const suggestions = suggestOutcomeTuning(textContract, stats)
    expect(suggestions).toHaveLength(1)
    const sug = suggestions[0]!
    expect(sug.kind).toBe('lower_severity')
    expect(sug.fromValue).toBe('MUST')
    expect(sug.toValue).toBe('SHOULD')
    expect(sug.suggestedPatch?.severity).toBe('SHOULD')
  })

  it('规则 2 (度量缺失)：UNKNOWN 率 >= 30% 时提示度量缺失，不修改契约阈值', () => {
    const stats: OutcomeHistoricalStats = {
      sampleCount: 20,
      passCount: 10,
      failCount: 2,
      unknownCount: 8, // 40% >= 30%
      inspectionalFailCount: 2, // 10% 未达误报线
    }
    const suggestions = suggestOutcomeTuning(durationContract, stats)
    expect(suggestions).toHaveLength(1)
    const sug = suggestions[0]!
    expect(sug.kind).toBe('measurement_missing')
    expect(sug.suggestedPatch).toBeUndefined()
  })

  it('规则 3 (死条件)：场景已运行 10+ 次但条件 0 次求值时提示死条件', () => {
    const stats: OutcomeHistoricalStats = {
      sampleCount: 0,
      passCount: 0,
      failCount: 0,
      unknownCount: 0,
      inspectionalFailCount: 0,
      totalScenarioRuns: 12,
    }
    const suggestions = suggestOutcomeTuning(durationContract, stats)
    expect(suggestions).toHaveLength(1)
    const sug = suggestions[0]!
    expect(sug.kind).toBe('dead_condition')
    expect(sug.suggestedPatch).toBeUndefined()
  })

  it('规则 4 (阈值收紧)：耗时类 PASS 率 100% 且实际耗时最大值 <= 阈值 50% 建议收紧', () => {
    const stats: OutcomeHistoricalStats = {
      sampleCount: 30,
      passCount: 30,
      failCount: 0,
      unknownCount: 0,
      inspectionalFailCount: 0,
      actualDistribution: { p50: 800, p95: 1100, min: 600, max: 1200 }, // max 1200 <= 3000 * 0.5 (1500)
    }
    const suggestions = suggestOutcomeTuning(durationContract, stats)
    expect(suggestions).toHaveLength(1)
    const sug = suggestions[0]!
    expect(sug.kind).toBe('tighten_threshold')
    expect(sug.ruleName).toBe('阈值收紧')
    expect(sug.fromValue).toBe(3000)
    // p95 = 1100 * 1.2 = 1320, 向上取整到整 500 => 1500
    expect(sug.toValue).toBe(1500)
    expect(sug.suggestedPatch?.rule).toEqual({
      kind: 'run_duration',
      op: 'lte',
      valueMs: 1500,
    })
  })

  it('规则优先级：误报放宽 > 度量缺失 > 死条件 > 收紧', () => {
    // 同时满足误报放宽与度量缺失时，取误报放宽
    const stats: OutcomeHistoricalStats = {
      sampleCount: 20,
      passCount: 4,
      failCount: 8,
      unknownCount: 8, // unknown 40%
      inspectionalFailCount: 8, // inspectionalFail 40%
      actualDistribution: { p50: 3500, p95: 4800, min: 2500, max: 5000 },
    }
    const suggestions = suggestOutcomeTuning(durationContract, stats)
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]!.kind).toBe('loosen_threshold')
  })
})
