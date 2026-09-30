import { randomUUID } from 'node:crypto'
import {
  canonicalJson,
  syncSha256,
  type JsonValue,
  type TableDiscoveredItem,
  type TableReadPlan,
  type TableSample,
  type TableRowField,
} from '@cairn/shared'
import type { Page } from './runtime.js'

const TABLE_DISCOVERY_MAX_TABLES = 10
const DEFAULT_SAMPLE_TIMEOUT_MS = 10_000
const STABILITY_INTERVAL_MS = 400
const MAX_STABILITY_ROUNDS = 3
const DEFAULT_TABLE_SELECTOR = 'table, [role="table"], [role="grid"]'

export class TableObserveError extends Error {
  constructor(
    readonly code: 'TABLE_NOT_FOUND' | 'TABLE_AMBIGUOUS' | 'TABLE_PLAN_INVALID',
    message: string,
  ) {
    super(message)
    this.name = 'TableObserveError'
  }
}

export type TableSampleSourceMeta = {
  runId?: string
  stepRunId?: string
  attemptId?: string
  pageRef?: TableSample['source']['pageRef']
}

/**
 * 发现页面上的表格（至多 10 张）
 */
export async function discoverTablesOnPage(page: Page): Promise<TableDiscoveredItem[]> {
  return page.evaluate((maxTables: number) => {
    type DomElement = {
      tagName: string
      getAttribute: (name: string) => string | null
      getBoundingClientRect: () => { x: number; y: number; width: number; height: number }
      querySelectorAll: (sel: string) => Iterable<DomElement>
      querySelector: (sel: string) => DomElement | null
      innerText?: string
      textContent: string | null
      closest: (sel: string) => DomElement | null
      parentElement: DomElement | null
    }

    const doc = (globalThis as unknown as { document: { querySelectorAll: (sel: string) => Iterable<DomElement> } }).document
    const candidates = Array.from(doc.querySelectorAll('table, [role="table"], [role="grid"], .ant-table, .el-table'))
    const discovered: TableDiscoveredItem[] = []

    for (let i = 0; i < candidates.length && discovered.length < maxTables; i++) {
      const el = candidates[i]!
      const rect = el.getBoundingClientRect()
      // 忽略不可见或零尺寸元素
      if (rect.width <= 0 || rect.height <= 0) continue

      const tag = el.tagName.toLowerCase()
      const roleAttr = el.getAttribute('role') || ''

      // 表格 ID 与 Selector
      const id = el.getAttribute('id')
      const tableId = id || `table_${discovered.length + 1}`
      const selector = id ? `#${id}` : tag === 'table' ? `table:nth-of-type(${i + 1})` : `[role="${roleAttr || 'table'}"]:nth-of-type(${i + 1})`

      // 名称提取：caption, aria-label
      let name = el.getAttribute('aria-label') || undefined
      if (!name) {
        const caption = el.querySelector('caption')
        if (caption?.textContent?.trim()) {
          name = caption.textContent.trim()
        }
      }

      // 列头提取
      const headerEls = Array.from(el.querySelectorAll('thead th, [role="columnheader"], th'))
      // 数据行（用于列类型建议：每列抽至多 5 个非空单元格文本做探测）
      const dataRowEls = Array.from(el.querySelectorAll('tbody tr, [role="row"]:not(thead [role="row"])'))
      const sampleRows = dataRowEls.slice(0, 5)
      const typeHint = (colIdx: number): { valueType?: 'text' | 'number' | 'boolean'; numericKind?: 'integer' | 'decimal' } => {
        const texts: string[] = []
        for (const rowEl of sampleRows) {
          const cells = Array.from(rowEl.querySelectorAll('td, [role="cell"], [role="gridcell"]'))
          const text = (cells[colIdx]?.innerText || cells[colIdx]?.textContent || '').trim()
          if (text) texts.push(text)
        }
        if (texts.length === 0) return {}
        const clean = (t: string) => t.replace(/[^\d.-]/g, '')
        if (texts.every((t) => /^(true|false|yes|no|是|否|真|假)$/i.test(t))) {
          return { valueType: 'boolean' }
        }
        if (texts.every((t) => /^-?\d+(\.\d+)?$/.test(clean(t)))) {
          const allInteger = texts.every((t) => /^-?\d+$/.test(clean(t)))
          return { valueType: 'number', numericKind: allInteger ? 'integer' : 'decimal' }
        }
        return { valueType: 'text' }
      }
      const columns: Array<{ key: string; name: string; tag?: string; valueType?: 'text' | 'number' | 'boolean'; numericKind?: 'integer' | 'decimal' }> = []
      for (let cIdx = 0; cIdx < headerEls.length; cIdx++) {
        const h = headerEls[cIdx]!
        const text = (h.innerText || h.textContent || '').trim().replace(/\s+/g, ' ')
        if (text) {
          columns.push({ key: `col_${cIdx + 1}`, name: text, tag: h.tagName ? h.tagName.toLowerCase() : undefined, ...typeHint(cIdx) })
        }
      }

      // 行数提取
      const rowCount = dataRowEls.length

      // 分页检测
      let hasPagination = false
      const parent = el.parentElement
      if (parent) {
        const nav = parent.querySelector('nav, [role="navigation"], .pagination, .ant-pagination, .el-pagination')
        if (nav) hasPagination = true
      }
      if (!hasPagination && el.querySelector('.pagination, [role="navigation"], .ant-pagination, .el-pagination')) {
        hasPagination = true
      }

      const target = {
        framePath: [],
        candidates: [{ by: 'css' as const, value: selector }],
        ...(name ? { semantic: name } : {}),
      }

      discovered.push({
        index: discovered.length,
        target,
        columns,
        rowCountHint: rowCount,
        box: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        readinessClues: hasPagination ? ['pagination'] : [],
      })
      void tableId
    }

    return discovered
  }, TABLE_DISCOVERY_MAX_TABLES)
}

