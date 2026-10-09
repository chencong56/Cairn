-- 0156_worker_roles_release：锁步部署 P1（方案 docs/spec/2026-10-08-lockstep-deploy-remove-protocol-gates.md 第 3、4 节）
-- Worker 登记改为显式角色（executor / scheduler / maintenance / analyst）与发布号，删除按协议串推断能力的 protocol_capabilities。
-- 不回填：在线 Worker 每次启动都会重新登记；锁步部署下旧版本 Worker 不与新版控制台混跑。

ALTER TABLE "__SCHEMA__".workers
  ADD COLUMN IF NOT EXISTS roles JSONB NOT NULL DEFAULT '[]';

-- 发布号（CAIRN_BUILD_VERSION）；本机开发为空，不参与版本一致性判断
ALTER TABLE "__SCHEMA__".workers
  ADD COLUMN IF NOT EXISTS release TEXT;

ALTER TABLE "__SCHEMA__".workers
  DROP COLUMN IF EXISTS protocol_capabilities;
