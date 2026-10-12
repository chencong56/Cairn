#!/usr/bin/env bash
# 内部步骤，稀有。底座镜像在 build_host 上构建。日常 release 不跑。
# 需要：CAIRN_PUSH_SSH 或在 ah3 的构建目录执行。
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
TAG="${1:?用法: build-base.sh <tag>}"

echo "▶ 原生构建 cairn-api / cairn-worker:$TAG（架构：$(uname -m)）"
docker build -f deploy/images/Dockerfile.api    -t "cairn-api:$TAG"    .
docker build -f deploy/images/Dockerfile.worker -t "cairn-worker:$TAG" .
echo "✅ 底座镜像就绪：cairn-api:$TAG / cairn-worker:$TAG"
