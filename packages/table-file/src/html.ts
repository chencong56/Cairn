import { parse } from 'parse5'
import { cleanText, fileError, type Grid, type GridError, type Merge } from './grid.js'

/* parse5 的节点只用到这几个字段 */
type Node = { nodeName: string; tagName?: string; value?: string; attrs?: Array<{ name: string; value: string }>; childNodes?: Node[] }

const attr = (n: Node, name: string): string | undefined => n.attrs?.find((a) => a.name === name)?.value

function textOf(n: Node): string {
  if (n.nodeName === '#text') return n.value ?? ''
  if (n.nodeName === 'script' || n.nodeName === 'style' || n.nodeName === 'template') return ''
  if (n.nodeName === 'br') return ' '
  // 嵌套的表格不算在格子文字里
  if (n.nodeName === 'table') return ''
  const inner = (n.childNodes ?? []).map(textOf).join('')
  return /^(p|div|li|tr)$/.test(n.nodeName) ? ` ${inner} ` : inner
}

function collect(n: Node, name: string, out: Node[], stopAt?: string): void {
  for (const c of n.childNodes ?? []) {
    if (c.nodeName === name) out.push(c)
    if (stopAt && c.nodeName === stopAt) continue
    collect(c, name, out, stopAt)
  }
}

/** 这张表自己的行（不进嵌套表格），以及每行是否在 thead 里。 */
function ownRows(table: Node): Array<{ tr: Node; head: boolean }> {
  const out: Array<{ tr: Node; head: boolean }> = []
  const walk = (n: Node, head: boolean): void => {
    for (const c of n.childNodes ?? []) {
      if (c.nodeName === 'table') continue
      if (c.nodeName === 'tr') out.push({ tr: c, head })
      else walk(c, head || c.nodeName === 'thead')
    }
  }
  walk(table, false)
  return out
}

/** 一张表 → 网格：按 rowspan / colspan 排出格子位置，合并区记下来。 */
function tableToGrid(table: Node, maxRows: number): Grid {
  const rows: string[][] = []
  const merges: Merge[] = []
  const occupied: boolean[][] = []
  const own = ownRows(table)
  let headCount = 0
  let headStart = -1
  let truncated = false
  own.forEach(({ tr, head }, r) => {
    if (r >= maxRows) {
      truncated = true
      return
    }
    if (head) {
      if (headStart < 0) headStart = r
      headCount++
    }
    rows[r] = rows[r] ?? []
    occupied[r] = occupied[r] ?? []
    let c = 0
    for (const cell of (tr.childNodes ?? []).filter((x) => x.nodeName === 'td' || x.nodeName === 'th')) {
      while (occupied[r]?.[c]) c++
      const rs = Math.max(1, Math.min(1000, Number(attr(cell, 'rowspan') ?? 1) || 1))
      const cs = Math.max(1, Math.min(256, Number(attr(cell, 'colspan') ?? 1) || 1))
      ;(rows[r] as string[])[c] = cleanText(textOf(cell))
      for (let i = 0; i < rs; i++) {
        occupied[r + i] = occupied[r + i] ?? []
        for (let j = 0; j < cs; j++) (occupied[r + i] as boolean[])[c + j] = true
      }
      if (rs > 1 || cs > 1) merges.push({ r1: r, c1: c, r2: r + rs - 1, c2: c + cs - 1 })
      c += cs
    }
  })
  const filled = rows.map((r) => Array.from(r ?? [], (v) => v ?? ''))
  return {
    rows: filled,
    merges,
    clues: [],
    ...(headCount > 0 && headStart === 0 ? { headerHint: { start: 0, count: headCount } } : {}),
    ...(truncated ? { truncated: true } : {}),
  }
}

/**
 * HTML 伪 XLS（老系统“导出 Excel”常见的实际是一张 HTML 表格）→ 网格。不执行任何脚本，只读结构与文字。
 * 有多张表时取“多列数据行”最多的那张（排版用的外层表格通常只有一两列）。
 */
export function readHtmlTable(text: string, maxRows: number): { ok: true; grid: Grid; tableCount: number } | GridError {
  const doc = parse(text) as unknown as Node
  const tables: Node[] = []
  collect(doc, 'table', tables)
  if (tables.length === 0) return fileError('TABLE_FILE_NO_TABLE', '文件里没有表格')
  let best: { grid: Grid; score: number } | null = null
  for (const t of tables) {
    const grid = tableToGrid(t, maxRows)
    const score = grid.rows.filter((r) => r.filter((v) => v !== '').length >= 2).length
    if (!best || score > best.score) best = { grid, score }
  }
  return { ok: true, grid: (best as { grid: Grid }).grid, tableCount: tables.length }
}
