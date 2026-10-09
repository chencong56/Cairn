import { unzipSync } from 'fflate'
import { cellRef, fileError, rangeRef, type Grid, type GridError } from './grid.js'

/** 解压后总大小、单个部件大小上限：防压缩炸弹。 */
const MAX_TOTAL_UNZIPPED = 200 * 1024 * 1024
const MAX_ENTRY_UNZIPPED = 150 * 1024 * 1024

type XmlToken =
  | { kind: 'open'; name: string; attrs: Record<string, string>; selfClose: boolean }
  | { kind: 'close'; name: string }
  | { kind: 'text'; text: string }

const decodeEntities = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, e: string) => {
    const k = e.toLowerCase()
    if (k === 'lt') return '<'
    if (k === 'gt') return '>'
    if (k === 'amp') return '&'
    if (k === 'quot') return '"'
    if (k === 'apos') return "'"
    const code = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10)
    return Number.isFinite(code) ? String.fromCodePoint(code) : ''
  })

/** 极简 XML 读取：xlsx 部件是机器生成的规整 XML，只需标签、属性、文本；命名空间前缀去掉。 */
function* xmlTokens(xml: string): Generator<XmlToken> {
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/)?(?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)([^>]*?)(\/)?>|([^<]+)/g
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    if (m[1] !== undefined) {
      yield { kind: 'text', text: m[1] }
      continue
    }
    if (m[6] !== undefined) {
      yield { kind: 'text', text: decodeEntities(m[6]) }
      continue
    }
    if (m[3] === undefined) continue
    if (m[2]) {
      yield { kind: 'close', name: m[3] }
      continue
    }
    const attrs: Record<string, string> = {}
    const attrRe = /(?:[\w.-]+:)?([\w.-]+)\s*=\s*"([^"]*)"/g
    for (let a = attrRe.exec(m[4] ?? ''); a; a = attrRe.exec(m[4] ?? '')) attrs[a[1] as string] = decodeEntities(a[2] as string)
    yield { kind: 'open', name: m[3], attrs, selfClose: m[5] === '/' }
  }
}

function unzip(bytes: Uint8Array, wanted: (name: string) => boolean): { ok: true; files: Record<string, Uint8Array> } | GridError {
  let total = 0
  try {
    const files = unzipSync(bytes, {
      filter: (file) => {
        total += file.originalSize
        if (file.originalSize > MAX_ENTRY_UNZIPPED || total > MAX_TOTAL_UNZIPPED) throw new Error('UNZIP_TOO_LARGE')
        return wanted(file.name)
      },
    })
    return { ok: true, files }
  } catch (error) {
    if (error instanceof Error && error.message === 'UNZIP_TOO_LARGE') {
      return fileError('TABLE_FILE_TOO_LARGE', '这个 Excel 解压后过大，超过读取上限')
    }
    return fileError('TABLE_FILE_CORRUPT', '这个 Excel 文件已损坏或不是有效的 xlsx')
  }
}

const utf8 = (b: Uint8Array | undefined): string => (b ? new TextDecoder('utf-8').decode(b) : '')

/** 内置的日期 / 时间格式编号（含中日韩区域格式）。 */
const BUILTIN_DATE_FMTS = new Set([14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 57, 58])
const BUILTIN_TIME_FMTS = new Set([18, 19, 20, 21, 32, 33, 45, 46, 47, 55, 56])

type CellStyle = { kind: 'date' | 'time' | 'number'; decimals?: number; percent?: boolean }

/** 内置数字格式的小数位：1 '0'、2 '0.00'、3 '#,##0'、4 '#,##0.00'、9 '0%'、10 '0.00%'、37–40 会计格式。 */
const BUILTIN_NUMBER_FMTS: Record<number, { decimals: number; percent?: boolean }> = {
  1: { decimals: 0 },
  2: { decimals: 2 },
  3: { decimals: 0 },
  4: { decimals: 2 },
  9: { decimals: 0, percent: true },
  10: { decimals: 2, percent: true },
  37: { decimals: 0 },
  38: { decimals: 0 },
  39: { decimals: 2 },
  40: { decimals: 2 },
}

