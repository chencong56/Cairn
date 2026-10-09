/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AdapterHelpers, Model, ModelError, ModelCol, ModelRow, TableAdapter } from './types.js'

/** 页面内自包含：只允许使用参数 h 提供的辅助，不得引用模块作用域内的运行时值（见 table-read-dom.ts 的组合方式）。 */
export function extjsAdapter(h: AdapterHelpers): TableAdapter {
  const { textOf, stripSort, isHidden, leafPath, EMPTY_RE } = h
  /** ExtJS 4–6：.x-column-header 叶子表头；每个 grid view（锁定列 / 普通列）里的 tr.x-grid-row 按行序拼接。 */
  const model = (root: any): Model | ModelError => {
    const headers = (Array.from(root.querySelectorAll('.x-column-header')) as any[]).filter(
      (h) => !h.querySelector('.x-column-header') && h.closest('.x-grid') === root,
    )
    const visibleHeaders = headers.filter((h) => !isHidden(h) && h.getClientRects().length > 0)
    const cols: ModelCol[] = visibleHeaders.map((h) => {
      const leaf = stripSort(textOf(h.querySelector('.x-column-header-text-inner,.x-column-header-text') || h))
      const groupHeader = h.parentElement?.closest('.x-column-header')
      const group = groupHeader ? stripSort(textOf(groupHeader.querySelector('.x-column-header-text-inner,.x-column-header-text'))) : ''
      const cls = String(h.className || '')
      return {
        leaf,
        path: leafPath(leaf, group),
        field: h.getAttribute('data-columnid') || h.id || undefined,
        special: /x-column-header-checkbox/.test(cls) ? 'checkbox' : /row-numberer/.test(cls) ? 'index' : undefined,
      }
    })
    const views = (Array.from(root.querySelectorAll('.x-grid-view')) as any[]).filter((v) => v.closest('.x-grid') === root)
    const rowsPerView = views.map((v) =>
      (Array.from(v.querySelectorAll('tr.x-grid-row')) as any[]).filter((tr) => !tr.matches('.x-grid-row-summary')),
    )
    const n = rowsPerView.reduce((m, rs) => Math.max(m, rs.length), 0)
    const cellsOf = (tr: any): any[] => (Array.from(tr.querySelectorAll('td.x-grid-cell')) as any[]).filter((td) => !isHidden(td))
    const dataRows: ModelRow[] = []
    for (let i = 0; i < n; i++) {
      const parts = rowsPerView.map((rs) => rs[i]).filter(Boolean) as any[]
      const cells = parts.flatMap((tr) => cellsOf(tr))
      dataRows.push({ el: parts[parts.length - 1] ?? parts[0], cells: cols.map((_, c) => cells[c] ?? null) })
    }
    const summaryEls = Array.from(root.querySelectorAll('.x-grid-row-summary,.x-docked-summary tr')) as any[]
    const summaryRows: ModelRow[] = summaryEls.map((tr) => {
      const cells = cellsOf(tr)
      return { el: tr, cells: cols.map((_, c) => cells[c] ?? null) }
    })
    return {
      shape: 'extjs',
      cols,
      hasHeader: cols.length > 0,
      dataRows,
      summaryRows,
      excluded: { mergedRows: root.querySelectorAll('.x-grid-group-hd').length, paginationRows: 0, footerRows: summaryRows.length },
      hasPagination: Boolean(root.querySelector('.x-paging-toolbar')) || Boolean(root.parentElement?.querySelector('.x-paging-toolbar')),
      isBusy: Array.from(root.querySelectorAll('.x-mask')).some((m: any) => !isHidden(m)),
      emptyNote: dataRows.length === 0 && (Boolean(root.querySelector('.x-grid-empty')) || EMPTY_RE.test(textOf(root.querySelector('.x-grid-empty')))),
      renderedRowEls: rowsPerView.flat(),
    }
  }
  return {
    shape: 'extjs',
    pagerSelector: '.x-paging-toolbar',
    claimSelector: '.x-grid,.x-grid-panel',
    gridSelector: '.x-grid',
    model,
  }
}
