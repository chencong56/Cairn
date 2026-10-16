# 新标签页门户（目标系统联调夹具）

模拟「门户首页菜单都在新标签页打开子系统」的企业门户，用于验证受管浏览器手动操作时新标签页的发现与接管、跨标签指认与试跑。不访问外网，不是真实企业系统。

```bash
cd tests/target-popup-portal
node server.mjs          # 默认 http://127.0.0.1:4183/，换端口：PORTAL_PORT=4190 node server.mjs
node check.mjs           # 自检：临时端口 + 真 Chromium 走一遍四种开页方式
```

| 账号 | 密码 |
| --- | --- |
| `demo` | `demo123` |

登记进本机识途并做端到端核对（需要本机 API / Worker 已启动，且 `node server.mjs` 在跑）：

```bash
node seed.mjs            # 幂等登记目标系统、账号 demo/demo123 与跨标签场景，打印各 ID
node verify-stack.mjs    # 开会话 → 手动操作点菜单 → 新页登记并成为当前页 → 指认作用于所看的页 → 跨标签试跑
```

`verify-stack.mjs` 会真实打开会话并发起一次试跑。手工登记目标系统时：

- 入口 URL：`http://127.0.0.1:4183/`
- 登录 URL：`http://127.0.0.1:4183/login`
- 认证方式：账号密码；验证码：无
- 登录后落点：`/eip/index`

数据检查联调：`/reports/income`（合计行与各行相加一致）、`/reports/income?bad=1`（合计行故意对不上），表格有数字列和「合计」行。`/reports/dashboard`：一组指标卡片（`#board`）和一块设备详情（`#detail`，dl），验证卡片 / 键值读取。

## 表格控件靶场（`/grids/`）

用来验证识途的表格读取 / 识别 / 断言。需先登录门户（demo / demo123）；首页「表格控件靶场」→ `/grids/` 索引。

- **现代控件**（真实库渲染，资源来自本目录 `node_modules`，不走 CDN）：`/grids/aggrid`、`/grids/antd`、`/grids/handsontable`。依赖独立安装：`pnpm install --ignore-workspace`；Ant Design 由 `build-grids.mjs`（esbuild）打成本地单文件，首次访问自动构建，也可 `pnpm build:grids`。Handsontable 使用非商用 license 键，仅限本靶场。
- **老控件**：`/grids/legacy/<文件>.html` 直接服务 `packages/worker/src/browser/__fixtures__/legacy-grids/`（单一来源，不复制）。
- **变体参数**（`grids/common.js`）：`rows=N` 数据量（5000 验证虚拟滚动）、`delay=ms` 异步加载、`empty=1` 空数据、`pinned=1` 固定 / 冻结列、`summary=1` 合计行、`bad=1` 合计与明细不一致、`group=1` 分组表头、`paged=1` 分页、`virtual=1`（仅 antd）虚拟列表。
- **自动化**：worker 的 `table-read-modern-grids.browser.spec.ts` 与 `table-adapters/registry.browser.spec.ts` 直接起本门户；平台端到端用 `node verify-grids.mjs`（需本机 API / Worker 与 `node server.mjs` 已启动，会真实试跑 11 个「导航 → 表格读取 → 数据检查」场景，核对合计不一致、虚拟滚动读不全应判不通过且读取步骤本身成功）。

## 老系统页面快照（`/legacy/`）

把保存下来的真实老系统页面（mhtml）挂在门户下面，用来在场景编排里对真实的框架与表格结构做读取、识别与断言验证：

- 默认读取仓库根目录 `tmp/铁塔页面20261007`（被忽略，页面内容不入库），换目录用 `PORTAL_LEGACY_DIR=/path node server.mjs`；目录不存在时该入口关闭。
- 门户首页「老系统页面快照」→ `/legacy/` 列出全部页面，`/legacy/<序号>/` 打开；iframe、样式、图片、字体都改写到 `/legacy/<序号>/r/<n>`，需先登录门户（demo / demo123）。
- 页面脚本被去掉，响应带严格 CSP（禁脚本、禁外连），不会回连原系统。保存下来的是渲染后的静态 DOM，所以只能读取与断言，不能翻页、点查询。
- 已核对涉及的框架：BI 报表中心 = jQuery EasyUI 1.4.5 datagrid；仪表盘 / OA 指标 = Vue 2 + Element UI el-table；营收报表 = 帆软 FineReport 冻结表。

## 开页方式

| 首页元素 | 方式 | 打开的页 |
| --- | --- | --- |
| `#quick-mail`、`#nav-mail`「工作邮箱」 | `window.open` 到 `/eip/api/redirect/resourceJump`，302 到子系统 | `/apps/mail/` |
| `#quick-doc`「公文起草」 | `<a target="_blank">`（Chromium 默认 noopener） | `/apps/doc/` |
| `#quick-bi`「数据展示」 | `window.open` 到 SSO 中转页，脚本再跳子系统 | `/apps/bi/` |
| `#quick-itsm`「IT工单」 | `window.open` 到中转弹窗，它再开子系统并关闭自己 | `/apps/itsm/` |
| `#nav-news`「新闻中心」 | 同页跳转（对照） | `/eip/news` |

子系统页有输入框 `#keyword`、按钮 `#submit-apply`（结果写到 `#apply-result`）和一张表格，可用来指认和编写步骤。
