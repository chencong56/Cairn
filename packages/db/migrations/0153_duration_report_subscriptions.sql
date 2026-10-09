-- 0153_duration_report_subscriptions：周期耗时报告的订阅（到点生成并推送）与每期记录
-- 订阅新建默认不启用；「同一目标系统 + 场景集 + 周期 + 发起方至多一条启用订阅」在应用层加锁校验（不用条件唯一索引）。

CREATE TABLE IF NOT EXISTS "__SCHEMA__".duration_report_subscriptions (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets (id) ON DELETE RESTRICT,
  suite_id UUID REFERENCES "__SCHEMA__".scenario_suites (id) ON DELETE RESTRICT,
  period_kind TEXT NOT NULL,
  send_weekday INTEGER NOT NULL DEFAULT 1,
  send_day INTEGER NOT NULL DEFAULT 1,
  send_time TEXT NOT NULL DEFAULT '09:00',
  time_zone TEXT NOT NULL,
  trigger_filter TEXT NOT NULL,
  channel_ids JSONB NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  enabled_at TIMESTAMPTZ,
  revision INTEGER NOT NULL DEFAULT 1,
  created_by_console_account_id UUID NOT NULL REFERENCES "__SCHEMA__".console_accounts (id) ON DELETE RESTRICT,
  updated_by_console_account_id UUID REFERENCES "__SCHEMA__".console_accounts (id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT duration_report_subscriptions_period_check CHECK (period_kind IN ('week', 'month')),
  CONSTRAINT duration_report_subscriptions_weekday_check CHECK (send_weekday BETWEEN 1 AND 7),
  CONSTRAINT duration_report_subscriptions_day_check CHECK (send_day BETWEEN 1 AND 28),
  CONSTRAINT duration_report_subscriptions_trigger_check CHECK (trigger_filter IN ('all', 'manual', 'schedule', 'service')),
  CONSTRAINT duration_report_subscriptions_revision_check CHECK (revision > 0)
);
CREATE INDEX IF NOT EXISTS duration_report_subscriptions_target_idx ON "__SCHEMA__".duration_report_subscriptions (target_id, created_at);
CREATE INDEX IF NOT EXISTS duration_report_subscriptions_enabled_idx ON "__SCHEMA__".duration_report_subscriptions (enabled, period_kind);

CREATE TABLE IF NOT EXISTS "__SCHEMA__".duration_report_issues (
  id UUID PRIMARY KEY,
  duration_report_subscription_id UUID NOT NULL REFERENCES "__SCHEMA__".duration_report_subscriptions (id) ON DELETE CASCADE,
  period_start TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  report_id UUID REFERENCES "__SCHEMA__".reports (id) ON DELETE RESTRICT,
  export_job_id UUID,
  outbound_event_id UUID,
  attempts INTEGER NOT NULL DEFAULT 0,
  send_at TIMESTAMPTZ NOT NULL,
  next_attempt_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT duration_report_issues_status_check CHECK (status IN ('pending', 'generated', 'delivered', 'skipped', 'failed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS duration_report_issues_period_idx ON "__SCHEMA__".duration_report_issues (duration_report_subscription_id, period_start);
CREATE INDEX IF NOT EXISTS duration_report_issues_status_idx ON "__SCHEMA__".duration_report_issues (status, next_attempt_at);
