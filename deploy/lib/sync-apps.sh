#!/usr/bin/env bash
# 应用产物内网分发（在 ah3 上执行）：apps/ 增量同步到 ah2/ah4 并滚动重启执行节点
# 用法：./sync-apps.sh [ah2|ah4|all] [--no-restart]
set -euo pipefail
CLUSTER=/data/wp/cairn/cluster
TARGETS="${1:-all}"
RESTART=true
[ "${2:-}" = "--no-restart" ] && RESTART=false

sync_to() {
  local short="$1" ip="$2"
  echo "▶ [$short] tar 管道同步 apps → $ip"
  ssh "root@$ip" "mkdir -p $CLUSTER/apps"
  tar -C "$CLUSTER/apps" -cf - api worker web | ssh "root@$ip" "tar -C $CLUSTER/apps -xf -"
  ssh "root@$ip" "chown -R 1000:1000 $CLUSTER/apps"
  if $RESTART; then
    # up -d 在 bind mount 仅内容变化时不会重建/重启容器（产物换了进程仍是旧代码），
    # 必须显式 restart 才重新解析挂载并加载新产物
    echo "▶ [$short] 启动/更新 executor 并清理旧孤儿容器"
    ssh "root@$ip" "cd $CLUSTER/deploy && docker compose -f executor.compose.yml up -d --remove-orphans && docker compose -f executor.compose.yml restart cairn-executor"
  fi
}

case "$TARGETS" in
  ah2) sync_to ah2 192.168.3.202 ;;
  ah4) sync_to ah4 192.168.3.204 ;;
  all) sync_to ah2 192.168.3.202; sync_to ah4 192.168.3.204 ;;
  *) echo "用法：$0 [ah2|ah4|all] [--no-restart]" >&2; exit 1 ;;
esac
echo "✅ 分发完成（ah3 本机生效：cd /data/wp/cairn/cluster/deploy && ./cairn-ctl.sh restart）"
