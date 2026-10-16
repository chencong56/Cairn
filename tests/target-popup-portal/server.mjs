import { createServer } from 'node:http'
import { loadSnapshots, serveLegacy } from './legacy-pages.mjs'
import { serveGrids } from './grids.mjs'

/**
 * 新标签页门户夹具：模拟「门户首页菜单都在新标签页打开子系统」的企业门户。
 * 覆盖 window.open 经跳转中转、target=_blank（默认 noopener）、SSO 中转页、
 * 自行关闭的中转弹窗（弹窗再开弹窗）四种开页方式，以及同页跳转作对照。
 */
const PORT = Number(process.env.PORTAL_PORT ?? 4183)
const SESSION_COOKIE = 'portal_session'
const ACCOUNTS = new Map([['demo', 'demo123']])

const APPS = {
  mail: { title: '工作邮箱', rows: [['周例会纪要', '已读'], ['预算审批提醒', '未读'], ['系统升级通知', '未读']] },
  doc: { title: '公文起草', rows: [['关于开展安全检查的通知', '草稿'], ['年度工作总结', '待审']] },
  bi: { title: '数据展示', rows: [['本月工单', '128'], ['平均处理时长', '3.2 小时']] },
  itsm: { title: 'IT工单', rows: [['打印机故障', '处理中'], ['VPN 无法连接', '待分派']] },
}

const STYLE = `
body { font-family: -apple-system, "PingFang SC", sans-serif; margin: 0; background: #f5f6f8; color: #222; }
header { display: flex; align-items: center; gap: 16px; padding: 12px 32px; background: #fff; }
header h1 { font-size: 18px; margin: 0; }
nav { display: flex; gap: 4px; padding: 0 32px; background: #e60012; }
nav a, nav button { color: #fff; background: none; border: 0; padding: 12px 16px; font-size: 15px; cursor: pointer; text-decoration: none; }
main { padding: 24px 32px; }
.panel { background: #fff; border-radius: 6px; padding: 16px 20px; margin-bottom: 16px; }
.quick { display: flex; gap: 12px; flex-wrap: wrap; }
.quick a, .quick button { padding: 10px 18px; border: 1px solid #ddd; border-radius: 4px; background: #fafafa; font-size: 14px; cursor: pointer; color: #222; text-decoration: none; }
table { border-collapse: collapse; width: 100%; }
td, th { border-bottom: 1px solid #eee; padding: 8px; text-align: left; }
`

function html(title, body) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title><style>${STYLE}</style></head><body>${body}</body></html>`
}

function loginPage(error) {
  return html('模拟门户 - 登录', `
<main><div class="panel" style="max-width:360px;margin:80px auto">
  <h1>模拟门户登录</h1>
  ${error ? '<p id="login-error" style="color:#e60012">账号或密码错误</p>' : ''}
  <form method="post" action="/login">
    <p><label for="username">账号</label><br><input id="username" name="username" autocomplete="username"></p>
    <p><label for="password">密码</label><br><input id="password" name="password" type="password" autocomplete="current-password"></p>
    <button id="login-submit" type="submit">登录</button>
  </form>
</div></main>`)
}

function indexPage(user) {
  return html('模拟门户 - 首页', `
<header><h1>模拟门户</h1><span>欢迎您，<b id="user-name">${user}</b></span><a id="logout" href="/logout">退出</a></header>
<nav>
  <a id="nav-home" href="/eip/index">首页</a>
  <a id="nav-news" href="/eip/news">新闻中心</a>
  <button id="nav-mail" type="button" onclick="window.open('/eip/api/redirect/resourceJump?app=mail')">工作邮箱</button>
