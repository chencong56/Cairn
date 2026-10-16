import { randomUUID } from 'node:crypto'
import { seedPortal } from './seed.mjs'
import { replaceScenario } from './scenario-helper.mjs'

/**
 * 表格控件端到端核对：对本机运行中的识途，用 /grids/ 里的真实控件页（AG Grid / Ant Design Table / Handsontable / 老控件）
 * 各建一个「导航 → 表格读取 → 数据检查」场景并真实试跑，核对运行结果。
 * “合计不一致”和“虚拟滚动读不全”这类应记为业务结果异常的页面，期望试跑不成功（不是执行报错）。
 * 需要本机 API / Worker 与 node server.mjs 已启动；会真实开会话并发起多次试跑。
 */
const lab = process.env.PORTAL_ORIGIN ?? 'http://127.0.0.1:4183'
const seeded = await seedPortal()
const api = `${seeded.api}/api`
const { token, targetId, scenarioId: _unused } = seeded
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** dev 热重载期间 API 会短暂不可连：连接被拒时重试，不当作失败。 */
async function fetchRetry(url, init) {
  for (let i = 0; ; i++) {
    try {
      return await fetch(url, init)
    } catch (e) {
      if (i >= 30) throw e
      await sleep(2000)
    }
  }
}
async function req(path, method = 'GET', body) {
  const res = await fetchRetry(`${api}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text(); let data; try { data = JSON.parse(text) } catch { data = text }
  if (!res.ok) throw new Error(`${method} ${path} ${res.status} ${JSON.stringify(data).slice(0, 400)}`)
  return data
}

const target = (selector) => ({ framePath: [], candidates: [{ by: 'css', value: selector }] })
async function labTruth(query) {
  const login = await fetch(`${lab}/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=demo&password=demo123' })
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
  return (await fetch(`${lab}/grids/truth?${query}`, { headers: { cookie } })).json()
}
const FILE_COLUMNS = [
  { key: 'id', name: '编号', valueType: 'number', numericKind: 'integer' },
  { key: 'name', name: '站点名称', valueType: 'text' },
  { key: 'qty', name: '数量', valueType: 'number', numericKind: 'integer' },
  { key: 'amount', name: '金额（元）', valueType: 'number', numericKind: 'decimal' },
]
/** 文件来源：打开导出页 → 点导出按钮下载 → 读文件。 */
const fileCase = (name, query, button, rules, ok, extra = {}) => ({
  name,
  path: `export-page?${query}`,
  download: button,
  rules,
  ok,
  ...extra,
})
const SITE_COLUMNS = [
  { key: 'id', name: '编号', valueType: 'number', numericKind: 'integer' },
  { key: 'name', name: '站点名称', valueType: 'text' },
  { key: 'qty', name: '数量', valueType: 'number', numericKind: 'integer' },
  { key: 'amount', name: '金额（元）', valueType: 'number', numericKind: 'decimal' },
]
const REPORT_COLUMNS = [
  { key: 'name', name: '报表名称', field: 'item1', valueType: 'text' },
  { key: 'uses', name: '使用次数', field: 'item4', valueType: 'number', numericKind: 'integer' },
]
const rowCount = (value) => ({ rule: 'row_count', op: 'eq', value })
const totalMatch = { rule: 'total_row_match', column: 'qty', precision: 'display' }
const pageTotal = (value) => ({ rule: 'page_total', op: 'eq', value })
const pageConsistency = { rule: 'page_consistency' }

/** 接口来源：站点接口（data.list / data.total）与图表接口（列式）。 */
const API_COLUMNS = [
  { key: 'id', name: 'id', path: 'id', valueType: 'number', numericKind: 'integer' },
  { key: 'name', name: 'name', path: 'name', valueType: 'text' },
  { key: 'qty', name: 'qty', path: 'qty', valueType: 'number', numericKind: 'integer' },
  { key: 'amount', name: 'amount', path: 'amount', valueType: 'number', numericKind: 'decimal' },
]
const sitesApi = (extra = {}) => ({ protocol: 'table.network@1', match: { url: '/grids/api/sites' }, rowsPath: 'data.list', totalPath: 'data.total', columns: API_COLUMNS, window: { since: 'page_load', waitMs: 10_000 }, ...extra })
const SERIES_COLUMNS = [
  { key: 'month', name: '月份', path: 'data.months', valueType: 'text' },
  { key: 'income', name: '收入', path: 'data.series.0.data', valueType: 'number', numericKind: 'decimal' },
  { key: 'expense', name: '支出', path: 'data.series.1.data', valueType: 'number', numericKind: 'decimal' },
]
const seriesApi = { protocol: 'table.network@1', match: { url: '/grids/api/series' }, layout: 'columns', columns: SERIES_COLUMNS, window: { since: 'page_load', waitMs: 10_000 } }
/** 页面表格与接口逐行比对：页面读成 pageRows，接口读成 rows，按编号比数量与金额。 */
const pageMatch = { rule: 'record_sets_match', otherKey: 'pageRows', key: { column: 'id', otherColumn: 'id' }, columns: [{ column: 'qty', otherColumn: 'qty', precision: 'display' }, { column: 'amount', otherColumn: 'amount', precision: 'display' }] }
const networkCase = (name, path, network, rules, ok, extra = {}) => ({ name, path, network, rules, ok, ...extra })

/** 树形：名称 / 数量 / 金额，读法为树形。 */
const TREE_COLUMNS = [
  { key: 'name', name: '名称', valueType: 'text' },
  { key: 'qty', name: '数量', valueType: 'number', numericKind: 'integer' },
  { key: 'amount', name: '金额（元）', valueType: 'number', numericKind: 'decimal' },
]
const rollup = { rule: 'tree_rollup_match', column: 'qty', precision: 'display' }
const treeCase = (name, path, selector, scope, rules, ok, extra = {}) => ({ name, path, selector, columns: TREE_COLUMNS, layout: { mode: 'tree', scope }, rules, ok, ...extra })

/** 交叉表：前两列是行维度，两层列头（指标 / 月份）逆透视成长表。 */
const CROSS_ROW_DIMS = [
  { key: 'col_1', name: '区域', valueType: 'text' },
  { key: 'col_2', name: '城市', valueType: 'text' },
]
const crossLayout = { mode: 'crosstab', columnDims: ['指标', '月份'] }
const crossTotalMatch = { rule: 'crosstab_total_match', precision: 'display' }
const crossCase = (name, path, rules, ok, extra = {}) => ({ name, path, selector: '#cross', columns: CROSS_ROW_DIMS, layout: crossLayout, rules, ok, ...extra })

/** 状态信号：状态区域固定读文字 / 语义 / 序号；表格里的状态列与进度列读派生的语义 / 百分比。 */
const STATUS_COLUMNS = [
  { key: 'text', name: '文字', valueType: 'text' },
  { key: 'tone', name: '语义', valueType: 'text', read: 'tone' },
  { key: 'order', name: '序号', valueType: 'number', numericKind: 'integer', read: 'order' },
]
const STATUS_TABLE_COLUMNS = [
  { key: 'id', name: '编号', valueType: 'number', numericKind: 'integer' },
  { key: 'tone', name: '状态', label: '「状态」的语义', valueType: 'text', read: 'tone' },
  { key: 'pct', name: '进度', label: '「进度」的百分比', valueType: 'number', numericKind: 'decimal', read: 'percent' },
]
const tone = (rule, op, value) => ({ rule, column: 'tone', predicate: { op, value } })
const statusCase = (name, path, selector, columns, rules, ok, extra = {}) => ({ name, path, selector, columns, rules, ok, ...(columns === STATUS_COLUMNS ? { kind: 'status' } : {}), ...extra })

/** ok=true：试跑应成功；ok=false：应判为业务上不通过（试跑不成功，但数据读取步骤本身要成功）。 */
const CASES = [
  { name: 'AG Grid 基本读取', path: 'aggrid?rows=8', selector: '#grid', columns: SITE_COLUMNS, rule: rowCount(8), ok: true },
  { name: 'AG Grid 固定列+合计核对', path: 'aggrid?rows=6&pinned=1&summary=1', selector: '#grid', columns: SITE_COLUMNS, rule: totalMatch, ok: true },
  { name: 'AG Grid 合计不一致', path: 'aggrid?rows=6&summary=1&bad=1', selector: '#grid', columns: SITE_COLUMNS, rule: totalMatch, ok: false },
  { name: 'AG Grid 5000 行虚拟滚动（不能宣称读全）', path: 'aggrid?rows=5000', selector: '#grid', columns: SITE_COLUMNS, rule: rowCount(5000), ok: false },
  { name: 'Ant Design 固定表头+合计核对', path: 'antd?rows=6&summary=1', selector: '#grid', columns: SITE_COLUMNS, rule: totalMatch, ok: true },
  { name: 'Ant Design 合计不一致', path: 'antd?rows=6&summary=1&bad=1', selector: '#grid', columns: SITE_COLUMNS, rule: totalMatch, ok: false },
  { name: 'Ant Design 延迟加载', path: 'antd?rows=5&delay=600', selector: '#grid', columns: SITE_COLUMNS, rule: rowCount(5), ok: true },
  { name: 'Handsontable 基本读取（冻结列）', path: 'handsontable?rows=7&pinned=1', selector: '#grid', columns: SITE_COLUMNS, rule: rowCount(7), ok: true },
  { name: 'Handsontable 末行合计核对', path: 'handsontable?rows=6&summary=1', selector: '#grid', columns: SITE_COLUMNS, rule: totalMatch, ok: true },
  { name: 'Handsontable 合计不一致', path: 'handsontable?rows=6&summary=1&bad=1', selector: '#grid', columns: SITE_COLUMNS, rule: totalMatch, ok: false },
  { name: '老控件 easyui 对照（隐藏空壳 + 选择器 #datagrid）', path: 'legacy/easyui-edc.html', selector: '#datagrid', columns: REPORT_COLUMNS, rule: rowCount(3), ok: true },
  // P1 分页元信息
  { name: 'Ant Design 分页：总条数 + 本页条数一致', path: 'antd?rows=45&paged=1', selector: '#grid', columns: SITE_COLUMNS, rules: [pageTotal(45), pageConsistency], ok: true },
  { name: 'Ant Design 分页显示的总数与真实不符', path: 'antd?rows=45&paged=1&badTotal=1', selector: '#grid', columns: SITE_COLUMNS, rule: pageTotal(45), ok: false },
  { name: 'Ant Design 本页少行（服务端分页漏数据）', path: 'antd?rows=45&paged=1&shortPage=1', selector: '#grid', columns: SITE_COLUMNS, rule: pageConsistency, ok: false },
  { name: 'AG Grid 分页总条数（行虚拟渲染不影响总数）', path: 'aggrid?rows=45&paged=1', selector: '#grid', columns: SITE_COLUMNS, rule: pageTotal(45), ok: true },
  { name: '老控件 easyui 分页总条数', path: 'legacy/easyui-datagrid.html', selector: '#dg-wrap', columns: [{ key: 'name', name: '名称', valueType: 'text' }], rule: pageTotal(3), ok: true },
  // P2 导出文件
  fileCase('xlsx 导出：标题行 + 合并表头 + 合计核对', 'rows=12&title=1&merged=1&summary=1', '#export-xlsx', [rowCount(12), totalMatch], true),
  fileCase('HTML 伪 xls 导出', 'rows=12&summary=1', '#export-html-xls', [rowCount(12)], true),
  fileCase('CSV（GBK）导出：合计不一致', 'rows=12&summary=1&bad=1', '#export-csv-gbk', [totalMatch], false),
  fileCase('xlsx 5000 行：全量外置、按全量求和', 'rows=5000', '#export-xlsx', [rowCount(5000), 'SUM_QTY'], true),
  fileCase('二进制 xls：读取明确报不支持', 'rows=3', '#export-xls-binary', [rowCount(3)], false, { extractError: 'TABLE_FILE_XLS_UNSUPPORTED' }),
  // P3 接口返回的数据
  networkCase('接口：页面背后的查询接口（行数 + 接口总条数）', 'antd?rows=45&paged=1', sitesApi(), [rowCount(45), pageTotal(45)], true),
  networkCase('接口：POST 查询按方法匹配', 'antd?rows=8&post=1', sitesApi({ match: { url: '/grids/api/sites', method: 'POST' } }), [rowCount(8)], true),
  networkCase('接口：页面表格与接口逐行一致', 'antd?rows=8', sitesApi(), [pageMatch], true, { pageFirst: true }),
  networkCase('接口：页面与接口不一致（drift）', 'antd?rows=8&drift=1', sitesApi(), [pageMatch], false, { pageFirst: true }),
  networkCase('接口：ECharts 图表的列式数据（按全量求和）', 'chart?lib=echarts&months=6', seriesApi, ['SUM_INCOME'], true),
  networkCase('接口：图表数组长度不一致明确报错', 'chart?lib=chartjs&months=6&ragged=1', seriesApi, [rowCount(6)], false, { extractError: 'TABLE_NETWORK_COLUMNS_LENGTH_MISMATCH' }),
  networkCase('接口：返回 500 明确报状态码不符', 'antd?rows=3&fail=1', sitesApi({ window: { since: 'page_load', waitMs: 3_000 } }), [rowCount(3)], false, { extractError: 'TABLE_NETWORK_STATUS_MISMATCH' }),
  networkCase('接口：没有匹配的接口是来源未找到（不是空表）', 'antd?rows=3', sitesApi({ match: { url: '/grids/api/nothing' }, window: { since: 'page_load', waitMs: 2_000 } }), [rowCount(0)], false, { extractError: 'TABLE_SOURCE_NOT_FOUND' }),
  // P4 树形
  treeCase('树形：antd 父行等于子行之和', 'tree?lib=antd', '#grid', 'all', ['TREE_ROWS', rollup], true),
  treeCase('树形：上海小计与下级之和不符', 'tree?lib=antd&bad=1', '#grid', 'all', [rollup], false),
  treeCase('树形：节点没展开时判无法确认（不是业务不通过）', 'tree?lib=antd&collapsed=1', '#grid', 'all', [rowCount(4)], false, { checkError: 'TABLE_FACTS_UNAVAILABLE' }),
  treeCase('树形：只取顶层，折叠着也能读全', 'tree?lib=antd&collapsed=1', '#grid', 'top', [rowCount(4)], true),
  treeCase('树形：Element 静态页按层级路径找行', 'legacy/elementui-tree.html', '.el-table', 'top', ['TREE_LOOKUP'], true),
  // P5 状态信号
  statusCase('状态：antd 步骤条没有错误步骤、有进行中的步骤', 'status?lib=antd', '#steps .ant-steps', STATUS_COLUMNS, [tone('all_rows', 'neq', 'error'), tone('any_row', 'eq', 'processing')], true),
  statusCase('状态：“财务复核”还没完成（反例）', 'status?lib=antd', '#steps .ant-steps', STATUS_COLUMNS,
    [{ rule: 'row_lookup', where: [{ column: 'text', predicate: { op: 'eq', value: '财务复核' } }], expect: [{ column: 'tone', predicate: { op: 'eq', value: 'success' } }], onMissing: 'fail', onMultiple: 'all' }], false, { checkError: 'ASSERT_FAILED' }),
  statusCase('状态：标签里有未识别的样式，结论取决于它时判无法确认', 'status?lib=antd', '#tags', STATUS_COLUMNS, [tone('any_row', 'eq', 'info')], false, { checkError: 'TABLE_FACTS_UNAVAILABLE' }),
  statusCase('状态：antd 表格的状态列与进度列', 'status?lib=antd', '#status-grid', STATUS_TABLE_COLUMNS, ['STATUS_ROW', 'STATUS_PROGRESS_SUM'], true),
  statusCase('状态：Bootstrap 进度都不低于 50%（反例）', 'status?lib=bootstrap', '#grid', STATUS_TABLE_COLUMNS, [{ rule: 'all_rows', column: 'pct', predicate: { op: 'gte', value: 50 } }], false, { checkError: 'ASSERT_FAILED' }),
  statusCase('状态：layui 静态页状态列没有错误', 'legacy/status-layui.html', '#status-grid', STATUS_TABLE_COLUMNS, [tone('all_rows', 'neq', 'error')], true),
  // P6 交叉表
  crossCase('交叉表：逆透视长表与真值行数一致', 'crosstab', ['CROSS_ROWS', crossTotalMatch], true),
  crossCase('交叉表：华东小计与明细之和不符', 'crosstab?bad=1', [crossTotalMatch], false),
]

async function buildScenario(c) {
  const name = `表格控件核对：${c.name}`
  const query = c.path.split('?')[1] ?? ''
  let rules = c.rules ?? [c.rule]
  if (rules.includes('TREE_ROWS') || rules.includes('TREE_LOOKUP')) {
    const truth = await labTruth(`view=tree&${query}`)
    const east = truth.rows.find((r) => r.path === '华东')
    rules = rules.map((r) =>
      r === 'TREE_ROWS'
        ? rowCount(truth.rows.length)
        : r === 'TREE_LOOKUP'
          ? { rule: 'row_lookup', where: [{ column: 'tree_path', predicate: { op: 'eq', value: '华东' } }], expect: [{ column: 'qty', predicate: { op: 'eq', value: east.qty } }], onMissing: 'fail', onMultiple: 'all' }
          : r,
    )
  }
  if (rules.includes('STATUS_ROW') || rules.includes('STATUS_PROGRESS_SUM')) {
    const truth = await labTruth(`view=status&${query}`)
    const third = truth.rows[2]
    rules = rules.map((r) =>
      r === 'STATUS_ROW'
        ? { rule: 'row_lookup', where: [{ column: 'id', predicate: { op: 'eq', value: third.id } }], expect: [{ column: 'tone', predicate: { op: 'eq', value: third.tone } }], onMissing: 'fail', onMultiple: 'all' }
        : r === 'STATUS_PROGRESS_SUM'
          ? { rule: 'column_stat', column: 'pct', stat: 'sum', op: 'eq', value: truth.rows.reduce((n, x) => n + x.progress, 0), ignoreEmpty: false }
          : r,
    )
  }
  if (rules.includes('SUM_INCOME')) {
    const truth = await labTruth(`view=series&${query}`)
    const sum = Math.round(truth.rows.reduce((n, x) => n + x.income, 0) * 100) / 100
    rules = rules.map((r) => (r === 'SUM_INCOME' ? { rule: 'column_stat', column: 'income', stat: 'sum', op: 'eq', value: sum, ignoreEmpty: false } : r))
  }
  if (rules.includes('SUM_QTY')) {
    const truth = await labTruth(`view=export&${query}`)
    rules = rules.map((r) => (r === 'SUM_QTY' ? { rule: 'column_stat', column: 'qty', stat: 'sum', op: 'eq', value: truth.rows.reduce((n, x) => n + x.qty, 0), ignoreEmpty: false } : r))
  }
  if (rules.includes('CROSS_ROWS')) {
    const truth = await labTruth(`view=crosstab&${query}`)
    rules = rules.map((r) => (r === 'CROSS_ROWS' ? rowCount(truth.rows.length) : r))
  }
  const read = c.network
    ? [
        ...(c.pageFirst
          ? [{
              id: randomUUID(), name: '读取页面表格', type: 'extract', effectType: 'READ_ONLY', outputKey: 'pageRows',
              input: { target: target('#grid'), as: 'table', table: { protocol: 'table.read@2', target: target('#grid'), columns: SITE_COLUMNS } },
            }]
          : []),
        { id: randomUUID(), name: '读取接口返回的数据', type: 'extract', effectType: 'READ_ONLY', outputKey: 'rows', input: { as: 'table', source: 'network', table: c.network } },
      ]
    : c.download
    ? [
        { id: randomUUID(), name: '导出', type: 'download', effectType: 'READ_ONLY', outputKey: 'exportFile', input: { target: target(c.download), waitMs: 30_000 } },
        { id: randomUUID(), name: '读取导出文件', type: 'extract', effectType: 'READ_ONLY', outputKey: 'rows', input: { as: 'table', source: 'file', table: { protocol: 'table.file@1', fromKey: 'exportFile', columns: FILE_COLUMNS } } },
      ]
    : [
        {
          id: randomUUID(), name: '读取表格', type: 'extract', effectType: 'READ_ONLY', outputKey: 'rows',
          input: { target: target(c.selector), as: 'table', table: { protocol: 'table.read@2', target: target(c.selector), columns: c.columns, ...(c.layout ? { layout: c.layout } : {}), ...(c.kind ? { kind: c.kind } : {}) } },
        },
      ]
  const steps = [
    { id: randomUUID(), name: '打开控件页', type: 'navigate', effectType: 'READ_ONLY', input: { url: `${lab}/grids/${c.path}` } },
    ...read,
    ...rules.map((rule, i) => ({ id: randomUUID(), name: `数据检查 ${i + 1}`, type: 'check_context', effectType: 'READ_ONLY', input: { key: 'rows', expect: { kind: 'table', rule } } })),
  ]
  return replaceScenario(req, targetId, name, steps)
}

let failed = 0
// GRID_ONLY=关键字：只跑名称含该关键字的用例（排查单条时用）
const only = process.env.GRID_ONLY
for (const c of only ? CASES.filter((x) => x.name.includes(only)) : CASES) {
  const scenario = await buildScenario(c)
  const run = await req('/runs', 'POST', { scenarioId: scenario.id })
  let finished
  for (let i = 0; i < 60 && !finished; i++) {
    await sleep(2000)
    const r = await req(`/runs/${run.id}`)
    if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'NEEDS_REVIEW'].includes(r.status)) finished = r
  }
  const succeeded = finished?.status === 'SUCCEEDED'
  const stepsSeen = (finished?.stepRuns ?? []).map((x) => `${x.type}:${x.status}`)
  // 不通过的场景必须是“读到了数据、检查没过”：读取步骤成功，检查步骤不成功；读取本身报错不算
  const extractRun = [...(finished?.stepRuns ?? [])].reverse().find((x) => x.type === 'extract')
  const readOk = extractRun?.status === 'SUCCEEDED'
  const extractCode = extractRun?.attempts?.at(-1)?.error?.code
  // 反例分两种：读到了数据、检查没过（读取步骤成功）；或文件本身不受支持，读取明确报对应错误码
  // 证据轴与执行轴分开核对：文件读取不碰页面，不应因为没有现场截图被判证据不完整
  let evidence = finished?.evidenceStatus
  for (let i = 0; i < 15 && finished && evidence === 'PENDING'; i++) {
    await sleep(1000)
    evidence = (await req(`/runs/${run.id}`)).evidenceStatus
  }
  // 反例还要求检查步骤失败的原因对得上（例如读不全必须是“无法确认”，不能当成业务不通过）
  const checkCode = finished?.stepRuns?.filter((x) => x.type === 'check_context').map((x) => x.attempts?.at(-1)?.error?.code).find(Boolean)
  const good =
    evidence === 'COMPLETE' &&
    (c.ok
      ? succeeded
      : Boolean(finished) && !succeeded && (c.extractError ? extractCode === c.extractError : readOk) && (!c.checkError || checkCode === c.checkError))
  if (!good) failed++
  console.log(`${good ? '✓' : '✗'} ${c.name}：试跑 ${finished?.status ?? '超时'}（期望${c.ok ? '成功' : '不通过'}）证据 ${evidence ?? '-'} [${stepsSeen.join(' ')}]${extractCode ? ` ${extractCode}` : ''}${checkCode ? ` ${checkCode}` : ''} run=${run.id}`)
  if (process.env.GRID_VERBOSE) console.log(JSON.stringify(finished).slice(0, 1500))
}
if (failed) {
  console.error(`\n${failed} 项与期望不符`)
  process.exitCode = 1
} else {
  console.log('\n表格控件端到端核对通过')
}
