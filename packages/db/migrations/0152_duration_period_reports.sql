-- 0152_duration_period_reports：报告新增「周期耗时」主体——某目标系统（可限定场景集）在一个自然周 / 月的耗时报告
-- 报告内容仍由来源快照 + 修订封存，沿用现有生成、导出、保留与删除流程；本迁移只放开主体与范围。

ALTER TABLE "__SCHEMA__".reports
  ADD COLUMN IF NOT EXISTS suite_id UUID REFERENCES "__SCHEMA__".scenario_suites (id) ON DELETE RESTRICT;
ALTER TABLE "__SCHEMA__".reports
  ADD COLUMN IF NOT EXISTS period_kind TEXT;
ALTER TABLE "__SCHEMA__".reports
  ADD COLUMN IF NOT EXISTS period_start TEXT;
ALTER TABLE "__SCHEMA__".reports
  ADD COLUMN IF NOT EXISTS period_time_zone TEXT;
ALTER TABLE "__SCHEMA__".reports
  ADD COLUMN IF NOT EXISTS trigger_filter TEXT;

ALTER TABLE "__SCHEMA__".reports
  DROP CONSTRAINT IF EXISTS reports_subject_check;
ALTER TABLE "__SCHEMA__".reports
  ADD CONSTRAINT reports_subject_check CHECK (
    (subject_kind = 'RUN' AND run_id IS NOT NULL AND suite_run_id IS NULL AND period_kind IS NULL)
    OR (subject_kind = 'SUITE_RUN' AND suite_run_id IS NOT NULL AND run_id IS NULL AND period_kind IS NULL)
    OR (
      subject_kind = 'DURATION_PERIOD' AND run_id IS NULL AND suite_run_id IS NULL
      AND period_kind IN ('week', 'month') AND period_start IS NOT NULL
      AND period_time_zone IS NOT NULL AND trigger_filter IN ('all', 'manual', 'schedule', 'service')
    )
  );

ALTER TABLE "__SCHEMA__".report_revisions
  DROP CONSTRAINT IF EXISTS report_revisions_scope_check;
ALTER TABLE "__SCHEMA__".report_revisions
  ADD CONSTRAINT report_revisions_scope_check CHECK (scope IN ('run', 'suite_summary', 'suite_bundle', 'duration_period'));

CREATE INDEX IF NOT EXISTS reports_period_idx ON "__SCHEMA__".reports (target_id, period_kind, period_start);
