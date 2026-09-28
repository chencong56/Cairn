-- 0139: 录制草稿做减法：剔除名单持久化与修订号支持
-- 用于持久化记录录制草稿中被排除的事实/步骤项，支持乐观并发控制与回执追溯。

ALTER TABLE "__SCHEMA__".recording_drafts
  ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "__SCHEMA__".recording_draft_exclusions (
  id UUID PRIMARY KEY,
  recording_draft_id UUID NOT NULL REFERENCES "__SCHEMA__".recording_drafts(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT recording_draft_exclusions_item UNIQUE (recording_draft_id, item_id)
);

CREATE INDEX recording_draft_exclusions_draft_idx ON "__SCHEMA__".recording_draft_exclusions (recording_draft_id);
