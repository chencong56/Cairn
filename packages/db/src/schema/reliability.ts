import { bigint, boolean, doublePrecision, index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import type {
  BaselineKind,
  EvidenceScores,
  FeatureWindowType,
  IncidentLineage,
  IncidentSeverity,
  IncidentStatus,
  MapChangeCandidateStatus,
  ReliabilitySignalKind,
  ReliabilitySignalSeverity,
  WatermarkVector,
} from '@cairn/shared'
import { newId } from '../id.js'
import { cairnSchema } from './console.js'
import { targets } from './targets.js'
import { runs } from './execution.js'

export const reliabilitySignals = cairnSchema.table(
  'reliability_signals',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().$type<ReliabilitySignalKind>(),
    severity: text('severity').notNull().default('WARN').$type<ReliabilitySignalSeverity>(),
    subjectRef: jsonb('subject_ref').notNull().$type<Record<string, unknown>>(),
    sourceRef: jsonb('source_ref').notNull().$type<Record<string, unknown>>(),
    sourceKind: text('source_kind'),
    sourceId: text('source_id'),
    errorFamily: text('error_family'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    commitPosition: bigint('commit_position', { mode: 'number' }),
    value: doublePrecision('value'),
    unit: text('unit'),
    scopeDigest: text('scope_digest').notNull(),
    groupingKey: text('grouping_key'),
    availability: text('availability', { enum: ['available', 'missing', 'truncated'] })
      .notNull()
      .default('available'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_rel_signals_target_occurred').on(t.targetId, t.occurredAt),
    index('idx_rel_signals_grouping').on(t.groupingKey),
    index('idx_rel_signals_scope').on(t.scopeDigest),
    // 作用域入键：同一 Run 的多作用域 latency_regression（source 同为 run）互不挤占
    uniqueIndex('idx_rel_signals_source_uniq').on(t.targetId, t.scopeDigest, t.kind, t.sourceKind, t.sourceId),
  ],
)

export const featureWindows = cairnSchema.table(
  'feature_windows',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'cascade' }),
    scopeDigest: text('scope_digest').notNull(),
    windowType: text('window_type').notNull().$type<FeatureWindowType>(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    windowEnd: timestamp('window_end', { withTimezone: true }).notNull(),
    startOrdinal: bigint('start_ordinal', { mode: 'number' }),
    endOrdinal: bigint('end_ordinal', { mode: 'number' }),
    metricVersion: text('metric_version').notNull().default('1.0'),
    sampleCount: integer('sample_count').notNull().default(0),
    primaryHitCount: integer('primary_hit_count').notNull().default(0),
    fallbackCount: integer('fallback_count').notNull().default(0),
    retryStepCount: integer('retry_step_count').notNull().default(0),
    ewmaLatencyMs: doublePrecision('ewma_latency_ms').notNull().default(0),
    ewmaSuccessRate: doublePrecision('ewma_success_rate').notNull().default(1.0),
    stats: jsonb('stats').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('idx_feature_windows_target_scope_win').on(t.targetId, t.scopeDigest, t.windowType, t.windowStart),
    index('idx_feature_windows_target_end').on(t.targetId, t.windowEnd),
    index('idx_feature_windows_target_scope_end_ord').on(t.targetId, t.scopeDigest, t.windowType, t.endOrdinal),
  ],
)

export const baselineRevisions = cairnSchema.table(
  'baseline_revisions',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'cascade' }),
    scopeDigest: text('scope_digest').notNull(),
    baselineKind: text('baseline_kind').notNull().$type<BaselineKind>(),
    algorithmVersion: text('algorithm_version').notNull().default('1.0'),
    sampleFloor: integer('sample_floor').notNull().default(10),
    // 单调递增的评估序号：同一事务创建多版基线时 createdAt 相同，以它决胜最新版
    revisionOrdinal: bigint('revision_ordinal', { mode: 'number' }).notNull().default(0),
    stats: jsonb('stats').notNull().default({}),
    status: text('status', { enum: ['ready', 'insufficient', 'unavailable'] })
      .notNull()
      .default('ready'),
    excludedReasons: jsonb('excluded_reasons').$type<string[]>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_baseline_revisions_target_scope_kind').on(t.targetId, t.scopeDigest, t.baselineKind),
  ],
)

export const reliabilityEvaluations = cairnSchema.table(
  'reliability_evaluations',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'cascade' }),
    scopeDigest: text('scope_digest').notNull(),
    watermarkVector: jsonb('watermark_vector').notNull().$type<WatermarkVector>(),
    generation: integer('generation').notNull().default(1),
    rulesEvaluated: integer('rules_evaluated').notNull().default(0),
    breachesCount: integer('breaches_count').notNull().default(0),
    result: jsonb('result').notNull().default({}),
    coverageGaps: jsonb('coverage_gaps').notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_rel_evaluations_target_generation').on(t.targetId, t.generation),
    index('idx_rel_evaluations_target_created').on(t.targetId, t.createdAt),
  ],
)

