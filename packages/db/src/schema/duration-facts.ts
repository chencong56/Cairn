import { bigint, boolean, index, integer, jsonb, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import type {
  DurationCompositionIncompleteReason,
  DurationIncompleteReason,
  DurationNodeKind,
  DurationResolutionLevel,
  RunStatus,
  RunTriggerSource,
  StepRunStatus,
} from '@cairn/shared'
import { cairnSchema } from './console.js'
import { runs } from './execution.js'

/**
 * 运行耗时事实：每条完结运行一行，由后台事实作业从运行事件、步骤与 attempt 计算后写入。
 * 运行事件有保留期，事实一旦写入即为该运行的耗时事实源；口径见 @cairn/shared duration-facts。
 */
export const runDurationFacts = cairnSchema.table(
  'run_duration_facts',
  {
    runId: uuid('run_id')
      .primaryKey()
      .references(() => runs.id, { onDelete: 'cascade' }),
    targetId: uuid('target_id').notNull(),
    scenarioId: uuid('scenario_id').notNull(),
    scenarioVersionId: uuid('scenario_version_id').notNull(),
    suiteRunId: uuid('suite_run_id'),
    triggerSource: text('trigger_source').notNull().$type<RunTriggerSource>(),
    comparable: boolean('comparable').notNull(),
    status: text('status').notNull().$type<RunStatus>(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    totalMs: bigint('total_ms', { mode: 'number' }),
    activeMs: bigint('active_ms', { mode: 'number' }),
    authWaitMs: bigint('auth_wait_ms', { mode: 'number' }),
    requeueMs: bigint('requeue_ms', { mode: 'number' }),
    reviewMs: bigint('review_ms', { mode: 'number' }),
    holdMs: bigint('hold_ms', { mode: 'number' }),
    unclassifiedMs: bigint('unclassified_ms', { mode: 'number' }),
    queueMs: bigint('queue_ms', { mode: 'number' }),
    overheadMs: bigint('overhead_ms', { mode: 'number' }),
    modelMs: bigint('model_ms', { mode: 'number' }).notNull().default(0),
    pageMs: bigint('page_ms', { mode: 'number' }),
    overlapMs: bigint('overlap_ms', { mode: 'number' }),
    residualMs: bigint('residual_ms', { mode: 'number' }).notNull().default(0),
    pagePartial: boolean('page_partial').notNull().default(false),
    compositionIncompleteReasons: jsonb('composition_incomplete_reasons').$type<DurationCompositionIncompleteReason[]>().notNull().default([]),
    workerLost: boolean('worker_lost').notNull(),
    complete: boolean('complete').notNull(),
    incompleteReason: text('incomplete_reason').$type<DurationIncompleteReason>(),
    calcVersion: integer('calc_version').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('run_duration_facts_scenario_finished_idx').on(t.scenarioId, t.finishedAt),
    index('run_duration_facts_target_finished_idx').on(t.targetId, t.finishedAt),
    index('run_duration_facts_suite_run_idx').on(t.suiteRunId),
  ],
)

/** 按编排节点汇总的节点耗时事实：每条运行每个节点一行（循环合并、模块按调用汇总、检查为子行）。 */
export const runNodeDurationFacts = cairnSchema.table(
  'run_node_duration_facts',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    nodeKey: text('node_key').notNull(),
    scenarioId: uuid('scenario_id').notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    parentKey: text('parent_key'),
    kind: text('kind').notNull().$type<DurationNodeKind>(),
    name: text('name').notNull(),
    ordinal: integer('ordinal').notNull(),
    status: text('status').notNull().$type<StepRunStatus>(),
    activeMs: bigint('active_ms', { mode: 'number' }).notNull(),
    windowMs: bigint('window_ms', { mode: 'number' }),
    attemptCount: integer('attempt_count').notNull(),
    iterationCount: integer('iteration_count').notNull(),
    maxResolution: text('max_resolution').$type<DurationResolutionLevel>(),
    modelMs: bigint('model_ms', { mode: 'number' }).notNull().default(0),
    pageMs: bigint('page_ms', { mode: 'number' }),
    overlapMs: bigint('overlap_ms', { mode: 'number' }),
    residualMs: bigint('residual_ms', { mode: 'number' }).notNull().default(0),
    modelCallCount: integer('model_call_count').notNull().default(0),
    pageWaitCount: integer('page_wait_count').notNull().default(0),
    pagePartial: boolean('page_partial').notNull().default(false),
    compositionComplete: boolean('composition_complete').notNull().default(true),
    compositionIncompleteReasons: jsonb('composition_incomplete_reasons').$type<DurationCompositionIncompleteReason[]>().notNull().default([]),
  },
  (t) => [
    primaryKey({ name: 'run_node_duration_facts_pk', columns: [t.runId, t.nodeKey] }),
    index('run_node_duration_facts_scenario_node_finished_idx').on(t.scenarioId, t.nodeKey, t.finishedAt),
  ],
)
