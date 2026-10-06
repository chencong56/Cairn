#!/usr/bin/env bash
# Mac 侧源码增量推送（跨站慢链路只走源码增量，产物构建在 ah3 本地完成）
# 增量机制：git stash create 快照当前工作区 → 与上次推送的 ref diff → tar 管道只传变更/删除。
# 不依赖 rsync（Mac 仅 openrsync，与 CentOS 7 rsync 3.1.2 协议不兼容）。
# 用法：./push-src.sh          # 增量推送并更新 ref
#       ./push-src.sh --full   # 全量重推（修复远端目录时用）
set -euo pipefail
cd "$(dirname "$0")/../.."

REMOTE=root@shsnc-ah3
BUILD=/data/wp/cairn/cluster/build
REF_FILE=$BUILD/.pushed-ref

EXCLUDES=(
  .zcode .agents .claude .env .env.local .env.remote .env.production
)
is_excluded() {
  local p="$1"
  for e in "${EXCLUDES[@]}"; do [ "$p" = "$e" ] && return 0; done
  return 1
}

push_full() {
  echo "▶ 全量推送源码 → $REMOTE:$BUILD"
  tar -czf - \
    --exclude='.git' --exclude='node_modules' --exclude='*/node_modules' \
    --exclude='*/dist' --exclude='*/.data' --exclude='*/coverage' --exclude='*/.turbo' \
    --exclude='vendor' --exclude='docs/spec' --exclude='docs/reviews' --exclude='docs/plan' \
    --exclude='docs/arch' --exclude='docs/targets' --exclude='docs/deploy' \
    --exclude='tools' --exclude='scripts' --exclude='tmp' --exclude='logs' --exclude='.run' \
    --exclude='.zcode' --exclude='.agents' --exclude='.claude' \
    --exclude='.env' --exclude='.env.local' --exclude='.env.remote' --exclude='.env.production' \
    --exclude='deploy/singe' --exclude='deploy/cluster/dist' --exclude='deploy/compose.yml' \
    --exclude='.data' --exclude='*.log' \
    package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc-build .dockerignore tsconfig.base.json turbo.json packages docs/design deploy/cluster \
    | ssh $REMOTE "mkdir -p $BUILD && tar -xzf - -C $BUILD"
}

# 当前工作区快照（干净时等于 HEAD）
NEW=$(git stash create)
[ -z "$NEW" ] && NEW=$(git rev-parse HEAD)
LAST=$(ssh $REMOTE "cat $REF_FILE 2>/dev/null" || true)

if [ "${1:-}" = "--full" ] || [ -z "$LAST" ]; then
  push_full
else
  echo "▶ 增量推送（${LAST} → ${NEW}）"
  CHANGED=$(git diff --name-only "$LAST" "$NEW" | while IFS= read -r p; do is_excluded "$p" || echo "$p"; done || true)
  DELETED=$(git diff --name-only --diff-filter=D "$LAST" "$NEW" | while IFS= read -r p; do is_excluded "$p" || echo "$p"; done || true)
  if [ -n "$DELETED" ]; then
    echo "$DELETED" | ssh $REMOTE "cd $BUILD && xargs -r rm -f"
    echo "  删除 $(echo "$DELETED" | wc -l | tr -d ' ') 个文件"
  fi
  if [ -n "$CHANGED" ]; then
    echo "$CHANGED" | tar -czf - -T - | ssh $REMOTE "tar -xzf - -C $BUILD"
    echo "  更新 $(echo "$CHANGED" | wc -l | tr -d ' ') 个文件"
  else
    echo "  无变更"
  fi
fi

ssh $REMOTE "echo ${NEW} > $REF_FILE"
echo "✅ 源码已推送。下一步（ah3）：cd $BUILD/deploy/cluster && ./build-apps.sh all && ./sync-apps.sh all"
