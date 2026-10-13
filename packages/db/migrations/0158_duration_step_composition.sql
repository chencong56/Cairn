-- 0158_duration_step_composition：步骤执行耗时拆成模型 / 页面 / 重叠 / 其余（P0 先落模型账本与列，页面区间 P1 再采）
-- 计算规则升到 3、汇总升到 2；事实作业与汇总作业按新版本重算。事件已清理的运行保留原运行级分解，只补分段列。

ALTER TABLE "__SCHEMA__".scenario_ai_calls
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE "__SCHEMA__".scenario_ai_calls
  ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ;

ALTER TABLE "__SCHEMA__".run_duration_facts
  ADD COLUMN IF NOT EXISTS model_ms BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "__SCHEMA__".run_duration_facts
  ADD COLUMN IF NOT EXISTS page_ms BIGINT;
ALTER TABLE "__SCHEMA__".run_duration_facts
  ADD COLUMN IF NOT EXISTS overlap_ms BIGINT;
ALTER TABLE "__SCHEMA__".run_duration_facts
  ADD COLUMN IF NOT EXISTS residual_ms BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "__SCHEMA__".run_duration_facts
  ADD COLUMN IF NOT EXISTS page_partial BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "__SCHEMA__".run_duration_facts
  ADD COLUMN IF NOT EXISTS composition_incomplete_reasons JSONB NOT NULL DEFAULT '[]';

ALTER TABLE "__SCHEMA__".run_node_duration_facts
  ADD COLUMN IF NOT EXISTS model_ms BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "__SCHEMA__".run_node_duration_facts
  ADD COLUMN IF NOT EXISTS page_ms BIGINT;
ALTER TABLE "__SCHEMA__".run_node_duration_facts
  ADD COLUMN IF NOT EXISTS overlap_ms BIGINT;
ALTER TABLE "__SCHEMA__".run_node_duration_facts
  ADD COLUMN IF NOT EXISTS residual_ms BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "__SCHEMA__".run_node_duration_facts
  ADD COLUMN IF NOT EXISTS model_call_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "__SCHEMA__".run_node_duration_facts
  ADD COLUMN IF NOT EXISTS page_wait_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "__SCHEMA__".run_node_duration_facts
  ADD COLUMN IF NOT EXISTS page_partial BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "__SCHEMA__".run_node_duration_facts
  ADD COLUMN IF NOT EXISTS composition_complete BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE "__SCHEMA__".run_node_duration_facts
  ADD COLUMN IF NOT EXISTS composition_incomplete_reasons JSONB NOT NULL DEFAULT '[]';

ALTER TABLE "__SCHEMA__".duration_scenario_daily
  ADD COLUMN IF NOT EXISTS model_sketch JSONB;
ALTER TABLE "__SCHEMA__".duration_scenario_daily
  ADD COLUMN IF NOT EXISTS page_sketch JSONB;

ALTER TABLE "__SCHEMA__".duration_node_daily
  ADD COLUMN IF NOT EXISTS model_sketch JSONB;
ALTER TABLE "__SCHEMA__".duration_node_daily
  ADD COLUMN IF NOT EXISTS page_sketch JSONB;
