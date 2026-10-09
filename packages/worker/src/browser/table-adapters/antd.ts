/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AdapterHelpers, Model, ModelCol, ModelError, ModelRow, TableAdapter } from './types.js'

/** 页面内自包含：只允许使用参数 h 提供的辅助，不得引用模块作用域内的运行时值（见 table-read-dom.ts 的组合方式）。 */
export function antdAdapter(h: AdapterHelpers): TableAdapter {
  const { textOf, stripSort, EMPTY_RE, leafPath } = h
  /**
   * Ant Design Table（v4 / v5）：表头在 thead（固定表头时是单独的一张 table，靠 colgroup 与表体对齐）；表体 tr.ant-table-row，
   * 排除测量行 / 空态行 / 展开行；合计在 .ant-table-summary（固定时是单独的 table）；虚拟列表（virtual）改为 div 结构，仍是 .ant-table-row。
   */
  const model = (root: any): Model | ModelError => {
    const wrapper = root.matches?.('.ant-table-wrapper') ? root : root.closest?.('.ant-table-wrapper') || root
    const own = (n: any): boolean => n.closest('.ant-table-wrapper') === wrapper // 排除展开行里嵌套的子表
    const headRows = (Array.from(wrapper.querySelectorAll('thead tr')) as any[]).filter(own)
    if (headRows.length === 0) return { error: { code: 'TABLE_SHAPE_UNSUPPORTED', message: '没有找到 Ant Design Table 的表头' } }
    // 占位矩阵：分组表头的叶子取最底层，分组名取正上方那一格
    const occupied: any[][] = []
    const leaves: Array<{ pos: number; row: number; th: any }> = []
    headRows.forEach((tr, r) => {
      occupied[r] = occupied[r] || []
      let c = 0
      for (const th of Array.from(tr.children) as any[]) {
        while (occupied[r]?.[c]) c++
        const rs = Math.max(1, Number(th.rowSpan || 1))
        const cs = Math.max(1, Number(th.colSpan || 1))
        for (let i = 0; i < rs; i++) {
          occupied[r + i] = occupied[r + i] || []
          for (let j = 0; j < cs; j++) (occupied[r + i] as any[])[c + j] = th
        }
        if (r + rs >= headRows.length && cs === 1) leaves.push({ pos: c, row: r, th })
        c += cs
      }
    })
    leaves.sort((a, b) => a.pos - b.pos)
    const cols: ModelCol[] = leaves.map(({ pos, row, th }) => {
      const leaf = stripSort(textOf(th))
      let group: string | undefined
      for (let r = row - 1; r >= 0 && !group; r--) {
        const above = occupied[r]?.[pos]
        if (above && above !== th) group = stripSort(textOf(above))
      }
      const special = th.classList.contains('ant-table-selection-column')
        ? 'checkbox'
        : th.classList.contains('ant-table-row-expand-icon-cell')
          ? 'index'
          : undefined
      return { leaf, path: leafPath(leaf, group), hidden: false, special }
    })
    const virtualBody = wrapper.querySelector('.ant-table-tbody-virtual')
    const rowEls = (Array.from(wrapper.querySelectorAll(virtualBody ? '.ant-table-tbody-virtual .ant-table-row' : 'tbody tr.ant-table-row')) as any[]).filter(own)
    const cellsOf = (tr: any): Array<any | null> => {
      const out: Array<any | null> = []
      for (const td of Array.from(tr.children) as any[]) {
        out.push(td)
        for (let k = 1; k < Math.max(1, Number(td.colSpan || 1)); k++) out.push(null)
      }
      return out
    }
    const dataRows: ModelRow[] = rowEls.map((tr) => ({ el: tr, cells: cellsOf(tr) }))
    const summaryRows: ModelRow[] = (Array.from(wrapper.querySelectorAll('.ant-table-summary tr')) as any[])
      .filter(own)
      .map((tr) => ({ el: tr, cells: cellsOf(tr) }))
    const expanded = (Array.from(wrapper.querySelectorAll('tr.ant-table-expanded-row')) as any[]).filter(own).length
    const placeholder = (Array.from(wrapper.querySelectorAll('tr.ant-table-placeholder, .ant-table-tbody-virtual .ant-empty')) as any[]).filter(own)
    const spin = (Array.from(wrapper.querySelectorAll('.ant-spin-spinning')) as any[]).filter(own)
    return {
      shape: 'antd',
      cols,
      hasHeader: cols.length > 0,
      dataRows,
      summaryRows,
      excluded: { mergedRows: expanded, paginationRows: 0, footerRows: summaryRows.length },
      hasPagination: (Array.from(wrapper.querySelectorAll('.ant-pagination')) as any[]).some(own),
      isBusy: spin.length > 0,
      emptyNote: dataRows.length === 0 && (placeholder.length > 0 || EMPTY_RE.test(textOf(wrapper))),
      renderedRowEls: rowEls,
      virtualHint: Boolean(virtualBody),
    }
  }
  return {
    shape: 'antd',
    pagerSelector: '.ant-pagination',
    claimSelector: '.ant-table-wrapper',
    gridSelector: '.ant-table-wrapper',
    innerPartSelector: '.ant-table,.ant-table-container,.ant-table-header,.ant-table-body,.ant-table-content',
    normalizeRoot: (node: any) => node.closest?.('.ant-table-wrapper') || node,
    // 挂载容器 → 它里面的控件根
    resolveShell: (node: any) => (node.matches?.('.ant-table-wrapper') ? null : node.querySelector?.('.ant-table-wrapper') || null),
    model,
  }
}
