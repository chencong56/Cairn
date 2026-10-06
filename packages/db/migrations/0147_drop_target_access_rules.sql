-- 目标「访问范围」规则机制已移除：只读采集规则（read_only_requests_json 等）保留。
-- 历史冻结快照里的 rules 由 schema 兼容解析，不依赖该列。
ALTER TABLE "__SCHEMA__".target_access_policies
  DROP COLUMN rules_json;
