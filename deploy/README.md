# deploy

日常只记两条：

```bash
# 切本机进程连哪套组件（合并画像、迁开发库、拉起热重载）
pnpm dev:env use local
pnpm dev:env use remote
pnpm dev:env status|check|restart|down

# 远端专用开发组件：第一次或挂了之后
./deploy/cairn dev-infra up
./deploy/cairn dev-infra status
```

发布环境（ah2 / ah3 / ah4）走同一条命令，读 `deploy/targets/cluster.conf`，不进 `pnpm`：

```bash
./deploy/cairn release --dry-run
./deploy/cairn release
./deploy/cairn status
./deploy/cairn rollback
./deploy/cairn logs api
./deploy/cairn restart api
./deploy/cairn migrate
```

不要把本机 API / Worker 接到发布栈（`15432` / `16380` / `9031`）。`package.json` 不加 `deploy` / `release`。

## 配置在哪

| 文件 | 进仓库 | 写什么 |
| --- | --- | --- |
| `.env.local` / `.env.remote` | 是 | 本机进程连哪：host、端口、桶 |
| `.env.*.secrets` | 否 | 六个密钥 |
| `deploy/targets/dev-infra.conf` | 是 | gs1 开发组件：SSH、reach、绑定、端口、桶；数据在 `/home/cairn` |
| `deploy/targets/cluster.conf` | 是 | 发布拓扑：主机、角色、compose、restart、探活 |
| `deploy/dev-infra/.env` | 否 | 开发组件密钥；`dev-infra up` 按清单补端口 |
| 各机 `cluster/deploy/.env` | 否 | 发布栈密钥；`release` 只改 `CAIRN_BUILD_VERSION`，不拉回 Mac |

改开发组件端口：改 `dev-infra.conf`，再 `./deploy/cairn dev-infra up`，然后 `pnpm dev:env use remote`。

加执行节点：只改 `cluster.conf` 加一个 `[host.…]`。

## 目录

| 路径 | 干什么 |
| --- | --- |
| `cairn` | 对外唯一命令 |
| `targets/` | 清单 |
| `dev-infra/` | 远端开发组件编排 |
| `compose.yml` | 本机 Podman 组件，只服务 `use local` |
| `cluster/` | 发布栈正在用的 compose / nginx，不要当日常入口 |
| `images/` | 底座镜像 Dockerfile，稀有 |
| `lib/` | 内部脚本，不要直接跑 |

本机组件：`pnpm infra:up` 或 `dev:env use local`。清盘见 `./scripts/infra.sh`。数据库说明见 [database-backends.md](database-backends.md)。

`release` 只重建清单 `restart` 里的应用容器，不碰 `cairn-pg` / Redis / 对象存储。回滚只拨产物指针，不回滚数据库。