export const reliabilityCheckpoints = cairnSchema.table(
  'reliability_checkpoints',
  {
    targetId: uuid('target_id')
      .primaryKey()
      .references(() => targets.id, { onDelete: 'cascade' }),
    watermarkVector: jsonb('watermark_vector').notNull().$type<WatermarkVector>(),
    fencingToken: bigint('fencing_token', { mode: 'number' }).notNull().default(0),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    v2Enabled: boolean('v2_enabled').notNull().default(false),
    v2EnabledAt: timestamp('v2_enabled_at', { withTimezone: true }),
    runEvaluationOrdinal: bigint('run_evaluation_ordinal', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
)

export const reliabilityIncidents = cairnSchema.table(
  'reliability_incidents',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'cascade' }),
    groupingKey: text('grouping_key').notNull(),
    scopeDigest: text('scope_digest').notNull(),
    severity: text('severity').notNull().default('P3').$type<IncidentSeverity>(),
    status: text('status').notNull().default('DETECTED').$type<IncidentStatus>(),
    actionRequiredReason: text('action_required_reason'),
    memberCount: integer('member_count').notNull().default(1),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    rootCauseHypothesis: text('root_cause_hypothesis'),
    evidenceScores: jsonb('evidence_scores').notNull().$type<EvidenceScores>(),
    silencedUntil: timestamp('silenced_until', { withTimezone: true }),
    dismissedReason: text('dismissed_reason'),
    lineage: jsonb('lineage').$type<IncidentLineage>(),
    revision: integer('revision').notNull().default(1),
    ruleVersion: integer('rule_version').notNull().default(1),
    assetKind: text('asset_kind', { enum: ['scenario', 'action_module'] }),
    assetId: text('asset_id'),
    stepId: text('step_id'),
    implementationKey: text('implementation_key'),
    accountId: text('account_id'),
    observingStartedAt: timestamp('observing_started_at', { withTimezone: true }),
    observingStartedOrdinal: bigint('observing_started_ordinal', { mode: 'number' }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedEvaluationOrdinal: bigint('closed_evaluation_ordinal', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_rel_incidents_target_status').on(t.targetId, t.status),
    index('idx_rel_incidents_grouping').on(t.targetId, t.groupingKey),
    index('idx_rel_incidents_last_seen').on(t.targetId, t.lastSeenAt),
    index('idx_rel_incidents_target_asset').on(t.targetId, t.assetKind, t.assetId),
    index('idx_rel_incidents_target_rule_status').on(t.targetId, t.ruleVersion, t.status),
  ],
)

export const reliabilityRunReceipts = cairnSchema.table(
  'reliability_run_receipts',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    ruleVersion: integer('rule_version').notNull().default(2),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'cascade' }),
    finishedAt: timestamp('finished_at', { withTimezone: true }).notNull(),
    enqueuedAt: timestamp('enqueued_at', { withTimezone: true }).notNull().defaultNow(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    evaluationOrdinal: bigint('evaluation_ordinal', { mode: 'number' }),
  },
  (t) => [
    uniqueIndex('idx_rel_receipts_run_rule').on(t.runId, t.ruleVersion),
    uniqueIndex('idx_rel_receipts_target_rule_ord').on(t.targetId, t.ruleVersion, t.evaluationOrdinal),
    index('idx_rel_receipts_target_pending').on(t.targetId, t.ruleVersion, t.consumedAt, t.finishedAt, t.runId),
  ],
)

export const reliabilityRunSamples = cairnSchema.table(
  'reliability_run_samples',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    ruleVersion: integer('rule_version').notNull().default(2),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    scopeDigest: text('scope_digest').notNull(),
    scopeKind: text('scope_kind').notNull(),
    evaluationOrdinal: bigint('evaluation_ordinal', { mode: 'number' }).notNull(),
    executionConclusion: text('execution_conclusion').notNull(),
    signals: jsonb('signals').notNull().default([]),
    isComparable: boolean('is_comparable').notNull().default(true),
    durationMs: doublePrecision('duration_ms'),
    sourceRef: jsonb('source_ref').notNull().default({}),
    comparisons: jsonb('comparisons').notNull().default({}),
    assetKind: text('asset_kind'),
    assetId: text('asset_id'),
    moduleId: uuid('module_id'),
    implementationKey: text('implementation_key'),
    stepId: text('step_id'),
    internalStepId: text('internal_step_id'),
    accountId: text('account_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('idx_rel_samples_uniq').on(t.ruleVersion, t.targetId, t.runId, t.scopeDigest),
    index('idx_rel_samples_target_scope_ord').on(t.targetId, t.scopeDigest, t.evaluationOrdinal),
    index('idx_rel_samples_target_asset_ord').on(t.targetId, t.assetKind, t.assetId, t.evaluationOrdinal),
  ],
)

export const reliabilityIncidentMembers = cairnSchema.table(
  'reliability_incident_members',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    incidentId: uuid('incident_id')
      .notNull()
      .references(() => reliabilityIncidents.id, { onDelete: 'cascade' }),
    memberRef: text('member_ref').notNull(),
    memberType: text('member_type').notNull(),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_rel_inc_members_incident').on(t.incidentId),
    uniqueIndex('idx_rel_inc_members_uniq').on(t.incidentId, t.memberRef),
  ],
)

export const mapChangeCandidates = cairnSchema.table(
  'map_change_candidates',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'cascade' }),
    assetRef: jsonb('asset_ref').notNull().$type<Record<string, unknown>>(),
    beforeRef: jsonb('before_ref').$type<Record<string, unknown>>(),
    afterRef: jsonb('after_ref').$type<Record<string, unknown>>(),
    changeLevel: text('change_level', { enum: ['L1_structure', 'L2_object', 'L3_route'] }).notNull(),
    conditions: jsonb('conditions').notNull().$type<Record<string, unknown>>(),
    observationsCount: integer('observations_count').notNull().default(1),
    status: text('status').notNull().default('pending').$type<MapChangeCandidateStatus>(),
    evidenceScore: doublePrecision('evidence_score'),
    counterEvidenceScore: doublePrecision('counter_evidence_score'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_map_change_candidates_target_status').on(t.targetId, t.status),
  ],
)
