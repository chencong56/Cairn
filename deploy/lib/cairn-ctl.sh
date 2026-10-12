#!/usr/bin/env bash
# 内部 / 主机排障。不要当发布入口。日常：./deploy/cairn
set -euo pipefail
cd "$(dirname "$0")"
if [ -f core.compose.yml ]; then
  COMPOSE="docker compose -f core.compose.yml"
  ROLE="core"
elif [ -f ../cluster/core.compose.yml ]; then
  cd ../cluster
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
  restart)
    if [ $# -gt 0 ]; then $COMPOSE restart "$@"; else $COMPOSE restart; fi
    ;;
  ps)      $COMPOSE ps ;;
  status)
    echo "═══ Cairn [$ROLE] @ $(hostname) ═══"
    $COMPOSE ps
    ;;
  logs)
    if [ $# -gt 0 ]; then $COMPOSE logs --tail "${2:-100}" "$1"; else $COMPOSE logs --tail 100; fi
    ;;
  migrate)
    echo "迁移请走 ./deploy/cairn migrate 或 release 的门禁，不再 || true" >&2
    exit 1
    ;;
  *) echo "用法：$0 up|down|restart|ps|status|logs [service] [lines]" >&2; exit 1 ;;
esac
