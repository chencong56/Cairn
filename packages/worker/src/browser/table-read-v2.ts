import { randomUUID } from 'node:crypto'
import {
  canonicalJson,
  syncSha256,
  tableReadPlanV2Schema,
  TABLE_READ_PROTOCOL_V2,
  TABLE_READ_MAX_COLS,
  TABLE_READ_DEFAULT_SELECTED_COLS,
  TABLE_DETECT_MAX_COLS,
  TABLE_TREE_PATH_KEY,
  TABLE_CROSSTAB_DIM_PREFIX,
  TABLE_CROSSTAB_TOTALS_MAX_BYTES,
  TABLE_CROSSTAB_VALUE_KEY,
  crosstabDimText,
  tablePlanCheckColumns,
  validateCrosstabPlan,
  type JsonValue,
  type TableCrosstabLayout,
  type TableReadPlanV2,
  type TableRowField,
  type TableSample,
  type TargetDescriptor,
  type TargetObservation,
} from '@cairn/shared'
import { makeValueParsers } from '@cairn/table-file'
import type { ElementHandle, Locator, Page } from 'playwright'
import {
  tableDomEntry,
  type TableDomRequest,
  type DetectCandidate,
  type DetectedColumn,
  type DetectResult,
  type DomRow,
  type ReadTableArgs,
  type ReadTableResult,
  type TableShape,
} from './table-read-dom.js'
import { TOTAL_HEADER_RE } from './table-adapters/helpers.js'
import { delay, TableObserveError, type TableSampleSourceMeta } from './table-observe.js'

const DEFAULT_SAMPLE_TIMEOUT_MS = 10_000
const LOCATE_TIMEOUT_MS = 5_000
const STABILITY_INTERVAL_MS = 400
const MAX_STABILITY_ROUNDS = 3
export const TABLE_PREVIEW_ROWS = 20

type LocateOk = { kind: 'found'; locator: Locator }
type LocateFail = { kind: 'miss'; outcome: string }

export type LocateFn = (
  page: Page,
  target: TargetDescriptor,
  timeoutMs?: number,
  signal?: AbortSignal,
) => Promise<LocateOk | LocateFail>

export type SampleV2Options = {
  locate: LocateFn
  meta?: TableSampleSourceMeta
  signal?: AbortSignal
  timeoutMs?: number
}

function argsOf(plan: TableReadPlanV2): ReadTableArgs {
  return {
    ...(plan.kind && plan.kind !== 'table' ? { kind: plan.kind } : {}),
    columns: plan.columns.slice(0, plan.limits.maxCols).map((c) => ({
      key: c.key,
      name: c.name,
      field: c.field,
      source: c.source,
      index: c.index,
      selector: c.selector,
      valueType: c.valueType,
      sensitive: c.sensitive,
      scaleUnits: c.scaleUnits,
      read: c.read,
    })),
    rowSelector: plan.rows.selector,
    header: plan.rows.header,
    excludeHeader: plan.rows.excludeHeader,
    maxRows: plan.limits.maxRows,
    emptySelector: plan.readiness?.emptySelector,
    loadingSelector: plan.readiness?.loadingSelector,
    emptyMeansNone: plan.readiness?.emptyMeansNone,
    totalRow: plan.rows.totalRow,
    ...(plan.layout?.mode === 'tree' ? { tree: { scope: plan.layout.scope } } : {}),
    ...(plan.layout?.mode === 'crosstab' ? { crosstab: true } : {}),
  }
}

async function readOnce(
  page: Page,
  plan: TableReadPlanV2,
  options: SampleV2Options,
): Promise<Extract<ReadTableResult, { ok: true }>> {
  const located = await options.locate(page, plan.target, LOCATE_TIMEOUT_MS, options.signal)
  if (located.kind === 'miss') {
    if (located.outcome === 'AMBIGUOUS') {
      throw new TableObserveError('TABLE_AMBIGUOUS', '表格定位命中了多个位置，请换一张表或重新点选')
    }
    throw new TableObserveError('TABLE_NOT_FOUND', '页面上找不到这张表格，请确认当前页面，或重新点选')
  }
  let result: ReadTableResult
  try {
    const request: TableDomRequest = { mode: 'read', read: argsOf(plan) }
    result = await located.locator.evaluate(tableDomEntry, request)
  } catch {
    throw new TableObserveError('TABLE_NOT_FOUND', '读取表格时页面发生了变化，请重试')
  }
  if (!result.ok) throw new TableObserveError(result.code as TableObserveError['code'], result.message)
  return result
}

