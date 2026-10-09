/**
 * 文件来源的统一中间形态：单元格网格 + 合并区。CSV / XLSX / HTML 伪 XLS 都先转成它，再走同一套表头识别与取值。
 */

/** 合并区，0 起、首尾都含。 */
export type Merge = { r1: number; c1: number; r2: number; c2: number }

export type Grid = {
  rows: string[][]
  merges: Merge[]
  /** HTML 里 thead 所在的行（作为表头提示）。 */
  headerHint?: { start: number; count: number }
  /** 读取中遇到、要写进覆盖线索的情况（例如公式没有缓存值）。 */
  clues: string[]
  /** 源数据行数超过上限被截掉了。 */
  truncated?: boolean
}

export type GridError = { ok: false; code: string; message: string }

export function fileError(code: string, message: string): GridError {
  return { ok: false, code, message }
}

/** 文字规整：与页面读取一致——不间断空格、全角空格当空格，连续空白合一，去首尾。 */
export function cleanText(t: string): string {
  return t.replace(/ /g, ' ').replace(/　/g, ' ').replace(/\s+/g, ' ').trim()
}

/** 补齐每行宽度，并把合并区里被覆盖的格子填成左上角的文字（纵向合并 = 向下填充）。 */
export function normalizeGrid(grid: Grid): { rows: string[][]; width: number } {
  const width = grid.rows.reduce((m, r) => Math.max(m, r.length), 0)
  const rows = grid.rows.map((r) => {
    const out = r.map((v) => cleanText(v ?? ''))
    while (out.length < width) out.push('')
    return out
  })
  for (const m of grid.merges) {
    const origin = rows[m.r1]?.[m.c1] ?? ''
    for (let r = m.r1; r <= m.r2 && r < rows.length; r++) {
      for (let c = m.c1; c <= m.c2 && c < width; c++) {
        if (r === m.r1 && c === m.c1) continue
        ;(rows[r] as string[])[c] = origin
      }
    }
  }
  return { rows, width }
}

/** “A1” → { r: 0, c: 0 }。 */
export function cellRef(ref: string): { r: number; c: number } | null {
  const m = /^([A-Z]+)(\d+)$/i.exec(ref.trim())
  if (!m) return null
  let c = 0
  for (const ch of (m[1] as string).toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64)
  return { r: Number(m[2]) - 1, c: c - 1 }
}

/** “A1:C2” → 合并区。 */
export function rangeRef(ref: string): Merge | null {
  const [a, b] = ref.split(':')
  const p = a ? cellRef(a) : null
  const q = b ? cellRef(b) : p
  if (!p || !q) return null
  return { r1: Math.min(p.r, q.r), c1: Math.min(p.c, q.c), r2: Math.max(p.r, q.r), c2: Math.max(p.c, q.c) }
}
