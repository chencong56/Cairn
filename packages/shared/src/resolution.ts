import { z } from 'zod'
import { locatorPlanSchema } from './locator-plan.js'
import type { PlatformConfigDocument } from './platform-config.js'
import type { TargetResolutionPolicy } from './resolution-policy.js'
import { candidateTrySchema } from './browser-command.js'
import { mapEvidenceRefSchema } from './map-c0.js'
import { resolutionPolicySchema } from './resolution-policy.js'
import { waitKindSchema, type WaitKind } from './step.js'
import { nextCursorSchema } from './rbac.js'
import { entityIdSchema, utcInstantSchema } from './wire.js'

export const RESOLUTION_RUNGS = ['D', 'M', 'A'] as const
export type ResolutionRung = (typeof RESOLUTION_RUNGS)[number]
export const resolutionRungSchema = z.enum(RESOLUTION_RUNGS)

export const RESOLUTION_DECISIONS = ['deterministic', 'map', 'ai', 'failed'] as const
export type ResolutionDecisionKind = (typeof RESOLUTION_DECISIONS)[number]
export const resolutionDecisionKindSchema = z.enum(RESOLUTION_DECISIONS)

export const RESOLUTION_REASON_CODES = [
  'FRAME_UNSUPPORTED',
  'CEILING_CLOSED',
  'BUDGET_EXHAUSTED',
  'CROSS_CHECK_FAILED',
  'CROSS_CHECK_NOT_APPLICABLE',
  'AI_NOT_FOUND',
  'AI_AMBIGUOUS_POINT',
  'AI_HUNG',
  'AI_CALL_FAILED',
  'AI_DISABLED',
  'AI_CONFIG_INVALID',
  'WAIT_KIND_UNAVAILABLE',
  'CANCELLED',
  'LEASE_LOST',
  'SURFACE_LOST',
  'CAPABILITY_MISSING',
  'TARGET_NOT_FOUND',
  'TARGET_AMBIGUOUS',
  'PERSISTENCE_FAILED',
] as const
export type ResolutionReasonCode = (typeof RESOLUTION_REASON_CODES)[number]
export const resolutionReasonCodeSchema = z.enum(RESOLUTION_REASON_CODES)

export const RESOLUTION_CROSS_CHECKS = ['passed', 'failed', 'not_applicable', 'skipped'] as const
export type ResolutionCrossCheck = (typeof RESOLUTION_CROSS_CHECKS)[number]
export const resolutionCrossCheckSchema = z.enum(RESOLUTION_CROSS_CHECKS)

export const resolutionRungRecordSchema = z.strictObject({
  rung: resolutionRungSchema,
  aiRoute: z.enum(['text', 'vision']).optional(),
  outcomeClass: z.enum(['miss', 'ambiguous', 'hung', 'budget', 'cancelled', 'lease_lost', 'error']).optional(),
  outcome: z.string().min(1).max(64),
  spentMs: z.number().int().nonnegative().max(120_000),
  candidatesTried: z.array(candidateTrySchema).max(8).optional(),
  mapDecisionId: entityIdSchema.optional(),
  aiCallNs: z.array(z.number().int().positive()).max(8).optional(),
  center: z.tuple([z.number(), z.number()]).optional(),
  rectReliable: z.boolean().optional(),
  crossCheck: resolutionCrossCheckSchema.optional(),
})
export type ResolutionRungRecord = z.infer<typeof resolutionRungRecordSchema>

export const resolutionDecisionSchema = z.strictObject({
  decisionId: entityIdSchema,
  runId: entityIdSchema,
  stepRunId: entityIdSchema,
  attemptId: entityIdSchema,
  stepId: entityIdSchema,
  effectivePolicy: resolutionPolicySchema,
  plan: locatorPlanSchema.optional(),
  rungs: z.array(resolutionRungRecordSchema).max(4),
  decision: resolutionDecisionKindSchema,
  reasonCode: resolutionReasonCodeSchema.optional(),
  semanticDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  evidenceRefs: z.array(mapEvidenceRefSchema).max(16).default([]),
  createdAt: utcInstantSchema.optional(),
})
export type ResolutionDecision = z.infer<typeof resolutionDecisionSchema>

export const resolutionDecisionListQuerySchema = z.object({
  stepRunId: entityIdSchema.optional(),
  attemptId: entityIdSchema.optional(),
  limit: z
    .union([z.number(), z.string()])
    .optional()
    .transform((value) => (value === undefined ? 50 : typeof value === 'number' ? value : Number(value)))
    .pipe(z.number().int().min(1).max(100)),
  cursor: entityIdSchema.optional(),
})
export type ResolutionDecisionListQuery = z.infer<typeof resolutionDecisionListQuerySchema>

export const resolutionDecisionListResponseSchema = z.strictObject({
  items: z.array(resolutionDecisionSchema),
  nextCursor: nextCursorSchema,
})
export type ResolutionDecisionListResponse = z.infer<typeof resolutionDecisionListResponseSchema>

export const resolutionStatsQuerySchema = z.object({
  scenarioVersionId: entityIdSchema.optional(),
  targetId: entityIdSchema.optional(),
})
export type ResolutionStatsQuery = z.infer<typeof resolutionStatsQuerySchema>

export const resolutionStatsItemSchema = z.strictObject({
  stepId: entityIdSchema,
  scenarioVersionId: entityIdSchema,
  targetId: entityIdSchema,
  deterministic: z.number().int().nonnegative(),
  map: z.number().int().nonnegative(),
  ai: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  fallbackRate: z.number().min(0).max(1).nullable(),
  stepName: z.string().nullable().optional(),
})
export type ResolutionStatsItem = z.infer<typeof resolutionStatsItemSchema>

export const resolutionStatsResponseSchema = z.strictObject({
  items: z.array(resolutionStatsItemSchema).max(500),
})
export type ResolutionStatsResponse = z.infer<typeof resolutionStatsResponseSchema>

export const RESOLUTION_UNAVAILABLE_CODES = ['AI_DISABLED', 'AI_CONFIG_INVALID', 'CEILING_CLOSED'] as const
export type ResolutionUnavailableCode = (typeof RESOLUTION_UNAVAILABLE_CODES)[number]

export const WAIT_KINDS_AVAILABLE_NOW = ['time', 'visible', 'hidden', 'url', 'text'] as const satisfies readonly WaitKind[]

export const resolutionCapabilitiesSchema = z.strictObject({
  textReady: z.boolean().optional(),
  visionReady: z.boolean().optional(),
  reasons: z.array(
    z.strictObject({
      code: z.enum(RESOLUTION_UNAVAILABLE_CODES),
      message: z.string().min(1).max(512),
    }),
  ),
  waitKindsAvailable: z.array(waitKindSchema).min(1).max(6),
})
export type ResolutionCapabilities = z.infer<typeof resolutionCapabilitiesSchema>

export type CompileResolutionContext = {
  documentLocatorPlan?: import('./locator-plan.js').LocatorPlan
  locatorDocument?: PlatformConfigDocument
  locatorTarget?: TargetResolutionPolicy | null
  waitKindsAvailable?: readonly WaitKind[]
}

export const FACTORY_COMPILE_RESOLUTION: CompileResolutionContext = {
  waitKindsAvailable: WAIT_KINDS_AVAILABLE_NOW,
}