function sameSnapshot(
  a: Extract<ReadTableResult, { ok: true }>,
  b: Extract<ReadTableResult, { ok: true }>,
): boolean {
  if (a.isBusy !== b.isBusy || a.hasPagination !== b.hasPagination || a.emptyVerified !== b.emptyVerified) return false
  if (a.headerDigest !== b.headerDigest || a.totalDataRows !== b.totalDataRows || a.rows.length !== b.rows.length) return false
  if (JSON.stringify(a.pageInfo ?? null) !== JSON.stringify(b.pageInfo ?? null)) return false
  if (a.treeCollapsed !== b.treeCollapsed) return false
  return a.rows.every((row, i) => row.rawDigest === b.rows[i]!.rawDigest)
}

function toRecord(row: DomRow): Record<string, TableRowField> {
  const out: Record<string, TableRowField> = {}
  for (const [key, field] of Object.entries(row.values)) {
    out[key] = {
      value: field.value as JsonValue,
      ...(field.rawText !== undefined ? { rawText: field.rawText } : {}),
      ...(field.decimalValue !== undefined ? { decimalValue: field.decimalValue } : {}),
      status: field.status,
    }
  }
  return out
}

type CrosstabMatrix = NonNullable<Extract<ReadTableResult, { ok: true }>['crosstab']>
type CrosstabTotal = NonNullable<TableSample['crosstab']>['totals'][number]

/**
 * 交叉表逆透视（Node 侧，与控件无关）：页面核心交回整行文字矩阵与数值列表头路径，
 * 这里把每个明细格变成长表一行（行维度 + 每层列维度 + 数值），表头或行头是“合计 / 小计”的格
 * 单独收集成 totals（rowLevel / colLevel 说明它汇总到第几层维度，供 crosstab_total_match 核对）。
 */
