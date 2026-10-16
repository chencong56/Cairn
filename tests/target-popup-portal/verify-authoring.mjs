import { randomUUID } from 'node:crypto'
import { seedPortal } from './seed.mjs'
import { replaceScenario } from './scenario-helper.mjs'

/**
 * 编写链路核对：走与 Web 编辑器相同的接口——开会话 → 在受管画面打开控件页 → 识别表格（observe table detect）→
 * 预览与 /grids/truth 核对（含分页信息）→ 用识别出的读取计划保存场景并试跑 → 运行结果与真值一致。
 * 需要本机 API / Worker 与 node server.mjs 已启动；会真实开会话并发起试跑。
 */
const lab = process.env.PORTAL_ORIGIN ?? 'http://127.0.0.1:4183'
const seeded = await seedPortal()
const api = `${seeded.api}/api`
const { token, targetId, accountId } = seeded
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const check = (ok, message) => {
  console.log(`${ok ? '✓' : '✗'} ${message}`)
  if (!ok) failed++
}

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
async function truthOf(query) {
  const login = await fetch(`${lab}/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=demo&password=demo123' })
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
  return (await fetch(`${lab}/grids/truth?view=sites&${query}`, { headers: { cookie } })).json()
}
async function firstFrame(sessionId) {
  const ctl = new AbortController()
  const res = await fetch(`${api}/browser-sessions/${sessionId}/browser/frames`, { headers: { authorization: `Bearer ${token}`, Accept: 'text/event-stream' }, signal: ctl.signal })
  const reader = res.body.getReader(); let buf = ''
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const { value, done } = await reader.read(); if (done) break
    buf += new TextDecoder().decode(value)
    const m = /event: (\w+)\ndata: (.*)\n\n/.exec(buf)
    if (m) { ctl.abort(); return JSON.parse(m[2]) }
  }
  ctl.abort(); throw new Error('没有收到受管画面帧')
}

// 1. 打开会话
const base = `/targets/${targetId}/accounts/${accountId}/session`
let detail = await req(base)
let sessionId = detail.session?.status === 'OPEN' ? detail.session.id : undefined
if (!sessionId) {
  await req(`${base}/operations`, 'POST', { kind: 'PREPARE', idempotencyKey: `authoring-${randomUUID()}`, originContext: 'INTERACTIVE' })
  for (let i = 0; i < 60 && !sessionId; i++) {
    await sleep(2000); detail = await req(base)
    if (detail.session?.status === 'OPEN' && detail.session?.authState === 'AUTHENTICATED') sessionId = detail.session.id
  }
}
if (!sessionId) throw new Error('会话未就绪')

// 2. 在受管画面打开 antd 分页页（与编辑器顶部地址栏相同的手动导航）
const query = 'rows=45&paged=1'
const granted = await req(`/browser-sessions/${sessionId}/auth-control/acquire`, 'POST', {})
const frame = await firstFrame(sessionId)
await req(`/browser-sessions/${sessionId}/auth-control/input`, 'POST', {
  token: granted.token,
  command: { type: 'navigate', url: `${lab}/grids/antd?${query}`, pageRef: frame.pageRef, commandId: randomUUID(), seq: 1, frameId: frame.frameId, viewport: { width: frame.width, height: frame.height } },
})
await req(`/browser-sessions/${sessionId}/auth-control/release`, 'POST', { token: granted.token })
let meta
for (let i = 0; i < 20; i++) {
  await sleep(500); meta = await req(`/browser-sessions/${sessionId}/browser`)
  if ((meta.currentPage?.url ?? '').includes('/grids/antd')) break
}
const pageId = meta.currentPage?.pageRef?.pageId
check(Boolean(pageId) && meta.currentPage.url.includes('/grids/antd'), `受管画面已打开控件页：${meta.currentPage?.url}`)

// 3. 识别表格（编辑器“范围大一点 / 手动指定”走的同一接口；点选走 x / y）
let detected
for (let i = 0; i < 10 && !detected; i++) {
  const obs = await req(`/browser-sessions/${sessionId}/observe`, 'POST', { op: 'table', subOp: 'detect', rootSelector: '#grid', pageId })
  if (obs.outcome === 'FOUND') detected = obs.detected
  else await sleep(1000)
}
check(detected?.shape === 'antd', `识别出 Ant Design 表格（shape=${detected?.shape}）`)
const truth = await truthOf(query)
const info = detected?.sample?.pageInfo
check(info?.totalRows === truth.paging.shownTotal && info?.currentPage === 1 && info?.pageSize === truth.paging.pageSize,
  `预览里的分页信息与真值一致：${JSON.stringify(info)}`)
const idCol = detected?.plan.columns.find((c) => c.name === '编号')
const previewIds = (detected?.sample?.rows ?? []).map((r) => r[idCol?.key]?.value)
check(JSON.stringify(previewIds) === JSON.stringify(truth.rows.slice(0, 20).map((r) => r.id)), `预览的 20 行编号与真值一致`)

// 4. 用识别出的读取计划保存场景并试跑（数据检查：总条数、本页条数与分页一致）
const name = '编写链路核对：Ant Design 分页'
const steps = [
  { id: randomUUID(), name: '打开控件页', type: 'navigate', effectType: 'READ_ONLY', input: { url: `${lab}/grids/antd?${query}` } },
  { id: randomUUID(), name: '读取表格', type: 'extract', effectType: 'READ_ONLY', outputKey: 'rows', input: { target: detected.plan.target, as: 'table', table: detected.plan } },
  { id: randomUUID(), name: '总条数', type: 'check_context', effectType: 'READ_ONLY', input: { key: 'rows', expect: { kind: 'table', rule: { rule: 'page_total', op: 'eq', value: truth.total } } } },
  { id: randomUUID(), name: '本页条数与分页一致', type: 'check_context', effectType: 'READ_ONLY', input: { key: 'rows', expect: { kind: 'table', rule: { rule: 'page_consistency' } } } },
]
const scenario = await replaceScenario(req, targetId, name, steps)
const run = await req('/runs', 'POST', { scenarioId: scenario.id })
let finished
for (let i = 0; i < 60 && !finished; i++) {
  await sleep(2000)
  const r = await req(`/runs/${run.id}`)
  if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'NEEDS_REVIEW'].includes(r.status)) finished = r
}
check(finished?.status === 'SUCCEEDED', `试跑 ${finished?.status ?? '超时'}（${(finished?.stepRuns ?? []).map((s) => `${s.type}:${s.status}`).join(' ')}） run=${run.id}`)
const rawOutput = finished?.stepRuns?.find((s) => s.type === 'extract')?.attempts?.at(-1)?.output
const output = rawOutput?.value ?? rawOutput
check(output?.pageInfo?.totalRows === truth.total, `运行结果里的分页信息：${JSON.stringify(output?.pageInfo ?? null)}`)

// 5. 导出文件：与编辑器「下载文件里的数据」面板同一流程——先跑到下载步骤 → 用最近一次运行的文件预览识别 →
//    上传样例预览 → 用识别出的计划保存并试跑，结果与真值一致
async function runUntilDone(scenarioId) {
  const started = await req('/runs', 'POST', { scenarioId })
  for (let i = 0; i < 60; i++) {
    await sleep(2000)
    const r = await req(`/runs/${started.id}`)
    if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'NEEDS_REVIEW'].includes(r.status)) return r
  }
  return { id: started.id, status: '超时', stepRuns: [] }
}
const summary = (r) => `${r.status}（${(r.stepRuns ?? []).map((s) => `${s.type}:${s.status}`).join(' ')}） run=${r.id}`
const fileQuery = 'rows=12&title=1&merged=1&summary=1'
const fileTruth = await (async () => {
  const login = await fetch(`${lab}/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=demo&password=demo123' })
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
  const truthJson = await (await fetch(`${lab}/grids/truth?view=export&${fileQuery}`, { headers: { cookie } })).json()
  const gbk = Buffer.from(await (await fetch(`${lab}/grids/export?format=csv-gbk&rows=8&title=1`, { headers: { cookie } })).arrayBuffer())
  const gbkTruth = await (await fetch(`${lab}/grids/truth?view=export&rows=8&title=1`, { headers: { cookie } })).json()
  return { ...truthJson, gbk, gbkTruth }
})()
const downloadStepId = randomUUID()
const navigateStep = { id: randomUUID(), name: '打开导出页', type: 'navigate', effectType: 'READ_ONLY', input: { url: `${lab}/grids/export-page?${fileQuery}` } }
const downloadStep = {
  id: downloadStepId, name: '导出 Excel', type: 'download', effectType: 'READ_ONLY', outputKey: 'exportFile',
  input: { target: { framePath: [], candidates: [{ by: 'css', value: '#export-xlsx' }] }, waitMs: 30_000 },
}
const fileScenario = await replaceScenario(req, targetId, '编写链路核对：导出 Excel', [navigateStep, downloadStep])
const firstRun = await runUntilDone(fileScenario.id)
check(firstRun.status === 'SUCCEEDED', `先跑到下载步骤：${summary(firstRun)}`)