type DomRowData = {
  values: Record<string, { value: JsonValue; rawText: string; decimalValue?: string; status: 'ok' | 'missing' | 'error' | 'masked' }>
  rawDigest: string
}

type DomSampleSnapshot = {
  rootFound: boolean
  rootCount: number
  isBusy: boolean
  hasDeclaredLoading: boolean
  emptyVerified: boolean
  headerDigest: string
  hasPagination: boolean
  totalDomRows: number
  rows: DomRowData[]
}

export type SampleTableOptions = {
  meta?: TableSampleSourceMeta
  signal?: AbortSignal
  timeoutMs?: number
}

/**
 * 在受管页面执行有界表格采样，支持稳定性判定与定量重试。
 * 根不存在 / 根不唯一按定位失败抛错（TABLE_NOT_FOUND / TABLE_AMBIGUOUS），
 * 不产出貌似完整的空样本。
 */
export async function sampleTableOnPage(
  page: Page,
  plan: TableReadPlan,
  options: SampleTableOptions = {},
): Promise<TableSample> {
  const signal = options.signal
  const timeoutMs = options.timeoutMs ?? DEFAULT_SAMPLE_TIMEOUT_MS
  const startTime = Date.now()
  const planDigest = syncSha256(canonicalJson(plan))

  let lastSnapshot: DomSampleSnapshot | null = null
  let stableSnapshot: DomSampleSnapshot | null = null
  let everSawReady = false

  for (let round = 0; round < MAX_STABILITY_ROUNDS; round++) {
    signal?.throwIfAborted()
    if (Date.now() - startTime >= timeoutMs) break

    // 第 1 次取样
    const sample1 = await captureDomSample(page, plan)
    if (!sample1.rootFound) {
      throw new TableObserveError('TABLE_NOT_FOUND', '未找到表格根节点，定位失败')
    }
    if (sample1.rootCount > 1) {
      throw new TableObserveError('TABLE_AMBIGUOUS', `表格根定位命中 ${sample1.rootCount} 个节点，根不唯一`)
    }
    if (sample1.isBusy) {
      await delay(STABILITY_INTERVAL_MS, signal)
      continue
    }
    everSawReady = true

    // 等待稳定性采样间隔
    await delay(STABILITY_INTERVAL_MS, signal)
    signal?.throwIfAborted()

    // 第 2 次取样
    const sample2 = await captureDomSample(page, plan)
    if (!sample2.rootFound) {
      throw new TableObserveError('TABLE_NOT_FOUND', '采样过程中表格根节点消失（页面被替换或导航）')
    }
    if (sample2.rootCount > 1) {
      throw new TableObserveError('TABLE_AMBIGUOUS', `表格根定位命中 ${sample2.rootCount} 个节点，根不唯一`)
    }

    // 比对两次采样：就绪、行数、行顺序、字段值、表头与范围信号
    if (areSnapshotsEqual(sample1, sample2)) {
      stableSnapshot = sample2
      break
    }

    lastSnapshot = sample2
    await delay(STABILITY_INTERVAL_MS, signal)
  }

  const finalSnapshot = stableSnapshot ?? lastSnapshot ?? (await captureDomSample(page, plan))
  if (!finalSnapshot.rootFound) {
    throw new TableObserveError('TABLE_NOT_FOUND', '未找到表格根节点，定位失败')
  }
  const sampleTime = new Date().toISOString()

  const rows: Record<string, TableRowField>[] = finalSnapshot.rows.map((r) => r.values)
  const maxRows = plan.limits?.maxRows ?? 200
  const truncated = finalSnapshot.totalDomRows > maxRows

  // 覆盖判定：稳定性是完整的前提；分页不必然不完整（当前页读全即可检查，范围线索另行保留）
  let coverageStatus: 'complete' | 'partial' | 'unknown'
  let reasonCode: string | undefined
  let reasonMessage: string | undefined
  const clues: string[] = []
  if (finalSnapshot.hasPagination) {
    clues.push('pagination_present')
  }

  if (!stableSnapshot) {
    coverageStatus = 'unknown'
    if (!everSawReady) {
      reasonCode = 'TABLE_READINESS_TIMEOUT'
      reasonMessage = '读取预算内声明就绪信号未成立或加载信号仍活跃，不能确认当前页数据已加载'
    } else {
      reasonCode = 'TABLE_MUTATING_UNSTABLE'
      reasonMessage = '采样窗口内表格内容持续变化，未能取得连续两次一致快照'
    }
  } else if (truncated) {
    coverageStatus = 'partial'
    reasonCode = 'TABLE_ROW_LIMIT_TRUNCATED'
    reasonMessage = `数据行数超过读取上限 ${maxRows}，仅读取前 ${rows.length} 行`
  } else {
    coverageStatus = 'complete'
    // 零行必须有可靠空态或明确加载完成依据，否则不能判为空表
    if (rows.length === 0 && !finalSnapshot.emptyVerified) {
      coverageStatus = 'unknown'
      reasonCode = 'TABLE_EMPTY_UNVERIFIED'
      reasonMessage = '零行且未取得可靠空态证据，不能确认表格确为空'
    }
  }

  return {
    protocol: 'table.sample@1',
    source: {
      runId: options.meta?.runId ?? randomUUID(),
      stepRunId: options.meta?.stepRunId,
      attemptId: options.meta?.attemptId,
      pageRef: options.meta?.pageRef,
      sampledAt: sampleTime,
      planDigest,
    },
    columns: plan.columns,
    rows,
    rowCount: rows.length,
    coverage: {
      requestedScope: 'current_page',
      observedScope: 'current_page',
      status: coverageStatus,
      ...(reasonCode ? { reasonCode, reasonMessage } : {}),
      ...(clues.length > 0 ? { clues } : {}),
    },
    presentation: {
      omitted: false,
      previewCount: Math.min(20, rows.length),
    },
  }
}

