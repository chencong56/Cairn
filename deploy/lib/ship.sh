#!/usr/bin/env bash
# 内部步骤，首次装机。日常 ./deploy/cairn release 不跑，避免重写各机 .env。
# 读 deploy/targets/cluster.conf，不写主机字面量。不传输 worker-gateway 模板。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
DEPLOY=$(cd "$HERE/.." && pwd)
# shellcheck source=target.sh
. "$HERE/target.sh"

CONF="${CAIRN_TARGET_FILE:-$DEPLOY/targets/cluster.conf}"
target_assert_readable "$CONF" || exit 1
target_has_hosts "$CONF" || { echo "清单没有主机，拒绝装机" >&2; exit 1; }
ROOT=$(target_kv "$CONF" remote_root)
CLUSTER="$DEPLOY/cluster"

echo "ship 会改各机 deploy/.env。确认这是首次装机，不是日常发布。" >&2

for id in $(target_host_ids "$CONF"); do
  ssh_spec=$(target_host_kv "$CONF" "$id" ssh)
  lan=$(target_host_kv "$CONF" "$id" lan_ip)
  compose=$(target_host_kv "$CONF" "$id" compose)
  echo "▶ [$id] 布置目录与 compose（不覆盖已有 .env）"
  ssh -o BatchMode=yes "$ssh_spec" "mkdir -p $ROOT/{deploy/nginx,pg,rustfs2,browser-profiles,logs,apps}"
  scp -q "$CLUSTER/nginx/entry.conf" "$ssh_spec:$ROOT/deploy/nginx/"
  scp -q "$HERE/cairn-ctl.sh" "$ssh_spec:$ROOT/deploy/"
  scp -q "$CLUSTER/$compose" "$ssh_spec:$ROOT/deploy/"
  ssh -o BatchMode=yes "$ssh_spec" "if [ ! -f $ROOT/deploy/.env ]; then echo '缺少 $ROOT/deploy/.env，从本机 cluster/.env.example 填好再 scp' >&2; exit 1; fi; chmod +x $ROOT/deploy/cairn-ctl.sh; rm -f $ROOT/deploy/nginx/worker-gateway.conf.template"
  echo "✅ [$id] $lan $compose"
done
