import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseParams, seriesResponse, sitesResponse, statusRows, treeData, truthOf, crossData, CROSS_LAYOUT, STATUS_ALERTS, STATUS_STEPS, STATUS_TAGS } from './grids/data.mjs'
import { exportFile, exportOptions, exportTruth } from './grids/export.mjs'

/**
 * /grids/：表格控件靶场。新三个控件（AG Grid / Ant Design Table / Handsontable）用真实库渲染，资源全部来自本地
 * node_modules；老控件（easyui / jqGrid / ExtJS / layui / Element UI / FineReport）直接服务 worker 的静态靶场目录，不复制。
 * 参数见 grids/data.mjs 的 parseParams：rows / delay / empty / pinned / summary / bad / group / paged / virtual / post，
 * 接口另有 fail / nonjson / drift。控件页从 /grids/api 取数；/grids/truth 给出同一组参数下的标准答案。
 */
const HERE = fileURLToPath(new URL('.', import.meta.url))
const LEGACY_DIR = resolve(HERE, '../../packages/worker/src/browser/__fixtures__/legacy-grids')
const NM = join(HERE, 'node_modules')

const VENDOR = {
  'ag-grid-community.min.js': [join(NM, 'ag-grid-community/dist/ag-grid-community.min.js'), 'text/javascript'],
  'handsontable.full.min.js': [join(NM, 'handsontable/dist/handsontable.full.min.js'), 'text/javascript'],
  'handsontable.full.min.css': [join(NM, 'handsontable/dist/handsontable.full.min.css'), 'text/css'],
  'antd.bundle.js': [join(HERE, 'grids/dist/antd.bundle.js'), 'text/javascript'],
  'echarts.min.js': [join(NM, 'echarts/dist/echarts.min.js'), 'text/javascript'],
  'chart.umd.js': [join(NM, 'chart.js/dist/chart.umd.js'), 'text/javascript'],
  'bootstrap.min.css': [join(NM, 'bootstrap/dist/css/bootstrap.min.css'), 'text/css'],
}
const PAGES = { aggrid: 'AG Grid', antd: 'Ant Design Table', handsontable: 'Handsontable' }
const VARIANTS = [
  ['默认', ''],
  ['5000 行（虚拟滚动）', '?rows=5000'],
  ['分页', '?rows=45&paged=1'],
  ['分页总数不符', '?rows=45&paged=1&badTotal=1'],
  ['分页本页少行', '?rows=45&paged=1&shortPage=1'],
  ['固定列', '?pinned=1'],
  ['合计行', '?summary=1'],
  ['合计不一致', '?bad=1'],
  ['分组表头', '?group=1'],
  ['延迟 1.5 秒加载', '?delay=1500'],
  ['空数据', '?empty=1'],
]

const TEXT = (body, type = 'text/html; charset=utf-8', status = 200) => ({ status, type, body })

async function ensureBuilt() {
  if (!existsSync(VENDOR['antd.bundle.js'][0])) await import('./build-grids.mjs')
}

const LEGACY_FILES = [
  ['easyui-edc.html', 'jQuery EasyUI（BI 报表中心风格）'],
  ['easyui-datagrid.html', 'jQuery EasyUI（冻结列 / 分组表头 / 页脚）'],
  ['jqgrid.html', 'jqGrid'],
  ['extjs4.html', 'ExtJS 4'],
  ['extjs5.html', 'ExtJS 5'],
  ['extjs6.html', 'ExtJS 6'],
  ['layui-table.html', 'layui table'],
  ['elementui-table.html', 'Element UI el-table'],
  ['finereport-frozen.html', '帆软 FineReport 冻结表'],
  ['virtual-scroll.html', '虚拟滚动'],
  ['native-basic.html', '原生表格'],
  ['cards-metrics.html', '指标卡片'],
  ['keyvalue-dl.html', '键值（dl）'],
  ['elementui-tree.html', 'Element UI 树形表格（华北折叠）'],
  ['easyui-treegrid.html', 'jQuery EasyUI treegrid（西南折叠）'],
  ['aria-treegrid.html', 'ARIA treegrid'],
  ['status-element.html', 'Element UI 状态信号'],
  ['status-layui.html', 'layui 状态信号'],
]

