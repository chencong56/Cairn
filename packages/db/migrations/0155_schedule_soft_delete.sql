-- 0155_schedule_soft_delete：定时任务软删除支持与审计标记
ALTER TABLE "__SCHEMA__".schedules
  ADD COLUMN IF NOT EXISTS deleted_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS deleted_by jsonb;

CREATE INDEX IF NOT EXISTS schedules_deleted_at_idx ON "__SCHEMA__".schedules (deleted_at);
