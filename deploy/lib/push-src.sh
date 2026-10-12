#!/usr/bin/env bash
# 内部步骤，不要直接跑。由 ./deploy/cairn release 调用。
# 需要：CAIRN_PUSH_SSH  CAIRN_PUSH_BUILD
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"

SSH="${CAIRN_PUSH_SSH:?}"
BUILD="${CAIRN_PUSH_BUILD:?}"
REF_FILE=$BUILD/.pushed-ref

EXCLUDES='.zcode .agents .claude .env .env.local .env.remote .env.production'
is_excluded() {
  echo "$EXCLUDES" | grep -qw -- "$1"
}

export COPYFILE_DISABLE=1
NEW="${CAIRN_PUSH_NEW:-}"
if [ -z "$NEW" ]; then
  NEW=$(git stash create)
  [ -z "$NEW" ] && NEW=$(git rev-parse HEAD)
fi
REV=$(git rev-parse --short=12 "$NEW")
LAST=$(ssh -o BatchMode=yes -o ConnectTimeout=15 "$SSH" "cat $REF_FILE 2>/dev/null" || true)

push_full() {
  echo "▶ 全量推送源码 → $SSH:$BUILD"
  COPYFILE_DISABLE=1 tar -czf - \
    --exclude='.git' --exclude='node_modules' --exclude='*/node_modules' \
    --exclude='*/dist' --exclude='*/.data' --exclude='*/coverage' --exclude='*/.turbo' \
    --exclude='vendor' --exclude='docs/spec' --exclude='docs/reviews' --exclude='docs/plan' \
    --exclude='docs/arch' --exclude='docs/targets' --exclude='docs/deploy' \
    --exclude='tools' --exclude='scripts' --exclude='tmp' --exclude='logs' --exclude='.run' \
    --exclude='.zcode' --exclude='.agents' --exclude='.claude' \
    --exclude='.env' --exclude='.env.local' --exclude='.env.remote' --exclude='.env.production' \
    --exclude='.env.local.secrets' --exclude='.env.remote.secrets' \
    --exclude='deploy/singe' --exclude='deploy/cluster/dist' --exclude='deploy/compose.yml' \
    --exclude='deploy/dev-infra/.env' --exclude='.data' --exclude='*.log' \
    package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc-build .dockerignore tsconfig.base.json turbo.json packages docs/design deploy/cluster deploy/images \
    | ssh -o BatchMode=yes "$SSH" "mkdir -p $BUILD && tar -xzf - -C $BUILD"
}

if [ "${1:-}" = "--full" ] || [ -z "$LAST" ]; then
  push_full
else
  echo "▶ 增量推送（${LAST} → ${NEW}）"
  CHANGED=$(git diff --name-only --diff-filter=ACMRT "$LAST" "$NEW" | while IFS= read -r p; do
    is_excluded "$p" && continue
    [ -e "$p" ] || continue
    echo "$p"
  done || true)
  DELETED=$(git diff --name-only --diff-filter=D "$LAST" "$NEW" | while IFS= read -r p; do is_excluded "$p" || echo "$p"; done || true)
  if [ -n "$DELETED" ]; then
    echo "$DELETED" | ssh -o BatchMode=yes "$SSH" "cd $BUILD && xargs -r rm -f"
    echo "  删除 $(echo "$DELETED" | wc -l | tr -d ' ') 个文件"
  fi
  if [ -n "$CHANGED" ]; then
    if echo "$CHANGED" | COPYFILE_DISABLE=1 tar -czf - -T - | ssh -o BatchMode=yes "$SSH" "tar -xzf - -C $BUILD"; then
      echo "  更新 $(echo "$CHANGED" | wc -l | tr -d ' ') 个文件"
    else
      echo "  增量失败，改全量"
      push_full
    fi
  else
    echo "  无变更"
  fi
fi

ssh -o BatchMode=yes "$SSH" "echo ${NEW} > $REF_FILE"
echo "CAIRN_PUSH_REV=$REV"