function unpivotCrosstab(
  plan: TableReadPlanV2,
  layout: TableCrosstabLayout,
  cross: CrosstabMatrix,
  snapshot: Extract<ReadTableResult, { ok: true }>,
): { rows: Record<string, TableRowField>[]; dimKeys: string[]; totals: CrosstabTotal[]; totalsTruncated: boolean; sourceColumns: number } {
  const n = layout.columnDims.length
  const dimKeys = Array.from({ length: n }, (_, i) => `${TABLE_CROSSTAB_DIM_PREFIX}${i + 1}`)
  const parsers = makeValueParsers()
  const valueSpec = { key: TABLE_CROSSTAB_VALUE_KEY, valueType: 'number' as const, ...(layout.value.scaleUnits ? { scaleUnits: true } : {}) }
  const valueField = (raw: string | undefined): TableRowField => {
    const { field } = parsers.fieldFromText(valueSpec, raw ?? '')
    return {
      value: field.value,
      ...(field.rawText !== undefined ? { rawText: field.rawText } : {}),
      ...(field.decimalValue !== undefined ? { decimalValue: field.decimalValue } : {}),
      status: field.status,
    }
  }
  const text = (v: string | null): TableRowField => (v === null ? { value: null, status: 'missing' } : { value: v, status: 'ok' })

  // 表头路径 → 每层列维度的文字：比声明的层数深时并入最后一层，浅时缺的层为空
  const partsOf = (path: string): string[] => (path ? path.split(' / ') : [])
  const colParts = cross.colPaths.map(partsOf)
  const dimAt = (parts: string[], i: number): string | null => {
    if (i >= n) return null
    const v = i < n - 1 ? parts[i] : parts.slice(n - 1).join(' / ')
    return v ? v : null
  }
  const colDimsOf = (j: number): Array<string | null> => Array.from({ length: n }, (_, i) => dimAt(colParts[j] ?? [], i))
  // 表头从“合计 / 小计”那一层起是汇总列：colLevel ＝ 它汇总到第几层列维度（0＝总计）
  const colTotalAt = cross.colPaths.map((p) => {
    const at = partsOf(p).findIndex((seg) => TOTAL_HEADER_RE.test(seg.trim()))
    return at < 0 ? -1 : Math.min(at, n)
  })

  // 明细格 → 长表行（只取非汇总列）
  const rows: Record<string, TableRowField>[] = []
  snapshot.rows.forEach((domRow, i) => {
    const dims = toRecord(domRow)
    const cells = cross.matrix[i] ?? []
    cross.colPaths.forEach((_, j) => {
      if (colTotalAt[j] !== -1) return
      const record = { ...dims }
      dimKeys.forEach((key, d) => {
        record[key] = text(dimAt(colParts[j] ?? [], d))
      })
      record[TABLE_CROSSTAB_VALUE_KEY] = valueField(cells[j])
      rows.push(record)
    })
  })

  // 合计行 / 列的格 → totals；行维度文字在前、列维度在后。超出内联上限只保留前面的，判“无法确认”
  const totals: CrosstabTotal[] = []
  let totalsBytes = 0
  let totalsTruncated = false
  const pushTotal = (total: CrosstabTotal): void => {
    if (totalsTruncated) return
    const size = JSON.stringify(total).length
    if (totalsBytes + size > TABLE_CROSSTAB_TOTALS_MAX_BYTES) {
      totalsTruncated = true
      return
    }
    totalsBytes += size
    totals.push(total)
  }
  const rowDimTexts = (record: Record<string, TableRowField>): Array<string | null> =>
    plan.columns.map((c) => crosstabDimText(record[c.key]))
  // 合计行：行头“合计 / 小计”在第几列，就汇总到第几层行维度（如“华东 / 小计”汇总到第 1 层）
  const rowLevelOf = (dims: Array<string | null>): number => {
    const at = dims.findIndex((x) => x !== null && TOTAL_HEADER_RE.test(x))
    return at >= 0 ? at : 0
  }
  snapshot.summaryRows.forEach((domRow, s) => {
    if (totalsTruncated) return
    const texts = rowDimTexts(toRecord(domRow))
    const rowLevel = rowLevelOf(texts)
    const cells = cross.summaryMatrix[s] ?? []
    cross.colPaths.forEach((_, j) => {
      if (totalsTruncated) return
      pushTotal({
        rowLevel,
        colLevel: colTotalAt[j] === -1 ? n : colTotalAt[j]!,
        dims: [...texts, ...colDimsOf(j)],
        value: valueField(cells[j]),
      })
    })
  })
  // 合计列：每个数据行与汇总列的交点（这一行的所有列维度都定了，只按列汇总）
  snapshot.rows.forEach((domRow, i) => {
    if (totalsTruncated) return
    const texts = rowDimTexts(toRecord(domRow))
    const cells = cross.matrix[i] ?? []
    colTotalAt.forEach((at, j) => {
      if (totalsTruncated || at === -1) return
      pushTotal({ rowLevel: texts.length, colLevel: at, dims: [...texts, ...colDimsOf(j)], value: valueField(cells[j]) })
    })
  })

  return { rows, dimKeys, totals, totalsTruncated, sourceColumns: colTotalAt.filter((at) => at === -1).length }
}