</nav>
<main>
  <section class="panel">
    <h2>常用功能</h2>
    <div class="quick">
      <button id="quick-mail" type="button" onclick="window.open('/eip/api/redirect/resourceJump?app=mail')">工作邮箱</button>
      <a id="quick-doc" href="/eip/api/redirect/resourceJump?app=doc" target="_blank">公文起草</a>
      <a id="quick-income" href="/reports/income">收入报表</a>
      <a id="quick-legacy" href="/legacy/">老系统页面快照</a>
      <a id="quick-grids" href="/grids/">表格控件靶场</a>
      <button id="quick-bi" type="button" onclick="window.open('/sso/bridge?app=bi')">数据展示</button>
      <button id="quick-itsm" type="button" onclick="window.open('/sso/relay?app=itsm')">IT工单</button>
    </div>
  </section>
  <section class="panel"><h2>待办 (2)</h2><table><tr><td>预算审批</td><td>今天</td></tr><tr><td>请假申请</td><td>昨天</td></tr></table></section>
</main>`)
}

function newsPage() {
  return html('模拟门户 - 新闻中心', `
<header><h1>新闻中心</h1><a id="back-home" href="/eip/index">返回首页</a></header>
<main><div class="panel"><ul><li>公司召开年度工作会议</li><li>安全生产月活动启动</li></ul></div></main>`)
}

function appPage(key) {
  const app = APPS[key]
  const rows = app.rows.map(([a, b], i) => `<tr><td id="row-${i}-name">${a}</td><td>${b}</td></tr>`).join('')
  return html(`${app.title} - 子系统`, `
<header><h1 id="app-title">${app.title}</h1><span>子系统</span></header>
<main>
  <div class="panel">
    <p><label for="keyword">关键字</label> <input id="keyword" name="keyword" placeholder="输入关键字"></p>
    <button id="submit-apply" type="button" onclick="document.getElementById('apply-result').textContent='已提交：' + (document.getElementById('keyword').value || '空')">提交申请</button>
    <p id="apply-result" role="status"></p>
  </div>
  <div class="panel"><table><thead><tr><th>名称</th><th>状态</th></tr></thead><tbody>${rows}</tbody></table></div>
</main>`)
}

/** 收入报表：数字列 + 合计行。bad=1 时合计行故意对不上，用来验证“各行相加等于合计行”检查。 */
function incomePage(bad) {
  const data = [['华北', '1,200.50', '12.5%'], ['华东', '2,300.25', '8.0%'], ['华南', '980.00', '-3.2%']]
  const total = bad ? '4,500.00' : '4,480.75'
  const rows = data.map(([a, b, c]) => `<tr><td>${a}</td><td>${b}</td><td>${c}</td></tr>`).join('')
  return html('区域收入报表 - 子系统', `
<header><h1 id="app-title">区域收入报表</h1><a id="back-home" href="/eip/index">返回首页</a></header>
<main><div class="panel"><table id="income"><thead><tr><th>区域</th><th>收入(万元)</th><th>同比</th></tr></thead>
<tbody>${rows}<tr class="total"><td>合计</td><td>${total}</td><td></td></tr></tbody></table></div></main>`)
}

/** 看板：一组指标卡片 + 一块设备详情（dl），用来验证卡片 / 键值读取与检查。 */
function dashboardPage() {
  const cards = [['服务器A', '35%', '2'], ['服务器B', '81%', '0'], ['服务器C', '12%', '5']]
    .map(([n, cpu, al]) => `<div class="card"><h3 class="card-title">${n}</h3><div class="row"><span class="label">CPU：</span><span class="value">${cpu}</span></div><div class="row"><span class="label">告警数：</span><span class="value">${al}</span></div></div>`)
    .join('')
  return html('运行看板 - 子系统', `
<header><h1 id="app-title">运行看板</h1><a id="back-home" href="/eip/index">返回首页</a></header>
<main>
  <div class="panel"><h2>指标卡片</h2><div id="board" style="display:flex;gap:12px">${cards}</div></div>
  <div class="panel"><h2>设备详情</h2><dl id="detail"><dt>设备名称</dt><dd>核心交换机</dd><dt>状态</dt><dd>运行中</dd><dt>端口数</dt><dd>48</dd></dl></div>
</main>`)
}

/** SSO 中转：先落一页，再脚本跳到子系统（真实门户常见的重定向链）。 */
function bridgePage(key) {
  return html('单点登录中转', `<p>正在进入${APPS[key].title}…</p>
