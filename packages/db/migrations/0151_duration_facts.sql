-- 0151_duration_facts：耗时分析基座——运行 / 场景集运行的发起方，以及运行级、节点级耗时事实表
-- 事实表由 Worker analyst 后台作业计算写入（含历史回填），本迁移不回填事实。

-- 1. 发起方：谁让这次运行发生（manual / schedule / service），与 execution_origin（容器）正交
ALTER TABLE "__SCHEMA__".suite_runs
  ADD COLUMN IF NOT EXISTS trigger_source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "__SCHEMA__".suite_runs
  DROP CONSTRAINT IF EXISTS suite_runs_trigger_source_check;
ALTER TABLE "__SCHEMA__".suite_runs
  ADD CONSTRAINT suite_runs_trigger_source_check CHECK (trigger_source IN ('manual', 'schedule'));

ALTER TABLE "__SCHEMA__".runs
  ADD COLUMN IF NOT EXISTS trigger_source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "__SCHEMA__".runs
  DROP CONSTRAINT IF EXISTS runs_trigger_source_check;
ALTER TABLE "__SCHEMA__".runs
  ADD CONSTRAINT runs_trigger_source_check CHECK (trigger_source IN ('manual', 'schedule', 'service'));

-- 回填：调度准入（非「立即执行」）的场景集运行 → schedule
UPDATE "__SCHEMA__".suite_runs
   SET trigger_source = 'schedule'
 WHERE EXISTS (
   SELECT 1 FROM "__SCHEMA__".schedule_occurrences o
    WHERE o.suite_run_id = suite_runs.id AND o.source = 'scheduled'
 );

-- 回填：调度准入的场景运行 → schedule
UPDATE "__SCHEMA__".runs
   SET trigger_source = 'schedule'
 WHERE EXISTS (
   SELECT 1 FROM "__SCHEMA__".schedule_occurrences o
    WHERE o.run_id = runs.id AND o.source = 'scheduled'
 );

-- 回填：场景集成员继承所属场景集运行的发起方
UPDATE "__SCHEMA__".runs
   SET trigger_source = 'schedule'
 WHERE suite_run_id IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM "__SCHEMA__".suite_runs s
      WHERE s.id = runs.suite_run_id AND s.trigger_source = 'schedule'
   );

-- 回填：服务调用 → service；其余保持默认 manual（历史地图作业无来源字段，一律 manual，且不进入耗时分析）
UPDATE "__SCHEMA__".runs
   SET trigger_source = 'service'
 WHERE service_caller_id IS NOT NULL;

-- 事实作业按完成时间扫描（近期窗口 + 全量回扫）
CREATE INDEX IF NOT EXISTS runs_finished_at_id_idx
  ON "__SCHEMA__".runs (finished_at, id);

-- 2. 运行耗时事实：总耗时 = 执行 + 认证等待 + 重新排队 + 待核查 + 调试挂起 + 未归类；开跑前排队另计
CREATE TABLE IF NOT EXISTS "__SCHEMA__".run_duration_facts (
  run_id              UUID        PRIMARY KEY REFERENCES "__SCHEMA__".runs (id) ON DELETE CASCADE,
  target_id           UUID        NOT NULL,
  scenario_id         UUID        NOT NULL,
  scenario_version_id UUID        NOT NULL,
  suite_run_id        UUID,
  trigger_source      TEXT        NOT NULL,
  comparable          BOOLEAN     NOT NULL,
  status              TEXT        NOT NULL,
  finished_at         TIMESTAMPTZ,
  total_ms            BIGINT,
  active_ms           BIGINT,
  auth_wait_ms        BIGINT,
  requeue_ms          BIGINT,
  review_ms           BIGINT,
  hold_ms             BIGINT,
  unclassified_ms     BIGINT,
  queue_ms            BIGINT,
  overhead_ms         BIGINT,
  worker_lost         BOOLEAN     NOT NULL,
  complete            BOOLEAN     NOT NULL,
  incomplete_reason   TEXT,
  calc_version        INTEGER     NOT NULL,
  computed_at         TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS run_duration_facts_scenario_finished_idx
  ON "__SCHEMA__".run_duration_facts (scenario_id, finished_at);

CREATE INDEX IF NOT EXISTS run_duration_facts_target_finished_idx
  ON "__SCHEMA__".run_duration_facts (target_id, finished_at);

CREATE INDEX IF NOT EXISTS run_duration_facts_suite_run_idx
  ON "__SCHEMA__".run_duration_facts (suite_run_id);

-- 3. 节点耗时事实：每条运行每个编排节点一行
CREATE TABLE IF NOT EXISTS "__SCHEMA__".run_node_duration_facts (
  run_id          UUID        NOT NULL REFERENCES "__SCHEMA__".runs (id) ON DELETE CASCADE,
  node_key        TEXT        NOT NULL,
  scenario_id     UUID        NOT NULL,
  finished_at     TIMESTAMPTZ,
  parent_key      TEXT,
  kind            TEXT        NOT NULL,
  name            TEXT        NOT NULL,
  ordinal         INTEGER     NOT NULL,
  status          TEXT        NOT NULL,
  active_ms       BIGINT      NOT NULL,
  window_ms       BIGINT,
  attempt_count   INTEGER     NOT NULL,
  iteration_count INTEGER     NOT NULL,
  max_resolution  TEXT,
  CONSTRAINT run_node_duration_facts_pk PRIMARY KEY (run_id, node_key)
);

CREATE INDEX IF NOT EXISTS run_node_duration_facts_scenario_node_finished_idx
  ON "__SCHEMA__".run_node_duration_facts (scenario_id, node_key, finished_at);
