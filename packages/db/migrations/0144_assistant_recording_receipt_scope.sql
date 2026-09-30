-- 0144：助手的不同提案族可再次插入同一录制；普通导入继续保持每场景、录制一份回执。
ALTER TABLE "__SCHEMA__".recording_import_receipts ADD COLUMN import_scope_key TEXT NOT NULL DEFAULT 'direct';
UPDATE "__SCHEMA__".recording_import_receipts SET import_scope_key = proposal_family_id WHERE proposal_family_id IS NOT NULL;
DROP INDEX "__SCHEMA__".recording_import_receipts_scenario_draft_idx;
CREATE UNIQUE INDEX recording_import_receipts_scenario_draft_idx ON "__SCHEMA__".recording_import_receipts (scenario_id, recording_draft_id, import_scope_key);
