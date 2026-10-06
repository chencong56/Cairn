#!/usr/bin/env bash
# 应用产物构建脚本（在 ah3 上执行，产物供三台挂载运行，应用更新不走镜像）
# 前置：/data/wp/cairn/cluster/build 为源码目录（由 Mac push-src.sh 增量同步）
# 产物：/data/wp/cairn/cluster/apps/{api,worker,web}
# 用法：./build-apps.sh [api|worker|web|all]
set -euo pipefail
CLUSTER=/data/wp/cairn/cluster
SRC=$CLUSTER/build
OUT=$CLUSTER/apps
WHAT="${1:-all}"

mkdir -p "$OUT"

build_one() {
  local pkg="$1" target="$2"
  echo "▶ 构建 $pkg → $OUT/$target"
  rm -rf "$OUT/.staging-$target"
  docker run --rm \
    -v "$SRC":/repo -w /repo \
    -v "$OUT":/out \
    -e ONNXRUNTIME_NODE_INSTALL=skip \
    node:24-bookworm-slim \
    bash -c "set -e; corepack enable;
      pnpm install --frozen-lockfile --filter $pkg... ;
      pnpm --filter $pkg... build;
      pnpm --filter $pkg deploy --legacy --prod /out/.staging-$target"
  mkdir -p "$OUT"
  rm -rf "$OUT/$target.old"
  [ -d "$OUT/$target" ] && mv "$OUT/$target" "$OUT/$target.old"
  mv "$OUT/.staging-$target" "$OUT/$target"
}

build_web() {
  echo "▶ 构建 web → $OUT/web"
  rm -rf "$OUT/.staging-web-dist"
  docker run --rm \
    -v "$SRC":/repo -w /repo \
    -v "$OUT":/out \
    node:24-bookworm-slim \
    bash -c "set -e; corepack enable;
      pnpm install --frozen-lockfile --filter @cairn/web...;
      pnpm --filter @cairn/web... build;
      cp -r /repo/packages/web/dist /out/.staging-web-dist"
  rm -rf "$OUT/web.old"
  [ -d "$OUT/web" ] && mv "$OUT/web" "$OUT/web.old"
  mv "$OUT/.staging-web-dist" "$OUT/web"
}

case "$WHAT" in
  api)     build_one @cairn/api api ;;
  worker)  build_one @cairn/worker worker ;;
  web)     build_web ;;
  all)     build_one @cairn/api api; build_one @cairn/worker worker; build_web ;;
  *) echo "用法：$0 [api|worker|web|all]" >&2; exit 1 ;;
esac

chown -R 1000:1000 "$OUT"
echo "✅ 应用产物就绪：$OUT（重启容器生效：../deploy/cairn-ctl.sh restart）"
