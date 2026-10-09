-- 0157_visitor_identity：访客身份与运行账号
-- 1. 目标登录方式增加 none（无需登录）
-- 2. 会话认证状态增加 NOT_REQUIRED（访客会话无需认证）
-- 3. 账号增加身份类型与访客唯一性守卫；访客没有登录名，username 改为可空
-- 4. 目标默认账号、场景运行账号（不加外键：targets 与 target_accounts 会成环，归属在应用层校验）

ALTER TABLE "__SCHEMA__".targets
  DROP CONSTRAINT IF EXISTS targets_auth_method_check;
ALTER TABLE "__SCHEMA__".targets
  ADD CONSTRAINT targets_auth_method_check CHECK (auth_method IN ('password', 'manual', 'none'));

ALTER TABLE "__SCHEMA__".browser_sessions
  DROP CONSTRAINT IF EXISTS browser_sessions_auth_state_check;
ALTER TABLE "__SCHEMA__".browser_sessions
  ADD CONSTRAINT browser_sessions_auth_state_check
  CHECK (auth_state IN ('UNKNOWN', 'AUTHENTICATED', 'EXPIRED', 'NOT_REQUIRED'));

ALTER TABLE "__SCHEMA__".target_accounts
  ADD COLUMN IF NOT EXISTS identity_kind TEXT NOT NULL DEFAULT 'credential',
  ADD COLUMN IF NOT EXISTS visitor_guard TEXT,
  ALTER COLUMN username DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS target_accounts_visitor_guard
  ON "__SCHEMA__".target_accounts (target_id, visitor_guard);

ALTER TABLE "__SCHEMA__".targets
  ADD COLUMN IF NOT EXISTS default_account_id UUID;

ALTER TABLE "__SCHEMA__".scenarios
  ADD COLUMN IF NOT EXISTS run_account_id UUID;

-- 保持现状：存量目标若恰好有一个启用、可用于业务、带口令的账号，而可用身份有两个及以上，
-- 旧规则建 Run 时会自动选这个带口令的账号。新的取值顺序没有「唯一带口令账号」这一层，
-- 把它回填为目标默认账号，行为不变。
UPDATE "__SCHEMA__".targets
   SET default_account_id = (
     SELECT a.id FROM "__SCHEMA__".target_accounts a
      WHERE a.target_id = targets.id AND a.deleted_at IS NULL AND a.status = 'active'
        AND a.usage <> 'map' AND a.secret_id IS NOT NULL)
 WHERE default_account_id IS NULL
   AND deleted_at IS NULL
   AND (SELECT count(*) FROM "__SCHEMA__".target_accounts a
         WHERE a.target_id = targets.id AND a.deleted_at IS NULL AND a.status = 'active'
           AND a.usage <> 'map' AND a.secret_id IS NOT NULL) = 1
   AND (SELECT count(*) FROM "__SCHEMA__".target_accounts a
         WHERE a.target_id = targets.id AND a.deleted_at IS NULL AND a.status = 'active'
           AND a.usage <> 'map') >= 2;
