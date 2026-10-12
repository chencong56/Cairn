#!/usr/bin/env bash
# 内部步骤，在 build_host 上执行。不要直接跑。
# 产物写到 apps/releases/$REV/{api,worker,web}，不碰正在跑的 apps/{api,worker,web}。
set -euo pipefail
CLUSTER="${CAIRN_CLUSTER_ROOT:-/data/wp/cairn/cluster}"
SRC=$CLUSTER/build
OUT=$CLUSTER/apps
REV="${1:?用法: build-apps.sh <rev>}"
DEST=$OUT/releases/$REV

avail=$(df -Pm "$CLUSTER" | awk 'NR==2 { print $4 }')
if [ "${avail:-0}" -lt 2048 ]; then
  echo "磁盘不足：${avail}MB，需要至少 2GB 才构建" >&2
  exit 1
fi

mkdir -p "$DEST"

build_one() {
  local pkg="$1" target="$2"
  echo "▶ 构建 $pkg → $DEST/$target"
  rm -rf "$OUT/.staging-$target"
  docker run --rm \
    -v "$SRC":/repo -w /repo \
    -v "$OUT":/out \
    -e ONNXRUNTIME_NODE_INSTALL=skip \
    -e COREPACK_NPM_REGISTRY=https://registry.npmmirror.com \
    -e npm_config_registry=https://registry.npmmirror.com \
    -e npm_config_store_dir=/out/.pnpm-store \
    node:24-bookworm-slim \
    bash -c "set -e; corepack enable;
      pnpm install --frozen-lockfile --filter $pkg... ;
      pnpm --filter $pkg... build;
      pnpm --filter $pkg deploy --legacy --prod /out/.staging-$target"
  rm -rf "$DEST/$target"
  mv "$OUT/.staging-$target" "$DEST/$target"
}

build_web() {
  echo "▶ 构建 web → $DEST/web"
  rm -rf "$OUT/.staging-web-dist"
  docker run --rm \
    -v "$SRC":/repo -w /repo \
    -v "$OUT":/out \
    -e COREPACK_NPM_REGISTRY=https://registry.npmmirror.com \
    -e npm_config_registry=https://registry.npmmirror.com \
    -e npm_config_store_dir=/out/.pnpm-store \
    node:24-bookworm-slim \
    bash -c "set -e; corepack enable;
      pnpm install --frozen-lockfile --filter @cairn/web...;
      pnpm --filter @cairn/web... build;
      cp -r /repo/packages/web/dist /out/.staging-web-dist"
  rm -rf "$DEST/web"
  mv "$OUT/.staging-web-dist" "$DEST/web"
}

build_one @cairn/api api
build_one @cairn/worker worker
build_web
printf '%s\n' "$REV" > "$DEST/.rev"
chown -R 1000:1000 "$DEST"
echo "✅ 产物 $DEST"
