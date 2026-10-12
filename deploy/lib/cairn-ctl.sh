#!/usr/bin/env bash
# 宿主侧运维脚本（三台通用，位于 /data/wp/cairn/cluster/deploy/cairn-ctl.sh）
# ah3 使用 core.compose.yml；ah2/ah4 自动使用 executor.compose.yml。
# 用法：cairn-ctl.sh up|down|restart|ps|status|logs [service] [lines]
set -euo pipefail
cd "$(dirname "$0")"

if [ -f core.compose.yml ]; then
  COMPOSE="docker compose -f core.compose.yml"
  ROLE="core"
else
  COMPOSE="docker compose -f executor.compose.yml"
  ROLE="executor"
fi

cmd="${1:-status}"
shift || true
case "$cmd" in
  up)      $COMPOSE up -d ;;
  down)    $COMPOSE down ;;
  # 无参不得透传空串（compose 会当成服务名报 no such service:）
  restart)
    if [ $# -gt 0 ]; then $COMPOSE restart "$@"; else $COMPOSE restart; fi
    ;;
  ps)      $COMPOSE ps ;;
  status)
    echo "═══ Cairn 集群 [$ROLE] @ $(hostname) ═══"
    $COMPOSE ps
    echo ""
    echo "── 容器健康 ──"
    for c in $($COMPOSE ps -q); do
      name=$(docker inspect -f '{{.Name}}' "$c" | tr -d /)
      health=$(docker inspect -f '{{.State.Health.Status}}' "$c" 2>/dev/null || echo "-")
      state=$(docker inspect -f '{{.State.Status}}' "$c")
      printf "%-28s %-12s %s\n" "$name" "$state" "${health:-n/a}"
    done
    ;;
  logs)
    # logs [service] [lines]：service 省略时看全部，不得透传空串服务名
    if [ $# -gt 0 ]; then $COMPOSE logs --tail "${2:-100}" "$1"; else $COMPOSE logs --tail 100; fi
    ;;
  migrate)
    # 仅 ah3：重跑迁移一次性任务（幂等，已应用的跳过）
    $COMPOSE up --abort-on-container-exit cairn-migrate || true
    $COMPOSE rm -f cairn-migrate 2>/dev/null || true
    ;;
  *) echo "用法：$0 up|down|restart|ps|status|logs [service] [lines]|migrate" >&2; exit 1 ;;
esac
