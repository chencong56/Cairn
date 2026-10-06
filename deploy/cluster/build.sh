#!/usr/bin/env bash
# Mac 侧构建【运行时底座镜像】：交叉编译 linux/amd64（Node24+Chromium+字体+原生库）。
# 注意：应用代码不打进镜像——日常更新走 push-src.sh → build-apps.sh → sync-apps.sh（见 README）。
# 本脚本仅首次部署 / 更换底座时使用；也可直接在 ah3 用源码 docker build（服务器 npm/CDN 可达）。
# 产物在 deploy/cluster/dist/（已 gitignore）。
# 用法：./build.sh [tag]   默认 tag = 日期-git短哈希
set -euo pipefail
cd "$(dirname "$0")/../.."

TAG="${1:-$(date +%Y%m%d)-$(git rev-parse --short HEAD)}"
DIST="deploy/cluster/dist"
RUSTFS_DIGEST="rustfs/rustfs@sha256:b7014e0ce2bc703c1316b3ef760e29dfae61fe4a50d1a66fa89638e0f8ea211f"

echo "▶ TAG=$TAG"
mkdir -p "$DIST"

echo "▶ 构建三镜像（linux/amd64，QEMU 交叉，耗时较长）"
podman build --platform linux/amd64 -f deploy/cluster/Dockerfile.api    -t "cairn-api:$TAG"    .
podman build --platform linux/amd64 -f deploy/cluster/Dockerfile.worker -t "cairn-worker:$TAG" .
podman build --platform linux/amd64 -f deploy/cluster/Dockerfile.web    -t "cairn-web:$TAG"    .

echo "▶ 拉齐基础设施镜像（postgres/redis/rustfs/mc/nginx）"
podman pull --platform linux/amd64 postgres:16
podman pull --platform linux/amd64 redis:7-alpine
podman pull --platform linux/amd64 "$RUSTFS_DIGEST"
podman pull --platform linux/amd64 minio/mc:RELEASE.2025-08-13T08-35-41Z
podman pull --platform linux/amd64 nginx:stable-alpine

echo "▶ 导出 tar"
podman save -o "$DIST/cairn-$TAG.tar" "cairn-api:$TAG" "cairn-worker:$TAG" "cairn-web:$TAG"
podman save -o "$DIST/infra.tar" \
  postgres:16 redis:7-alpine "$RUSTFS_DIGEST" \
  minio/mc:RELEASE.2025-08-13T08-35-41Z nginx:stable-alpine
echo "$TAG" > "$DIST/TAG"

echo "✅ 构建完成：$DIST/cairn-$TAG.tar + infra.tar（tag=$TAG）"