async function captureDomSample(page: Page, plan: TableReadPlan): Promise<DomSampleSnapshot> {
  return page.evaluate((planInput: TableReadPlan) => {
    type DomElement = {
      tagName: string
      getAttribute: (name: string) => string | null
      querySelectorAll: (sel: string) => Iterable<DomElement>
      querySelector: (sel: string) => DomElement | null
      innerText?: string
      textContent: string | null
      parentElement: DomElement | null
    }

    const doc = (globalThis as unknown as { document: { querySelector: (sel: string) => DomElement | null; querySelectorAll: (sel: string) => Iterable<DomElement> } }).document
    const cssCandidate = planInput.target?.candidates?.find((c) => c.by === 'css')?.value
    const selector = cssCandidate || 'table, [role="table"], [role="grid"]'
    const rootMatches = Array.from(doc.querySelectorAll(selector))
    const tableEl = rootMatches[0] ?? null

    if (!tableEl) {
      return {
        rootFound: false,
        rootCount: 0,
        isBusy: false,
        hasDeclaredLoading: false,
        emptyVerified: false,
        headerDigest: '',
        hasPagination: false,
        totalDomRows: 0,
        rows: [],
      }
    }

    // 就绪检查：aria-busy 是 ARIA 语义信号；骨架/加载定位只在计划声明后参与判断
    const loadingSelector = planInput.readiness?.loadingSelector
    const hasDeclaredLoading = loadingSelector ? Boolean(tableEl.querySelector(loadingSelector)) : false
    const isBusy = tableEl.getAttribute('aria-busy') === 'true' || Boolean(tableEl.querySelector('[aria-busy="true"]')) || hasDeclaredLoading

    // 空态证据：只认计划声明的空态定位（在表格根或其父级内查找）
    const emptySelector = planInput.readiness?.emptySelector
    let emptyVerified = false
    if (emptySelector) {
      emptyVerified = Boolean(tableEl.querySelector(emptySelector)) || Boolean(tableEl.parentElement?.querySelector(emptySelector))
    }

    // 分页检查（范围线索，不降低覆盖状态）
    let hasPagination = false
    const parent = tableEl.parentElement
    if (parent && parent.querySelector('nav, [role="navigation"], .pagination, .ant-pagination, .el-pagination')) {
      hasPagination = true
    }

    // 提取正文数据行
    const rowEls = Array.from(tableEl.querySelectorAll('tbody tr, [role="row"]:not(thead [role="row"])'))
    const maxRows = planInput.limits?.maxRows ?? 200
    const rowsToProcess = rowEls.slice(0, maxRows)

    const headerEls = Array.from(tableEl.querySelectorAll('thead th, [role="columnheader"], th'))
    const headerTexts = headerEls.map((h) => (h.innerText || h.textContent || '').trim().toLowerCase())

    const rows: DomRowData[] = []

    for (let rIdx = 0; rIdx < rowsToProcess.length; rIdx++) {
      const rowEl = rowsToProcess[rIdx]!
      const cells = Array.from(rowEl.querySelectorAll('td, [role="cell"], [role="gridcell"]'))
      const values: DomRowData['values'] = {}
      const digestParts: string[] = []

      for (let cIdx = 0; cIdx < planInput.columns.length; cIdx++) {
        const colSpec = planInput.columns[cIdx]!
        let cellText = ''
        let foundCell: DomElement | null = null

        if (colSpec.selector) {
          foundCell = rowEl.querySelector(colSpec.selector)
        }
        if (!foundCell) {
          // 按表头精确匹配 → 唯一包含匹配 → 序号兜底；重复列名不能唯一映射时不猜
          let targetIndex = cIdx
          if (colSpec.name) {
            const lowered = colSpec.name.toLowerCase()
            const exact = headerTexts.findIndex((h) => h === lowered)
            if (exact !== -1) {
              targetIndex = exact
            } else {
              const includes = headerTexts.map((h, idx) => (h.includes(lowered) ? idx : -1)).filter((idx) => idx !== -1)
              if (includes.length === 1) {
                targetIndex = includes[0]!
              } else if (includes.length > 1) {
                values[colSpec.key] = { value: null, rawText: '', status: 'error' }
                digestParts.push(`${colSpec.key}:ambiguous-header`)
                continue
              }
            }
          }
          foundCell = cells[targetIndex] ?? null
        }

        if (foundCell) {
          cellText = (foundCell.innerText || foundCell.textContent || '').trim()
        }

        if (!foundCell || !cellText) {
          values[colSpec.key] = { value: null, rawText: cellText, status: 'missing' }
          digestParts.push(`${colSpec.key}:missing`)
          continue
        }

        let parsedVal: JsonValue = cellText
        let decimalValue: string | undefined
        if (colSpec.valueType === 'number') {
          // 清理货币符号和千分位，保留规范化十进制字符串供精确计算
          const clean = cellText.replace(/[^\d.-]/g, '')
          const num = Number(clean)
          if (Number.isFinite(num) && /^-?\d+(\.\d+)?$/.test(clean)) {
            parsedVal = num
            decimalValue = clean
          } else {
            values[colSpec.key] = { value: null, rawText: cellText, status: 'error' }
            digestParts.push(`${colSpec.key}:error:${cellText}`)
            continue
          }
        } else if (colSpec.valueType === 'boolean') {
          const lower = cellText.toLowerCase()
          parsedVal = lower === 'true' || lower === 'yes' || lower === '是' || lower === '1'
        }

        values[colSpec.key] = {
          value: parsedVal,
          rawText: cellText,
          ...(decimalValue !== undefined ? { decimalValue } : {}),
          status: 'ok',
        }
        digestParts.push(`${colSpec.key}:${String(parsedVal)}`)
      }

      rows.push({
        values,
        rawDigest: digestParts.join('|'),
      })
    }

    return {
      rootFound: true,
      rootCount: rootMatches.length,
      isBusy,
      hasDeclaredLoading,
      emptyVerified,
      headerDigest: headerTexts.join('|'),
      hasPagination,
      totalDomRows: rowEls.length,
      rows,
    }
  }, plan)
}

function areSnapshotsEqual(a: DomSampleSnapshot, b: DomSampleSnapshot): boolean {
  if (a.rootCount !== b.rootCount) return false
  if (a.isBusy !== b.isBusy) return false
  if (a.hasPagination !== b.hasPagination) return false
  if (a.emptyVerified !== b.emptyVerified) return false
  if (a.headerDigest !== b.headerDigest) return false
  if (a.totalDomRows !== b.totalDomRows) return false
  if (a.rows.length !== b.rows.length) return false
  for (let i = 0; i < a.rows.length; i++) {
    if (a.rows[i]!.rawDigest !== b.rows[i]!.rawDigest) {
      return false
    }
  }
  return true
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Aborted'))
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('Aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
