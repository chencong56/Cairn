/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AdapterHelpers, Model, ModelCol, ModelError, ModelRow, TableAdapter } from './types.js'

/** 页面内自包含：只允许使用参数 h 提供的辅助，不得引用模块作用域内的运行时值（见 table-read-dom.ts 的组合方式）。 */
export function aggridAdapter(h: AdapterHelpers): TableAdapter {
  const { textOf, stripSort, isHidden, attrSel, leafPath, EMPTY_RE } = h
  /**
   * AG Grid（社区版）：表头叶子 .ag-header-cell[col-id]，按 aria-colindex 排成视觉列序；表体被拆成左固定 / 中间 / 右固定三个容器，
   * 行绝对定位、DOM 顺序不等于视觉顺序，按 row-index 对齐，再按 col-id 在三个容器间取格。行与列都虚拟化：只读已渲染部分，并如实标记。
   */
  const model = (root: any): Model | ModelError => {
    const grid = root.matches?.('.ag-root-wrapper') ? root : root.querySelector('.ag-root-wrapper') || root
    const leafCells = (Array.from(grid.querySelectorAll('.ag-header-row-column .ag-header-cell[col-id]')) as any[])
      .map((c) => ({ c, idx: Number(c.getAttribute('aria-colindex') || 0) }))
      .sort((a, b) => a.idx - b.idx)
      .map((x) => x.c)
    if (leafCells.length === 0) return { error: { code: 'TABLE_SHAPE_UNSUPPORTED', message: '没有找到 AG Grid 的表头' } }
    const groupOf = (leaf: any): string | undefined => {
      const box = leaf.getBoundingClientRect()
      const cx = box.left + box.width / 2
      const hits = (Array.from(grid.querySelectorAll('.ag-header-row-column-group .ag-header-group-cell')) as any[])
        .map((g) => ({ g, r: g.getBoundingClientRect(), t: textOf(g.querySelector('.ag-header-group-text')) }))
        .filter((x) => x.t && x.r.left <= cx && cx <= x.r.right && x.r.top < box.top)
        .sort((a, b) => b.r.top - a.r.top)
      return hits[0]?.t
    }
    const cols: ModelCol[] = leafCells.map((c) => {
      const field = c.getAttribute('col-id') as string
      const leaf = stripSort(textOf(c.querySelector('.ag-header-cell-text')))
      const special = field === 'ag-Grid-SelectionColumn' ? 'checkbox' : /^ag-Grid-(RowNumbers|AutoColumn)/.test(field) ? 'index' : undefined
      return { leaf, path: leafPath(leaf, groupOf(c)), field, hidden: false, special }
    })
    const rowsByIndex = new Map<number, any[]>()
    let groupRows = 0
    for (const r of Array.from(grid.querySelectorAll('.ag-pinned-left-cols-container > .ag-row, .ag-center-cols-container > .ag-row, .ag-pinned-right-cols-container > .ag-row')) as any[]) {
      if (r.classList.contains('ag-row-group')) {
        groupRows++
        continue
      }
      const idx = Number(r.getAttribute('row-index'))
      const list = rowsByIndex.get(idx) ?? []
      list.push(r)
      rowsByIndex.set(idx, list)
    }
    const cellIn = (els: any[], field: string): any | null => {
      for (const e of els) {
        const hit = e.querySelector(`.ag-cell${attrSel('col-id', field)}`)
        if (hit) return hit
      }
      return null
    }
    const dataRows: ModelRow[] = Array.from(rowsByIndex.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, els]) => ({ el: els[els.length > 1 ? 1 : 0], cells: cols.map((c) => cellIn(els, c.field as string)) }))
    // 固定在顶部 / 底部的行（合计）：三个容器里第 i 行属于同一逻辑行
    const pinnedRows = (pos: 'top' | 'bottom'): ModelRow[] => {
      const lists = [`.ag-pinned-left-floating-${pos}`, `.ag-floating-${pos}-container`, `.ag-pinned-right-floating-${pos}`].map(
        (sel) => Array.from(grid.querySelectorAll(`${sel} > .ag-row`)) as any[],
      )
      const n = lists.reduce((m, l) => Math.max(m, l.length), 0)
      const out: ModelRow[] = []
      for (let i = 0; i < n; i++) {
        const els = lists.map((l) => l[i]).filter(Boolean)
        out.push({ el: els[0], cells: cols.map((c) => cellIn(els, c.field as string)) })
      }
      return out
    }
    const summaryRows = [...pinnedRows('top'), ...pinnedRows('bottom')]
    // 只认渲染出来的文字（innerText）：隐藏的遮罩可能残留文本节点，textOf 会回退到 textContent 把它算进去
    const overlayText = (sel: string): string => String(grid.querySelector(sel)?.innerText ?? '').trim()
    const pager = grid.querySelector('.ag-paging-panel')
    // 虚拟化：行——aria-rowcount 远大于已渲染行；列——表头叶子少于 aria-colcount
    const rowCount = Number(grid.querySelector('[aria-rowcount]')?.getAttribute('aria-rowcount') || 0)
    const colCount = Number(grid.querySelector('[aria-colcount]')?.getAttribute('aria-colcount') || 0)
    const rowsMissing = rowCount > 0 && rowCount - dataRows.length - summaryRows.length - 1 > 2
    const colsMissing = colCount > 0 && leafCells.length < colCount
    return {
      shape: 'aggrid',
      cols,
      hasHeader: true,
      dataRows,
      summaryRows,
      excluded: { mergedRows: groupRows, paginationRows: 0, footerRows: summaryRows.length },
      hasPagination: Boolean(pager) && !isHidden(pager),
      isBusy: overlayText('.ag-overlay-loading-wrapper') !== '',
      emptyNote: dataRows.length === 0 && (overlayText('.ag-overlay-no-rows-wrapper') !== '' || EMPTY_RE.test(textOf(grid))),
      renderedRowEls: dataRows.map((r) => r.el).filter(Boolean),
      virtualHint: rowsMissing || colsMissing,
    }
  }
  return {
    shape: 'aggrid',
    pagerSelector: '.ag-paging-panel',
    claimSelector: '.ag-root-wrapper,.ag-root',
    gridSelector: '.ag-root-wrapper',
    innerPartSelector: '.ag-body-viewport,.ag-header,.ag-center-cols-viewport,.ag-center-cols-container',
    normalizeRoot: (node: any) => node.closest?.('.ag-root-wrapper') || node,
    // 挂载容器（用户常把选择器写在它上面）→ 它里面的控件根
    resolveShell: (node: any) => (node.matches?.('.ag-root-wrapper') ? null : node.querySelector?.('.ag-root-wrapper') || null),
    model,
  }
}
