-- 0141_reliability_semantics_v2：自动化维护信号与事件语义校准（v2）
-- 1. 扩展 step_runs 模块身份三元组 (module_id, implementation_key, internal_step_id)
-- 2. 扩展 reliability_signals 来源投影与天然唯一键 (source_kind, source_id, error_family)
-- 3. 扩展 reliability_incidents 结构化资产/实现/账号身份、规则版本与观察/关闭时序元数据
-- 4. 扩展 feature_windows 接纳序号起止范围
-- 5. 扩展 reliability_checkpoints v2 启用标记与单调递增评估接纳序号
-- 6. 创建 reliability_run_receipts 事务内待消费记录账本表
-- 7. 创建 reliability_run_samples 全量窗口与基线可重建派生样本投影表

ALTER TABLE "__SCHEMA__".step_runs ADD COLUMN IF NOT EXISTS module_id UUID;
ALTER TABLE "__SCHEMA__".step_runs ADD COLUMN IF NOT EXISTS implementation_key TEXT;
ALTER TABLE "__SCHEMA__".step_runs ADD COLUMN IF NOT EXISTS internal_step_id TEXT;

ALTER TABLE "__SCHEMA__".reliability_signals ADD COLUMN IF NOT EXISTS source_kind TEXT;
ALTER TABLE "__SCHEMA__".reliability_signals ADD COLUMN IF NOT EXISTS source_id TEXT;
ALTER TABLE "__SCHEMA__".reliability_signals ADD COLUMN IF NOT EXISTS error_family TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_rel_signals_source_uniq
  ON "__SCHEMA__".reliability_signals (target_id, kind, source_kind, source_id);

ALTER TABLE "__SCHEMA__".reliability_incidents ADD COLUMN IF NOT EXISTS rule_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "__SCHEMA__".reliability_incidents ADD COLUMN IF NOT EXISTS asset_kind TEXT;
ALTER TABLE "__SCHEMA__".reliability_incidents ADD COLUMN IF NOT EXISTS asset_id TEXT;
ALTER TABLE "__SCHEMA__".reliability_incidents ADD COLUMN IF NOT EXISTS step_id TEXT;
ALTER TABLE "__SCHEMA__".reliability_incidents ADD COLUMN IF NOT EXISTS implementation_key TEXT;
ALTER TABLE "__SCHEMA__".reliability_incidents ADD COLUMN IF NOT EXISTS account_id TEXT;
ALTER TABLE "__SCHEMA__".reliability_incidents ADD COLUMN IF NOT EXISTS observing_started_at TIMESTAMPTZ;
ALTER TABLE "__SCHEMA__".reliability_incidents ADD COLUMN IF NOT EXISTS observing_started_ordinal BIGINT;
ALTER TABLE "__SCHEMA__".reliability_incidents ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
ALTER TABLE "__SCHEMA__".reliability_incidents ADD COLUMN IF NOT EXISTS closed_evaluation_ordinal BIGINT;

CREATE INDEX IF NOT EXISTS idx_rel_incidents_target_asset
  ON "__SCHEMA__".reliability_incidents (target_id, asset_kind, asset_id);

CREATE INDEX IF NOT EXISTS idx_rel_incidents_target_rule_status
  ON "__SCHEMA__".reliability_incidents (target_id, rule_version, status);

ALTER TABLE "__SCHEMA__".feature_windows ADD COLUMN IF NOT EXISTS start_ordinal BIGINT;
ALTER TABLE "__SCHEMA__".feature_windows ADD COLUMN IF NOT EXISTS end_ordinal BIGINT;

CREATE INDEX IF NOT EXISTS idx_feature_windows_target_scope_end_ord
  ON "__SCHEMA__".feature_windows (target_id, scope_digest, window_type, end_ordinal);

ALTER TABLE "__SCHEMA__".reliability_checkpoints ADD COLUMN IF NOT EXISTS v2_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "__SCHEMA__".reliability_checkpoints ADD COLUMN IF NOT EXISTS v2_enabled_at TIMESTAMPTZ;
ALTER TABLE "__SCHEMA__".reliability_checkpoints ADD COLUMN IF NOT EXISTS run_evaluation_ordinal BIGINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "__SCHEMA__".reliability_run_receipts (
  run_id              UUID        NOT NULL REFERENCES "__SCHEMA__".runs (id) ON DELETE CASCADE,
  rule_version        INTEGER     NOT NULL DEFAULT 2,
  target_id           UUID        NOT NULL REFERENCES "__SCHEMA__".targets (id) ON DELETE CASCADE,
  finished_at         TIMESTAMPTZ NOT NULL,
  enqueued_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at         TIMESTAMPTZ,
  evaluation_ordinal  BIGINT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rel_receipts_run_rule
  ON "__SCHEMA__".reliability_run_receipts (run_id, rule_version);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rel_receipts_target_rule_ord
  ON "__SCHEMA__".reliability_run_receipts (target_id, rule_version, evaluation_ordinal);

CREATE INDEX IF NOT EXISTS idx_rel_receipts_target_pending
  ON "__SCHEMA__".reliability_run_receipts (target_id, rule_version, consumed_at, finished_at, run_id);

CREATE TABLE IF NOT EXISTS "__SCHEMA__".reliability_run_samples (
  id                  UUID        PRIMARY KEY,
  rule_version        INTEGER     NOT NULL DEFAULT 2,
  target_id           UUID        NOT NULL REFERENCES "__SCHEMA__".targets (id) ON DELETE CASCADE,
  run_id              UUID        NOT NULL REFERENCES "__SCHEMA__".runs (id) ON DELETE CASCADE,
  scope_digest        TEXT        NOT NULL,
  scope_kind          TEXT        NOT NULL,
  evaluation_ordinal  BIGINT      NOT NULL,
  execution_conclusion TEXT       NOT NULL,
  signals             JSONB       NOT NULL DEFAULT '[]'::jsonb,
  is_comparable       BOOLEAN     NOT NULL DEFAULT true,
  duration_ms         DOUBLE PRECISION,
  source_ref          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  comparisons         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  asset_kind          TEXT,
  asset_id            TEXT,
  module_id           UUID,
  implementation_key  TEXT,
  step_id             TEXT,
  internal_step_id    TEXT,
  account_id          TEXT,
  occurred_at         TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rel_samples_uniq
  ON "__SCHEMA__".reliability_run_samples (rule_version, target_id, run_id, scope_digest);

CREATE INDEX IF NOT EXISTS idx_rel_samples_target_scope_ord
  ON "__SCHEMA__".reliability_run_samples (target_id, scope_digest, evaluation_ordinal);

CREATE INDEX IF NOT EXISTS idx_rel_samples_target_asset_ord
  ON "__SCHEMA__".reliability_run_samples (target_id, asset_kind, asset_id, evaluation_ordinal);