/** table.read@2 采样：定位表根 → 页面内读取 → 两次一致才算稳定；覆盖度诚实。 */
export async function sampleTableV2(
  page: Page,
  plan: TableReadPlanV2,
  options: SampleV2Options,
): Promise<TableSample> {
  const signal = options.signal
  const timeoutMs = options.timeoutMs ?? plan.readiness?.timeoutMs ?? DEFAULT_SAMPLE_TIMEOUT_MS
  const startedAt = Date.now()
  const planDigest = syncSha256(canonicalJson(plan))
  const crossLayout = plan.layout?.mode === 'crosstab' ? plan.layout : undefined
  if (crossLayout) {
    const check = validateCrosstabPlan(plan)
    if (!check.valid) throw new TableObserveError('TABLE_PLAN_INVALID', check.message)
  }

  let last: Extract<ReadTableResult, { ok: true }> | null = null
  let stable: Extract<ReadTableResult, { ok: true }> | null = null
  let everReady = false
  for (let round = 0; round < MAX_STABILITY_ROUNDS; round++) {
    signal?.throwIfAborted()
    if (Date.now() - startedAt >= timeoutMs) break
    const first = await readOnce(page, plan, options)
    if (first.isBusy) {
      await delay(STABILITY_INTERVAL_MS, signal)
      continue
    }
    everReady = true
    await delay(STABILITY_INTERVAL_MS, signal)
    const second = await readOnce(page, plan, options)
    if (sameSnapshot(first, second)) {
      stable = second
      break
    }
    last = second
  }
  const finalSnapshot = stable ?? last ?? (await readOnce(page, plan, options))
  if (crossLayout && !finalSnapshot.crosstab) {
    throw new TableObserveError('TABLE_PLAN_INVALID', '这次读取没有返回交叉表矩阵，无法按交叉表读')
  }

  // 体积预算：从前往后累计，超出即截断
  const budget = plan.limits.maxBytes
  const tree = plan.layout?.mode === 'tree'
  const rows: Record<string, TableRowField>[] = []
  const rowMeta: NonNullable<TableSample['rowMeta']> = []
  let bytes = 0
  let budgetHit = false
  // 交叉表：先在 Node 侧逆透视（长表行 + 合计格），再按预算截断
  const crosstab = crossLayout && finalSnapshot.crosstab
    ? unpivotCrosstab(plan, crossLayout, finalSnapshot.crosstab, finalSnapshot)
    : undefined
  if (crosstab) {
    for (const record of crosstab.rows) {
      const size = JSON.stringify(record).length
      if (bytes + size > budget) {
        budgetHit = true
        break
      }
      bytes += size
      rows.push(record)
    }
  } else {
    for (const domRow of finalSnapshot.rows) {
      const record = toRecord(domRow)
      // 树形：加“层级路径”一列，并记下这一行的层级（与 rows 一一对应）
      if (tree && domRow.tree) record[TABLE_TREE_PATH_KEY] = domRow.tree.path ? { value: domRow.tree.path, status: 'ok' } : { value: null, status: 'missing' }
      const size = JSON.stringify(record).length
      if (bytes + size > budget) {
        budgetHit = true
        break
      }
      bytes += size
      rows.push(record)
      if (tree && domRow.tree) {
        const { path: _path, ...meta } = domRow.tree
        rowMeta.push(meta)
      }
    }
  }
  // 交叉表的合计格在 crosstab.totals 里表达，不占 summaryRows
  const summaryRows = crossLayout ? [] : finalSnapshot.summaryRows.map(toRecord)

  const maxRows = plan.limits.maxRows
  const rowLimitHit = finalSnapshot.totalDataRows > maxRows
  const clues: string[] = []
  if (finalSnapshot.hasPagination) clues.push('pagination_present')
  if (finalSnapshot.pageInfo?.ambiguous) clues.push('page_info_ambiguous')
  // 分页信息：只保留读到的字段；ambiguous 只作线索，不进记录集
  const { ambiguous: _ambiguous, ...pageInfoFields } = finalSnapshot.pageInfo ?? { rawText: '' }
  const pageInfo =
    finalSnapshot.pageInfo &&
    (pageInfoFields.totalRows !== undefined ||
      pageInfoFields.currentPage !== undefined ||
      pageInfoFields.pageSize !== undefined ||
      pageInfoFields.totalPages !== undefined ||
      pageInfoFields.rowRange !== undefined)
      ? pageInfoFields
      : undefined

  let status: 'complete' | 'partial' | 'unknown'
  let reasonCode: string | undefined
  let reasonMessage: string | undefined
  if (!stable) {
    status = 'unknown'
    if (!everReady) {
      reasonCode = 'TABLE_READINESS_TIMEOUT'
      reasonMessage = '表格一直处于加载中，不能确认数据已经加载完'
    } else {
      reasonCode = 'TABLE_MUTATING_UNSTABLE'
      reasonMessage = '读取期间表格内容一直在变化，没有取得连续两次一致的结果'
    }
  } else if (finalSnapshot.virtualScroll) {
    status = 'partial'
    reasonCode = 'TABLE_VIRTUAL_SCROLL'
    reasonMessage = '这张表只渲染了屏幕上看得到的行（虚拟滚动），无法确认已经读全'
  } else if (budgetHit) {
    status = 'partial'
    reasonCode = 'TABLE_OUTPUT_BUDGET'
    reasonMessage = crosstab
      ? `逆透视后的长表数据量超出单步输出上限，只保留了前 ${rows.length} 行`
      : `数据量超出单步输出上限，只保留了前 ${rows.length} 行，请减少列数或勾选更少的列`
  } else if (rowLimitHit) {
    status = 'partial'
    reasonCode = 'TABLE_ROW_LIMIT_TRUNCATED'
    reasonMessage = crosstab
      ? `交叉表的数据行数（逆透视前）超过读取上限 ${maxRows}，只读取了前 ${finalSnapshot.rows.length} 行`
      : `数据行数超过读取上限 ${maxRows}，只读取了前 ${rows.length} 行`
  } else if (plan.layout?.mode === 'tree' && plan.layout.scope !== 'top' && (finalSnapshot.treeCollapsed ?? 0) > 0) {
    status = 'partial'
    reasonCode = 'TABLE_TREE_COLLAPSED'
    reasonMessage = `有 ${finalSnapshot.treeCollapsed} 个节点没展开，读不全。要读全，请在本步前加点击展开的步骤`
  } else if (rows.length === 0 && !finalSnapshot.emptyVerified) {
    status = 'unknown'
    reasonCode = 'TABLE_EMPTY_UNVERIFIED'
    reasonMessage = '现在没有数据，但页面上没有“暂无数据”之类的提示，不能确认这张表确实是空的'
  } else {
    status = 'complete'
  }

  return {
    protocol: 'table.sample@1',
    // 步骤输出要过 JSON 校验：值为 undefined 的键必须省略，不能留空键
    source: {
      runId: options.meta?.runId ?? randomUUID(),
      ...(options.meta?.stepRunId ? { stepRunId: options.meta.stepRunId } : {}),
      ...(options.meta?.attemptId ? { attemptId: options.meta.attemptId } : {}),
      ...(options.meta?.pageRef ? { pageRef: options.meta.pageRef } : {}),
      sampledAt: new Date().toISOString(),
      planDigest,
    },
    columns: tree || crossLayout ? tablePlanCheckColumns(plan) : plan.columns,
    rows,
    rowCount: rows.length,
    ...(tree && rowMeta.length === rows.length ? { rowMeta } : {}),
    ...(crosstab
      ? {
          crosstab: {
            rowDims: plan.columns.map((c) => c.key),
            colDims: crosstab.dimKeys,
            valueKey: TABLE_CROSSTAB_VALUE_KEY,
            sourceRows: finalSnapshot.rows.length,
            sourceColumns: crosstab.sourceColumns,
            totals: crosstab.totals,
            ...(crosstab.totalsTruncated ? { totalsTruncated: true } : {}),
          },
        }
      : {}),
    coverage: {
      requestedScope: 'current_page',
      observedScope: 'current_page',
      status,
      ...(reasonCode ? { reasonCode, reasonMessage } : {}),
      ...(clues.length > 0 ? { clues } : {}),
    },
    excluded: finalSnapshot.excluded,
    ...(summaryRows.length > 0 ? { summaryRows } : {}),
    ...(pageInfo ? { pageInfo } : {}),
    presentation: { omitted: false, previewCount: Math.min(TABLE_PREVIEW_ROWS, rows.length) },
  }
}

