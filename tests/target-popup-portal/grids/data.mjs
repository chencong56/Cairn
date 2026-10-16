/**
 * 表格控件靶场的唯一数据源（服务端）：同一组参数同时生成控件页的接口数据（/grids/api/*）、
 * 导出文件（/grids/export）与标准答案（/grids/truth）。数据全部虚构、确定性生成。
 */
const REGIONS = ['华南', '华东', '华北', '西南']
const STATUS = ['在用', '停用', '待核查']

export const SITE_COLUMNS = [
  { key: 'id', title: '编号' },
  { key: 'name', title: '站点名称' },
  { key: 'region', title: '区域' },
  { key: 'qty', title: '数量' },
  { key: 'amount', title: '金额（元）' },
  { key: 'status', title: '状态' },
  { key: 'date', title: '日期' },
]

/** URL 参数 → 规范化参数（页面、接口、真值共用同一份解析）。 */
export function parseParams(search) {
  const q = search instanceof URLSearchParams ? search : new URLSearchParams(search)
  return {
    rows: Math.max(0, Number(q.get('rows') ?? 8)),
    delay: Math.max(0, Number(q.get('delay') ?? 0)),
    empty: q.get('empty') === '1',
    pinned: q.get('pinned') === '1',
    summary: q.get('summary') === '1' || q.get('bad') === '1',
    bad: q.get('bad') === '1',
    group: q.get('group') === '1',
    paged: q.get('paged') === '1',
    virtual: q.get('virtual') === '1',
    post: q.get('post') === '1',
    fail: q.get('fail') === '1',
    nonjson: q.get('nonjson') === '1',
    drift: q.get('drift') === '1',
    badTotal: q.get('badTotal') === '1',
    shortPage: q.get('shortPage') === '1',
    months: Math.min(24, Math.max(1, Number(q.get('months') ?? 6))),
    ragged: q.get('ragged') === '1',
    collapsed: q.get('collapsed') === '1',
    lib: q.get('lib') ?? 'antd',
  }
}

/** 站点明细（确定性）。 */
export function siteRows(p) {
  if (p.empty) return []
  return Array.from({ length: p.rows }, (_, i) => ({
    id: 1000 + i,
    name: `站点${String(i + 1).padStart(4, '0')}`,
    region: REGIONS[i % REGIONS.length],
    qty: (i % 7) + 1,
    amount: Math.round(((i % 13) + 1) * 1234.56 * 100) / 100,
    status: STATUS[i % STATUS.length],
    date: `2026-10-${String((i % 28) + 1).padStart(2, '0')}`,
  }))
}

/** 合计行（bad=1 时故意与明细不一致：数量多 1）。 */
export function siteTotal(p, rows = siteRows(p)) {
  return {
    qty: rows.reduce((s, r) => s + r.qty, 0) + (p.bad ? 1 : 0),
    amount: Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100) / 100,
  }
}

/** /grids/api/sites 的响应体；drift=1 时第一行数量与页面不一致（用于“页面与接口一致”的反例）。 */
export function sitesResponse(p) {
  const list = siteRows(p).map((r, i) => (p.drift && i === 0 ? { ...r, qty: r.qty + 100 } : r))
  return { code: 0, message: 'ok', data: { total: list.length, list, ...(p.summary ? { summary: siteTotal(p) } : {}) } }
}

