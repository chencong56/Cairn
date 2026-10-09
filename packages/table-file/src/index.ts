import {
  TABLE_FILE_MAX_BYTES,
  TABLE_FILE_PROTOCOL,
  TABLE_READ_DEFAULT_SELECTED_COLS,
  tableFilePlanSchema,
  type TableFilePlan,
  type TableSample,
} from '@cairn/shared'
import { parseCsv } from './csv.js'
import { decodeText, detectFileFormat, type FileFormat } from './format.js'
import { fileError, type Grid, type GridError } from './grid.js'
import { readHtmlTable } from './html.js'
import { detectColumns, readRecords, type FileDetectedColumn } from './records.js'
import { listXlsxSheets, readXlsx } from './xlsx.js'

export { detectFileFormat, decodeText } from './format.js'
export { makeValueParsers, type ValueField, type ValueParsers, type ValueSpec } from './values.js'
export type { FileDetectedColumn } from './records.js'

/** 解析时多留的行：表头、标题、合计行都在数据行之外。 */
const ROW_HEADROOM = 200

type Parsed = { grid: Grid; format: FileFormat; sheet?: string; encoding?: string }

function parse(bytes: Uint8Array, name: string, plan: Pick<TableFilePlan, 'format' | 'sheet' | 'encoding' | 'delimiter'>, maxRows: number): { ok: true; parsed: Parsed } | GridError {
  if (bytes.byteLength > TABLE_FILE_MAX_BYTES) {
    return fileError('TABLE_FILE_TOO_LARGE', `文件 ${Math.round(bytes.byteLength / 1024 / 1024)} MB，超过读取上限 ${TABLE_FILE_MAX_BYTES / 1024 / 1024} MB`)
  }
  if (bytes.byteLength === 0) return fileError('TABLE_FILE_EMPTY', `「${name}」是空文件`)
  const fmt = detectFileFormat(bytes, name, plan.format)
  if (!fmt.ok) return fmt
  const limit = maxRows + ROW_HEADROOM
  if (fmt.format === 'xlsx') {
    const r = readXlsx(bytes, plan.sheet, limit)
    if (!r.ok) return r
    return { ok: true, parsed: { grid: r.grid, format: 'xlsx', sheet: r.sheetName } }
  }
  const { text, encoding } = decodeText(bytes, plan.encoding)
  if (fmt.format === 'html') {
    const r = readHtmlTable(text, limit)
    if (!r.ok) return r
    return { ok: true, parsed: { grid: r.grid, format: 'html', encoding } }
  }
  return { ok: true, parsed: { grid: parseCsv(text, plan.delimiter, limit), format: 'csv', encoding } }
}

export type FileSampleBody = Pick<TableSample, 'columns' | 'rows' | 'rowCount' | 'coverage' | 'excluded' | 'summaryRows'> & {
  file: NonNullable<TableSample['source']['file']>
}

/**
 * 按读取计划把文件读成记录集主体（不含 source 的运行元数据）：完整行，覆盖情况如实——
 * 源数据被行数上限截断就是 partial，不宣称完整；空表是文件给出的事实，判为 complete。
 */
export function readTableFile(input: { bytes: Uint8Array; name: string; plan: TableFilePlan }): { ok: true; body: FileSampleBody } | GridError {
  const plan = input.plan
  const p = parse(input.bytes, input.name, plan, plan.limits.maxRows)
  if (!p.ok) return p
  const read = readRecords(p.parsed.grid, plan)
  if (!read.ok) return read
  const { result } = read
  const truncated = result.rowLimitHit || Boolean(p.parsed.grid.truncated)
  return {
    ok: true,
    body: {
      file: {
        name: input.name.slice(0, 255),
        format: p.parsed.format,
        ...(p.parsed.sheet ? { sheet: p.parsed.sheet.slice(0, 128) } : {}),
        ...(p.parsed.encoding ? { encoding: p.parsed.encoding } : {}),
      },
      columns: plan.columns,
      rows: result.rows,
      rowCount: result.rows.length,
      coverage: {
        requestedScope: 'current_page',
        observedScope: 'current_page',
        status: truncated ? 'partial' : 'complete',
        ...(truncated
          ? { reasonCode: 'TABLE_ROW_LIMIT_TRUNCATED', reasonMessage: `文件里的数据行超过读取上限 ${plan.limits.maxRows} 行，只读取了前 ${result.rows.length} 行` }
          : {}),
        ...(result.clues.length > 0 ? { clues: result.clues } : {}),
      },
      excluded: result.excluded,
      ...(result.summaryRows.length > 0 ? { summaryRows: result.summaryRows } : {}),
    },
  }
}

export type FileDetection = {
  format: FileFormat
  encoding?: string
  sheet?: string
  sheets?: Array<{ name: string; rows: number }>
  headerRow: number
  headerRows: number
  dataRows: number
  columns: FileDetectedColumn[]
  /** 建议的读取计划：勾选前若干个未排除的列；表头保持自动，换了文件也能找到。 */
  plan: TableFilePlan
}

/** 编写期识别：格式、工作表、表头位置、每列名称与类型，以及一份建议计划。 */
export function detectTableFile(input: {
  bytes: Uint8Array
  name: string
  fromKey: string
  hints?: Partial<Pick<TableFilePlan, 'format' | 'sheet' | 'encoding' | 'delimiter' | 'header'>>
}): { ok: true; detection: FileDetection } | GridError {
  const hints = { format: 'auto' as const, encoding: 'auto' as const, delimiter: 'auto' as const, header: { row: 'auto' as const, rows: 'auto' as const }, ...input.hints }
  const p = parse(input.bytes, input.name, hints, 50_000)
  if (!p.ok) return p
  const detected = detectColumns(p.parsed.grid, hints.header)
  if (!detected.ok) return detected
  let sheets: FileDetection['sheets']
  if (p.parsed.format === 'xlsx') {
    const listed = listXlsxSheets(input.bytes)
    if (listed.ok) sheets = listed.sheets
  }
  const kept = detected.columns.filter((c) => !c.excludedReason).slice(0, TABLE_READ_DEFAULT_SELECTED_COLS)
  const plan = tableFilePlanSchema.parse({
    protocol: TABLE_FILE_PROTOCOL,
    fromKey: input.fromKey,
    format: hints.format,
    ...(hints.sheet ? { sheet: hints.sheet } : p.parsed.sheet ? { sheet: { name: p.parsed.sheet } } : {}),
    header: hints.header,
    encoding: hints.encoding,
    delimiter: hints.delimiter,
    columns: (kept.length > 0 ? kept : detected.columns.slice(0, 1)).map((c) => ({
      key: c.key,
      name: c.name,
      source: c.source,
      ...(c.source === 'index' ? { index: c.index } : {}),
      valueType: c.valueType,
      ...(c.valueType === 'number' ? { numericKind: c.numericKind ?? 'decimal' } : {}),
    })),
  })
  return {
    ok: true,
    detection: {
      format: p.parsed.format,
      ...(p.parsed.encoding ? { encoding: p.parsed.encoding } : {}),
      ...(p.parsed.sheet ? { sheet: p.parsed.sheet } : {}),
      ...(sheets ? { sheets } : {}),
      headerRow: detected.headerRow,
      headerRows: detected.headerRows,
      dataRows: detected.dataRows,
      columns: detected.columns,
      plan,
    },
  }
}
