-- 0154_duration_daily_rollups：耗时分析按天汇总（目标系统页、场景页与周期报告只读汇总，不再全量拉事实明细）
-- 一天按平台统计时区切分（stat_day 为本地日期 YYYY-MM-DD）；分位数存可合并的草图（JSON），在应用层合并与取分位。
-- 汇总由 Worker analyst 作业维护：事实写入 / 重算、运行删除在同一事务里登记脏键，作业按（场景、统计日）整行重算。

-- 1. 场景日汇总：键 = 场景 + 统计日 + 发起方 + 场景版本（只汇总可比事实，已删除运行不计）
CREATE TABLE IF NOT EXISTS "__SCHEMA__".duration_scenario_daily (
  scenario_id         UUID        NOT NULL REFERENCES "__SCHEMA__".scenarios (id) ON DELETE CASCADE,
  stat_day            TEXT        NOT NULL,
  trigger_source      TEXT        NOT NULL,
  scenario_version_id UUID        NOT NULL,
  target_id           UUID        NOT NULL,
  runs                INTEGER     NOT NULL,
  succeeded           INTEGER     NOT NULL,
  failed              INTEGER     NOT NULL,
  cancelled           INTEGER     NOT NULL,
  samples             INTEGER     NOT NULL,
  incomplete          INTEGER     NOT NULL,
  wait_samples        INTEGER     NOT NULL,
  total_sum_ms        BIGINT      NOT NULL,
  wait_sum_ms         BIGINT      NOT NULL,
  -- 草图分列存放：页面只读前四列，分项草图只在周期报告给变慢 / 变快场景归因时读
  active_sketch           JSONB   NOT NULL,
  overhead_sketch         JSONB   NOT NULL,
  queue_standalone_sketch JSONB   NOT NULL,
  total_ok_sketch         JSONB   NOT NULL,
  detail_sketches         JSONB   NOT NULL,
  first_finished_at   TIMESTAMPTZ NOT NULL,
  last_finished_at    TIMESTAMPTZ NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (scenario_id, stat_day, trigger_source, scenario_version_id),
  CONSTRAINT duration_scenario_daily_trigger_check CHECK (trigger_source IN ('manual', 'schedule', 'service'))
);
CREATE INDEX IF NOT EXISTS duration_scenario_daily_target_idx
  ON "__SCHEMA__".duration_scenario_daily (target_id, stat_day);

-- 2. 顶层节点日汇总：键 = 场景 + 节点 + 统计日 + 发起方 + 场景版本（模块内部步骤、循环子行不汇总）
CREATE TABLE IF NOT EXISTS "__SCHEMA__".duration_node_daily (
  scenario_id         UUID        NOT NULL REFERENCES "__SCHEMA__".scenarios (id) ON DELETE CASCADE,
  node_key            TEXT        NOT NULL,
  stat_day            TEXT        NOT NULL,
  trigger_source      TEXT        NOT NULL,
  scenario_version_id UUID        NOT NULL,
  target_id           UUID        NOT NULL,
  kind                TEXT        NOT NULL,
  name                TEXT        NOT NULL,
  ordinal             INTEGER     NOT NULL,
  has_children        BOOLEAN     NOT NULL,
  runs                INTEGER     NOT NULL,
  ok                  INTEGER     NOT NULL,
  retried             INTEGER     NOT NULL,
  assisted            INTEGER     NOT NULL,
  iteration_sum       BIGINT      NOT NULL,
  active_sketch       JSONB       NOT NULL,
  -- 每次迭代的耗时：当天成功节点都恰好迭代一次时与执行耗时相同，不另存（为空）
  per_iteration_sketch JSONB,
  -- 尝试次数、迭代次数的精确计数（小整数：值 → 次数）
  counts              JSONB       NOT NULL,
  resolutions         JSONB       NOT NULL,
  last_finished_at    TIMESTAMPTZ NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (scenario_id, node_key, stat_day, trigger_source, scenario_version_id),
  CONSTRAINT duration_node_daily_trigger_check CHECK (trigger_source IN ('manual', 'schedule', 'service'))
);
CREATE INDEX IF NOT EXISTS duration_node_daily_day_idx
  ON "__SCHEMA__".duration_node_daily (scenario_id, stat_day);

-- 3. 脏键：需要按（场景、统计日）重算的汇总；与事实写入、运行删除同事务登记，重复登记即忽略
CREATE TABLE IF NOT EXISTS "__SCHEMA__".duration_rollup_dirty (
  scenario_id UUID        NOT NULL,
  stat_day    TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (scenario_id, stat_day)
);
CREATE INDEX IF NOT EXISTS duration_rollup_dirty_created_idx
  ON "__SCHEMA__".duration_rollup_dirty (created_at);

-- 4. 汇总状态（单行）：按哪个统计时区、哪版口径汇总；时区或口径变了作业整体重建，重建完成前读路径退回明细
CREATE TABLE IF NOT EXISTS "__SCHEMA__".duration_rollup_state (
  key              TEXT        PRIMARY KEY,
  time_zone        TEXT        NOT NULL,
  calc_version     INTEGER     NOT NULL,
  ready            BOOLEAN     NOT NULL,
  backfill_cursor  JSONB,
  updated_at       TIMESTAMPTZ NOT NULL
);
