#!/usr/bin/env bash
# Mac 侧分发：生成/复用 .env（密钥 openssl 随机），把 compose、配置送到三台并布置目录。
# 不传输镜像：底座镜像由服务器原生构建（build-base.sh），基础设施镜像由服务器 compose up 时自行拉取。
# 只加不改：不触碰任何存量容器与目录。
# 用法：./ship.sh          # 全新分发（首次；本地已生成 .env 则复用）
#       ./ship.sh <tag>    # 指定与 dist/TAG 不同的镜像 tag
set -euo pipefail
cd "$(dirname "$0")"
REPO_ROOT="../.."
DIST="dist"
TAG="${1:-$(cat "$DIST/TAG")}"
SECRET_FILE="dist/.env.secrets"

AH3=root@shsnc-ah3
AH2=root@shsnc-ah2
AH4=root@shsnc-ah4

# ── 1. 生成共享 .env（密钥只生成一次，三台复用同一份）──
if [ ! -f "$SECRET_FILE" ]; then
  echo "▶ 生成密钥与 .env 模板"
  JWT=$(openssl rand -base64 48 | tr -d '\n')
  CRED=$(openssl rand -base64 32 | tr -d '\n')
  HMAC=$(openssl rand -base64 32 | tr -d '\n')
  DBPW=$(openssl rand -base64 24 | tr -d '\n')
  S3AK="CAIRN$(openssl rand -hex 10 | tr 'a-f' 'A-F' | head -c 20)"
  S3SK=$(openssl rand -base64 32 | tr -d '\n/+=' | head -c 40)
  sed -e "s|^CAIRN_IMAGE_TAG=.*|CAIRN_IMAGE_TAG=$TAG|" \
      -e "s|^CAIRN_BUILD_VERSION=.*|CAIRN_BUILD_VERSION=$TAG|" \
      -e "s|^CAIRN_DB_PASSWORD=.*|CAIRN_DB_PASSWORD=$DBPW|" \
      -e "s|^CAIRN_JWT_SECRET=.*|CAIRN_JWT_SECRET=$JWT|" \
      -e "s|^CAIRN_CREDENTIAL_KEY=.*|CAIRN_CREDENTIAL_KEY=$CRED|" \
      -e "s|^CAIRN_INTERNAL_AUTH_SECRET=.*|CAIRN_INTERNAL_AUTH_SECRET=$HMAC|" \
      -e "s|^CAIRN_S3_ACCESS_KEY=.*|CAIRN_S3_ACCESS_KEY=$S3AK|" \
      -e "s|^CAIRN_S3_SECRET_KEY=.*|CAIRN_S3_SECRET_KEY=$S3SK|" \
      -e "s|^RUSTFS_ACCESS_KEY=.*|RUSTFS_ACCESS_KEY=$S3AK|" \
      -e "s|^RUSTFS_SECRET_KEY=.*|RUSTFS_SECRET_KEY=$S3SK|" \
      .env.example > "$SECRET_FILE"
  chmod 600 "$SECRET_FILE"
  echo "secrets written: $SECRET_FILE (gitignored, do not commit)"
else
  sed -i '' "s|^CAIRN_IMAGE_TAG=.*|CAIRN_IMAGE_TAG=$TAG|; s|^CAIRN_BUILD_VERSION=.*|CAIRN_BUILD_VERSION=$TAG|" "$SECRET_FILE"
fi

# ── 2. 逐台布置 ──
ship() {
  local host="$1" short="$2" ip="$3"
  echo "▶ [$short] 传输配置"
  ssh "$host" "mkdir -p /data/wp/cairn/cluster/{deploy/nginx,pg,rustfs2,browser-profiles,logs}"
  scp -q nginx/entry.conf nginx/worker-gateway.conf.template "$host:/data/wp/cairn/cluster/deploy/nginx/"
  scp -q cairn-ctl.sh "$host:/data/wp/cairn/cluster/deploy/"
  echo "▶ [$short] 检查底座镜像（须已由服务器原生构建）"
  if ! ssh "$host" "docker image inspect cairn-worker:$TAG >/dev/null 2>&1"; then
    echo "  ! [$short] 缺少 cairn-worker:$TAG：先 push-src.sh，再在 ah3 构建目录执行 ./build-base.sh $TAG --to ah2,ah4" >&2
  fi
  echo "▶ [$short] 写入 .env 与 compose"
  sed -e "s|^HOST_IP=.*|HOST_IP=$ip|" -e "s|^HOST_SHORT=.*|HOST_SHORT=$short|" "$SECRET_FILE" \
    | ssh "$host" "cat > /data/wp/cairn/cluster/deploy/.env && chmod 640 /data/wp/cairn/cluster/deploy/.env"
  if [ "$short" = "ah3" ]; then
    scp -q core.compose.yml "$host:/data/wp/cairn/cluster/deploy/"
  else
    scp -q executor.compose.yml "$host:/data/wp/cairn/cluster/deploy/"
  fi
  echo "▶ [$short] 数据目录属主（PG 999 / RustFS 10001 / 浏览器 Profile 1000）"
  ssh "$host" "chown -R 999:wp /data/wp/cairn/cluster/pg 2>/dev/null; \
               chown -R 10001:wp /data/wp/cairn/cluster/rustfs2 2>/dev/null; \
               chown -R 1000:1000 /data/wp/cairn/cluster/browser-profiles 2>/dev/null; \
               chmod 750 /data/wp/cairn/cluster/pg/data 2>/dev/null || true; \
               chmod +x /data/wp/cairn/cluster/deploy/cairn-ctl.sh"
  echo "✅ [$short] 完成"
}

ship "$AH3" ah3 192.168.3.203
ship "$AH2" ah2 192.168.3.202
ship "$AH4" ah4 192.168.3.204

echo "✅ 全部分发完成。启动：ah3 执行 cairn-ctl.sh up，ah2/ah4 执行 cairn-ctl.sh up"