function indexPage() {
  const modern = Object.entries(PAGES)
    .map(([k, label]) => `<h3>${label}</h3><ul>${VARIANTS.map(([t, q]) => `<li><a href="/grids/${k}${q}">${t}</a></li>`).join('')}</ul>`)
    .join('')
  const legacy = LEGACY_FILES.map(([f, t]) => `<li><a href="/grids/legacy/${f}">${t}</a></li>`).join('')
  return TEXT(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>表格控件靶场</title></head><body style="font-family:-apple-system,'PingFang SC',sans-serif;margin:24px">
<h1>表格控件靶场</h1><p>虚构数据，仅用于识途表格读取 / 识别 / 断言的联调验证。</p>
<h2>现代控件（真实库渲染）</h2>${modern}<h3>状态信号（数据来自 /grids/api/status）</h3><ul><li><a href="/grids/status?lib=antd">Ant Design</a></li><li><a href="/grids/status?lib=bootstrap">Bootstrap 5</a></li></ul><h3>树形表格（数据来自 /grids/api/tree）</h3><ul><li><a href="/grids/tree?lib=antd">Ant Design 树形（全部展开）</a></li><li><a href="/grids/tree?lib=antd&collapsed=1">折叠</a></li><li><a href="/grids/tree?lib=antd&bad=1">上海小计不符</a></li></ul><h3>图表（数据来自 /grids/api/series）</h3><ul><li><a href="/grids/chart?lib=echarts">ECharts</a></li><li><a href="/grids/chart?lib=chartjs">Chart.js</a></li></ul><h3>交叉表（原生，数据由服务端生成）</h3><ul><li><a href="/grids/crosstab">默认</a></li><li><a href="/grids/crosstab?bad=1">华东小计不符</a></li></ul><h2>老系统控件（静态结构）</h2><ul>${legacy}</ul></body></html>`,
  )
}

const JSON_TYPE = 'application/json; charset=utf-8'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** /grids/api/*：控件页的数据接口。delay 在服务端延迟；fail=1 返回 500；nonjson=1 返回 HTML。 */
async function serveApi(name, url) {
  const p = parseParams(url.searchParams)
  if (p.delay > 0) await sleep(Math.min(p.delay, 15_000))
  if (p.fail) return TEXT(JSON.stringify({ code: 500, message: '服务器内部错误' }), JSON_TYPE, 500)
  if (p.nonjson) return TEXT('<html><body>系统维护中</body></html>')
  if (name === 'sites') return TEXT(JSON.stringify(sitesResponse(p)), JSON_TYPE)
  if (name === 'series') return TEXT(JSON.stringify(seriesResponse(p)), JSON_TYPE)
  if (name === 'tree') return TEXT(JSON.stringify({ code: 0, data: { list: treeData(p) } }), JSON_TYPE)
  if (name === 'status') return TEXT(JSON.stringify({ code: 0, data: { steps: STATUS_STEPS, tags: STATUS_TAGS, alerts: STATUS_ALERTS, list: statusRows(p) } }), JSON_TYPE)
  return TEXT(JSON.stringify({ code: 404, message: '未知接口' }), JSON_TYPE, 404)
}

/** 导出页：每种格式一个“导出”按钮（下载步骤点它），参数原样带到 /grids/export。 */
function exportPage(q) {
  const keep = new URLSearchParams(q)
  keep.delete('format')
  const qs = keep.toString()
  const FORMATS = [
    ['xlsx', '导出 Excel（xlsx）'],
    ['csv', '导出 CSV'],
    ['csv-gbk', '导出 CSV（GBK）'],
    ['html-xls', '导出 Excel（老系统 .xls）'],
    ['xls-binary', '导出 Excel 97（二进制）'],
  ]
  const links = FORMATS.map(([f, t]) => `<a id="export-${f}" class="btn" href="/grids/export?format=${f}${qs ? `&${qs}` : ''}">${t}</a>`).join(' ')
  return TEXT(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>站点清单导出</title></head><body style="font-family:-apple-system,'PingFang SC',sans-serif;margin:24px"><h2>站点清单导出</h2><p>${links}</p></body></html>`)
}

