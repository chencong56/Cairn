# 发布环境（ah2 / ah3 / ah4）

这是版本发布后的全套环境，**不是** `pnpm dev:env use remote` 的开发底座。

Mac 经 Tailscale：ah3=`100.64.0.4`。三机互达仍用机房网 `192.168.3.20x`（compose 的 `HOST_IP` 不要改成 Tailscale）。

日常入口：

```bash
./deploy/cairn release --dry-run
./deploy/cairn release
./deploy/cairn status
./deploy/cairn rollback
```

拓扑只写在 `../targets/cluster.conf`。本目录只留还在跑的 compose 与入口 nginx，不要在这里跑脚本。

**铁律：只加不改**——不碰三台上存量容器（snclog*、旧 cairn-postgres / cairn-rustfs），不重写正在跑的 `core.compose.yml` / `executor.compose.yml` / `nginx/entry.conf`。
