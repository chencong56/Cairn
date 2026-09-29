import { index, integer, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'
import type {
  AcceptanceSnapshotCoverage,
  AcceptanceSnapshotFindingSummary,
  SweepBatchStatus,
  SweepBatchTrigger,
} from '@cairn/shared'
import { newId } from '../id.js'
import { cairnSchema } from './console.js'
import { scenarios } from './execution.js'
import { targets } from './targets.js'

export const acceptanceSweepBatches = cairnSchema.table(
  'acceptance_sweep_batches',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    scope: text('scope').notNull().default('platform'),
    trigger: text('trigger').notNull().$type<SweepBatchTrigger>(),
    status: text('status').notNull().$type<SweepBatchStatus>(),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    scenarioCount: integer('scenario_count').notNull().default(0),
    skippedCount: integer('skipped_count').notNull().default(0),
    durationMs: integer('duration_ms'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('acceptance_sweep_batches_status_idx').on(t.status, t.createdAt),
    index('acceptance_sweep_batches_lease_idx').on(t.status, t.leaseExpiresAt),
  ],
)

export const acceptanceCoverageSnapshots = cairnSchema.table(
  'acceptance_coverage_snapshots',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => acceptanceSweepBatches.id, { onDelete: 'cascade' }),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    scenarioId: uuid('scenario_id')
      .notNull()
      .references(() => scenarios.id, { onDelete: 'restrict' }),
    draftRevision: integer('draft_revision').notNull(),
    auditedAt: timestamp('audited_at', { withTimezone: true }).notNull(),
    trigger: text('trigger').notNull().$type<SweepBatchTrigger>(),
    coverage: jsonb('coverage').$type<AcceptanceSnapshotCoverage>(),
    findingsCount: integer('findings_count').notNull().default(0),
    topFindings: jsonb('top_findings').$type<AcceptanceSnapshotFindingSummary[]>().notNull().default([]),
    durationMs: integer('duration_ms').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('acceptance_coverage_snapshots_target_audited_idx').on(t.targetId, t.auditedAt),
    index('acceptance_coverage_snapshots_scenario_audited_idx').on(t.scenarioId, t.auditedAt),
    index('acceptance_coverage_snapshots_batch_idx').on(t.batchId),
  ],
)

export const acceptanceSweepBatchesRelations = relations(acceptanceSweepBatches, ({ many }) => ({
  snapshots: many(acceptanceCoverageSnapshots),
}))

export const acceptanceCoverageSnapshotsRelations = relations(acceptanceCoverageSnapshots, ({ one }) => ({
  batch: one(acceptanceSweepBatches, {
    fields: [acceptanceCoverageSnapshots.batchId],
    references: [acceptanceSweepBatches.id],
  }),
  target: one(targets, {
    fields: [acceptanceCoverageSnapshots.targetId],
    references: [targets.id],
  }),
  scenario: one(scenarios, {
    fields: [acceptanceCoverageSnapshots.scenarioId],
    references: [scenarios.id],
  }),
}))

export type AcceptanceSweepBatchRow = typeof acceptanceSweepBatches.$inferSelect
export type AcceptanceCoverageSnapshotRow = typeof acceptanceCoverageSnapshots.$inferSelect
