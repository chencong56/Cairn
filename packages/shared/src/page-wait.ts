import { z } from 'zod'
import { entityIdSchema, runtimeSchemaVersionSchema, utcInstantSchema } from './wire.js'

/** 平台为等待页面可用而阻塞的时间。collector_ready 只作采集标记，不算页面时长。 */
export const PAGE_WAIT_REASONS = [
  'navigate',
  'load_state',
  'nav_request',
  'landing_settle',
  'wait_condition',
  'action_settle',
  'collector_ready',
] as const
export type PageWaitReason = (typeof PAGE_WAIT_REASONS)[number]
export const pageWaitReasonSchema = z.enum(PAGE_WAIT_REASONS)

export const PAGE_WAIT_KIND = 'page_wait' as const

export const pageWaitEvidenceSchema = z.strictObject({
  schemaVersion: runtimeSchemaVersionSchema,
  kind: z.literal(PAGE_WAIT_KIND),
  reason: pageWaitReasonSchema,
  startedAt: utcInstantSchema,
  endedAt: utcInstantSchema,
  durationMs: z.number().int().nonnegative(),
  attemptId: entityIdSchema,
  url: z.string().max(512).optional(),
})
export type PageWaitEvidence = z.infer<typeof pageWaitEvidenceSchema>

export function isPageWaitEvidence(payload: unknown): payload is PageWaitEvidence {
  return pageWaitEvidenceSchema.safeParse(payload).success
}

export const DURATION_CHECK_COMPONENTS = ['wall', 'model', 'page'] as const
export type DurationCheckComponent = (typeof DURATION_CHECK_COMPONENTS)[number]
export const durationCheckComponentSchema = z.enum(DURATION_CHECK_COMPONENTS)

export function durationCheckComponentOf(value: unknown): DurationCheckComponent {
  return value === 'model' || value === 'page' ? value : 'wall'
}
