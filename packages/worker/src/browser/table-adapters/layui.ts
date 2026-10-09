/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AdapterHelpers, Model, ModelError, ModelCol, ModelRow, TableAdapter } from './types.js'

/** 页面内自包含：只允许使用参数 h 提供的辅助，不得引用模块作用域内的运行时值（见 table-read-dom.ts 的组合方式）。 */
export function layuiAdapter(h: AdapterHelpers): TableAdapter {
  const { textOf, stripSort, isHidden, attrSel } = h
  /** layui table：主表头 .layui-table-header、主表体 .layui-table-main，表头与单元格带 data-field。 */
  const model = (root: any): Model | ModelError => {
    const headerTable = root.querySelector('.layui-table-box > .layui-table-header table') || root.querySelector('.layui-table-header table')
    const bodyTable =
      root.querySelector('.layui-table-box > .layui-table-body table') || root.querySelector('.layui-table-main table') || root.querySelector('.layui-table-body table')
    if (!headerTable) return { error: { code: 'TABLE_SHAPE_UNSUPPORTED', message: '没有找到 layui 表格的表头' } }
    const ths = (Array.from(headerTable.querySelectorAll('th[data-field]')) as any[]).filter((th) => !th.classList.contains('layui-hide'))
    const cols: ModelCol[] = ths.map((th) => {
      const field = th.getAttribute('data-field')
      const special = th.classList.contains('layui-table-col-special')
      const hasCheckbox = Boolean(th.querySelector('input[type="checkbox"],.layui-form-checkbox'))
      return {
        leaf: stripSort(textOf(th)),
        path: stripSort(textOf(th)),
        field: field || undefined,
        hidden: isHidden(th),
        special: special && hasCheckbox ? 'checkbox' : undefined,
      }
    })
    const rowEls = bodyTable ? (Array.from(bodyTable.querySelectorAll('tbody tr[data-index]')) as any[]) : []
    const fixedBodies = Array.from(root.querySelectorAll('.layui-table-fixed .layui-table-body tbody')) as any[]
    const cellFor = (tr: any, field: string): any | null => {
      const direct = tr.querySelector(`td${attrSel('data-field', field)}`)
      if (direct && !direct.classList.contains('layui-hide')) return direct
      const idx = tr.getAttribute('data-index')
      for (const fb of fixedBodies) {
        const ftr = fb.querySelector(`tr${attrSel('data-index', idx)}`)
        const c = ftr ? ftr.querySelector(`td${attrSel('data-field', field)}`) : null
        if (c) return c
      }
      return direct
    }
    const dataRows: ModelRow[] = rowEls.map((tr) => ({ el: tr, cells: cols.map((c) => cellFor(tr, c.field as string)) }))
    const totalEls = Array.from(root.querySelectorAll('.layui-table-total tbody tr, .layui-table-total table tr')) as any[]
    const summaryRows: ModelRow[] = totalEls.map((tr) => ({
      el: tr,
      cells: cols.map((c) => tr.querySelector(`td${attrSel('data-field', c.field as string)}`)),
    }))
    const none = root.querySelector('.layui-none')
    return {
      shape: 'layui',
      cols,
      hasHeader: cols.length > 0,
      dataRows,
      summaryRows,
      excluded: { mergedRows: 0, paginationRows: 0, footerRows: summaryRows.length },
      hasPagination: Boolean(root.querySelector('.layui-table-page')),
      isBusy: Array.from(root.querySelectorAll('.layui-table-init')).some((m: any) => !isHidden(m)),
      emptyNote: dataRows.length === 0 && Boolean(none) && !isHidden(none),
      renderedRowEls: rowEls,
    }
  }
  return {
    shape: 'layui',
    claimSelector: '.layui-table-view',
    gridSelector: '.layui-table-view',
    resolveShell: (node: any) => {
      if (!node.matches?.('table.layui-table') || node.closest('.layui-table-view')) return null
      const next = node.nextElementSibling
      return next?.matches?.('.layui-table-view') ? next : null
    },
    model,
  }
}
