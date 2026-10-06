-- 0148_suite_run_soft_delete：场景集运行软删除与审计标记支持
ALTER TABLE "__SCHEMA__".suite_runs
  ADD COLUMN IF NOT EXISTS deleted_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS deleted_by jsonb;

CREATE INDEX IF NOT EXISTS suite_runs_deleted_at_idx ON "__SCHEMA__".suite_runs (deleted_at);