/** Bootstrap 5 状态页：badge / alert / progress 的官方写法；bg-teal 不是 Bootstrap 的上下文色（答案 unknown）。 */
function bootstrapStatusPage(q) {
  const p = parseParams(q)
  const BS = { success: 'success', processing: 'primary', warning: 'warning', error: 'danger', default: 'secondary', info: 'info' }
  const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
  const badge = (t) => `<span class="badge ${t.variant === 'preset' ? 'bg-teal' : t.variant === 'custom' ? 'status-chip' : `bg-${BS[t.tone]}`}">${esc(t.text)}</span>`
  const tags = STATUS_TAGS.map(badge).join(' ')
  const alerts = STATUS_ALERTS.map((a) => `<div class="alert alert-${BS[a.tone]}" role="alert">${esc(a.text)}</div>`).join('')
  const rows = statusRows(p)
    .map((r) => `<tr><td>${r.id}</td><td>${esc(r.name)}</td><td><span class="badge bg-${BS[r.tone]}">${esc(r.status)}</span></td><td><div class="progress" role="progressbar" aria-valuenow="${r.progress}" aria-valuemin="0" aria-valuemax="100"><div class="progress-bar${r.progress === 100 ? ' bg-success' : ''}" style="width: ${r.progress}%">${r.progress}%</div></div></td></tr>`)
    .join('')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>状态信号（Bootstrap）</title><link rel="stylesheet" href="/grids/vendor/bootstrap.min.css"><style>body{margin:16px}.status-chip{background:#0aa;color:#fff;padding:2px 6px;border-radius:4px}</style></head><body>
<h2>状态信号（Bootstrap 5）</h2><p id="tags">${tags}</p><div id="alerts">${alerts}</div>
<table class="table" id="grid"><thead><tr><th>编号</th><th>站点名称</th><th>状态</th><th>进度</th></tr></thead><tbody>${rows}</tbody></table></body></html>`
}

/** 交叉表页：原生表格（与控件无关），两层列头 + 纵向合并行头 + 小计行 / 合计列 / 总计行；数据由 grids/data.mjs 生成，答案在 /grids/truth?view=crosstab。 */
function crosstabPage(q) {
  const p = parseParams(q)
  const d = crossData(p)
  const fmt = (v) => (v === null ? '' : v.toFixed(1))
  const cell = (v) => `<td class="num">${fmt(v)}</td>`
  const months = CROSS_LAYOUT.months.map((m) => `<th>${m}</th>`).join('')
  const body = []
  for (const [region, cities] of CROSS_LAYOUT.regions) {
    cities.forEach(([city], k) => {
      const r = d.detail.find((x) => x.region === region && x.city === city)
      body.push(`<tr>${k === 0 ? `<td rowspan="${cities.length + 1}" class="dim">${region}</td>` : ''}<td class="dim">${city}</td>${r.cells.flat().map(cell).join('')}${cell(r.total)}</tr>`)
    })
    const s = d.subtotal.find((x) => x.region === region)
    body.push(`<tr class="total"><td class="dim">小计</td>${s.cells.flat().map(cell).join('')}${cell(s.total)}</tr>`)
  }
  body.push(`<tr class="total"><td colspan="2" class="dim">总计</td>${d.grand.cells.flat().map(cell).join('')}${cell(d.grand.total)}</tr>`)
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>区域营收交叉表（原生）</title><style>body{font-family:-apple-system,'PingFang SC',sans-serif;margin:24px}#cross{border-collapse:collapse}#cross th,#cross td{border:1px solid #ccc;padding:4px 10px}#cross thead{background:#fafafa}#cross .num{text-align:right}#cross .total{background:#f5f5f5;font-weight:600}</style></head><body>
<h2>区域营收交叉表（原生表格）</h2><p>行头：区域 → 城市（纵向合并，每个区域末尾有小计行）；列头：指标 × 月份（两层，末列合计）；杭州的「本月累计 / 3 月」为空。</p>
<table id="cross"><thead>
<tr><th rowspan="2">区域</th><th rowspan="2">城市</th>${CROSS_LAYOUT.kinds.map((k) => `<th colspan="3">${k}</th>`).join('')}<th rowspan="2">合计</th></tr>
<tr>${months}${months}</tr>
</thead><tbody>${body.join('')}</tbody></table></body></html>`
}

/** 返回 { status, type, body }；不属于 /grids/ 的路径返回 null。 */
export async function serveGrids(url) {
  const pathname = url.pathname
  if (pathname !== '/grids' && !pathname.startsWith('/grids/')) return null
  const rest = pathname.slice('/grids'.length).replace(/^\//, '')
  if (rest === '') return indexPage()
  const api = /^api\/([a-z-]+)$/.exec(rest)
  if (api) return serveApi(api[1], url)
  if (rest === 'export') {
    const out = await exportFile(parseParams(url.searchParams), exportOptions(url.searchParams))
    if (!out) return TEXT('未知导出格式', 'text/plain', 400)
    return { status: 200, type: out.type, body: out.body, filename: out.filename }
  }
  if (rest === 'export-page') return exportPage(url.searchParams)
  // 状态信号页：lib=antd（真实库渲染）| bootstrap（真实 CSS，结构按官方文档写）；数据与答案来自 /grids/api/status、/grids/truth?view=status
  if (rest === 'status') {
    if (url.searchParams.get('lib') === 'bootstrap') return TEXT(bootstrapStatusPage(url.searchParams))
    await ensureBuilt()
    return TEXT(readFileSync(join(HERE, 'grids/antd.html'), 'utf8').replace('站点清单（Ant Design Table）', '状态信号（Ant Design）'))
  }
  // 树形表格页：lib=antd（真实库），数据来自 /grids/api/tree；collapsed=1 全部折叠、bad=1 上海小计不符
  if (rest === 'tree') {
    await ensureBuilt()
    return TEXT(readFileSync(join(HERE, 'grids/antd.html'), 'utf8').replace('站点清单（Ant Design Table）', '区域站点汇总（Ant Design 树形表格）'))
  }
  // 图表页：lib=echarts | chartjs，数据来自 /grids/api/series（months、ragged 参数原样带过去）
  if (rest === 'chart') return TEXT(readFileSync(join(HERE, 'grids/chart.html'), 'utf8'))
  // 交叉表页：原生两层列头 + 合并行头，答案在 /grids/truth?view=crosstab；bad=1 华东小计不符
  if (rest === 'crosstab') return TEXT(crosstabPage(url.searchParams))
  if (rest === 'truth' && url.searchParams.get('view') === 'export') {
    return TEXT(JSON.stringify(exportTruth(parseParams(url.searchParams), exportOptions(url.searchParams))), JSON_TYPE)
  }
  if (rest === 'truth') {
    const truth = truthOf(url.searchParams.get('view') ?? 'sites', parseParams(url.searchParams))
    return truth ? TEXT(JSON.stringify(truth), JSON_TYPE) : TEXT(JSON.stringify({ message: '未知视图' }), JSON_TYPE, 404)
  }
  if (rest === 'common.js') return TEXT(readFileSync(join(HERE, 'grids/common.js'), 'utf8'), 'text/javascript; charset=utf-8')
  if (PAGES[rest]) {
    await ensureBuilt()
    return TEXT(readFileSync(join(HERE, `grids/${rest}.html`), 'utf8'))
  }
  if (rest.startsWith('vendor/')) {
    await ensureBuilt()
    const entry = VENDOR[rest.slice('vendor/'.length)]
    if (!entry || !existsSync(entry[0])) return TEXT('未找到', 'text/plain', 404)
    return { status: 200, type: entry[1], body: readFileSync(entry[0]) }
  }
  const legacy = /^legacy\/([\w.-]+\.html)$/.exec(rest)
  if (legacy && existsSync(join(LEGACY_DIR, legacy[1]))) return TEXT(readFileSync(join(LEGACY_DIR, legacy[1]), 'utf8'))
  return TEXT('未找到', 'text/plain', 404)
}
