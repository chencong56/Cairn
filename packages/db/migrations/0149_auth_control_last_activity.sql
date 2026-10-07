-- 0149_auth_control_last_activity：直连会话手动操作权记录最近一次活动（输入、本人指认），用于服务端空闲收回
ALTER TABLE "__SCHEMA__".browser_sessions
  ADD COLUMN IF NOT EXISTS auth_control_last_activity_at timestamp with time zone;
