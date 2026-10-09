/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AdapterHelpers, Model, ModelError, ModelCol, ModelRow, TableAdapter } from './types.js'

/** 页面内自包含：只允许使用参数 h 提供的辅助，不得引用模块作用域内的运行时值（见 table-read-dom.ts 的组合方式）。 */
export function elementuiAdapter(h: AdapterHelpers): TableAdapter {
  const { textOf, stripSort, isHidden, EMPTY_RE, pagerNear } = h
  /**
   * Element UI（Vue 2）el-table：表头和表体是两张分开的 table（header-wrapper / body-wrapper），
   * 列靠 th / td 上相同的 `el-table_<表>_column_<列>` 类名对应；表头最右有一个空的 gutter 列；
   * 合计行在 footer-wrapper；无数据时有 `.el-table__empty-text`，加载时有 `.el-loading-mask`。
   */
  const model = (root: any): Model | ModelError => {
    const headerTable = root.querySelector('.el-table__header-wrapper table')
    const bodyTable = root.querySelector('.el-table__body-wrapper table')
    if (!headerTable || !bodyTable) return { error: { code: 'TABLE_SHAPE_UNSUPPORTED', message: '没有找到 el-table 的表头或表体' } }
    const headRows = Array.from(headerTable.querySelectorAll('thead tr')) as any[]
    if (headRows.length === 0) return { error: { code: 'TABLE_SHAPE_UNSUPPORTED', message: '没有找到 el-table 的表头' } }
    const keyOf = (node: any): string => {
      const hit = (Array.from(node.classList || []) as string[]).find((c) => /^el-table_\d+_column_\d+$/.test(c))
      return hit || ''
    }
    // 叶子列带 is-leaf；被 rowspan 的叶子出现在上面几行里，所以按占位矩阵算每个格子的真实列位置
    type HeadCell = { th: any; r: number; pos: number; cs: number; leaf: boolean }
    const headCells: HeadCell[] = []
    const occupied: boolean[][] = []
    headRows.forEach((tr, r) => {
      occupied[r] = occupied[r] || []
      let c = 0
      for (const th of Array.from(tr.children) as any[]) {
        if (th.classList.contains('gutter')) continue
        while (occupied[r]?.[c]) c++
        const rs = Math.max(1, Number(th.rowSpan || 1))
        const cs = Math.max(1, Number(th.colSpan || 1))
        for (let i = 0; i < rs; i++) {
          occupied[r + i] = occupied[r + i] || []
          for (let j = 0; j < cs; j++) (occupied[r + i] as boolean[])[c + j] = true
        }
        headCells.push({ th, r, pos: c, cs, leaf: th.classList.contains('is-leaf') || (headRows.length === 1) })
        c += cs
      }
    })
    const leafCells = headCells.filter((h) => h.leaf).sort((a, b) => a.pos - b.pos)
    const leafThs = leafCells.map((h) => h.th)
    const cols: ModelCol[] = leafCells.map((h) => {
      const leaf = stripSort(textOf(h.th))
      const groups = headCells
        .filter((g) => !g.leaf && g.r < h.r + 1 && g.pos <= h.pos && h.pos < g.pos + g.cs)
        .sort((x, y) => x.r - y.r)
        .map((g) => stripSort(textOf(g.th)))
        .filter((t) => t && t !== leaf)
      const hasCheckbox = h.th.classList.contains('el-table-column--selection') || Boolean(h.th.querySelector('.el-checkbox'))
      return { leaf, path: groups.length > 0 ? `${groups.join(' / ')} / ${leaf}` : leaf, hidden: isHidden(h.th), special: hasCheckbox ? ('checkbox' as const) : undefined }
    })
    const keys = leafThs.map((th) => keyOf(th))
    const cellsOf = (tr: any): Array<any | null> => {
      const tds = Array.from(tr.children) as any[]
      const byKey: Record<string, any> = {}
      for (const td of tds) {
        const k = keyOf(td)
        if (k) byKey[k] = td
      }
      return keys.map((k, i) => (k ? byKey[k] ?? null : tds[i] ?? null))
    }
    const rowEls = (Array.from(bodyTable.querySelectorAll('tbody > tr')) as any[]).filter(
      (tr) => tr.classList.contains('el-table__row') && !isHidden(tr),
    )
    const dataRows: ModelRow[] = rowEls.map((tr) => ({ el: tr, cells: cellsOf(tr) }))
    const footRows = (Array.from(root.querySelectorAll('.el-table__footer-wrapper tbody tr')) as any[]).map((tr) => ({ el: tr, cells: cellsOf(tr) }))
    const emptyText = root.querySelector('.el-table__empty-text')
    const loading = Array.from(root.querySelectorAll('.el-loading-mask')).some((m: any) => !isHidden(m))
    return {
      shape: 'elementui',
      cols,
      hasHeader: cols.length > 0,
      dataRows,
      summaryRows: footRows,
      excluded: { mergedRows: 0, paginationRows: 0, footerRows: footRows.length },
      hasPagination: pagerNear(root),
      isBusy: loading,
      emptyNote: dataRows.length === 0 && ((Boolean(emptyText) && !isHidden(emptyText)) || EMPTY_RE.test(textOf(root))),
      renderedRowEls: rowEls,
    }
  }
  return {
    shape: 'elementui',
    pagerSelector: '.el-pagination',
    claimSelector: '.el-table',
    gridSelector: '.el-table',
    model,
  }
}
