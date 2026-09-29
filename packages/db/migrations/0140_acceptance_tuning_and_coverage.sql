-- 0140: 验收意图（三期）：条件调优索引、批量巡检批次与覆盖快照表
-- 增加 outcome_results 契约索引以支持跨运行条件洞察聚合；
-- 增加 acceptance_sweep_batches 与 acceptance_coverage_snapshots 表以支持平台定时/手动巡检与横向覆盖视图。

CREATE INDEX IF NOT EXISTS outcome_results_contract_idx ON "__SCHEMA__".outcome_results (contract_id);

CREATE TABLE "__SCHEMA__".acceptance_sweep_batches (
  id UUID PRIMARY KEY,
  scope TEXT NOT NULL,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  scenario_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX acceptance_sweep_batches_status_idx ON "__SCHEMA__".acceptance_sweep_batches (status, created_at);
CREATE INDEX acceptance_sweep_batches_lease_idx ON "__SCHEMA__".acceptance_sweep_batches (status, lease_expires_at);

CREATE TABLE "__SCHEMA__".acceptance_coverage_snapshots (
  id UUID PRIMARY KEY,
  batch_id UUID NOT NULL REFERENCES "__SCHEMA__".acceptance_sweep_batches(id) ON DELETE CASCADE,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  scenario_id UUID NOT NULL REFERENCES "__SCHEMA__".scenarios(id) ON DELETE RESTRICT,
  draft_revision INTEGER NOT NULL,
  audited_at TIMESTAMPTZ NOT NULL,
  trigger TEXT NOT NULL,
  coverage JSONB,
  findings_count INTEGER NOT NULL DEFAULT 0,
  top_findings JSONB NOT NULL DEFAULT '[]',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX acceptance_coverage_snapshots_target_audited_idx ON "__SCHEMA__".acceptance_coverage_snapshots (target_id, audited_at);
CREATE INDEX acceptance_coverage_snapshots_scenario_audited_idx ON "__SCHEMA__".acceptance_coverage_snapshots (scenario_id, audited_at);
CREATE INDEX acceptance_coverage_snapshots_batch_idx ON "__SCHEMA__".acceptance_coverage_snapshots (batch_id);