const fromRun = await req(`/scenarios/${fileScenario.id}/table-file/preview`, 'POST', { fromKey: 'exportFile', downloadStepId, source: { kind: 'latest_run' } })
check(fromRun.source.kind === 'latest_run' && fromRun.source.runId === firstRun.id && fromRun.file.format === 'xlsx',
  `预览取的是最近一次运行的文件：${fromRun.file.name}（${fromRun.file.format}）run=${fromRun.source.runId}`)
const colOf = (res, name) => res.columns.find((c) => c.name === name)
check(fromRun.headerRow === 4 && fromRun.headerRows === 2 && /业务数据/.test(colOf(fromRun, '数量')?.groupPath ?? ''),
  `跳过标题行、认出两级合并表头：第 ${fromRun.headerRow} 行起 ${fromRun.headerRows} 行，数量归在「${colOf(fromRun, '数量')?.groupPath}」`)
const idKey = colOf(fromRun, '编号')?.key
const runIds = fromRun.sample.rows.map((r) => r[idKey]?.value)
check(JSON.stringify(runIds) === JSON.stringify(fileTruth.rows.map((r) => r.id)) && fromRun.sample.rowCount === fileTruth.rowCount,
  `预览的 ${runIds.length} 行编号与真值一致（合计行未混入明细）`)

