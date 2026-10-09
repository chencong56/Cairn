import type { TableColumnSpec, TableFilePlan } from '@cairn/shared'
import { makeValueParsers, type ValueField } from './values.js'
import { fileError, normalizeGrid, type Grid, type GridError } from './grid.js'

const values = makeValueParsers()
/** 与页面读取一致的合计行文字。 */
const TOTAL_RE = /^(合计|总计|小计|汇总|合\s*计|总\s*计|total|sum|subtotal)\s*[:：]?$/i
const INDEX_HEADER = /^(序号|序|行号|no\.?|#)$/i

export type FileColumn = { leaf: string; path: string }
export type FileRow = Record<string, ValueField>

type Layout = {
  rows: string[][]
  width: number
  headerStart: number
  headerRows: number
  cols: FileColumn[]
  dataStart: number
  /** 被合并成一整行的“分组 / 说明行”（不计入数据）。 */
  fullRowMerges: Set<number>
  /** 数据区里有纵向合并、已向下填充。 */
  filledDown: boolean
}

const nonEmpty = (row: readonly string[]): number => row.filter((v) => v !== '').length

/**
 * 找表头：显式指定就用；HTML 有 thead 就用 thead；否则跳过开头的空行、标题行（只有一格有字，或一个合并格占满整行），
 * 第一个至少两格有字的行就是表头。表头里有横向合并（分组表头）时，默认占两行。
 */
export function layoutOf(grid: Grid, header: TableFilePlan['header']): { ok: true; layout: Layout } | GridError {
  const { rows, width } = normalizeGrid(grid)
  if (rows.length === 0 || width === 0) return fileError('TABLE_FILE_EMPTY', '文件里没有任何数据')
  const fullRow = (r: number): boolean => grid.merges.some((m) => m.r1 === r && m.c1 === 0 && m.c2 >= width - 1 && width > 1)
  let start: number
  if (header.row !== 'auto') {
    start = header.row - 1
    if (start >= rows.length) return fileError('TABLE_HEADER_NOT_FOUND', `指定的表头在第 ${header.row} 行，但文件只有 ${rows.length} 行`)
  } else if (grid.headerHint) {
    start = grid.headerHint.start
  } else {
    const need = Math.min(2, width)
    start = rows.findIndex((row, r) => nonEmpty(row) >= need && !fullRow(r))
    if (start < 0) return fileError('TABLE_HEADER_NOT_FOUND', '没有找到表头行（至少两格有文字的行）；可以手工指定表头在第几行')
  }
  let count: number
  if (header.rows !== 'auto') count = header.rows
  else if (grid.headerHint && header.row === 'auto') count = grid.headerHint.count
  else {
    const grouped = grid.merges.some((m) => m.r1 === start && m.c2 > m.c1 && m.r2 === start)
    // 没有合并信息的两级表头（CSV）：本行有空格，下一行字更多、而且全是文字（不是数据）
    const next = rows[start + 1]
    const textOnly = (row: readonly string[]): boolean => row.every((v) => v === '' || !/^[-+]?[\d,.]+%?$/.test(v))
    const flatGrouped =
      !grouped && next !== undefined && grid.merges.length === 0 && (rows[start] as string[]).some((v) => v === '') && nonEmpty(next) > nonEmpty(rows[start] as string[]) && textOnly(next)
    count = (grouped || flatGrouped) && start + 1 < rows.length ? 2 : 1
  }
  count = Math.max(1, Math.min(count, rows.length - start))
  // 多级表头里上层的空格：没有合并信息时，继承左边的分组名（导出成 CSV 的合并表头就是这样）
  for (let r = start; r < start + count - 1; r++) {
    const row = rows[r] as string[]
    for (let c = 1; c < width; c++) {
      const covered = grid.merges.some((m) => r >= m.r1 && r <= m.r2 && c >= m.c1 && c <= m.c2)
      const below = (rows[start + count - 1] as string[])[c] ?? ''
      if (row[c] === '' && row[c - 1] !== '' && !covered && below !== '' && below !== row[c - 1]) row[c] = row[c - 1] as string
    }
  }
  const cols: FileColumn[] = []
  for (let c = 0; c < width; c++) {
    const parts: string[] = []
    for (let r = start; r < start + count; r++) {
      const t = (rows[r] as string[])[c] ?? ''
      if (t && parts[parts.length - 1] !== t) parts.push(t)
    }
    const leaf = parts[parts.length - 1] ?? ''
    cols.push({ leaf, path: parts.join(' / ') })
  }
  const dataStart = start + count
  const fullRowMerges = new Set<number>()
  let filledDown = false
  for (const m of grid.merges) {
    if (m.r1 < dataStart) continue
    if (m.c1 === 0 && m.c2 >= width - 1 && width > 1 && m.r1 === m.r2) fullRowMerges.add(m.r1)
    else if (m.r2 > m.r1) filledDown = true
  }
  return { ok: true, layout: { rows, width, headerStart: start, headerRows: count, cols, dataStart, fullRowMerges, filledDown } }
}

export type FileReadResult = {
  rows: FileRow[]
  summaryRows: FileRow[]
  excluded: { mergedRows: number; paginationRows: number; footerRows: number }
  clues: string[]
  /** 数据行超过计划的 maxRows 被截掉了。 */
  rowLimitHit: boolean
}

/** 计划里的列 → 网格列号：按第几列、或按表头（叶子或“上级 / 列名”）匹配，与页面读取同一规则。 */
function mapColumns(layout: Layout, columns: readonly TableColumnSpec[]): { ok: true; at: number[] } | GridError {
  const lower = (s: string): string => s.toLowerCase()
  const hasHeader = layout.cols.some((c) => c.leaf !== '')
  const at: number[] = []
  for (const spec of columns) {
    if (spec.source === 'index') {
      if (spec.index === undefined || spec.index >= layout.width) {
        return fileError('TABLE_COLUMN_NOT_FOUND', `列「${spec.name}」按第 ${(spec.index ?? 0) + 1} 列取，但文件只有 ${layout.width} 列`)
      }
      at.push(spec.index)
      continue
    }
    if (!hasHeader) return fileError('TABLE_HEADER_NOT_FOUND', `没有表头，无法按列名找「${spec.name}」。请改为“按第几列取”`)
    const want = lower(spec.name.replace(/\s+/g, ' ').trim())
    const hits = layout.cols.map((c, i) => (lower(c.leaf) === want || lower(c.path) === want ? i : -1)).filter((i) => i >= 0)
    if (hits.length === 0) {
      return fileError('TABLE_COLUMN_NOT_FOUND', `表头里找不到列「${spec.name}」（现有列：${layout.cols.map((c) => c.leaf).filter(Boolean).join('、') || '无'}）`)
    }
    if (hits.length > 1) return fileError('TABLE_COLUMN_AMBIGUOUS', `表头里有 ${hits.length} 列都叫「${spec.name}」，请改用“上级 / 列名”或按第几列取`)
    at.push(hits[0] as number)
  }
  return { ok: true, at }
}

/** 按计划读出数据行与合计行。 */
export function readRecords(grid: Grid, plan: TableFilePlan): { ok: true; result: FileReadResult; layout: Layout } | GridError {
  const laid = layoutOf(grid, plan.header)
  if (!laid.ok) return laid
  const layout = laid.layout
  const mapped = mapColumns(layout, plan.columns)
  if (!mapped.ok) return mapped
  const clues = new Set(grid.clues)
  if (layout.filledDown) clues.add('merged_cells_filled')
  const from = plan.range.startRow !== undefined ? plan.range.startRow - 1 : layout.dataStart
  const to = plan.range.endRow !== undefined ? Math.min(plan.range.endRow, layout.rows.length) : layout.rows.length
  const totalCol = plan.totalRow ? plan.columns.findIndex((c) => c.key === plan.totalRow?.columnKey) : -1
  const read = (row: readonly string[]): FileRow => {
    const out: FileRow = {}
    plan.columns.forEach((spec, i) => {
      if (spec.sensitive) {
        out[spec.key] = { value: null, status: 'masked' }
        return
      }
      out[spec.key] = values.fieldFromText(spec, row[mapped.at[i] as number] ?? '').field
    })
    return out
  }
  const data: FileRow[] = []
  const summary: FileRow[] = []
  let mergedRows = 0
  let seenData = false
  let rowLimitHit = false
  for (let r = from; r < to; r++) {
    const row = layout.rows[r] as string[]
    if (nonEmpty(row) === 0) {
      if (plan.range.stopAtBlankRow && seenData) break
      continue
    }
    const first = row.slice(0, 3).find((v) => v !== '') ?? ''
    const manualTotal = totalCol >= 0 && row[mapped.at[totalCol] as number] === plan.totalRow?.equals
    if (manualTotal || TOTAL_RE.test(first)) {
      summary.push(read(row))
      continue
    }
    if (layout.fullRowMerges.has(r)) {
      mergedRows++
      continue
    }
    seenData = true
    if (data.length >= plan.limits.maxRows) {
      rowLimitHit = true
      break
    }
    data.push(read(row))
  }
  return {
    ok: true,
    layout,
    result: {
      rows: data,
      summaryRows: summary.slice(0, 5),
      excluded: { mergedRows, paginationRows: 0, footerRows: summary.length },
      clues: [...clues],
      rowLimitHit,
    },
  }
}

export type FileDetectedColumn = {
  index: number
  key: string
  name: string
  groupPath?: string
  source: 'header' | 'index'
  valueType: 'text' | 'number' | 'boolean' | 'date'
  numericKind?: 'integer' | 'decimal'
  excludedReason?: 'index'
  indexOnly?: boolean
}

/** 编写期识别：表头位置、每列名称与类型（取数据区前 50 行推断），序号列默认排除。 */
export function detectColumns(grid: Grid, header: TableFilePlan['header']): { ok: true; columns: FileDetectedColumn[]; headerRow: number; headerRows: number; dataRows: number } | GridError {
  const laid = layoutOf(grid, header)
  if (!laid.ok) return laid
  const { layout } = laid
  const data = layout.rows.slice(layout.dataStart).filter((r, i) => nonEmpty(r) > 0 && !layout.fullRowMerges.has(layout.dataStart + i))
  // 明细行：合计 / 小计行不算数据行（与读取时一致，否则识别说 13 行、读出 12 行）
  const body = data.filter((r) => !TOTAL_RE.test(r.slice(0, 3).find((v) => v !== '') ?? ''))
  const samples = body.slice(0, 50)
  const seen: Record<string, number> = {}
  for (const c of layout.cols) if (c.leaf) seen[c.leaf] = (seen[c.leaf] ?? 0) + 1
  const columns = layout.cols.map((col, c): FileDetectedColumn => {
    const texts = samples.map((r) => r[c] ?? '').filter(Boolean)
    const inferred = values.inferType(texts)
    const dup = col.leaf !== '' && (seen[col.leaf] ?? 0) > 1
    const indexOnly = col.leaf === '' || (dup && col.path === col.leaf)
    const isIndex = INDEX_HEADER.test(col.leaf) || (!col.leaf && texts.length >= 2 && texts.every((t, i) => t === String(i + 1)))
    return {
      index: c,
      key: `col_${c + 1}`,
      name: col.leaf ? (dup && col.path !== col.leaf ? col.path : col.leaf) : `列${c + 1}`,
      ...(col.path && col.path !== col.leaf ? { groupPath: col.path } : {}),
      source: indexOnly ? 'index' : 'header',
      valueType: inferred.valueType,
      ...(inferred.numericKind ? { numericKind: inferred.numericKind } : {}),
      ...(isIndex ? { excludedReason: 'index' as const } : {}),
      ...(indexOnly ? { indexOnly: true } : {}),
    }
  })
  return { ok: true, columns, headerRow: layout.headerStart + 1, headerRows: layout.headerRows, dataRows: body.length }
}