/** 自定义数字格式的显示小数位与是否百分比（取第一节，忽略引号文字与方括号）；科学计数等其余格式按原值。 */
function numberDisplay(code: string): { decimals?: number; percent?: boolean } {
  const first = (code.split(';')[0] ?? '').replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '')
  if (/e[+-]/i.test(first) || !/[0#]/.test(first)) return {}
  const frac = /\.([0#]+)/.exec(first)
  return { decimals: frac ? (frac[1] as string).length : 0, ...(first.includes('%') ? { percent: true } : {}) }
}

function formatKind(code: string): 'date' | 'time' | 'number' {
  const f = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '').toLowerCase()
  if (f.includes('general')) return 'number'
  if (/[yd]/.test(f) || /年|月|日/.test(code)) return 'date'
  if (/h/.test(f) && /[ms]/.test(f)) return 'time'
  return 'number'
}

const p2 = (n: number): string => String(n).padStart(2, '0')

/** Excel 序列号 → 日期文字。1900 体系保留 Excel 的 1900-02-29 历史问题（序列号 60）。 */
export function excelSerialToText(serial: number, date1904: boolean, kind: 'date' | 'time'): string {
  if (kind === 'time' && serial < 1) {
    const secs = Math.round(serial * 86_400)
    return `${p2(Math.floor(secs / 3600))}:${p2(Math.floor((secs % 3600) / 60))}:${p2(secs % 60)}`
  }
  const base = date1904 ? Date.UTC(1904, 0, 1) : serial >= 61 ? Date.UTC(1899, 11, 30) : Date.UTC(1899, 11, 31)
  const ms = Math.round(serial * 86_400) * 1000
  const d = new Date(base + ms)
  const day = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`
  const hasTime = d.getUTCHours() + d.getUTCMinutes() + d.getUTCSeconds() > 0
  return hasTime ? `${day} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}` : day
}

/** 数字原值规范成文字：去掉二进制浮点尾差（0.1 + 0.2 存成 0.30000000000000004 时取 0.3）。 */
const numberText = (raw: string): string => {
  const n = Number(raw)
  return Number.isFinite(n) ? String(Number(n.toPrecision(15))) : raw
}

export type XlsxSheet = { name: string; path: string }

type Workbook = { sheets: XlsxSheet[]; date1904: boolean; shared: string[]; styles: CellStyle[] }

function readWorkbook(bytes: Uint8Array): { ok: true; book: Workbook } | GridError {
  const meta = unzip(bytes, (n) => n === 'xl/workbook.xml' || n === 'xl/_rels/workbook.xml.rels' || n === 'xl/sharedStrings.xml' || n === 'xl/styles.xml')
  if (!meta.ok) return meta
  const wbXml = utf8(meta.files['xl/workbook.xml'])
  if (!wbXml) return fileError('TABLE_FILE_CORRUPT', '这不是有效的 xlsx（缺少工作簿信息）')
  const rels: Record<string, string> = {}
  for (const t of xmlTokens(utf8(meta.files['xl/_rels/workbook.xml.rels']))) {
    if (t.kind === 'open' && t.name === 'Relationship' && t.attrs.Id && t.attrs.Target) {
      const target = t.attrs.Target.replace(/^\//, '')
      rels[t.attrs.Id] = target.startsWith('xl/') ? target : `xl/${target}`
    }
  }
  const sheets: XlsxSheet[] = []
  let date1904 = false
  for (const t of xmlTokens(wbXml)) {
    if (t.kind !== 'open') continue
    if (t.name === 'workbookPr' && (t.attrs.date1904 === '1' || t.attrs.date1904 === 'true')) date1904 = true
    if (t.name === 'sheet' && t.attrs.id && rels[t.attrs.id]) sheets.push({ name: t.attrs.name ?? `Sheet${sheets.length + 1}`, path: rels[t.attrs.id] as string })
  }
  // 共享字符串：<si> 里所有 <t> 拼起来（富文本分段），跳过注音 <rPh>
  const shared: string[] = []
  let cur: string | null = null
  let inT = false
  let rph = 0
  for (const t of xmlTokens(utf8(meta.files['xl/sharedStrings.xml']))) {
    if (t.kind === 'open') {
      if (t.name === 'si') cur = t.selfClose ? null : ''
      if (t.name === 'si' && t.selfClose) shared.push('')
      else if (t.name === 'rPh' && !t.selfClose) rph++
      else if (t.name === 't' && !t.selfClose) inT = true
    } else if (t.kind === 'close') {
      if (t.name === 'si') {
        shared.push(cur ?? '')
        cur = null
      } else if (t.name === 'rPh') rph = Math.max(0, rph - 1)
      else if (t.name === 't') inT = false
    } else if (inT && rph === 0 && cur !== null) cur += t.text
  }
  // 样式：cellXfs 的第 i 个 xf → numFmtId → 日期 / 时间 / 数字
  const customFmts: Record<number, string> = {}
  const styles: CellStyle[] = []
  let inXfs = false
  for (const t of xmlTokens(utf8(meta.files['xl/styles.xml']))) {
    if (t.kind === 'open' && t.name === 'numFmt' && t.attrs.numFmtId) customFmts[Number(t.attrs.numFmtId)] = t.attrs.formatCode ?? ''
    if (t.kind === 'open' && t.name === 'cellXfs' && !t.selfClose) inXfs = true
    else if (t.kind === 'close' && t.name === 'cellXfs') inXfs = false
    else if (t.kind === 'open' && t.name === 'xf' && inXfs) {
      const id = Number(t.attrs.numFmtId ?? 0)
      const custom = customFmts[id]
      if (BUILTIN_DATE_FMTS.has(id)) styles.push({ kind: 'date' })
      else if (BUILTIN_TIME_FMTS.has(id)) styles.push({ kind: 'time' })
      else if (custom !== undefined) {
        const kind = formatKind(custom)
        styles.push(kind === 'number' ? { kind, ...numberDisplay(custom) } : { kind })
      } else styles.push({ kind: 'number', ...(BUILTIN_NUMBER_FMTS[id] ?? {}) })
    }
  }
  return { ok: true, book: { sheets, date1904, shared, styles } }
}

function readSheet(xml: string, book: Workbook, maxRows: number): Grid {
  const rows: string[][] = []
  const merges: Grid['merges'] = []
  const clues = new Set<string>()
  let truncated = false
  let rowIndex = -1
  let colIndex = -1
  let cell: { r: number; c: number; t: string; s: number; v: string | null; is: string; f: boolean; capture: 'v' | 'is' | null } | null = null
  const finish = (): void => {
    if (!cell) return
    const { r, c, t, s, v, is, f } = cell
    cell = null
    if (r >= maxRows) {
      truncated = true
      return
    }
    let text = ''
    if (t === 's') text = book.shared[Number(v)] ?? ''
    else if (t === 'inlineStr') text = is
    else if (t === 'str' || t === 'e') text = v ?? ''
    else if (t === 'b') text = v === '1' ? 'TRUE' : v === '0' ? 'FALSE' : (v ?? '')
    else if (t === 'd') text = (v ?? '').replace('T', ' ').replace(/(\.\d+)?Z?$/, '').replace(/ 00:00:00$/, '')
    else if (v === null || v === '') {
      if (f) clues.add('formula_without_cached_value')
      text = ''
    } else {
      const style = book.styles[s] ?? { kind: 'number' as const }
      const n = Number(v)
      if (!Number.isFinite(n)) text = v
      else if (style.kind !== 'number') text = excelSerialToText(n, book.date1904, style.kind)
      else if (style.decimals !== undefined) text = style.percent ? `${(n * 100).toFixed(style.decimals)}%` : n.toFixed(style.decimals)
      else text = numberText(v)
    }
    while (rows.length <= r) rows.push([])
    ;(rows[r] as string[])[c] = text
  }
  for (const t of xmlTokens(xml)) {
    if (t.kind === 'open') {
      if (t.name === 'row') {
        rowIndex = t.attrs.r ? Number(t.attrs.r) - 1 : rowIndex + 1
        colIndex = -1
        if (rowIndex >= maxRows) {
          truncated = true
          break
        }
      } else if (t.name === 'c') {
        const ref = t.attrs.r ? cellRef(t.attrs.r) : null
        colIndex = ref ? ref.c : colIndex + 1
        cell = { r: ref ? ref.r : rowIndex, c: colIndex, t: t.attrs.t ?? 'n', s: Number(t.attrs.s ?? 0), v: null, is: '', f: false, capture: null }
        if (t.selfClose) finish()
      } else if (cell && t.name === 'v' && !t.selfClose) {
        cell.capture = 'v'
        cell.v = ''
      } else if (cell && t.name === 't' && !t.selfClose) cell.capture = 'is'
      else if (cell && t.name === 'f') cell.f = true

    } else if (t.kind === 'close') {
      if (t.name === 'c') finish()
      else if (cell && (t.name === 'v' || t.name === 't')) cell.capture = null
    } else if (cell?.capture === 'v') cell.v = (cell.v ?? '') + t.text
    else if (cell?.capture === 'is') cell.is += t.text
  }
  // 合并区在 sheetData 之后：单独取，超过行数上限提前停止扫描时也不丢
  for (const m of xml.matchAll(/<(?:[\w.-]+:)?mergeCell\s[^>]*?ref="([^"]+)"/g)) {
    const range = rangeRef(m[1] as string)
    if (range && range.r1 < maxRows) merges.push(range)
  }
  return { rows: rows.map((r) => Array.from(r, (v) => v ?? '')), merges, clues: [...clues], ...(truncated ? { truncated: true } : {}) }
}

const hasData = (g: Grid): boolean => g.rows.some((r) => r.some((v) => v.trim() !== ''))

/** 列出工作表（编写期预览用）：名称与数据行数。 */
export function listXlsxSheets(bytes: Uint8Array): { ok: true; sheets: Array<{ name: string; rows: number }> } | GridError {
  const wb = readWorkbook(bytes)
  if (!wb.ok) return wb
  const parts = unzip(bytes, (n) => wb.book.sheets.some((s) => s.path === n))
  if (!parts.ok) return parts
  return {
    ok: true,
    sheets: wb.book.sheets.map((s) => {
      const g = readSheet(utf8(parts.files[s.path]), wb.book, 1_000_000)
      return { name: s.name, rows: g.rows.filter((r) => r.some((v) => v.trim() !== '')).length }
    }),
  }
}

/** 读一个工作表：按名称或序号；缺省取第一个有数据的。 */
export function readXlsx(
  bytes: Uint8Array,
  sheet: { name?: string; index?: number } | undefined,
  maxRows: number,
): { ok: true; grid: Grid; sheetName: string } | GridError {
  const wb = readWorkbook(bytes)
  if (!wb.ok) return wb
  const { sheets } = wb.book
  if (sheets.length === 0) return fileError('TABLE_FILE_CORRUPT', '这个 Excel 里没有工作表')
  let candidates = sheets
  if (sheet?.name !== undefined) {
    candidates = sheets.filter((s) => s.name === sheet.name)
    if (candidates.length === 0) return fileError('TABLE_FILE_SHEET_NOT_FOUND', `找不到工作表「${sheet.name}」（现有：${sheets.map((s) => s.name).join('、')}）`)
  } else if (sheet?.index !== undefined) {
    const at = sheets[sheet.index]
    if (!at) return fileError('TABLE_FILE_SHEET_NOT_FOUND', `没有第 ${sheet.index + 1} 个工作表（共 ${sheets.length} 个）`)
    candidates = [at]
  }
  const parts = unzip(bytes, (n) => candidates.some((s) => s.path === n))
  if (!parts.ok) return parts
  for (const s of candidates) {
    const grid = readSheet(utf8(parts.files[s.path]), wb.book, maxRows)
    if (candidates.length === 1 || hasData(grid)) return { ok: true, grid, sheetName: s.name }
  }
  const first = candidates[0] as XlsxSheet
  return { ok: true, grid: readSheet(utf8(parts.files[first.path]), wb.book, maxRows), sheetName: first.name }
}