const uploaded = await req(`/scenarios/${fileScenario.id}/table-file/preview`, 'POST', {
  fromKey: 'exportFile', downloadStepId, source: { kind: 'upload', name: '站点清单.csv', base64: fileTruth.gbk.toString('base64') },
})
const upIds = uploaded.sample.rows.map((r) => r[colOf(uploaded, '编号')?.key]?.value)
check(uploaded.source.kind === 'upload' && uploaded.file.encoding === 'gb18030' && colOf(uploaded, '站点名称') &&
  JSON.stringify(upIds) === JSON.stringify(fileTruth.gbkTruth.rows.map((r) => r.id)),
  `上传 GBK CSV 样例：编码 ${uploaded.file.encoding}，列 ${uploaded.columns.map((c) => c.name).join('、')}，编号与真值一致`)

const qtyKey = colOf(fromRun, '数量')?.key
const qtySum = fileTruth.rows.reduce((n, r) => n + r.qty, 0)
await replaceScenario(req, targetId, '编写链路核对：导出 Excel', [
  navigateStep,
  downloadStep,
  { id: randomUUID(), name: '读取导出文件', type: 'extract', effectType: 'READ_ONLY', outputKey: 'rows', input: { as: 'table', source: 'file', table: fromRun.plan } },
  { id: randomUUID(), name: '明细行数', type: 'check_context', effectType: 'READ_ONLY', input: { key: 'rows', expect: { kind: 'table', rule: { rule: 'row_count', op: 'eq', value: fileTruth.rowCount } } } },
  { id: randomUUID(), name: '数量合计', type: 'check_context', effectType: 'READ_ONLY', input: { key: 'rows', expect: { kind: 'table', rule: { rule: 'column_stat', column: qtyKey, stat: 'sum', op: 'eq', value: qtySum, ignoreEmpty: false } } } },
]).then(async (s) => {
  const r = await runUntilDone(s.id)
  check(r.status === 'SUCCEEDED', `用预览识别出的计划保存并试跑：${summary(r)}`)
})

