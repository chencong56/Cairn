import { z } from 'zod'
import { entityIdSchema, utcInstantSchema } from './wire.js'
import {
  outcomeScopeSchema,
  outcomeSeveritySchema,
  outcomeOnViolationSchema,
  outcomeRuleSchema,
} from './outcome.js'

export const OUTCOME_TUNING_RULES = {
  SAMPLE_MIN: 10,
  WINDOW_MAX: 30,
  WINDOW_DAYS: 30,
  INSPECTIONAL_FAIL_RATE_THRESHOLD: 0.3,
  MEASUREMENT_MISSING_RATE_THRESHOLD: 0.3,
  TIGHTEN_MARGIN_MAX: 0.5,
  TIGHTEN_FACTOR: 1.2,
} as const

/**
 * 确定性阶梯向上取整常数函数：
 * - < 1s：向上取整到整百毫秒
 * - 1s ~ 10s：向上取整到整 500 毫秒
 * - >= 10s：向上取整到整千毫秒（整秒）
 */
export function roundLadderMs(valMs: number): number {
  const safeVal = Math.max(0, valMs)
  if (safeVal < 1_000) {
    return Math.max(100, Math.ceil(safeVal / 100) * 100)
  }
  if (safeVal < 10_000) {
    return Math.ceil(safeVal / 500) * 500
  }
  return Math.ceil(safeVal / 1_000) * 1_000
}

export const ACCEPTANCE_TUNING_SUGGESTION_KINDS = [
  'loosen_threshold',
  'lower_severity',
  'tighten_threshold',
  'measurement_missing',
  'dead_condition',
] as const
export type AcceptanceTuningSuggestionKind = (typeof ACCEPTANCE_TUNING_SUGGESTION_KINDS)[number]
export const acceptanceTuningSuggestionKindSchema = z.enum(ACCEPTANCE_TUNING_SUGGESTION_KINDS)

export const acceptanceTuningPatchSchema = z.strictObject({
  meaning: z.string().trim().min(1).max(512).optional(),
  severity: outcomeSeveritySchema.optional(),
  onViolation: outcomeOnViolationSchema.optional(),
  rule: outcomeRuleSchema.optional(),
})
export type AcceptanceTuningPatch = z.infer<typeof acceptanceTuningPatchSchema>

export const acceptanceTuningSuggestionSchema = z.strictObject({
  kind: acceptanceTuningSuggestionKindSchema,
  ruleName: z.string().min(1).max(64),
  rationale: z.string().min(1).max(1024),
  fromValue: z.union([z.number(), z.string()]).optional(),
  toValue: z.union([z.number(), z.string()]).optional(),
  sampleCount: z.number().int().nonnegative(),
  suggestedPatch: acceptanceTuningPatchSchema.optional(),
})
export type AcceptanceTuningSuggestion = z.infer<typeof acceptanceTuningSuggestionSchema>

export const actualDistributionSchema = z.strictObject({
  p50: z.number(),
  p95: z.number(),
  min: z.number(),
  max: z.number(),
  unitHint: z.string().max(32).optional(),
})
export type ActualDistribution = z.infer<typeof actualDistributionSchema>

export const acceptanceHistoryInsightSchema = z.strictObject({
  contractId: entityIdSchema,
  meaning: z.string(),
  scope: outcomeScopeSchema,
  sampleCount: z.number().int().nonnegative(),
  sampleBreakdown: z.record(z.string(), z.number().int().nonnegative()),
  passCount: z.number().int().nonnegative(),
  failCount: z.number().int().nonnegative(),
  unknownCount: z.number().int().nonnegative(),
  inspectionalFailCount: z.number().int().nonnegative(),
  actualDistribution: actualDistributionSchema.optional(),
  priorSegmentSampleCount: z.number().int().nonnegative().optional(),
  suggestions: z.array(acceptanceTuningSuggestionSchema),
})
export type AcceptanceHistoryInsight = z.infer<typeof acceptanceHistoryInsightSchema>

export const scenarioAcceptanceHistoryResponseSchema = z.strictObject({
  scenarioId: entityIdSchema,
  insights: z.array(acceptanceHistoryInsightSchema),
})
export type ScenarioAcceptanceHistoryResponse = z.infer<typeof scenarioAcceptanceHistoryResponseSchema>

export const acceptanceHistoryQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  since: utcInstantSchema.optional(),
})
export type AcceptanceHistoryQuery = z.infer<typeof acceptanceHistoryQuerySchema>
