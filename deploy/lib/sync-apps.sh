#!/usr/bin/env bash
# 内部步骤，在 build_host 上执行。把指定 rev 的 worker 同步到 executor。
# 用法：sync-apps.sh <rev> <ssh-or-ip> [<ssh-or-ip>...]
# 不重启；重启由 ./deploy/cairn release 按清单做。
set -euo pipefail
CLUSTER="${CAIRN_CLUSTER_ROOT:-/data/wp/cairn/cluster}"
REV="${1:?用法: sync-apps.sh <rev> <host>...}"
shift
SRC=$CLUSTER/apps/releases/$REV/worker
[ -d "$SRC" ] || { echo "找不到 $SRC" >&2; exit 1; }

for dest in "$@"; do
  echo "▶ 同步 worker@$REV → $dest"
  ssh -o BatchMode=yes -o ConnectTimeout=15 "$dest" "set -euo pipefail
    mkdir -p $CLUSTER/apps/releases/$REV
    if [ ! -L $CLUSTER/apps/worker ] && [ -d $CLUSTER/apps/worker ]; then
      mkdir -p $CLUSTER/apps/releases/legacy
      mv $CLUSTER/apps/worker $CLUSTER/apps/releases/legacy/worker
    fi"
  tar -C "$CLUSTER/apps/releases" -cf - "$REV/worker" | ssh -o BatchMode=yes "$dest" "tar -C $CLUSTER/apps/releases -xf -"
  ssh -o BatchMode=yes "$dest" "chown -R 1000:1000 $CLUSTER/apps/releases/$REV && ln -sfn $CLUSTER/apps/releases/$REV/worker $CLUSTER/apps/worker"
done
echo "✅ worker@$REV 已分发（未重启）"