// 6. 接口返回的数据（含图表）：与编辑器“选择接口”对话框同一流程——
//    受管画面打开图表页 → 点图表识别为“图表” → 重新加载并捕获 → 选星标的接口、看结构与建议 → 按建议预览 → 保存试跑
async function navigateManaged(url) {
  const grant = await req(`/browser-sessions/${sessionId}/auth-control/acquire`, 'POST', {})
  const f = await firstFrame(sessionId)
  await req(`/browser-sessions/${sessionId}/auth-control/input`, 'POST', {
    token: grant.token,
    command: { type: 'navigate', url, pageRef: f.pageRef, commandId: randomUUID(), seq: 1, frameId: f.frameId, viewport: { width: f.width, height: f.height } },
  })
  await req(`/browser-sessions/${sessionId}/auth-control/release`, 'POST', { token: grant.token })
  let m
  for (let i = 0; i < 20; i++) {
    await sleep(500); m = await req(`/browser-sessions/${sessionId}/browser`)
    if ((m.currentPage?.url ?? '').startsWith(url.split('?')[0])) break
  }
  return m
}
const chartQuery = 'lib=echarts&months=6'
const chartMeta = await navigateManaged(`${lab}/grids/chart?${chartQuery}`)
const chartPageId = chartMeta.currentPage?.pageRef?.pageId
await sleep(1500)
const chartDetect = await req(`/browser-sessions/${sessionId}/observe`, 'POST', { op: 'table', subOp: 'detect', rootSelector: '#chart', pageId: chartPageId })
check(chartDetect.outcome === 'NOT_FOUND' && chartDetect.chart?.lib === 'echarts' && chartDetect.reason?.code === 'TABLE_IS_CHART',
  `点在图表上：识别为图表（${chartDetect.chart?.lib ?? '-'}），引导改读接口`)
const listed = await req(`/browser-sessions/${sessionId}/observe`, 'POST', { op: 'network', subOp: 'reload', pageId: chartPageId })
const star = listed.entries.find((e) => e.best)
check(star?.url.endsWith('/grids/api/series') && !star.url.includes('?'), `重新加载并捕获：${listed.entries.length} 个接口，星标是 ${star?.method} ${star?.url}`)
const inspected = await req(`/browser-sessions/${sessionId}/observe`, 'POST', { op: 'network', subOp: 'inspect', entryId: star.id, pageId: chartPageId })
const best = inspected.suggestions[0]
check(best?.layout === 'columns' && best.columns.map((c) => c.name).join('、') === 'months、收入、支出',
  `看结构：建议按下标拼成行（${best?.columns.map((c) => c.name).join('、')}），结构树 ${inspected.nodes.length} 个节点`)
