/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AdapterHelpers, Model, ModelError, ModelCol, ModelRow, TableAdapter } from './types.js'

/** 页面内自包含：只允许使用参数 h 提供的辅助，不得引用模块作用域内的运行时值（见 table-read-dom.ts 的组合方式）。 */
export function easyuiAdapter(h: AdapterHelpers): TableAdapter {
  const { textOf, stripSort, isHidden, attrSel, EMPTY_RE } = h
  /** easyui datagrid：view1 冻结列、view2 主列；表头与表体分离，单元格带 field 属性。 */
  const model = (root: any): Model | ModelError => {
    const views = [root.querySelector('.datagrid-view1'), root.querySelector('.datagrid-view2')].filter(Boolean) as any[]
    if (views.length === 0) return { error: { code: 'TABLE_SHAPE_UNSUPPORTED', message: '没有找到 easyui 表格的主体区域' } }
    const cols: Array<ModelCol & { view: number }> = []
    views.forEach((v, vi) => {
      const headerTable = v.querySelector('.datagrid-header table')
      if (!headerTable) return
      // 分组表头里 rowspan / colspan 会让叶子在 DOM 里的顺序和视觉列序不一致：按占位矩阵算出真实列位置再排序
      const occupied: boolean[][] = []
      const leaves: Array<{ pos: number; td: any }> = []
      ;(Array.from(headerTable.querySelectorAll('tr')) as any[]).forEach((tr, r) => {
        occupied[r] = occupied[r] || []
        let c = 0
        for (const td of Array.from(tr.children) as any[]) {
          while (occupied[r]?.[c]) c++
          const rs = Math.max(1, Number(td.rowSpan || 1))
          const cs = Math.max(1, Number(td.colSpan || 1))
          for (let i = 0; i < rs; i++) {
            occupied[r + i] = occupied[r + i] || []
            for (let j = 0; j < cs; j++) (occupied[r + i] as boolean[])[c + j] = true
          }
          if (td.getAttribute('field')) leaves.push({ pos: c, td })
          c += cs
        }
      })
      leaves.sort((a, b) => a.pos - b.pos)
      for (const { td } of leaves) {
        const field = td.getAttribute('field') as string
        const leaf = stripSort(textOf(td))
        cols.push({ leaf, path: leaf, field, hidden: isHidden(td), special: field === 'ck' ? 'checkbox' : undefined, view: vi })
      }
    })
    const bodyRows = views.map((v) => Array.from(v.querySelectorAll('.datagrid-body tr.datagrid-row')) as any[])
    const n = bodyRows.reduce((m, rs) => Math.max(m, rs.length), 0)
    const cellOf = (view: number, rows: any[][], i: number, field: string): any | null => {
      const tr = rows[view]?.[i]
      return tr ? tr.querySelector(`td${attrSel('field', field)}`) : null
    }
    const dataRows: ModelRow[] = []
    for (let i = 0; i < n; i++) {
      const rowEl = (bodyRows[bodyRows.length - 1] as any[])[i] ?? (bodyRows[0] as any[])[i]
      dataRows.push({ el: rowEl, cells: cols.map((c) => cellOf(c.view, bodyRows, i, c.field as string)) })
    }
    const footRows = views.map((v) => Array.from(v.querySelectorAll('.datagrid-footer tr')) as any[])
    const fn = footRows.reduce((m, rs) => Math.max(m, rs.length), 0)
    const summaryRows: ModelRow[] = []
    for (let i = 0; i < fn; i++) {
      summaryRows.push({
        el: (footRows[footRows.length - 1] as any[])[i] ?? (footRows[0] as any[])[i],
        cells: cols.map((c) => cellOf(c.view, footRows, i, c.field as string)),
      })
    }
    return {
      shape: 'easyui',
      cols,
      hasHeader: cols.length > 0,
      dataRows,
      summaryRows,
      excluded: { mergedRows: root.querySelectorAll('.datagrid-group').length, paginationRows: 0, footerRows: summaryRows.length },
      hasPagination: Boolean(root.querySelector('.datagrid-pager,.pagination')),
      isBusy: Array.from(root.querySelectorAll('.datagrid-mask,.datagrid-mask-msg')).some((m: any) => !isHidden(m)),
      emptyNote: dataRows.length === 0 && (Boolean(root.querySelector('.datagrid-empty')) || EMPTY_RE.test(textOf(root))),
      renderedRowEls: dataRows.map((r) => r.el).filter(Boolean),
    }
  }
  return {
    shape: 'easyui',
    pagerSelector: '.datagrid-pager',
    // treegrid：树列里每层一个 span.tree-indent，父节点用 span.tree-hit（tree-expanded / tree-collapsed）代替最后一个缩进位
    rowLevel: (rowEl: any) => {
      const indents = rowEl?.querySelectorAll?.('span.tree-indent').length ?? 0
      const hit = rowEl?.querySelector?.('span.tree-hit')
      if (!indents && !hit) return null
      return {
        level: Math.max(0, indents + (hit ? 1 : 0) - 1),
        hasChildren: Boolean(hit),
        ...(hit ? { expanded: hit.classList.contains('tree-expanded') } : {}),
      }
    },
    claimSelector: '.datagrid-wrap,.datagrid-view,.datagrid',
    gridSelector: '.datagrid-wrap,.datagrid-view',
    innerPartSelector: 'table.datagrid-btable,table.datagrid-htable',
    normalizeRoot: (node: any) => (node.matches?.('.datagrid-view,.datagrid') ? node.closest('.datagrid-wrap') || node : node),
    // easyui 初始化后原始 table.datagrid-f 留作隐藏空壳，渲染结构在它后面的兄弟节点里
    resolveShell: (node: any) => {
      if (!node.matches?.('table.datagrid-f')) return null
      const next = node.nextElementSibling
      return (next?.matches?.('.datagrid-wrap') ? next : next?.querySelector?.('.datagrid-wrap')) || null
    },
    model,
  }
}
