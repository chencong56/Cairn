# Cairn 三机集群部署（shsnc-ah2 / ah3 / ah4）

按 [方案](../../docs/spec/2026-10-01-shsnc-cluster-deployment.md) 落地的容器化部署资产，2026-10-01 已上线并通过验收。
**铁律：只加不改**——不触碰三台上任何存量容器（snclog*、旧 cairn-postgres / cairn-rustfs 原样运行），
全部组件新起 `cairn-xxx` 容器，端口冲突一律用新端口。

## 形态：运行时底座镜像 + 应用产物挂载

应用（API / Worker / Web）**不打进镜像**（频繁更新不走镜像链路）：

- `cairn-api` / `cairn-worker` 镜像 = 运行时底座（Node 24 + Chromium + CJK 字体 + 原生库），慢变，基本只构建一次；
- 应用产物（dist + 生产 node_modules / Web 静态文件）放宿主 `/data/wp/cairn/cluster/apps/{api,worker,web}`，
  容器以 bind mount 挂到 `/app`（Web 挂到 nginx html）；
- 更新流程 = `push-src.sh`（Mac 增量推源码）→ ah3 `build-apps.sh`（容器内构建产物）→ `sync-apps.sh`（内网分发 + 滚动重启），分钟级。

基础设施（PG/Redis/RustFS/Nginx/autoheal）保持镜像形态，变更频率低。

## 架构速览

- **ah3（192.168.3.203，核心节点）**：`cairn-nginx`:80（Web + /api 入口，SSE 无缓冲）、`cairn-api`（容器网络内:3030）、
  `cairn-pg`:15432、`cairn-redis`:16380、`cairn-rustfs2`:9031/9032、
  `cairn-scheduler`:8093 / `cairn-analyst`:8094 / `cairn-maintenance`:8095（单实例角色）、
  `cairn-executor-ah3`:8092。
- **ah2 / ah4（执行节点）**：`cairn-executor-ah2|ah4`:8092。
- **无边车极简架构**：Worker 直接监听容器内 `0.0.0.0:8091`，Docker 宿主机端口映射直通 Worker（`${HOST_IP}:809x:8091`）。已彻底移除全部 6 个 `*-gw` Nginx 边车与 `cairn-autoheal` 守护容器。
- 全集群仅 `shsnc-ah3:80`（`http://100.64.0.4/`）运行唯一的 Web 入口 `cairn-nginx`（单实例，无高可用冗余）。
- Worker 内部 RPC 通信由 `CAIRN_INTERNAL_AUTH_SECRET` 的 HMAC 鉴权机制与宿主机内网 IP 端口绑定双重保障安全；API 按库内登记地址 + HMAC 定向调用。
- 每台 executor：`CAIRN_WORKER_CAPACITY=2`、`CAIRN_BROWSER_MAX_SESSIONS=3`。

## 文件

| 文件 | 用途 |
| --- | --- |
| `Dockerfile.api` / `.worker` / `.web` | 三类**运行时底座**镜像（首次部署用；应用代码不进镜像） |
| `nginx/entry.conf` | 控制面入口（静态 + /api 反代 + SSE；变量化 upstream 防上游未就绪启动失败） |
| `nginx/worker-gateway.conf.template` | Worker 内部入口网关（envsubst 模板，HMAC 头透传） |
| `core.compose.yml` | ah3 核心栈（基础设施 + 迁移/建桶一次性任务 + 角色容器） |
| `executor.compose.yml` | ah2/ah4 执行栈 |
| `.env.example` | 环境变量模板（密钥 openssl 随机生成） |
| `push-src.sh`（Mac） | 源码增量推送（git stash create 快照 diff + tar 管道；Mac openrsync 与 CentOS 7 rsync 协议不兼容，勿用 rsync） |
| `build-base.sh`（ah3） | 在服务器上原生构建运行时底座镜像（仅首次/换底座时用；Mac 不构建、不传输镜像） |
| `build-apps.sh`（ah3） | 容器内构建应用产物到 `apps/`（含 `.old` 回滚目录） |
| `sync-apps.sh`（ah3） | 产物内网分发 ah2/ah4 并滚动重启 executor |
| `cairn-ctl.sh`（各机） | 宿主运维：up/down/restart/ps/status/logs/migrate |

## 更新流程（日常）

```bash
# Mac：
./push-src.sh                    # 增量推源码到 ah3（秒级~分钟级）
ssh root@shsnc-ah3
  cd /data/wp/cairn/cluster/build/deploy/cluster
  ./build-apps.sh all            # ah3 容器内构建三产物
  ./sync-apps.sh all             # 内网分发 + 重启 executor（ah2/ah4）
  cd /data/wp/cairn/cluster/deploy && ./cairn-ctl.sh restart   # ah3 本机生效
```

顺序纪律：迁移 → Worker → API → Web；含破坏性协议变更（`session-occupancy@2` 类）先排空活租约再整组替换，禁止新旧混跑。
锁步部署：API 与 Worker 整组同版本，不做混跑兼容。发布号守卫按 `CAIRN_BUILD_VERSION` 比对；本集群该值取自 `ship.sh` 写入的底座镜像 tag、三台共用，日常 `build-apps.sh` / `sync-apps.sh` 发布应用产物时不会更新，守卫在本集群因此不会触发（也拦不住漏升的主机）。
数据库迁移：ah3 上 `cairn-ctl.sh migrate`（幂等）。

## 首次部署（底座镜像，仅记录用）

**原则：Mac 不构建、不拉取、不传输任何镜像，只传源码和配置；镜像架构由各服务器自己决定。**
`push-src.sh` 推源码到 ah3 → ah3 构建目录执行 `./build-base.sh <tag> --to ah2,ah4`（原生 `docker build`，
同架构执行节点经内网 `docker save | docker load`；注意 `ONNXRUNTIME_NODE_INSTALL=skip` 已内置，避免 nuget 302）→ Mac `./ship.sh` 分发配置。
基础设施镜像（PG / Redis / RustFS / mc / Nginx）三台 `compose up` 时走 daocloud mirror 自拉，不经过 Mac。

## 运维要点（踩过的坑）

- **强杀 executor 后**：worker 按同 ID 心跳冲突保护会干净退出（exit 0），`unless-stopped` 不会拉起；
  等 LOST 判定（~45s）后需 `docker start`（autoheal 会自动救活 gw）。
- **LOST 会话回收**：等待空闲 TTL（治理平台配置），急用可 `POST /api/browser-sessions/{id}/dispose` 手动回收。
- **WAITING_FOR_AUTH 的 run**：需账号配凭据走自动登录（`POST /api/targets/{id}/accounts/{accountId}`
  带 `password` + `validity`（有限期必须带 `timeZone`））；无凭据会话会被即刻关闭，auth-control 503（产品现状）。
- 中继链路（Mac↔站点 tailscale headscale relay）只有 ~0.3MB/s：大文件一律走「ah3 落地 + 内网千兆分发」。
- 备份：`docker exec cairn-pg pg_dump -U cairn cairn > .../cairn-$(date +%F).sql`（建议 cron 每日）+ `rustfs2/` 目录归档。

## 访问

入口 `http://192.168.3.203`，初始管理员 `admin / cairn-admin`（**首次登录后立即改密**）。
浏览器 AI 密钥：对准集群库执行 `pnpm secret:register-browser-ai` 注册（未注册前 AI 步骤类不可用）。
