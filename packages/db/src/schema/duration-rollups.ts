import { bigint, boolean, index, integer, jsonb, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import type { DurationCounts, DurationNodeKind, DurationSketch, RunTriggerSource } from '@cairn/shared'
import { cairnSchema } from './console.js'
import { scenarios } from './execution.js'

/** 场景日汇总的分项草图（总耗时与各项等待、排队）：只在周期报告给变慢 / 变快场景归因时读。 */
export type ScenarioDetailSketches = {
  total: DurationSketch
  authWait: DurationSketch
  requeue: DurationSketch
  review: DurationSketch
  queue: DurationSketch
}

/** 场景日汇总行里的各分位数草图（样本 = 成功、分解完整且有执行耗时的运行，另有两项口径见注释）。 */
export type ScenarioDailySketches = ScenarioDetailSketches & {
  active: DurationSketch
  overhead: DurationSketch
  /** 全部成功运行的总耗时（不要求分解完整）。 */
  totalOk: DurationSketch
  /** 不属于场景集的运行的开跑前排队（任意状态）。 */
  queueStandalone: DurationSketch
  model: DurationSketch
  page: DurationSketch
}

/** 节点日汇总里尝试次数、迭代次数的精确计数。 */
export type NodeDailyCounts = { attempt: DurationCounts; iteration: DurationCounts }

/**
 * 耗时分析的场景日汇总：按平台统计时区切天，只汇总可比事实（已删除运行不计）。
 * 由 analyst 作业按（场景、统计日）从事实表整行重算，见 db/src/runs/duration-rollup.ts。
 */
export const durationScenarioDaily = cairnSchema.table(
  'duration_scenario_daily',
  {
    scenarioId: uuid('scenario_id')
      .notNull()
      .references(() => scenarios.id, { onDelete: 'cascade' }),
    statDay: text('stat_day').notNull(),
    triggerSource: text('trigger_source').notNull().$type<RunTriggerSource>(),
    scenarioVersionId: uuid('scenario_version_id').notNull(),
    targetId: uuid('target_id').notNull(),
    runs: integer('runs').notNull(),
    succeeded: integer('succeeded').notNull(),
    failed: integer('failed').notNull(),
    cancelled: integer('cancelled').notNull(),
    samples: integer('samples').notNull(),
    incomplete: integer('incomplete').notNull(),
    waitSamples: integer('wait_samples').notNull(),
    totalSumMs: bigint('total_sum_ms', { mode: 'number' }).notNull(),
    waitSumMs: bigint('wait_sum_ms', { mode: 'number' }).notNull(),
    activeSketch: jsonb('active_sketch').$type<DurationSketch>().notNull(),
    overheadSketch: jsonb('overhead_sketch').$type<DurationSketch>().notNull(),
    queueStandaloneSketch: jsonb('queue_standalone_sketch').$type<DurationSketch>().notNull(),
    totalOkSketch: jsonb('total_ok_sketch').$type<DurationSketch>().notNull(),
    modelSketch: jsonb('model_sketch').$type<DurationSketch>(),
    pageSketch: jsonb('page_sketch').$type<DurationSketch>(),
    detailSketches: jsonb('detail_sketches').$type<ScenarioDetailSketches>().notNull(),
    firstFinishedAt: timestamp('first_finished_at', { withTimezone: true }).notNull(),
    lastFinishedAt: timestamp('last_finished_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.scenarioId, t.statDay, t.triggerSource, t.scenarioVersionId] }),
    index('duration_scenario_daily_target_idx').on(t.targetId, t.statDay),
  ],
)

/** 顶层节点日汇总：模块内部步骤与循环子行不汇总（展开子行时按单场景读明细）。 */
export const durationNodeDaily = cairnSchema.table(
  'duration_node_daily',
  {
    scenarioId: uuid('scenario_id')
      .notNull()
      .references(() => scenarios.id, { onDelete: 'cascade' }),
    nodeKey: text('node_key').notNull(),
    statDay: text('stat_day').notNull(),
    triggerSource: text('trigger_source').notNull().$type<RunTriggerSource>(),
    scenarioVersionId: uuid('scenario_version_id').notNull(),
    targetId: uuid('target_id').notNull(),
    kind: text('kind').notNull().$type<DurationNodeKind>(),
    name: text('name').notNull(),
    ordinal: integer('ordinal').notNull(),
    hasChildren: boolean('has_children').notNull(),
    runs: integer('runs').notNull(),
    ok: integer('ok').notNull(),
    retried: integer('retried').notNull(),
    assisted: integer('assisted').notNull(),
    iterationSum: bigint('iteration_sum', { mode: 'number' }).notNull(),
    activeSketch: jsonb('active_sketch').$type<DurationSketch>().notNull(),
    modelSketch: jsonb('model_sketch').$type<DurationSketch>(),
    pageSketch: jsonb('page_sketch').$type<DurationSketch>(),
    perIterationSketch: jsonb('per_iteration_sketch').$type<DurationSketch | null>(),
    counts: jsonb('counts').$type<NodeDailyCounts>().notNull(),
    resolutions: jsonb('resolutions').$type<Record<string, number>>().notNull(),
    lastFinishedAt: timestamp('last_finished_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.scenarioId, t.nodeKey, t.statDay, t.triggerSource, t.scenarioVersionId] }),
    index('duration_node_daily_day_idx').on(t.scenarioId, t.statDay),
  ],
)

/** 待重算的（场景、统计日）：事实写入 / 重算与运行删除同事务登记。 */
export const durationRollupDirty = cairnSchema.table(
  'duration_rollup_dirty',
  {
    scenarioId: uuid('scenario_id').notNull(),
    statDay: text('stat_day').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.scenarioId, t.statDay] }), index('duration_rollup_dirty_created_idx').on(t.createdAt)],
)

/** 重建回扫进度：null = 未开始；{ done: true } = 全部事实已登记为脏键。 */
export type DurationRollupBackfillState = { finishedAt: string; runId: string } | { done: true } | null

/** 汇总状态（单行 key = 'default'）。 */
export const durationRollupState = cairnSchema.table('duration_rollup_state', {
  key: text('key').primaryKey(),
  timeZone: text('time_zone').notNull(),
  calcVersion: integer('calc_version').notNull(),
  ready: boolean('ready').notNull(),
  backfillCursor: jsonb('backfill_cursor').$type<DurationRollupBackfillState>(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
})
