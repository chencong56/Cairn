/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AdapterHelpers, Model, ModelError, ModelCol, ModelRow, TableAdapter } from './types.js'

/** 页面内自包含：只允许使用参数 h 提供的辅助，不得引用模块作用域内的运行时值（见 table-read-dom.ts 的组合方式）。 */
export function jqgridAdapter(h: AdapterHelpers): TableAdapter {
  const { textOf, stripSort, isHidden, leafPath, EMPTY_RE } = h
  /** jqGrid：表头 .ui-jqgrid-htable、表体 table.ui-jqgrid-btable 的 tr.jqgrow；分组行 jqgroup 不计入。 */
  const model = (root: any): Model | ModelError => {
    const headerTable = root.querySelector('table.ui-jqgrid-htable')
    const bodyTable = root.querySelector('table.ui-jqgrid-btable')
    if (!headerTable || !bodyTable) return { error: { code: 'TABLE_SHAPE_UNSUPPORTED', message: '没有找到 jqGrid 的表头或表体' } }
    const gridId = String(bodyTable.id || '').trim()
    const labelRow = headerTable.querySelector('tr.ui-jqgrid-labels') || headerTable.querySelector('tr:last-child')
    const ths = Array.from(labelRow.querySelectorAll('th')) as any[]
    // 分组表头：第二行表头里带 colspan 的格子
    const groupRow = headerTable.querySelector('tr.jqg-second-row-header')
    const groupOfCol: string[] = []
    if (groupRow) {
      let c = 0
      for (const th of Array.from(groupRow.querySelectorAll('th')) as any[]) {
        const span = Math.max(1, Number(th.colSpan || 1))
        const gt = stripSort(textOf(th))
        for (let j = 0; j < span; j++) groupOfCol[c + j] = span > 1 ? gt : ''
        c += span
      }
    }
    const cols: ModelCol[] = ths.map((th, c) => {
      const leaf = stripSort(textOf(th.querySelector('.ui-jqgrid-sortable') || th))
      const idAttr = String(th.id || '')
      const field = gridId && idAttr.startsWith(`${gridId}_`) ? idAttr.slice(gridId.length + 1) : idAttr || undefined
      return {
        leaf,
        path: leafPath(leaf, groupOfCol[c]),
        field,
        hidden: th.style?.display === 'none' || isHidden(th),
        special: field === 'cb' ? 'checkbox' : field === 'rn' ? 'index' : undefined,
      }
    })
    const rowEls = Array.from(bodyTable.querySelectorAll('tr.jqgrow')) as any[]
    const dataRows: ModelRow[] = rowEls.map((tr) => {
      const tds = Array.from(tr.cells || []) as any[]
      return { el: tr, cells: cols.map((_, c) => tds[c] ?? null) }
    })
    const footTable = root.querySelector('.ui-jqgrid-sdiv table')
    const summaryRows: ModelRow[] = footTable
      ? (Array.from(footTable.querySelectorAll('tr')) as any[]).map((tr) => {
          const tds = Array.from(tr.cells || []) as any[]
          return { el: tr, cells: cols.map((_, c) => tds[c] ?? null) }
        })
      : []
    const info = textOf(root.querySelector('.ui-paging-info'))
    return {
      shape: 'jqgrid',
      cols,
      hasHeader: cols.length > 0,
      dataRows,
      summaryRows,
      excluded: { mergedRows: bodyTable.querySelectorAll('tr.jqgroup').length, paginationRows: 0, footerRows: summaryRows.length },
      hasPagination: Boolean(root.querySelector('.ui-jqgrid-pager,.ui-pg-table')),
      isBusy: Array.from(root.querySelectorAll('div.loading')).some((m: any) => !isHidden(m)),
      emptyNote: dataRows.length === 0 && (EMPTY_RE.test(info) || Boolean(root.querySelector('.ui-jqgrid-nodata'))),
      renderedRowEls: rowEls,
    }
  }
  return {
    shape: 'jqgrid',
    claimSelector: '.ui-jqgrid,.ui-jqgrid-view',
    gridSelector: '.ui-jqgrid',
    innerPartSelector: 'table.ui-jqgrid-btable,table.ui-jqgrid-htable',
    model,
  }
}