<script>setTimeout(() => { location.replace('/apps/${key}/') }, 300)</script>`)
}

/** 自行关闭的中转弹窗：再开一页子系统后关闭自己。 */
function relayPage(key) {
  return html('跳转中', `<p>正在打开${APPS[key].title}…</p>
<script>setTimeout(() => { window.open('/apps/${key}/'); window.close() }, 300)</script>`)
}

function cookies(req) {
  const out = new Map()
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const idx = part.indexOf('=')
    if (idx > 0) out.set(part.slice(0, idx).trim(), decodeURIComponent(part.slice(idx + 1).trim()))
  }
  return out
}

function send(res, status, body, headers = {}) {
  const payload = Buffer.from(body)
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': payload.length, ...headers })
  res.end(payload)
}

function redirect(res, location, headers = {}) {
  res.writeHead(302, { Location: location, ...headers })
  res.end()
}

async function readForm(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}

export function createPortalServer() {
  let snapshots = null
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const user = cookies(req).get(SESSION_COOKIE)
    const authed = Boolean(user && ACCOUNTS.has(user))

    if (url.pathname === '/login' && req.method === 'GET') return send(res, 200, loginPage(url.searchParams.has('error')))
    if (url.pathname === '/login' && req.method === 'POST') {
      const form = await readForm(req)
      const username = form.get('username') ?? ''
      if (ACCOUNTS.get(username) === (form.get('password') ?? '')) {
        return redirect(res, '/eip/index', { 'Set-Cookie': `${SESSION_COOKIE}=${encodeURIComponent(username)}; Path=/; HttpOnly` })
      }
      return redirect(res, '/login?error=1')
    }
    if (url.pathname === '/logout') return redirect(res, '/login', { 'Set-Cookie': `${SESSION_COOKIE}=; Path=/; Max-Age=0` })
    if (url.pathname === '/healthz') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' })
    if (!authed) return redirect(res, '/login')

    const app = url.searchParams.get('app') ?? ''
    if (url.pathname === '/' ) return redirect(res, '/eip/index')
    if (url.pathname === '/eip/index') return send(res, 200, indexPage(user))
    if (url.pathname === '/eip/news') return send(res, 200, newsPage())
    if (url.pathname === '/legacy' || url.pathname.startsWith('/legacy/')) {
      snapshots ??= loadSnapshots()
      const out = serveLegacy(snapshots, url.pathname)
      // 快照只做静态读取：禁脚本、禁一切外连，保证不会回连原系统
      res.writeHead(out.status, {
        'Content-Type': out.type,
        'Content-Length': Buffer.byteLength(out.body),
        'Content-Security-Policy': "default-src 'self' data: blob:; script-src 'none'; style-src 'self' 'unsafe-inline'; connect-src 'none'; object-src 'none'",
      })
      return res.end(out.body)
    }
    if (url.pathname === '/grids' || url.pathname.startsWith('/grids/')) {
      const out = await serveGrids(url)
      res.writeHead(out.status, {
        'Content-Type': out.type,
        'Content-Length': Buffer.byteLength(out.body),
        ...(out.filename ? { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(out.filename)}` } : {}),
      })
      return res.end(out.body)
    }
    if (url.pathname === '/reports/dashboard') return send(res, 200, dashboardPage())
    if (url.pathname === '/reports/income') return send(res, 200, incomePage(url.searchParams.get('bad') === '1'))
    if (url.pathname === '/eip/api/redirect/resourceJump' && APPS[app]) return redirect(res, `/apps/${app}/`)
    if (url.pathname === '/sso/bridge' && APPS[app]) return send(res, 200, bridgePage(app))
    if (url.pathname === '/sso/relay' && APPS[app]) return send(res, 200, relayPage(app))
    const matched = /^\/apps\/([a-z]+)\/$/.exec(url.pathname)
    if (matched && APPS[matched[1]]) return send(res, 200, appPage(matched[1]))
    return send(res, 404, html('未找到', '<p>未找到</p>'))
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createPortalServer().listen(PORT, '127.0.0.1', () => {
    console.log(`target-popup-portal listening on http://127.0.0.1:${PORT}/`)
  })
}