// ---------------------------------------------------------------------------
// 识别：从点击位置找出整张表并给出建议计划
// ---------------------------------------------------------------------------

export type DetectDeps = {
  locate: LocateFn
  pick: (page: Page, x: number, y: number) => Promise<TargetObservation>
}

export type DetectedTable = {
  shape: TableShape
  plan: TableReadPlanV2
  sample: TableSample
  title?: string
  selectorQuality: 'stable' | 'positional'
  rowCount: number
  colCount: number
  columns: Array<{
    key: string
    name: string
    groupPath?: string
    excludedReason?: DetectedColumn['excludedReason']
    indexOnly?: boolean
    valueType: DetectedColumn['valueType']
    numericKind?: DetectedColumn['numericKind']
    source: DetectedColumn['source']
    index: number
    read?: DetectedColumn['read']
    label?: string
  }>
  alternatives: Array<Pick<DetectCandidate, 'selector' | 'level' | 'title' | 'rowCount' | 'colCount' | 'selectorQuality'>>
  /** 像交叉表（多级列头且多为数字列）时的建议：前几列是行维度、列头有几层；读法切换由用户确认。 */
  crosstabHint?: { rowDims: number; depth: number }
  notes: string[]
}

export type ChartLib = 'echarts' | 'chartjs' | 'highcharts' | 'other'

