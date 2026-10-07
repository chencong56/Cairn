-- 0150_monitoring_target_scope：监控样本与告警的范围新增 target（目标系统），用于页面健康的目标级指标与告警
ALTER TABLE "__SCHEMA__".monitor_samples
  DROP CONSTRAINT IF EXISTS monitor_samples_scope_check;
ALTER TABLE "__SCHEMA__".monitor_samples
  ADD CONSTRAINT monitor_samples_scope_check CHECK (scope IN ('platform', 'api', 'worker', 'target'));

ALTER TABLE "__SCHEMA__".monitoring_alerts
  DROP CONSTRAINT IF EXISTS monitoring_alerts_scope_check;
ALTER TABLE "__SCHEMA__".monitoring_alerts
  ADD CONSTRAINT monitoring_alerts_scope_check CHECK (scope IN ('platform', 'api', 'worker', 'target'));
