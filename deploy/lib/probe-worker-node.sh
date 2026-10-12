#!/usr/bin/env bash
# 内部：在该机上对指定 Worker 签 NODE_HEALTH。由 ./deploy/cairn 经 SSH stdin 调用。
# 用法：ssh host 'bash -s -- <workerId>' < probe-worker-node.sh
# 密钥不离开容器，主机不需要 node / python。
set -euo pipefail
want="${1:?用法: probe-worker-node.sh <workerId>}"
name=""
for c in $(docker ps --filter name=cairn- --format '{{.Names}}'); do
  id=$(docker exec "$c" printenv CAIRN_WORKER_ID 2>/dev/null || true)
  if [ "$id" = "$want" ]; then
    name=$c
    break
  fi
done
[ -n "$name" ] || { echo "找不到 worker $want" >&2; exit 1; }
docker exec "$name" node -e '
  const crypto = require("crypto");
  const http = require("http");
  const raw = process.env.CAIRN_INTERNAL_AUTH_SECRET || "";
  const secret = Buffer.from(raw, "base64");
  if (secret.length !== 32) {
    console.error("CAIRN_INTERNAL_AUTH_SECRET 不是 32 字节");
    process.exit(1);
  }
  const workerId = process.env.CAIRN_WORKER_ID;
  const expires = Math.floor(Date.now() / 1000) + 30;
  const path = "/internal/node/health";
  const bodyHash = crypto.createHash("sha256").update("").digest("hex");
  const canonical = ["NODE_HEALTH", "GET", path, bodyHash, String(expires), workerId].join("\n");
  const signature = crypto.createHmac("sha256", secret).update(canonical).digest("hex");
  const req = http.request({
    hostname: "127.0.0.1",
    port: Number(process.env.CAIRN_WORKER_INTERNAL_PORT || 8091),
    path,
    method: "GET",
    headers: {
      "x-cairn-node-expires": String(expires),
      "x-cairn-node-signature": signature,
      "x-cairn-node-worker": workerId,
    },
  }, (res) => {
    let d = "";
    res.on("data", (c) => { d += c; });
    res.on("end", () => {
      process.stdout.write(d);
      process.exit(res.statusCode === 200 ? 0 : 2);
    });
  });
  req.on("error", (e) => { console.error(e.message); process.exit(1); });
  req.end();
'
