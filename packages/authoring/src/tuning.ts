import {
  OUTCOME_TUNING_RULES,
  roundLadderMs,
  type AcceptanceTuningSuggestion,
  type ActualDistribution,
  type OutcomeContract,
} from '@cairn/shared'

export interface OutcomeHistoricalStats {
  sampleCount: number
  passCount: number
  failCount: number
  unknownCount: number
  inspectionalFailCount: number
  actualDistribution?: ActualDistribution
  totalScenarioRuns?: number
}

/**
 * 纯函数：根据单条契约定义与跨运行聚合统计，产生确定性调优建议。
 * 建议优先级：误报放宽 > 度量缺失 > 死条件 > 收紧。
 * 同一契约至多产生一条建议；样本不足时不产生建议。
 */
export function suggestOutcomeTuning(
  contract: OutcomeContract,
  stats: OutcomeHistoricalStats,
): AcceptanceTuningSuggestion[] {
  const { sampleCount, passCount, failCount, unknownCount, inspectionalFailCount, actualDistribution, totalScenarioRuns } = stats

  // 1. 检查死条件（可在样本不足时触发，例如场景已运行多次但该步骤从未被求值）
  const isDeadCondition =
    (sampleCount === 0 && (totalScenarioRuns ?? 0) >= OUTCOME_TUNING_RULES.SAMPLE_MIN) ||
    (sampleCount >= OUTCOME_TUNING_RULES.SAMPLE_MIN && passCount === 0 && failCount === 0 && unknownCount === 0)

  // 样本下限判定：非死条件场景下样本不足 10 次不产生建议（避免小样本噪声）
  if (sampleCount < OUTCOME_TUNING_RULES.SAMPLE_MIN && !isDeadCondition) {
    return []
  }

  // 2. 规则 1：误报放宽（巡检型失败率 >= 30%）
  const inspectionalFailRate = sampleCount > 0 ? inspectionalFailCount / sampleCount : 0
  if (inspectionalFailRate >= OUTCOME_TUNING_RULES.INSPECTIONAL_FAIL_RATE_THRESHOLD) {
    const ratePercent = Math.round(inspectionalFailRate * 100)

    // 耗时类条件放宽
    if (contract.rule.kind === 'step_duration' || contract.rule.kind === 'run_duration') {
      const currentLimit = contract.rule.valueMs
      const p95 = actualDistribution?.p95 ?? currentLimit
      const suggestedLimit = roundLadderMs(p95)

      if (suggestedLimit > currentLimit) {
        return [
          {
            kind: 'loosen_threshold',
            ruleName: '误报放宽',
            rationale: `该条件在流程成功的历史运行中失败率达 ${ratePercent}%，P95 耗时为 ${p95}ms，建议放宽阈值至 ${suggestedLimit}ms 避免误报`,
            fromValue: currentLimit,
            toValue: suggestedLimit,
            sampleCount,
            suggestedPatch: {
              rule: { ...contract.rule, valueMs: suggestedLimit },
              meaning: contract.meaning.replace(/\d+(?:\.\d+)?\s*(?:秒|毫秒|ms|s)/i, `${suggestedLimit >= 1000 ? `${suggestedLimit / 1000}秒` : `${suggestedLimit}毫秒`}`),
            },
          },
        ]
      }
    }

    // 数值一致类条件放宽（context.number_compare）
    if (
      contract.rule.kind === 'context' &&
      contract.rule.expect.kind === 'number_compare' &&
      (contract.rule.expect.op === 'lte' || contract.rule.expect.op === 'lt' || (contract.rule.expect.op === 'eq' && contract.rule.expect.value === 0))
    ) {
      const currentTolerance = contract.rule.expect.value
      const p95Diff = Math.ceil(Math.abs(actualDistribution?.p95 ?? 0))

      if (p95Diff > currentTolerance) {
        return [
          {
            kind: 'loosen_threshold',
            ruleName: '误报放宽',
            rationale: `数值差值在历史运行中 P95 为 ${p95Diff}，大于当前容差 ${currentTolerance}（巡检型失败率 ${ratePercent}%），建议将容差放宽至 ${p95Diff}`,
            fromValue: currentTolerance,
            toValue: p95Diff,
            sampleCount,
            suggestedPatch: {
              rule: {
                ...contract.rule,
                expect: { kind: 'number_compare', op: 'lte', value: p95Diff },
              },
              meaning: contract.meaning.includes('不超过')
                ? contract.meaning.replace(/不超过\s*\d+/g, `不超过 ${p95Diff}`)
                : `${contract.meaning}（容差 ${p95Diff}）`,
            },
          },
        ]
      }
    }

    // 若无法调阈值且为 MUST，建议降低严重度至 SHOULD
    if (contract.severity === 'MUST') {
      return [
        {
          kind: 'lower_severity',
          ruleName: '降严重度',
          rationale: `该条件在流程跑通的运行中反复判定未达标（失败率 ${ratePercent}%），建议降为 SHOULD（应当成立）级，避免阻碍整体发布`,
          fromValue: 'MUST',
          toValue: 'SHOULD',
          sampleCount,
          suggestedPatch: {
            severity: 'SHOULD',
          },
        },
      ]
    }
  }

  // 3. 规则 2：度量缺失（UNKNOWN 率 >= 30%）
  const unknownRate = sampleCount > 0 ? unknownCount / sampleCount : 0
  if (unknownRate >= OUTCOME_TUNING_RULES.MEASUREMENT_MISSING_RATE_THRESHOLD) {
    const ratePercent = Math.round(unknownRate * 100)
    return [
      {
        kind: 'measurement_missing',
        ruleName: '度量缺失',
        rationale: `历史求值中有 ${ratePercent}% 无法获取有效度量（如步骤超时、页面丢失或元素未找到），建议检查步骤健壮性或定位健康状态`,
        sampleCount,
      },
    ]
  }

  // 4. 规则 3：死条件
  if (isDeadCondition) {
    return [
      {
        kind: 'dead_condition',
        ruleName: '死条件',
        rationale: '场景已多次运行但该条件从未被实际求值，建议检查挂靠步骤或分支路径可达性',
        sampleCount,
      },
    ]
  }

  // 5. 规则 4：阈值收紧（仅耗时类，PASS 率 100% 且 actual.max <= 阈值 * 50%）
  if (
    (contract.rule.kind === 'step_duration' || contract.rule.kind === 'run_duration') &&
    failCount === 0 &&
    unknownCount === 0 &&
    actualDistribution &&
    actualDistribution.max <= contract.rule.valueMs * OUTCOME_TUNING_RULES.TIGHTEN_MARGIN_MAX
  ) {
    const currentLimit = contract.rule.valueMs
    const targetLimit = roundLadderMs(actualDistribution.p95 * OUTCOME_TUNING_RULES.TIGHTEN_FACTOR)
    if (targetLimit < currentLimit) {
      return [
        {
          kind: 'tighten_threshold',
          ruleName: '阈值收紧',
          rationale: `该耗时条件历史运行全部通过且实际耗时远低于当前阈值（余量超 50%），建议收紧阈值至 ${targetLimit}ms 以更灵敏地捕获性能退化。注意：收紧可能引入新的不达标判定。`,
          fromValue: currentLimit,
          toValue: targetLimit,
          sampleCount,
          suggestedPatch: {
            rule: { ...contract.rule, valueMs: targetLimit },
            meaning: contract.meaning.replace(/\d+(?:\.\d+)?\s*(?:秒|毫秒|ms|s)/i, `${targetLimit >= 1000 ? `${targetLimit / 1000}秒` : `${targetLimit}毫秒`}`),
          },
        },
      ]
    }
  }

  return []
}
