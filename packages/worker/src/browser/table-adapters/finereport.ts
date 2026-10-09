/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AdapterHelpers, Model, ModelError, ModelCol, ModelRow, TableAdapter } from './types.js'

/** 页面内自包含：只允许使用参数 h 提供的辅助，不得引用模块作用域内的运行时值（见 table-read-dom.ts 的组合方式）。 */
export function finereportAdapter(h: AdapterHelpers): TableAdapter {
  const { textOf, stripSort, isHidden, EMPTY_RE } = h
  /**
   * FineReport（帆软）报表：冻结表由四块 `table.x-table` 拼成（角 / 顶部表头 / 左侧行头 / 中间数据），
   * 每个单元格的 id 形如 `B3-0-2772`（Excel 式列字母 + 行号），靠它把四块对回同一张网格；
   * 表头 = 角与顶部里的行，数据 = 左侧与中间里表头以下的行；rowspan 合并的行头向下补齐。
   */
  const model = (root: any): Model | ModelError => {
    const tables = (String(root.tagName).toLowerCase() === 'table' && root.classList.contains('x-table')
      ? [root]
      : Array.from(root.querySelectorAll('table.x-table'))) as any[]
    if (tables.length === 0) return { error: { code: 'TABLE_SHAPE_UNSUPPORTED', message: '没有找到 FineReport 报表的数据区' } }
    const letters = (s: string): number => s.split('').reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1
    type FCell = { td: any; r: number; c: number; head: boolean; hidden: boolean; rs: number; cs: number }
    const grid = new Map<number, Map<number, FCell>>()
    const put = (cell: FCell, r: number, c: number): void => {
      let row = grid.get(r)
      if (!row) grid.set(r, (row = new Map()))
      if (!row.has(c)) row.set(c, { ...cell, r, c })
    }
    let anyHead = false
    for (const t of tables) {
      const head = Boolean(t.closest('.frozen-corner,.frozen-north'))
      if (head) anyHead = true
      for (const td of Array.from(t.querySelectorAll('td')) as any[]) {
        const m = /^([A-Z]+)(\d+)-/.exec(String(td.id || ''))
        if (!m) continue
        const c = letters(m[1] as string)
        const r = Number(m[2])
        const cell: FCell = { td, r, c, head, hidden: isHidden(td), rs: Math.max(1, Number(td.rowSpan || 1)), cs: Math.max(1, Number(td.colSpan || 1)) }
        for (let i = 0; i < cell.rs; i++) for (let j = 0; j < cell.cs; j++) put(cell, r + i, c + j)
      }
    }
    if (grid.size === 0) return { error: { code: 'TABLE_SHAPE_UNSUPPORTED', message: '这张报表里没有可读取的单元格' } }
    const rowNos = Array.from(grid.keys()).sort((a, b) => a - b)
    const nonEmptyAt = (r: number): number =>
      Array.from(grid.get(r)?.values() || []).filter((x) => !x.hidden && textOf(x.td)).length
    // 表头行：冻结表里是角与顶部的行；不是冻结表时取第一行有内容的行
    let headerRows: number[]
    if (anyHead) headerRows = rowNos.filter((r) => Array.from(grid.get(r)?.values() || []).some((x) => x.head))
    else {
      const first = rowNos.find((r) => nonEmptyAt(r) >= 2)
      headerRows = first === undefined ? [] : [first]
    }
    const textHeaderRows = headerRows.filter((r) => nonEmptyAt(r) > 0)
    const lastHeader = headerRows.length > 0 ? Math.max(...headerRows) : -1
    const colSet = new Set<number>()
    for (const row of grid.values()) for (const c of row.keys()) colSet.add(c)
    const colNos = Array.from(colSet).sort((a, b) => a - b)
    const headText = (r: number, c: number): string => {
      const x = grid.get(r)?.get(c)
      return x && !x.hidden ? stripSort(textOf(x.td)) : ''
    }
    const cols: ModelCol[] = colNos.map((c) => {
      const texts = textHeaderRows.map((r) => headText(r, c)).filter(Boolean)
      const leaf = texts.length > 0 ? (texts[texts.length - 1] as string) : ''
      const up = texts.slice(0, -1).filter((t, i, arr) => t !== leaf && arr.indexOf(t) === i)
      const allHidden = Array.from(grid.values()).every((row) => !row.has(c) || (row.get(c) as FCell).hidden)
      return { leaf, path: up.length > 0 ? `${up.join(' / ')} / ${leaf}` : leaf, hidden: allHidden }
    })
    const dataNos = rowNos.filter((r) => r > lastHeader && nonEmptyAt(r) > 0)
    const dataRows: ModelRow[] = dataNos.map((r) => {
      const row = grid.get(r) as Map<number, FCell>
      const first = Array.from(row.values())[0]
      return { el: first ? first.td.parentElement : null, cells: colNos.map((c) => row.get(c)?.td ?? null) }
    })
    const frozen = root.matches?.('.frozen-table') ? root : root.closest?.('.frozen-table')
    return {
      shape: 'finereport',
      cols,
      hasHeader: textHeaderRows.length > 0,
      dataRows,
      summaryRows: [],
      excluded: { mergedRows: 0, paginationRows: 0, footerRows: 0 },
      hasPagination: false,
      isBusy: false,
      emptyNote: dataRows.length === 0 && EMPTY_RE.test(textOf(frozen || root)),
      renderedRowEls: dataRows.map((r) => r.el).filter(Boolean),
    }
  }
  return {
    shape: 'finereport',
    claimSelector: '.frozen-table,table.x-table',
    gridSelector: '.frozen-table',
    model,
  }
}
