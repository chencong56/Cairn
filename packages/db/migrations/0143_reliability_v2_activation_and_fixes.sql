-- 0143：可靠性 v2 启用链路补全与复查修复
-- 1. 回填存量目标：全部启用 v2 评估（此前无任何启用路径，v2 管线生产暗转）
-- 2. reliability_signals 唯一键加入 scope_digest：同一 Run 多作用域 latency_regression 不再互相挤占
-- 3. baseline_revisions 增加 revision_ordinal：同一事务多版基线 createdAt 相同，以单调序号决胜最新版

UPDATE "__SCHEMA__".reliability_checkpoints
SET v2_enabled = true,
    v2_enabled_at = now()
WHERE v2_enabled = false;

DROP INDEX IF EXISTS "__SCHEMA__".idx_rel_signals_source_uniq;

CREATE UNIQUE INDEX IF NOT EXISTS idx_rel_signals_source_uniq
  ON "__SCHEMA__".reliability_signals (target_id, scope_digest, kind, source_kind, source_id);

ALTER TABLE "__SCHEMA__".baseline_revisions ADD COLUMN IF NOT EXISTS revision_ordinal BIGINT NOT NULL DEFAULT 0;