/** 图表数据（确定性）：每月收入 / 支出。 */
export function seriesData(p) {
  const months = Array.from({ length: p.months }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`)
  const income = months.map((_, i) => Math.round((1200 + i * 137.5 + (i % 3) * 42.25) * 100) / 100)
  const expense = months.map((_, i) => Math.round((800 + i * 91.2) * 100) / 100)
  return { months, income, expense }
}

/** /grids/api/series：ECharts 常见的列式结构；ragged=1 时支出少一个点（列式数据长度不一致的反例）。 */
export function seriesResponse(p) {
  const s = seriesData(p)
  return {
    code: 0,
    data: {
      months: s.months,
      series: [
        { name: '收入', type: 'bar', data: s.income },
        { name: '支出', type: 'line', data: p.ragged ? s.expense.slice(0, -1) : s.expense },
      ],
    },
  }
}

/**
 * 树形数据（确定性）：区域 → 城市 → 站点。城市、区域的数量与金额是下级之和；
 * bad=1 时“上海”的数量小计多 1（与下级站点之和不符，区域按显示的城市值汇总）。
 */
const TREE = [
  ['华东', [['上海', 3], ['杭州', 2]]],
  ['华南', [['广州', 2], ['深圳', 3]]],
  ['华北', [['北京', 2], ['天津', 2]]],
  ['西南', [['成都', 2], ['重庆', 2]]],
]
const round2 = (n) => Math.round(n * 100) / 100
export function treeData(p) {
  let n = 0
  return TREE.map(([region, cities], ri) => {
    const children = cities.map(([city, count], ci) => {
      const sites = Array.from({ length: count }, (_, si) => {
        const i = n++
        return { key: `r${ri}-c${ci}-s${si}`, name: `${city}站点${si + 1}`, qty: (i % 7) + 1, amount: round2(((i % 13) + 1) * 123.45) }
      })
      const qty = sites.reduce((t, x) => t + x.qty, 0) + (p.bad && city === '上海' ? 1 : 0)
      return { key: `r${ri}-c${ci}`, name: city, qty, amount: round2(sites.reduce((t, x) => t + x.amount, 0)), children: sites }
    })
    return { key: `r${ri}`, name: region, qty: children.reduce((t, x) => t + x.qty, 0), amount: round2(children.reduce((t, x) => t + x.amount, 0)), children }
  })
}

/** 树形的标准答案：页面上看得到的行（深度优先），带层级与层级路径；collapsed=1 时只看得到顶层。 */
export function treeTruthRows(p) {
  const out = []
  const walk = (nodes, level, path) => {
    for (const node of nodes) {
      const hasChildren = Boolean(node.children?.length)
      const here = [...path, node.name]
      out.push({ level, name: node.name, path: here.join(' / '), qty: node.qty, amount: node.amount, hasChildren, ...(hasChildren ? { expanded: !p.collapsed } : {}) })
      if (hasChildren && !p.collapsed) walk(node.children, level + 1, here)
    }
  }
  walk(treeData(p), 0, [])
  return out
}

/**
 * 状态信号（确定性）：步骤条、一组标签、告警、带状态标签与进度条的表格。
 * tone 是标准答案：映射表认得的给语义；预设颜色 / 自定义颜色 / 非标准类名不是语义，答案是 unknown（判“无法确认”）。
 */
export const STATUS_STEPS = [
  { text: '提交申请', tone: 'success' },
  { text: '部门审批', tone: 'success' },
  { text: '财务复核', tone: 'processing' },
  { text: '归档', tone: 'default' },
]
export const STATUS_TAGS = [
  { text: '在用', tone: 'success' },
  { text: '同步中', tone: 'processing' },
  { text: '待核查', tone: 'warning' },
  { text: '故障', tone: 'error' },
  { text: '停用', tone: 'default' },
  { text: '绿色标签', tone: 'unknown', variant: 'preset' },
  { text: '自定义色', tone: 'unknown', variant: 'custom' },
]
export const STATUS_ALERTS = [
  { text: '数据已同步', tone: 'success' },
  { text: '今晚 22:00 维护', tone: 'info' },
  { text: '3 个站点待核查', tone: 'warning' },
  { text: '1 个站点故障', tone: 'error' },
]
const STATUS_TONE = { 在用: 'success', 停用: 'default', 待核查: 'warning' }
export function statusRows(p) {
  return siteRows(p).map((r, i) => ({ id: r.id, name: r.name, status: r.status, tone: STATUS_TONE[r.status], progress: i === 0 ? 100 : (i * 13) % 100 }))
}

/** 标准答案：页面上应读到的数据（不受 drift 影响——drift 只改接口返回）。 */
export const PAGE_SIZE = 20

/**
 * 分页页面上第 1 页应读到的分页信息与行数（paged=1 时）。
 * badTotal=1：分页条显示的总条数比真实多 5（真值仍给真实总数，供“总条数”反例）；
 * shortPage=1：第 1 页少 2 行（模拟服务端分页漏行，供“本页条数与分页一致”反例）。
 */
export function pagingOf(p, total) {
  if (!p.paged) return null
  const shownTotal = total + (p.badTotal ? 5 : 0)
  const expectedPageRows = Math.min(PAGE_SIZE, shownTotal)
  return {
    pageSize: PAGE_SIZE,
    currentPage: 1,
    totalPages: Math.max(1, Math.ceil(shownTotal / PAGE_SIZE)),
    shownTotal,
    pageRows: p.shortPage ? Math.max(0, expectedPageRows - 2) : expectedPageRows,
    expectedPageRows,
  }
}

/**
 * 交叉表数据（确定性）：区域 → 城市 的行头（纵向合并），列头两层（指标：本年累计 / 本月累计 × 月份 1–3 月）。
 * 每个区域末尾是「小计」行，每行末尾是「合计」列，最后有「总计」行；杭州的「本月累计 / 3 月」空着（空格当 0）。
 * bad=1 时华东小计行的「本年累计 / 1 月」多 10，该行的合计格与总计行都按（错的）小计汇总：页面上 4 个合计格与明细不符。
 */
const CROSS_REGIONS = [
  ['华东', [['上海', 0], ['杭州', 1]]],
  ['华南', [['广州', 2], ['深圳', 3]]],
]
const CROSS_KINDS = ['本年累计', '本月累计']
const CROSS_MONTHS = ['1月', '2月', '3月']
const round1 = (n) => Math.round(n * 10) / 10
const sum1 = (xs) => round1(xs.reduce((t, x) => t + (x ?? 0), 0))
export const CROSS_LAYOUT = { regions: CROSS_REGIONS, kinds: CROSS_KINDS, months: CROSS_MONTHS }

export function crossData(p) {
  const detail = []
  CROSS_REGIONS.forEach(([region, cities]) => {
    cities.forEach(([city, ci]) => {
      const cells = CROSS_KINDS.map((_, ki) =>
        CROSS_MONTHS.map((_, mi) => (city === '杭州' && ki === 1 && mi === 2 ? null : round1(12 + ci * 7 + ki * 13 + mi * 4 + 0.5))),
      )
      detail.push({ region, city, cells, total: sum1(cells.flat()) })
    })
  })
  const subtotal = CROSS_REGIONS.map(([region]) => {
    const rows = detail.filter((r) => r.region === region)
    const cells = CROSS_KINDS.map((_, ki) => CROSS_MONTHS.map((_, mi) => sum1(rows.map((r) => r.cells[ki][mi]))))
    if (p.bad && region === '华东') cells[0][0] = round1(cells[0][0] + 10)
    return { region, cells, total: sum1(cells.flat()) }
  })
  const grand = { cells: CROSS_KINDS.map((_, ki) => CROSS_MONTHS.map((_, mi) => sum1(subtotal.map((s) => s.cells[ki][mi])))) }
  grand.total = sum1(grand.cells.flat())
  return { detail, subtotal, grand }
}

/** 交叉表的标准答案：明细格逆透视成的长表（每格一行，空格是 null）。真值永远按明细算，不受 bad 影响。 */
export function crossTruthRows(p) {
  const d = crossData({ ...p, bad: false })
  const rows = []
  d.detail.forEach((r) => {
    CROSS_KINDS.forEach((kind, ki) => CROSS_MONTHS.forEach((month, mi) => rows.push({ region: r.region, city: r.city, kind, month, value: r.cells[ki][mi] })))
  })
  return rows
}

export function truthOf(view, p) {
  if (view === 'sites') {
    const rows = siteRows(p)
    const paging = pagingOf(p, rows.length)
    return { view, rowCount: rows.length, total: rows.length, rows, ...(p.summary ? { summary: siteTotal(p, rows) } : {}), ...(paging ? { paging } : {}) }
  }
  if (view === 'status') {
    const rows = statusRows(p)
    // Bootstrap 没有“进行中”这个上下文色（页面用 primary，映射为默认），也没有步骤条
    const bs = p.lib === 'bootstrap'
    const tags = bs ? STATUS_TAGS.map((t) => (t.tone === 'processing' ? { ...t, tone: 'default' } : t)) : STATUS_TAGS
    return { view, steps: bs ? [] : STATUS_STEPS, tags, alerts: STATUS_ALERTS, rowCount: rows.length, total: rows.length, rows }
  }
  if (view === 'tree') {
    const rows = treeTruthRows(p)
    return { view, rowCount: rows.length, total: rows.length, rows, collapsed: rows.filter((r) => r.hasChildren && r.expanded === false).length }
  }
  if (view === 'crosstab') {
    const rows = crossTruthRows(p)
    return { view, rowCount: rows.length, total: rows.length, rows }
  }
  if (view === 'series') {
    const s = seriesData(p)
    const rows = s.months.map((month, i) => ({ month, income: s.income[i], expense: s.expense[i] }))
    return { view, rowCount: rows.length, total: rows.length, rows }
  }
  if (view === 'api-sites') {
    // 接口返回的标准答案（drift=1 时第一行数量与页面不同）
    const body = sitesResponse(p)
    return { view, rowCount: body.data.list.length, total: body.data.total, rows: body.data.list }
  }
  return null
}