export type DetectOutcome =
  | { outcome: 'FOUND'; detected: DetectedTable }
  | { outcome: 'NOT_FOUND'; reason: { code: string; message: string; feedback?: string }; chart?: { lib: ChartLib } }

/** 点到的是不是图表：图表的数字画在 canvas / SVG 里，不在页面文字上。只认明确的图表库标记，不按“有 canvas”猜。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function chartLibOf(node: any): ChartLib | null {
  const el = node && node.nodeType === 1 ? node : node?.parentElement
  if (!el) return null
  if (el.closest('[_echarts_instance_]')) return 'echarts'
  if (el.closest('.highcharts-container, .highcharts-root')) return 'highcharts'
  const canvas = el.tagName === 'CANVAS' ? el : el.querySelector(':scope > canvas')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chartJs = (globalThis as any).Chart
  if (canvas && typeof chartJs?.getChart === 'function' && chartJs.getChart(canvas)) return 'chartjs'
  return null
}

const CHART_MESSAGE = '这是一个图表，图表里的数字不在页面上，没法在页面上读；可以改为读取它背后接口返回的数据'

export type DetectInput =
  | { kind: 'point'; x: number; y: number }
  | { kind: 'root'; selector: string; framePath: TargetDescriptor['framePath'] }

async function elementAtPoint(page: Page, x: number, y: number): Promise<ElementHandle | null> {
  let frame = page.mainFrame()
  let px = x
  let py = y
  for (let depth = 0; depth < 8; depth++) {
    const handle = (await frame.evaluateHandle(
      ({ x: ex, y: ey }) => (globalThis as unknown as { document: { elementFromPoint: (a: number, b: number) => unknown } }).document.elementFromPoint(ex, ey),
      { x: px, y: py },
    )).asElement()
    if (!handle) return null
    const tag = await handle.evaluate((el) => String((el as { tagName?: string }).tagName || '').toUpperCase())
    if (tag !== 'IFRAME' && tag !== 'FRAME') return handle
    const child = await handle.contentFrame()
    if (!child) return handle
    const rect = await handle.evaluate((el) => {
      const r = (el as unknown as { getBoundingClientRect: () => { left: number; top: number } }).getBoundingClientRect()
      return { left: r.left, top: r.top }
    })
    px -= rect.left
    py -= rect.top
    frame = child
  }
  return null
}

/** 识别的总时限：页面太大或浏览器太忙时放弃，给出人话说明，不让请求拖到网关超时（30s）。 */
export const TABLE_DETECT_TIMEOUT_MS = 20_000