const netPlan = { protocol: 'table.network@1', match: { url: new URL(star.url).pathname, method: star.method }, layout: 'columns', columns: best.columns, window: { since: 'page_load', waitMs: 10_000 } }
const netRead = await req(`/browser-sessions/${sessionId}/observe`, 'POST', { op: 'network', subOp: 'read', entryId: star.id, plan: netPlan, pageId: chartPageId })
const seriesTruth = await (async () => {
  const login = await fetch(`${lab}/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=demo&password=demo123' })
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
  return (await fetch(`${lab}/grids/truth?view=series&${chartQuery}`, { headers: { cookie } })).json()
})()
const keys = best.columns.map((c) => c.key)
const netRows = (netRead.sample?.rows ?? []).map((r) => keys.map((k) => r[k]?.value))
check(JSON.stringify(netRows) === JSON.stringify(seriesTruth.rows.map((r) => [r.month, r.income, r.expense])), `按建议预览的 ${netRows.length} 行与真值一致`)
const incomeKey = best.columns.find((c) => c.name === '收入')?.key
const incomeSum = Math.round(seriesTruth.rows.reduce((n, r) => n + r.income, 0) * 100) / 100
const netScenario = await replaceScenario(req, targetId, '编写链路核对：图表接口', [
  { id: randomUUID(), name: '打开图表页', type: 'navigate', effectType: 'READ_ONLY', input: { url: `${lab}/grids/chart?${chartQuery}` } },
  { id: randomUUID(), name: '读取图表数据', type: 'extract', effectType: 'READ_ONLY', outputKey: 'rows', input: { as: 'table', source: 'network', table: netPlan } },
  { id: randomUUID(), name: '收入合计', type: 'check_context', effectType: 'READ_ONLY', input: { key: 'rows', expect: { kind: 'table', rule: { rule: 'column_stat', column: incomeKey, stat: 'sum', op: 'eq', value: incomeSum, ignoreEmpty: false } } } },
])
const netRun = await runUntilDone(netScenario.id)
const netOut = netRun.stepRuns?.find((x) => x.type === 'extract')?.attempts?.at(-1)?.output
check(netRun.status === 'SUCCEEDED' && (netOut?.value ?? netOut)?.source?.kind === 'network', `用建议的计划保存并试跑：${summary(netRun)}`)

// 7. 树形表格：受管画面打开 antd 树形页 → 识别出树形（默认按树形读）→ 预览的层级路径与真值一致 → 加“父行等于子行之和”保存试跑
const treeMeta = await navigateManaged(`${lab}/grids/tree?lib=antd`)
const treePageId = treeMeta.currentPage?.pageRef?.pageId
let treeDetected
for (let i = 0; i < 10 && !treeDetected; i++) {
  await sleep(800)
  const obs = await req(`/browser-sessions/${sessionId}/observe`, 'POST', { op: 'table', subOp: 'detect', rootSelector: '#grid', pageId: treePageId })
  if (obs.outcome === 'FOUND') treeDetected = obs.detected
}
check(treeDetected?.plan.layout?.mode === 'tree' && treeDetected.plan.layout.scope === 'all', `识别出树形表格，默认按树形读（${JSON.stringify(treeDetected?.plan.layout ?? null)}）`)
const treeTruth = await (async () => {
  const login = await fetch(`${lab}/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=demo&password=demo123' })
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
  return (await fetch(`${lab}/grids/truth?view=tree`, { headers: { cookie } })).json()
})()
const shown = treeDetected?.sample.rows.map((r) => r.tree_path?.value) ?? []
check(shown.length > 0 && JSON.stringify(shown) === JSON.stringify(treeTruth.rows.slice(0, shown.length).map((r) => r.path)) &&
  JSON.stringify(treeDetected.sample.rowMeta.map((m) => m.level)) === JSON.stringify(treeTruth.rows.slice(0, shown.length).map((r) => r.level)),
  `预览的 ${shown.length} 行层级与层级路径与真值一致（如“${shown[1] ?? ''}”）`)
const qtyCol = treeDetected.plan.columns.find((c) => c.name === '数量')?.key
const treeScenario = await replaceScenario(req, targetId, '编写链路核对：树形表格', [
  { id: randomUUID(), name: '打开树形表格', type: 'navigate', effectType: 'READ_ONLY', input: { url: `${lab}/grids/tree?lib=antd` } },
  { id: randomUUID(), name: '读取树形表格', type: 'extract', effectType: 'READ_ONLY', outputKey: 'rows', input: { target: treeDetected.plan.target, as: 'table', table: treeDetected.plan } },
  { id: randomUUID(), name: '父行等于子行之和', type: 'check_context', effectType: 'READ_ONLY', input: { key: 'rows', expect: { kind: 'table', rule: { rule: 'tree_rollup_match', column: qtyCol, precision: 'display' } } } },
])
const treeRun = await runUntilDone(treeScenario.id)
const treeOut = treeRun.stepRuns?.find((x) => x.type === 'extract')?.attempts?.at(-1)?.output
const treeSample = treeOut?.value ?? treeOut
check(treeRun.status === 'SUCCEEDED' && treeSample?.rowMeta?.length === treeTruth.rows.length, `用识别出的计划保存并试跑：${summary(treeRun)}，读到 ${treeSample?.rowMeta?.length ?? 0} 行带层级`)

// 8. 状态信号：受管画面打开 antd 状态页 → 按步骤条识别为“状态”且语义与真值一致 → 表格给出派生的语义 / 百分比列 → 保存试跑
const statusMeta = await navigateManaged(`${lab}/grids/status?lib=antd`)
const statusPageId = statusMeta.currentPage?.pageRef?.pageId
await sleep(1200)
const stepsObs = await req(`/browser-sessions/${sessionId}/observe`, 'POST', { op: 'table', subOp: 'detect', rootSelector: '#steps .ant-steps', pageId: statusPageId })
const statusTruth = await (async () => {
  const login = await fetch(`${lab}/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=demo&password=demo123' })
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
  return (await fetch(`${lab}/grids/truth?view=status&lib=antd`, { headers: { cookie } })).json()
})()
const stepRows = stepsObs.detected?.sample.rows ?? []
check(stepsObs.detected?.plan.kind === 'status' && JSON.stringify(stepRows.map((r) => [r.text?.value, r.tone?.value])) === JSON.stringify(statusTruth.steps.map((x) => [x.text, x.tone])),
  `步骤条识别为一组状态，语义与真值一致：${stepRows.map((r) => `${r.text?.value}=${r.tone?.value}`).join('、')}`)
const gridObs = await req(`/browser-sessions/${sessionId}/observe`, 'POST', { op: 'table', subOp: 'detect', rootSelector: '#status-grid', pageId: statusPageId })
const derived = (gridObs.detected?.columns ?? []).filter((c) => c.excludedReason === 'derived').map((c) => c.label)
check(derived.includes('「状态」的语义') && derived.includes('「进度」的百分比'), `表格给出派生列：${derived.join('、')}`)
const statusScenario = await replaceScenario(req, targetId, '编写链路核对：状态信号', [
  { id: randomUUID(), name: '打开状态页', type: 'navigate', effectType: 'READ_ONLY', input: { url: `${lab}/grids/status?lib=antd` } },
  { id: randomUUID(), name: '读取步骤条', type: 'extract', effectType: 'READ_ONLY', outputKey: 'steps', input: { target: stepsObs.detected.plan.target, as: 'table', table: stepsObs.detected.plan } },
  { id: randomUUID(), name: '没有错误步骤', type: 'check_context', effectType: 'READ_ONLY', input: { key: 'steps', expect: { kind: 'table', rule: { rule: 'all_rows', column: 'tone', predicate: { op: 'neq', value: 'error' }, allowEmpty: false } } } },
])
const statusRun = await runUntilDone(statusScenario.id)
check(statusRun.status === 'SUCCEEDED', `用识别出的计划保存并试跑：${summary(statusRun)}`)

// 9. 交叉表：受管画面打开原生交叉表页 → 识别给出交叉表建议（不自动改读法）→ 按交叉表读的预览与真值长表一致 → 加“合计格等于明细之和”保存试跑
const crossMeta = await navigateManaged(`${lab}/grids/crosstab`)
const crossPageId = crossMeta.currentPage?.pageRef?.pageId
await sleep(800)
const crossObs = await req(`/browser-sessions/${sessionId}/observe`, 'POST', { op: 'table', subOp: 'detect', rootSelector: '#cross', pageId: crossPageId })
check(crossObs.detected?.crosstabHint != null && crossObs.detected?.plan?.layout === undefined,
  `识别给出交叉表建议且不改默认读法（${JSON.stringify(crossObs.detected?.crosstabHint ?? null)}）`)
const crossTruth = await (async () => {
  const login = await fetch(`${lab}/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=demo&password=demo123' })
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
  return (await fetch(`${lab}/grids/truth?view=crosstab`, { headers: { cookie } })).json()
})()
// 与编辑器「按交叉表读」同一逻辑：行维度取识别出的前两列，列头两层命名（指标 / 月份）
const crossPlan = {
  ...crossObs.detected.plan,
  columns: crossObs.detected.plan.columns.slice(0, 2),
  layout: { mode: 'crosstab', columnDims: ['指标', '月份'] },
}
const crossPreview = await req(`/browser-sessions/${sessionId}/observe`, 'POST', { op: 'table', subOp: 'sample', plan: crossPlan, pageId: crossPageId })
const crossRows = crossPreview.sample?.rows ?? []
check(crossRows.length === crossTruth.rows.length &&
  JSON.stringify(crossRows.map((r) => [r.col_1?.value, r.col_2?.value, r.dim_1?.value, r.dim_2?.value, r.value?.decimalValue ?? null])) ===
  JSON.stringify(crossTruth.rows.map((r) => [r.region, r.city, r.kind, r.month, r.value === null ? null : r.value.toFixed(1)])),
  `交叉表预览逆透视成 ${crossRows.length} 行长表，与真值逐行一致`)
check((crossPreview.sample?.crosstab?.totals ?? []).length === 25 && crossPreview.sample?.summaryRows === undefined,
  `合计行 / 列分离成 ${crossPreview.sample?.crosstab?.totals?.length ?? 0} 个合计格，不占数据行`)
const crossScenario = await replaceScenario(req, targetId, '编写链路核对：交叉表', [
  { id: randomUUID(), name: '打开交叉表', type: 'navigate', effectType: 'READ_ONLY', input: { url: `${lab}/grids/crosstab` } },
  { id: randomUUID(), name: '读取交叉表', type: 'extract', effectType: 'READ_ONLY', outputKey: 'rows', input: { target: crossPlan.target, as: 'table', table: crossPlan } },
  { id: randomUUID(), name: '合计格等于明细之和', type: 'check_context', effectType: 'READ_ONLY', input: { key: 'rows', expect: { kind: 'table', rule: { rule: 'crosstab_total_match', precision: 'display' } } } },
])
const crossRun = await runUntilDone(crossScenario.id)
check(crossRun.status === 'SUCCEEDED', `用交叉表计划保存并试跑：${summary(crossRun)}`)

if (failed) {
  console.error(`\n${failed} 项不符`)
  process.exitCode = 1
} else {
  console.log('\n编写链路核对通过')
}
