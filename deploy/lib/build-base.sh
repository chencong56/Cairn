#!/usr/bin/env bash
# 在目标服务器上原生构建【运行时底座镜像】（API / Worker）。
# 镜像架构由服务器自己决定，本机（Mac）不构建、不拉取、不传输任何镜像。
# 源码来自 push-src.sh 推到 ah3 的构建目录；应用产物不进镜像（见 README）。
# 基础设施镜像（postgres / redis / rustfs / mc / nginx）不在此处理：compose up 时由服务器自行拉取。
# 用法（在 ah3 的构建目录 deploy/cluster 下执行）：
#   ./build-base.sh <tag>                 # 只在本机构建
#   ./build-base.sh <tag> --to ah2,ah4    # 构建后经内网搬运给同架构的执行节点（docker save | ssh docker load）
set -euo pipefail
cd "$(dirname "$0")/../.."

TAG="${1:?用法: build-base.sh <tag> [--to host1,host2]}"
TARGETS=""
if [ "${2:-}" = "--to" ]; then TARGETS="${3:?--to 需要主机列表，如 ah2,ah4}"; fi

echo "▶ 原生构建 cairn-api / cairn-worker:$TAG（架构：$(uname -m)）"
docker build -f deploy/cluster/Dockerfile.api    -t "cairn-api:$TAG"    .
docker build -f deploy/cluster/Dockerfile.worker -t "cairn-worker:$TAG" .

if [ -n "$TARGETS" ]; then
  local_arch=$(docker image inspect "cairn-worker:$TAG" --format '{{.Architecture}}')
  for short in ${TARGETS//,/ }; do
    host="root@shsnc-$short"
    remote_arch=$(ssh "$host" "uname -m")
    case "$remote_arch" in x86_64) want=amd64 ;; aarch64|arm64) want=arm64 ;; *) want=$remote_arch ;; esac
    if [ "$want" != "$local_arch" ]; then
      echo "✗ [$short] 架构不一致（本机镜像 $local_arch，目标 $want），请在该机器上直接运行 build-base.sh" >&2
      exit 1
    fi
    echo "▶ [$short] 内网搬运 cairn-worker:$TAG"
    docker save "cairn-worker:$TAG" | ssh "$host" docker load
  done
fi
echo "✅ 底座镜像就绪：cairn-api:$TAG / cairn-worker:$TAG"
