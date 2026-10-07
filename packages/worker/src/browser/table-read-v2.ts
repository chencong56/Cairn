import { randomUUID } from 'node:crypto'
import {
  canonicalJson,
  syncSha256,
  tableReadPlanV2Schema,
  TABLE_READ_PROTOCOL_V2,
  type JsonValue,
  type TableReadPlanV2,
  type TableRowField,
  type TableSample,
  type TargetDescriptor,
  type TargetObservation,
} from '@cairn/shared'
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
    })),
    rowSelector: plan.rows.selector,
    header: plan.rows.header,
    excludeHeader: plan.rows.excludeHeader,
    maxRows: plan.limits.maxRows,
    emptySelector: plan.readiness?.emptySelector,
    loadingSelector: plan.readiness?.loadingSelector,
    emptyMeansNone: plan.readiness?.emptyMeansNone,
    totalRow: plan.rows.totalRow,
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

  // 体积预算：从前往后累计，超出即截断
  const budget = plan.limits.maxBytes
  const rows: Record<string, TableRowField>[] = []
  let bytes = 0
  let budgetHit = false
  for (const domRow of finalSnapshot.rows) {
    const record = toRecord(domRow)
    const size = JSON.stringify(record).length
    if (bytes + size > budget) {
      budgetHit = true
      break
    }
    bytes += size
    rows.push(record)
  }
  const summaryRows = finalSnapshot.summaryRows.map(toRecord)

  const maxRows = plan.limits.maxRows
  const rowLimitHit = finalSnapshot.totalDataRows > maxRows
  const clues: string[] = []
  if (finalSnapshot.hasPagination) clues.push('pagination_present')

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
    reasonMessage = `数据量超出单步输出上限，只保留了前 ${rows.length} 行，请减少列数或勾选更少的列`
  } else if (rowLimitHit) {
    status = 'partial'
    reasonCode = 'TABLE_ROW_LIMIT_TRUNCATED'
    reasonMessage = `数据行数超过读取上限 ${maxRows}，只读取了前 ${rows.length} 行`
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
    columns: plan.columns,
    rows,
    rowCount: rows.length,
    coverage: {
      requestedScope: 'current_page',
      observedScope: 'current_page',
      status,
      ...(reasonCode ? { reasonCode, reasonMessage } : {}),
      ...(clues.length > 0 ? { clues } : {}),
    },
    excluded: finalSnapshot.excluded,
    ...(summaryRows.length > 0 ? { summaryRows } : {}),
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
  }>
  alternatives: Array<Pick<DetectCandidate, 'selector' | 'level' | 'title' | 'rowCount' | 'colCount' | 'selectorQuality'>>
  notes: string[]
}

export type DetectOutcome =
  | { outcome: 'FOUND'; detected: DetectedTable }
  | { outcome: 'NOT_FOUND'; reason: { code: string; message: string; feedback?: string } }

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

export async function detectTable(
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
    ...(chosen.shape === 'cards' || chosen.shape === 'keyvalue' ? { kind: chosen.shape } : {}),
    rows: { excludeHeader: true, header: chosen.headerMode },
    columns: kept.slice(0, 32).map((c) => ({
      key: c.key,
      name: c.name,
      ...(c.field ? { field: c.field } : {}),
      ...(c.source === 'index' ? { source: 'index', index: c.index } : {}),
      valueType: c.valueType,
      ...(c.valueType === 'number' ? { numericKind: c.numericKind ?? 'decimal' } : {}),
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
  if (!chosen.hasHeader) notes.push('这张表没有表头，列名是自动起的，按第几列读取')
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
      columns: chosen.columns.map((c) => ({
        key: c.key,
        name: c.name,
        ...(c.groupPath ? { groupPath: c.groupPath } : {}),
        ...(c.excludedReason ? { excludedReason: c.excludedReason } : {}),
        ...(c.indexOnly ? { indexOnly: true } : {}),
        valueType: c.valueType,
        ...(c.numericKind ? { numericKind: c.numericKind } : {}),
        source: c.source,
        index: c.index,
      })),
      alternatives: detected.alternatives.map((a) => ({
        selector: a.selector,
        level: a.level,
        ...(a.title ? { title: a.title } : {}),
        rowCount: a.rowCount,
        colCount: a.colCount,
        selectorQuality: a.selectorQuality,
      })),
      notes,
    },
  }
}
