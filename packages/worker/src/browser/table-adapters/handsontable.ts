/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AdapterHelpers, Model, ModelCol, ModelError, ModelRow, TableAdapter } from './types.js'

/** 页面内自包含：只允许使用参数 h 提供的辅助，不得引用模块作用域内的运行时值（见 table-read-dom.ts 的组合方式）。 */
export function handsontableAdapter(h: AdapterHelpers): TableAdapter {
  const { textOf, stripSort, leafPath } = h
  /**
   * Handsontable：容器里有主视图 .ht_master 和为冻结区画的克隆表 .ht_clone_*（内容重复），只读主视图。
   * 单元格没有 field / col-id，列只能靠位置和表头文本映射；表头可能带 colspan 的分组行（被覆盖的格子是 th.hiddenHeader，不参与定位）。
   * 只渲染视口内的行和列：行方向看 wtHolder 滚动高度，列方向比较已渲染表头宽度与滚动宽度。
   * 没有“暂无数据”之类的空态提示，也没有加载中标记：0 行时不自行宣称“确实为空”，由读取计划的 emptyMeansNone 声明。
   */
  const model = (root: any): Model | ModelError => {
    const master = root.matches?.('.ht_master') ? root : root.closest?.('.ht_master') || root.querySelector?.('.ht_master') || root
    const table = master.querySelector('table.htCore')
    if (!table) return { error: { code: 'TABLE_SHAPE_UNSUPPORTED', message: '没有找到 Handsontable 的主视图表格' } }
    const headRows = Array.from(table.querySelectorAll('thead tr')) as any[]
    const bodyRows = Array.from(table.querySelectorAll('tbody tr')) as any[]
    if (headRows.length === 0) return { error: { code: 'TABLE_SHAPE_UNSUPPORTED', message: '这张 Handsontable 没有列表头，无法按列名读取' } }
    // 开了行头时，每个表体行的第一格是 th（行号），表头行最左有一个空角格；容器上有 htRowHeaders 类（空表也成立）
    const rowHeader =
      Boolean(master.parentElement?.classList.contains('htRowHeaders')) ||
      Boolean(bodyRows[0]?.firstElementChild && String(bodyRows[0].firstElementChild.tagName).toUpperCase() === 'TH')
    // 按 colspan 排出每个表头格的起始位置；hiddenHeader 只是被覆盖的占位，跳过
    const placed: Array<Array<{ pos: number; span: number; th: any }>> = headRows.map((tr) => {
      let c = 0
      const out: Array<{ pos: number; span: number; th: any }> = []
      for (const th of Array.from(tr.children) as any[]) {
        if (th.classList.contains('hiddenHeader')) continue
        const span = Math.max(1, Number(th.colSpan || 1))
        out.push({ pos: c, span, th })
        c += span
      }
      return out
    })
    const leafRow = placed[placed.length - 1] as Array<{ pos: number; span: number; th: any }>
    const firstData = rowHeader ? 1 : 0
    const leaves = leafRow.filter((x) => x.pos >= firstData)
    const cols: ModelCol[] = leaves.map(({ pos, th }) => {
      const leaf = stripSort(textOf(th))
      let group: string | undefined
      for (let r = placed.length - 2; r >= 0 && !group; r--) {
        const hit = (placed[r] as Array<{ pos: number; span: number; th: any }>).find((x) => x.pos <= pos && pos < x.pos + x.span)
        const t = hit ? stripSort(textOf(hit.th)) : ''
        if (t) group = t
      }
      return { leaf, path: leafPath(leaf, group), hidden: false }
    })
    const dataRows: ModelRow[] = bodyRows.map((tr) => {
      const cells = (Array.from(tr.children) as any[]).filter((c) => String(c.tagName).toUpperCase() === 'TD')
      return { el: tr, cells: cols.map((_, i) => cells[i] ?? null) }
    })
    const holder = master.querySelector('.wtHolder')
    const renderedWidth = leafRow.reduce((sum, x) => sum + x.th.getBoundingClientRect().width, 0)
    const rowsPartial = Boolean(holder) && holder.scrollHeight > holder.clientHeight + 4
    const colsPartial = Boolean(holder) && holder.scrollWidth - renderedWidth > 24
    return {
      shape: 'handsontable',
      cols,
      hasHeader: cols.length > 0,
      dataRows,
      summaryRows: [],
      excluded: { mergedRows: 0, paginationRows: 0, footerRows: 0 },
      hasPagination: false,
      isBusy: false,
      emptyNote: false,
      renderedRowEls: dataRows.map((r) => r.el),
      virtualHint: rowsPartial || colsPartial,
    }
  }
  const CLONE = '[class*="ht_clone_"]'
  return {
    shape: 'handsontable',
    claimSelector: `.ht_master,${CLONE}`,
    gridSelector: `.ht_master,${CLONE}`,
    // 点到克隆表（冻结区）的格子，归一到同一容器里的主视图
    normalizeRoot: (node: any) => {
      if (node.matches?.('.ht_master')) return node
      const host = node.closest?.(CLONE)?.parentElement
      return host?.querySelector(':scope > .ht_master') || node
    },
    // 挂载容器 → 它里面的主视图
    resolveShell: (node: any) => (node.matches?.('.ht_master') ? null : node.matches?.(CLONE) ? node.parentElement?.querySelector(':scope > .ht_master') || null : node.querySelector?.('.ht_master') || null),
    model,
  }
}
