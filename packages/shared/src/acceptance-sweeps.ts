import { z } from 'zod'
import { entityIdSchema, utcInstantSchema } from './wire.js'

export const SWEEP_BATCH_STATUSES = ['queued', 'running', 'completed', 'failed'] as const
export type SweepBatchStatus = (typeof SWEEP_BATCH_STATUSES)[number]
export const sweepBatchStatusSchema = z.enum(SWEEP_BATCH_STATUSES)

export const SWEEP_BATCH_TRIGGERS = ['manual', 'periodic'] as const
export type SweepBatchTrigger = (typeof SWEEP_BATCH_TRIGGERS)[number]
export const sweepBatchTriggerSchema = z.enum(SWEEP_BATCH_TRIGGERS)

export const acceptanceSweepBatchSchema = z.strictObject({
  id: entityIdSchema,
  scope: z.literal('platform'),
  trigger: sweepBatchTriggerSchema,
  status: sweepBatchStatusSchema,
  leaseOwner: z.string().nullable().optional(),
  leaseExpiresAt: utcInstantSchema.nullable().optional(),
  startedAt: utcInstantSchema.nullable().optional(),
  finishedAt: utcInstantSchema.nullable().optional(),
  scenarioCount: z.number().int().nonnegative().optional(),
  skippedCount: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  error: z.string().nullable().optional(),
  createdAt: utcInstantSchema,
})
export type AcceptanceSweepBatch = z.infer<typeof acceptanceSweepBatchSchema>

export const acceptanceSnapshotCoverageSchema = z.strictObject({
  browserStepCoverage: z.number(),
  outputMetricCoverage: z.number(),
  browserStepsCount: z.number().int().nonnegative(),
  coveredBrowserStepsCount: z.number().int().nonnegative(),
  outputsCount: z.number().int().nonnegative(),
  coveredOutputsCount: z.number().int().nonnegative(),
})
export type AcceptanceSnapshotCoverage = z.infer<typeof acceptanceSnapshotCoverageSchema>

export const acceptanceSnapshotFindingSummarySchema = z.strictObject({
  code: z.string(),
  message: z.string(),
  stepId: z.string().optional(),
  severity: z.string().optional(),
})
export type AcceptanceSnapshotFindingSummary = z.infer<typeof acceptanceSnapshotFindingSummarySchema>

export const acceptanceCoverageSnapshotSchema = z.strictObject({
  id: entityIdSchema,
  batchId: entityIdSchema,
  targetId: entityIdSchema,
  scenarioId: entityIdSchema,
  draftRevision: z.number().int(),
  auditedAt: utcInstantSchema,
  trigger: sweepBatchTriggerSchema,
  coverage: acceptanceSnapshotCoverageSchema.nullable(),
  findingsCount: z.number().int().nonnegative(),
  topFindings: z.array(acceptanceSnapshotFindingSummarySchema),
  durationMs: z.number().int().nonnegative(),
})
export type AcceptanceCoverageSnapshot = z.infer<typeof acceptanceCoverageSnapshotSchema>

export const scenarioCoverageItemSchema = z.strictObject({
  scenarioId: entityIdSchema,
  scenarioName: z.string(),
  targetId: entityIdSchema,
  targetName: z.string(),
  hasDraft: z.boolean(),
  draftRevision: z.number().int().optional(),
  latestAuditedAt: utcInstantSchema.optional(),
  trigger: sweepBatchTriggerSchema.optional(),
  browserStepCoverage: z.number().optional(),
  outputMetricCoverage: z.number().optional(),
  findingsCount: z.number().int().nonnegative().optional(),
  topFindings: z.array(acceptanceSnapshotFindingSummarySchema).optional(),
})
export type ScenarioCoverageItem = z.infer<typeof scenarioCoverageItemSchema>

export const acceptanceCoverageOverviewResponseSchema = z.strictObject({
  platformAverageCoverage: z.number(),
  unauditedScenarioCount: z.number().int().nonnegative(),
  totalScenarioCount: z.number().int().nonnegative(),
  latestBatch: acceptanceSweepBatchSchema.nullable(),
  scenarios: z.array(scenarioCoverageItemSchema),
})
export type AcceptanceCoverageOverviewResponse = z.infer<typeof acceptanceCoverageOverviewResponseSchema>
