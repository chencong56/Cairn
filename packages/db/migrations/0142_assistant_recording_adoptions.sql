-- 0142_assistant_recording_adoptions：录制提案采纳元数据与受保护撤销支持
-- 1. 扩展 recording_import_receipts 助手采纳元数据 (proposal_id, proposal_family_id, proposal_summary, source_protocol, status, before_document, before_digest, after_digest, reverted_revision, reverted_at)
-- 2. 添加 actor + proposal_family_id 唯一约束保障同一提案族只允许一次采纳

ALTER TABLE "__SCHEMA__".recording_import_receipts ADD COLUMN IF NOT EXISTS proposal_id TEXT;
ALTER TABLE "__SCHEMA__".recording_import_receipts ADD COLUMN IF NOT EXISTS proposal_family_id TEXT;
ALTER TABLE "__SCHEMA__".recording_import_receipts ADD COLUMN IF NOT EXISTS proposal_summary TEXT;
ALTER TABLE "__SCHEMA__".recording_import_receipts ADD COLUMN IF NOT EXISTS source_protocol TEXT;
ALTER TABLE "__SCHEMA__".recording_import_receipts ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'applied';
ALTER TABLE "__SCHEMA__".recording_import_receipts ADD COLUMN IF NOT EXISTS before_document JSONB;
ALTER TABLE "__SCHEMA__".recording_import_receipts ADD COLUMN IF NOT EXISTS before_digest TEXT;
ALTER TABLE "__SCHEMA__".recording_import_receipts ADD COLUMN IF NOT EXISTS after_digest TEXT;
ALTER TABLE "__SCHEMA__".recording_import_receipts ADD COLUMN IF NOT EXISTS reverted_revision INTEGER;
ALTER TABLE "__SCHEMA__".recording_import_receipts ADD COLUMN IF NOT EXISTS reverted_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS recording_import_receipts_actor_proposal_family_idx
  ON "__SCHEMA__".recording_import_receipts (created_by_console_account_id, proposal_family_id);

CREATE INDEX IF NOT EXISTS recording_import_receipts_proposal_id_idx
  ON "__SCHEMA__".recording_import_receipts (proposal_id);
