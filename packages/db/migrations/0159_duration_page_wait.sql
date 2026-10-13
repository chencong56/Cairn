-- 0159_duration_page_wait：步骤页面等待账本。只有带采集标记的 attempt 才能把 pageMs 写成数字（含 0）。
-- 账本优先、证据补洞；collector_ready 心跳不算进 page_wait_count。无专有特性。

CREATE TABLE IF NOT EXISTS "__SCHEMA__".scenario_page_waits (
  id UUID PRIMARY KEY,
  evidence_id UUID NOT NULL,
  run_id UUID NOT NULL,
  step_run_id UUID NOT NULL,
  attempt_id UUID NOT NULL,
  reason TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NOT NULL,
  url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS scenario_page_waits_evidence_unique
  ON "__SCHEMA__".scenario_page_waits (evidence_id);
CREATE INDEX IF NOT EXISTS scenario_page_waits_run_idx
  ON "__SCHEMA__".scenario_page_waits (run_id);
CREATE INDEX IF NOT EXISTS scenario_page_waits_attempt_idx
  ON "__SCHEMA__".scenario_page_waits (attempt_id);