export async function detectTable(
  page: Page,
  input: DetectInput,
  deps: DetectDeps,
  meta?: TableSampleSourceMeta,
  timeoutMs: number = TABLE_DETECT_TIMEOUT_MS,
): Promise<DetectOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<DetectOutcome>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          outcome: 'NOT_FOUND',
          reason: {
            code: 'TABLE_DETECT_TIMEOUT',
            message: `识别用了超过 ${Math.round(timeoutMs / 1000)} 秒，已放弃：页面太大或浏览器正忙。可以点“范围小一点”，或稍后再点一次`,
          },
        }),
      timeoutMs,
    )
  })
  try {
    return await Promise.race([detectTableInner(page, input, deps, meta), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function detectTableInner(
  page: Page,
  input: DetectInput,
  deps: DetectDeps,
  meta?: TableSampleSourceMeta,
): Promise<DetectOutcome> {
  let framePath: TargetDescriptor['framePath'] = []
  let handle: ElementHandle | null = null
  let forceRoot = false
  if (input.kind === 'point') {
    handle = await elementAtPoint(page, input.x, input.y)
    if (!handle) {
      return { outcome: 'NOT_FOUND', reason: { code: 'TABLE_SHAPE_UNSUPPORTED', message: '点到的位置没有页面内容，请换个位置再点' } }
    }
    const picked = await deps.pick(page, input.x, input.y).catch(() => null)
    framePath = picked?.target?.framePath ?? []
  } else {
    framePath = input.framePath
    forceRoot = true
    const located = await deps.locate(page, { framePath, candidates: [{ by: 'css', value: input.selector }] }, LOCATE_TIMEOUT_MS)
    if (located.kind === 'miss') {
      return { outcome: 'NOT_FOUND', reason: { code: 'TABLE_NOT_FOUND', message: '找不到你选的这张表，请重新点选' } }
    }
    handle = await located.locator.elementHandle()
  }
  if (!handle) {
    return { outcome: 'NOT_FOUND', reason: { code: 'TABLE_NOT_FOUND', message: '找不到你选的这张表，请重新点选' } }
  }
  const chart = await handle.evaluate(chartLibOf).catch(() => null)
  if (chart) return { outcome: 'NOT_FOUND', reason: { code: 'TABLE_IS_CHART', message: CHART_MESSAGE }, chart: { lib: chart } }
  const detectRequest: TableDomRequest = { mode: 'detect', detect: { sampleRows: 5, forceRoot } }
  const detected: DetectResult = await handle.evaluate(tableDomEntry, detectRequest)
  if (!detected.ok) {
    const feedbackResult = (await handle.evaluate(tableDomEntry, { mode: 'feedback' } as TableDomRequest).catch(() => undefined)) as { feedback?: string } | undefined
    const feedback = feedbackResult?.feedback
    return { outcome: 'NOT_FOUND', reason: { code: detected.code, message: detected.message, ...(feedback ? { feedback } : {}) } }
  }
  const chosen = detected.chosen
  const kept = chosen.columns.filter((c) => !c.excludedReason)
  if (kept.length === 0) {
    return { outcome: 'NOT_FOUND', reason: { code: 'TABLE_SHAPE_UNSUPPORTED', message: '这张表里没有可读取的数据列' } }
  }
  const plan = tableReadPlanV2Schema.parse({
    protocol: TABLE_READ_PROTOCOL_V2,
    target: {
      framePath,
      candidates: [{ by: 'css', value: chosen.selector }],
      ...(chosen.title ? { semantic: chosen.title } : {}),
    },
    scope: 'current_page',
    ...(chosen.shape === 'cards' || chosen.shape === 'keyvalue' || chosen.shape === 'status' ? { kind: chosen.shape } : {}),
    // 认出控件声明的层级：默认按树形读（没展开的节点会如实报“读不全”，按普通读会把它当成读全了）
    ...(chosen.tree ? { layout: { mode: 'tree', scope: 'all' } } : {}),
    rows: { excludeHeader: true, header: chosen.headerMode },
    columns: kept.slice(0, TABLE_READ_DEFAULT_SELECTED_COLS).map((c) => ({
      key: c.key,
      name: c.name,
      ...(c.field ? { field: c.field } : {}),
      ...(c.source === 'index' ? { source: 'index', index: c.index } : {}),
      valueType: c.valueType,
      ...(c.valueType === 'number' ? { numericKind: c.numericKind ?? 'decimal' } : {}),
      ...(c.read ? { read: c.read } : {}),
      ...(c.label ? { label: c.label } : {}),
    })),
    readiness: { waitVisible: true, timeoutMs: 10_000 },
  })

  const notes: string[] = []
  for (const c of chosen.columns) {
    if (c.excludedReason === 'checkbox') notes.push(`已自动排除第 ${c.index + 1} 列（复选框）`)
    else if (c.excludedReason === 'index') notes.push(`已自动排除「${c.name}」列（序号）`)
    else if (c.excludedReason === 'action') notes.push(`已自动排除「${c.name}」列（操作按钮）`)
    else if (c.excludedReason === 'hidden') notes.push(`已自动排除「${c.name}」列（页面上隐藏）`)
  }
  if (kept.length > TABLE_READ_DEFAULT_SELECTED_COLS) {
    notes.push(`这张表有 ${kept.length} 列，默认只勾选前 ${TABLE_READ_DEFAULT_SELECTED_COLS} 列；需要后面的列，在下面的列表里勾选即可（一次最多读 ${TABLE_READ_MAX_COLS} 列）`)
  }
  if (chosen.shape === 'status') {
    notes.push('认成一组状态：每个标签 / 徽标 / 进度 / 步骤 / 告警一行，读文字、语义（成功 / 警告 / 错误 …）、进度与序号；语义只按组件库的官方样式认，认不出记为“未识别”')
  }
  const derived = chosen.columns.filter((c) => c.excludedReason === 'derived').map((c) => c.label ?? c.name)
  if (derived.length > 0) notes.push(`有状态标签 / 进度的列可以加读 ${derived.join('、')}（默认不勾，需要时在下面勾选）`)
  if (chosen.tree) notes.push('这是树形表格：按层级读，每行记下层级与“层级路径”（如“华东 / 上海”）；没展开的节点会报读不全')
  if (!chosen.hasHeader) notes.push('这张表没有表头，列名是自动起的，按第几列读取')
  if (chosen.shape === 'listgrid') notes.push('这是用列表（ul/li）搭出来的表格：第一行列表作表头，后面每个 li 是一行，每个子元素是一格')
  if (chosen.shape === 'cards') notes.push('按“名称：值”从每张卡片里取字段，卡片里没有的字段会显示为空')
  if (chosen.selectorQuality === 'positional') {
    notes.push('这张表没有稳定的标识，页面结构变化后可能需要重新点选')
  }

  let sample: TableSample
  try {
    sample = await sampleTableV2(page, plan, { locate: deps.locate, meta })
  } catch (error) {
    if (error instanceof TableObserveError) {
      return { outcome: 'NOT_FOUND', reason: { code: error.code, message: error.message } }
    }
    throw error
  }
  // 预览只带前若干行，避免响应过大
  const previewSample: TableSample = {
    ...sample,
    rows: sample.rows.slice(0, TABLE_PREVIEW_ROWS),
    ...(sample.rowMeta ? { rowMeta: sample.rowMeta.slice(0, TABLE_PREVIEW_ROWS) } : {}),
    presentation: { omitted: sample.rows.length > TABLE_PREVIEW_ROWS, previewCount: Math.min(TABLE_PREVIEW_ROWS, sample.rows.length) },
  }

  return {
    outcome: 'FOUND',
    detected: {
      shape: chosen.shape,
      plan,
      sample: previewSample,
      ...(chosen.title ? { title: chosen.title } : {}),
      selectorQuality: chosen.selectorQuality,
      rowCount: chosen.rowCount,
      colCount: chosen.colCount,
      columns: chosen.columns.slice(0, TABLE_DETECT_MAX_COLS).map((c) => ({
        key: c.key,
        name: c.name,
        ...(c.groupPath ? { groupPath: c.groupPath } : {}),
        ...(c.excludedReason ? { excludedReason: c.excludedReason } : {}),
        ...(c.indexOnly ? { indexOnly: true } : {}),
        valueType: c.valueType,
        ...(c.numericKind ? { numericKind: c.numericKind } : {}),
        source: c.source,
        index: c.index,
        ...(c.read ? { read: c.read } : {}),
        ...(c.label ? { label: c.label } : {}),
      })),
      alternatives: detected.alternatives.map((a) => ({
        selector: a.selector,
        level: a.level,
        ...(a.title ? { title: a.title } : {}),
        rowCount: a.rowCount,
        colCount: a.colCount,
        selectorQuality: a.selectorQuality,
      })),
      ...(chosen.crosstabHint ? { crosstabHint: chosen.crosstabHint } : {}),
      notes,
    },
  }
}
