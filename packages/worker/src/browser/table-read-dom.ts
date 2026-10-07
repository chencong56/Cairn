/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * table.read@2 的页面内逻辑。
 *
 * `tableDomEntry` 会被 Playwright 序列化后在页面（或 frame）内执行：必须自包含，
 * 不得引用模块作用域内的任何变量或类型运行时值。读取、识别、反馈三种模式共用同一套
 * 辅助函数与“形态适配器 → 统一模型”的结构，所以放在同一个函数里。
 *
 * 形态适配器依据各控件官方默认 DOM 约定编写（原生表格、ARIA 网格、easyui、jqGrid、
 * ExtJS 4–6、layui、Element UI el-table、FineReport 冻结表）；版本差异靠手工指定与页面结构反馈迭代。
 */

export type TableShape = 'native' | 'aria' | 'easyui' | 'jqgrid' | 'extjs' | 'layui' | 'elementui' | 'finereport' | 'cards' | 'keyvalue'
export type ReadKind = 'table' | 'cards' | 'keyvalue'

export type DomColumnSpec = {
  key: string
  name: string
  field?: string
  source?: 'header' | 'index'
  index?: number
  selector?: string
  valueType: 'text' | 'number' | 'boolean' | 'date'
  sensitive?: boolean
  scaleUnits?: boolean
}

export type ReadTableArgs = {
  /** 缺省按表格读；cards / keyvalue 走“名称：值”适配器。 */
  kind?: ReadKind
  columns: DomColumnSpec[]
  rowSelector?: string
  header: 'auto' | 'first_row' | 'none'
  excludeHeader: boolean
  maxRows: number
  emptySelector?: string
  loadingSelector?: string
  emptyMeansNone?: boolean
  totalRow?: { columnKey: string; equals: string }
}

export type DomField = {
  value: string | number | boolean | null
  rawText?: string
  decimalValue?: string
  status: 'ok' | 'missing' | 'error' | 'masked'
}

export type DomRow = { values: Record<string, DomField>; rawDigest: string }

export type ReadTableResult =
  | {
      ok: true
      shape: TableShape
      isBusy: boolean
      emptyVerified: boolean
      hasPagination: boolean
      virtualScroll: boolean
      headerDigest: string
      totalDataRows: number
      rows: DomRow[]
      summaryRows: DomRow[]
      excluded: { mergedRows: number; paginationRows: number; footerRows: number }
      colCount: number
    }
  | { ok: false; code: string; message: string }

export type DetectArgs = { sampleRows: number; forceRoot?: boolean }

export type DetectedColumn = {
  index: number
  key: string
  name: string
  groupPath?: string
  field?: string
  source: 'header' | 'index'
  valueType: 'text' | 'number' | 'boolean' | 'date'
  numericKind?: 'integer' | 'decimal'
  excludedReason?: 'checkbox' | 'index' | 'action' | 'hidden'
  /** 表头为空或重名，只能按第几列取。 */
  indexOnly?: boolean
}

export type DetectCandidate = {
  selector: string
  selectorQuality: 'stable' | 'positional'
  title?: string
  rowCount: number
  colCount: number
  score: number
  tagName: string
  isNative: boolean
  level: 'inner' | 'outer' | 'chosen'
}

export type DetectResult =
  | {
      ok: true
      chosen: DetectCandidate & {
        shape: TableShape
        hasHeader: boolean
        headerMode: 'auto' | 'none'
        columns: DetectedColumn[]
      }
      alternatives: DetectCandidate[]
    }
  | { ok: false; code: string; message: string }

export type TableDomRequest =
  | { mode: 'read'; read: ReadTableArgs }
  | { mode: 'detect'; detect: DetectArgs }
  | { mode: 'feedback' }

/** 页面内入口。mode=read 在表根上执行；mode=detect / feedback 在被点到的元素上执行。 */
export function tableDomEntry(el: any, req: TableDomRequest): any {
  // ---------------------------------------------------------------- 通用辅助
  const clean = (t: any): string =>
    String(t ?? '')
      .replace(/\u00a0/g, ' ')
      .replace(/\u3000/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  const textOf = (node: any): string => clean(node ? node.innerText || node.textContent || '' : '')
  const stripSort = (t: string): string => clean(t.replace(/[▲▼△▽↑↓⇅⇧⇩↕]+/g, ''))
  const roleOf = (node: any): string => String(node?.getAttribute?.('role') || '').toLowerCase()
  const doc: any = el.ownerDocument
  const win: any = doc.defaultView
  const isHidden = (node: any): boolean => {
    if (!node) return true
    const st = win.getComputedStyle(node)
    return st.display === 'none' || st.visibility === 'hidden'
  }
  const attrSel = (name: string, value: string): string => `[${name}="${String(value).replace(/["\\]/g, '\\$&')}"]`
  const PAGER_RE =
    /(上一页|下一页|首页|尾页|末页|每页\s*\d+|共\s*\d+\s*(条|页|行|个)|第\s*\d+\s*[/／]\s*\d+\s*页|previous|next\s*page)/i
  const EMPTY_RE = /(暂无数据|没有数据|无数据|暂无记录|没有记录|无记录|no\s*(data|records|results)|empty)/i
  const PAGER_SEL =
    '.pagination,.pager,.pagenav,.datagrid-pager,.ui-jqgrid-pager,.x-paging-toolbar,.layui-table-page,[class*="pagination"],[class*="pager"],[class*="Pager"]'
  /** 这张表自己的分页条：在表内，或紧挨着它的前 / 后一个兄弟（不能在整个父容器里找，否则同页别的表的分页条会被算到这张表头上）。 */
  const pagerNear = (node: any): boolean => {
    const hit = (n: any): boolean => Boolean(n && (n.matches?.(PAGER_SEL) || n.querySelector?.(PAGER_SEL)))
    return hit(node) || hit(node.nextElementSibling) || hit(node.previousElementSibling)
  }
  const TOTAL_RE = /^(合计|总计|小计|汇总|合\s*计|总\s*计|total|sum|subtotal)\s*[:：]?$/i
  const GRID_SEL = '.datagrid-wrap,.datagrid-view,.ui-jqgrid,.x-grid,.layui-table-view,.el-table,.frozen-table'
  const CHECKBOX_SEL = 'input[type="checkbox"],input[type="radio"],.layui-form-checkbox,.x-grid-row-checker,.cbox,.datagrid-cell-check'

  // ---------------------------------------------------------------- 统一模型
  type ModelCol = { leaf: string; path: string; field?: string; hidden?: boolean; special?: 'checkbox' | 'index' }
  type ModelRow = { el: any; cells: Array<any | null> }
  type Model = {
    shape: TableShape
    cols: ModelCol[]
    hasHeader: boolean
    dataRows: ModelRow[]
    summaryRows: ModelRow[]
    excluded: { mergedRows: number; paginationRows: number; footerRows: number }
    hasPagination: boolean
    isBusy: boolean
    emptyNote: boolean
    renderedRowEls: any[]
  }
  type ModelError = { error: { code: string; message: string } }

  const shapeOf = (root: any): TableShape | null => {
    if (root.matches?.('.datagrid-wrap,.datagrid-view,.datagrid')) return 'easyui'
    if (root.matches?.('.ui-jqgrid,.ui-jqgrid-view')) return 'jqgrid'
    if (root.matches?.('.x-grid,.x-grid-panel')) return 'extjs'
    if (root.matches?.('.layui-table-view')) return 'layui'
    if (root.matches?.('.el-table')) return 'elementui'
    if (root.matches?.('.frozen-table') || root.matches?.('table.x-table')) return 'finereport'
    const tag = String(root.tagName || '').toLowerCase()
    if (tag === 'table') return 'native'
    const r = roleOf(root)
    if (r === 'grid' || r === 'table' || r === 'treegrid') return 'aria'
    return null
  }

  const leafPath = (leaf: string, group?: string): string => (group && group !== leaf ? `${group} / ${leaf}` : leaf)

  /** 原生表格与 ARIA 网格：展开 rowspan / colspan 的格子矩阵，取叶子表头。 */
  const nativeModel = (
    root: any,
    shape: 'native' | 'aria',
    hint: { header: 'auto' | 'first_row' | 'none'; rowSelector?: string },
  ): Model | ModelError => {
    const isNative = shape === 'native'
    type RowItem = { el: any; section: 'head' | 'body' | 'foot' }
    let rowItems: RowItem[] = []
    if (isNative) {
      rowItems = (Array.from(root.rows || []) as any[]).map((tr) => {
        const parentTag = String(tr.parentElement?.tagName || '').toUpperCase()
        return { el: tr, section: parentTag === 'THEAD' ? 'head' : parentTag === 'TFOOT' ? 'foot' : 'body' } as RowItem
      })
    } else {
      const all = Array.from(root.querySelectorAll('[role="row"]')) as any[]
      const own = all.filter((r) => {
        let p = r.parentElement
        while (p && p !== root) {
          const rl = roleOf(p)
          if (rl === 'grid' || rl === 'table' || rl === 'treegrid') return false
          p = p.parentElement
        }
        return true
      })
      rowItems = own.map((r) => ({ el: r, section: r.querySelector('[role="columnheader"]') ? 'head' : 'body' }) as RowItem)
    }
    if (hint.rowSelector) {
      const keep = new Set(Array.from(root.querySelectorAll(hint.rowSelector)))
      rowItems = rowItems.filter((r) => r.section === 'head' || keep.has(r.el))
    }
    if (rowItems.length === 0) {
      return { error: { code: 'TABLE_SHAPE_UNSUPPORTED', message: '没有读到任何表格行，这个区域不像是表格' } }
    }
    type Cell = { el: any; origin: boolean }
    const cellsOfRow = (tr: any): any[] =>
      isNative
        ? (Array.from(tr.cells || []) as any[])
        : (Array.from(tr.querySelectorAll('[role="cell"],[role="gridcell"],[role="columnheader"],[role="rowheader"]')) as any[])
    const grid: Array<Array<Cell | undefined>> = []
    rowItems.forEach((item, r) => {
      const gridRow: Array<Cell | undefined> = (grid[r] = grid[r] || [])
      let c = 0
      for (const cell of cellsOfRow(item.el)) {
        while (gridRow[c]) c++
        const rs = Math.max(1, Number(cell.rowSpan || cell.getAttribute?.('aria-rowspan') || 1) || 1)
        const cs = Math.max(1, Number(cell.colSpan || cell.getAttribute?.('aria-colspan') || 1) || 1)
        for (let i = 0; i < rs && r + i < rowItems.length; i++) {
          grid[r + i] = grid[r + i] || []
          for (let j = 0; j < cs; j++) (grid[r + i] as Array<Cell | undefined>)[c + j] = { el: cell, origin: i === 0 && j === 0 }
        }
        c += cs
      }
    })
    const colCount = grid.reduce((m, row) => Math.max(m, row ? row.length : 0), 0)
    const isThCell = (cell: any): boolean => String(cell.tagName || '').toUpperCase() === 'TH' || roleOf(cell) === 'columnheader'
    let headRows: number[] = []
    if (hint.header !== 'none') {
      headRows = rowItems.map((it, i) => (it.section === 'head' ? i : -1)).filter((i) => i >= 0)
      if (headRows.length === 0) {
        if (hint.header === 'first_row') {
          const firstBody = rowItems.findIndex((it) => it.section === 'body')
          if (firstBody >= 0) headRows = [firstBody]
        } else {
          for (let i = 0; i < rowItems.length; i++) {
            const ri = rowItems[i] as RowItem
            if (ri.section !== 'body') break
            const cells = cellsOfRow(ri.el)
            if (cells.length > 0 && cells.every(isThCell)) headRows.push(i)
            else break
          }
        }
      }
    }
    const headerSet = new Set(headRows)
    const cols: ModelCol[] = []
    for (let c = 0; c < colCount; c++) {
      const parts: string[] = []
      for (const r of headRows) {
        const cell = grid[r]?.[c]
        if (!cell) continue
        const t = stripSort(textOf(cell.el))
        if (t && parts[parts.length - 1] !== t) parts.push(t)
      }
      cols.push({ leaf: parts.length ? (parts[parts.length - 1] as string) : '', path: parts.join(' / ') })
    }
    const excluded = { mergedRows: 0, paginationRows: 0, footerRows: 0 }
    const dataRows: ModelRow[] = []
    const summaryRows: ModelRow[] = []
    let sawEmptyNote = false
    const toModelRow = (r: number): ModelRow => ({
      el: (rowItems[r] as RowItem).el,
      cells: Array.from({ length: colCount }, (_, c) => grid[r]?.[c]?.el ?? null),
    })
    for (let r = 0; r < rowItems.length; r++) {
      const item = rowItems[r] as RowItem
      if (headerSet.has(r) || item.section === 'head') continue
      if (item.section === 'foot') {
        excluded.footerRows++
        summaryRows.push(toModelRow(r))
        continue
      }
      const origins = (grid[r] || []).filter((c): c is Cell => Boolean(c && c.origin))
      const text = textOf(item.el)
      const hasPager = Boolean(item.el.querySelector?.(PAGER_SEL)) || (PAGER_RE.test(text) && origins.length <= 2)
      if (hasPager) {
        excluded.paginationRows++
        continue
      }
      const fullMerged =
        colCount > 1 &&
        origins.length === 1 &&
        Number((origins[0] as Cell).el.colSpan || (origins[0] as Cell).el.getAttribute?.('aria-colspan') || 1) >= colCount
      if (fullMerged) {
        excluded.mergedRows++
        if (EMPTY_RE.test(text)) sawEmptyNote = true
        continue
      }
      if (!text && origins.every((c) => !textOf(c.el) && !c.el.querySelector?.('input,select,textarea'))) {
        excluded.mergedRows++
        continue
      }
      dataRows.push(toModelRow(r))
    }
    const parent = root.parentElement
    return {
      shape,
      cols,
      hasHeader: headRows.length > 0,
      dataRows,
      summaryRows,
      excluded,
      hasPagination:
        excluded.paginationRows > 0 || Boolean(root.querySelector(PAGER_SEL)) || Boolean(parent && parent.querySelector(PAGER_SEL)),
      isBusy: root.getAttribute('aria-busy') === 'true' || Boolean(root.querySelector('[aria-busy="true"]')),
      emptyNote: sawEmptyNote,
      renderedRowEls: dataRows.map((r) => r.el),
    }
  }

  /** easyui datagrid：view1 冻结列、view2 主列；表头与表体分离，单元格带 field 属性。 */
  const easyuiModel = (root: any): Model | ModelError => {
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

  /** jqGrid：表头 .ui-jqgrid-htable、表体 table.ui-jqgrid-btable 的 tr.jqgrow；分组行 jqgroup 不计入。 */
  const jqgridModel = (root: any): Model | ModelError => {
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

  /** ExtJS 4–6：.x-column-header 叶子表头；每个 grid view（锁定列 / 普通列）里的 tr.x-grid-row 按行序拼接。 */
  const extjsModel = (root: any): Model | ModelError => {
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

  /** layui table：主表头 .layui-table-header、主表体 .layui-table-main，表头与单元格带 data-field。 */
  const layuiModel = (root: any): Model | ModelError => {
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


  /**
   * Element UI（Vue 2）el-table：表头和表体是两张分开的 table（header-wrapper / body-wrapper），
   * 列靠 th / td 上相同的 `el-table_<表>_column_<列>` 类名对应；表头最右有一个空的 gutter 列；
   * 合计行在 footer-wrapper；无数据时有 `.el-table__empty-text`，加载时有 `.el-loading-mask`。
   */
  const elementuiModel = (root: any): Model | ModelError => {
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

  /**
   * FineReport（帆软）报表：冻结表由四块 `table.x-table` 拼成（角 / 顶部表头 / 左侧行头 / 中间数据），
   * 每个单元格的 id 形如 `B3-0-2772`（Excel 式列字母 + 行号），靠它把四块对回同一张网格；
   * 表头 = 角与顶部里的行，数据 = 左侧与中间里表头以下的行；rowspan 合并的行头向下补齐。
   */
  const finereportModel = (root: any): Model | ModelError => {
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

  // ---------------------------------------------------------------- 卡片 / 键值适配器
  // 老系统的详情页、看板指标卡没有统一控件：靠“名称 + 值”的成对结构识别。每个结果仍落到统一模型，
  // 名称当列名、值当单元格；键值面板是只有一行的记录集，卡片列表是每张卡片一行。
  type Pair = { label: string; value: string; cell: any }
  const LABEL_CLS = /(label|lbl|caption|field-?name|item-?name|(^|[\s_-])key([\s_-]|$)|(^|[\s_-])th([\s_-]|$))/i
  const VALUE_CLS = /(value|(^|[\s_-])val([\s_-]|$)|field-?value|item-?value|content|(^|[\s_-])text([\s_-]|$))/i
  const stripColon = (t: string): string => clean(t.replace(/[:：]\s*$/, ''))
  const isLeafish = (node: any): boolean => !node.querySelector || !node.querySelector('div,p,li,tr,table,dl,section,ul')
  const fakeCell = (text: string): any => ({ innerText: text, textContent: text })

  const pairsIn = (box: any): Pair[] => {
    const out: Pair[][] = []
    const visible = (n: any): boolean => !isHidden(n)
    // S1 dl / dt+dd
    const dts = (Array.from(box.querySelectorAll?.('dt') || []) as any[]).filter(visible)
    if (dts.length > 0) {
      const ps: Pair[] = []
      for (const dt of dts) {
        let dd = dt.nextElementSibling
        while (dd && String(dd.tagName).toLowerCase() !== 'dd' && String(dd.tagName).toLowerCase() !== 'dt') dd = dd.nextElementSibling
        if (dd && String(dd.tagName).toLowerCase() === 'dd' && stripColon(textOf(dt))) ps.push({ label: stripColon(textOf(dt)), value: cellText(dd), cell: dd })
      }
      out.push(ps)
    }
    // S2 表格里“th + td”（或 标签格 + 值格 成对）
    const trs = (String(box.tagName).toLowerCase() === 'tr' ? [box] : (Array.from(box.querySelectorAll?.('tr') || []) as any[])).filter(visible)
    if (trs.length > 0) {
      const ps: Pair[] = []
      for (const tr of trs) {
        const cells = (Array.from(tr.cells || []) as any[]).filter(visible)
        if (cells.length < 2 || cells.length % 2 !== 0) continue
        for (let i = 0; i < cells.length; i += 2) {
          const lc = cells[i]
          const vc = cells[i + 1]
          const lt = textOf(lc)
          const labelish = String(lc.tagName).toLowerCase() === 'th' || /[:：]$/.test(lt) || LABEL_CLS.test(String(lc.className || ''))
          if (labelish && stripColon(lt)) ps.push({ label: stripColon(lt), value: cellText(vc), cell: vc })
        }
      }
      out.push(ps)
    }
    // S3 class 带 label / value 字样的相邻元素
    const labelEls = (Array.from(box.querySelectorAll?.('*') || []) as any[]).filter(
      (e) => isLeafish(e) && LABEL_CLS.test(String(e.className || '')) && !VALUE_CLS.test(String(e.className || '')) && textOf(e) && visible(e),
    )
    if (labelEls.length > 0) {
      const ps: Pair[] = []
      for (const le of labelEls) {
        let ve = le.nextElementSibling
        if (!ve && le.parentElement && le.parentElement !== box) ve = le.parentElement.nextElementSibling
        if (ve && visible(ve)) ps.push({ label: stripColon(textOf(le)), value: cellText(ve), cell: ve })
      }
      out.push(ps)
    }
    // S4 “名称：值”文字，或“名称：”后面紧跟一个值元素
    const leaves = (Array.from(box.querySelectorAll?.('*') || []) as any[]).filter((e) => e.children.length === 0 && textOf(e) && visible(e))
    const ps4: Pair[] = []
    for (const lf of leaves) {
      const t = textOf(lf)
      const inline = /^(.{1,24}?)[:：]\s*(\S.*)$/.exec(t)
      if (inline) {
        ps4.push({ label: clean(inline[1] as string), value: clean(inline[2] as string), cell: fakeCell(clean(inline[2] as string)) })
      } else if (/[:：]$/.test(t) && t.length <= 25) {
        const ve = lf.nextElementSibling
        if (ve && visible(ve)) ps4.push({ label: stripColon(t), value: cellText(ve), cell: ve })
      }
    }
    out.push(ps4)
    let best: Pair[] = []
    for (const ps of out) if (ps.length > best.length) best = ps
    return best
  }

  const sigOf = (node: any): string => {
    const cls = (Array.from(node.classList || []) as string[]).filter((c) => !/^(active|hover|selected|focus|open|show|hide|hidden|first|last|odd|even|current|checked|disabled)$/i.test(c)).sort()
    return `${String(node.tagName).toLowerCase()}.${cls.join('.')}`
  }
  const cardEls = (root: any, rowSelector?: string): any[] => {
    if (rowSelector) {
      try {
        return (Array.from(root.querySelectorAll(rowSelector)) as any[]).filter((n) => !isHidden(n))
      } catch {
        return []
      }
    }
    const kids = (Array.from(root.children || []) as any[]).filter((n) => !/^(script|style|link|template)$/i.test(String(n.tagName)) && !isHidden(n) && !n.matches?.(PAGER_SEL))
    const groups: Record<string, any[]> = {}
    for (const k of kids) (groups[sigOf(k)] = groups[sigOf(k)] || []).push(k)
    let bestGroup: any[] = []
    for (const g of Object.values(groups)) if (g.length > bestGroup.length) bestGroup = g
    return bestGroup
  }
  const titleElOf = (card: any, used: Set<any>): any => {
    const t = card.querySelector?.('h1,h2,h3,h4,h5,h6,[class*="title"],[class*="Title"],[class*="header"],[class*="head"]')
    return t && textOf(t) && !used.has(t) && isLeafish(t) ? t : null
  }

  const keyvalueModel = (root: any): Model | ModelError => {
    const pairs = pairsIn(root)
    if (pairs.length === 0) return { error: { code: 'TABLE_SHAPE_UNSUPPORTED', message: '这块区域里没有找到“名称：值”形式的信息' } }
    return {
      shape: 'keyvalue',
      cols: pairs.map((p) => ({ leaf: p.label, path: p.label })),
      hasHeader: true,
      dataRows: [{ el: root, cells: pairs.map((p) => p.cell) }],
      summaryRows: [],
      excluded: { mergedRows: 0, paginationRows: 0, footerRows: 0 },
      hasPagination: false,
      isBusy: false,
      emptyNote: false,
      renderedRowEls: [],
    }
  }

  const cardsModel = (root: any, rowSelector?: string): Model | ModelError => {
    const cards = cardEls(root, rowSelector)
    const perCard = cards.map((c) => pairsIn(c))
    const labels: string[] = []
    for (const ps of perCard) for (const p of ps) if (!labels.includes(p.label)) labels.push(p.label)
    const titles = cards.map((c, i) => {
      const used = new Set<any>()
      for (const p of perCard[i] as Pair[]) used.add(p.cell)
      return titleElOf(c, used)
    })
    const hasTitle = cards.length > 0 && titles.every(Boolean) && !labels.includes('标题')
    if (cards.length > 0 && labels.length === 0 && !hasTitle) {
      return { error: { code: 'TABLE_SHAPE_UNSUPPORTED', message: '这组卡片里没有找到“名称：值”形式的信息' } }
    }
    const cols: ModelCol[] = [...(hasTitle ? [{ leaf: '标题', path: '标题' }] : []), ...labels.map((l) => ({ leaf: l, path: l }))]
    const dataRows: ModelRow[] = cards.map((card, i) => {
      const used: Record<string, number> = {}
      const cells: any[] = []
      if (hasTitle) cells.push(titles[i])
      for (const l of labels) {
        const nth = used[l] || 0
        const hits = (perCard[i] as Pair[]).filter((p) => p.label === l)
        used[l] = nth + 1
        cells.push(hits[0] ? hits[0].cell : null)
      }
      return { el: card, cells }
    })
    return {
      shape: 'cards',
      cols,
      hasHeader: true,
      dataRows,
      summaryRows: [],
      excluded: { mergedRows: 0, paginationRows: 0, footerRows: 0 },
      hasPagination: pagerNear(root),
      isBusy: Array.from(root.querySelectorAll?.('.loading,[aria-busy="true"],.layui-layer-loading') || []).some((m: any) => !isHidden(m)),
      emptyNote: cards.length === 0 && EMPTY_RE.test(textOf(root)),
      renderedRowEls: cards,
    }
  }

  const isKvTable = (t: any): boolean => {
    if (String(t.tagName).toLowerCase() !== 'table') return false
    const rows = (Array.from(t.rows || []) as any[]).filter((r) => r.cells && r.cells.length > 0)
    return rows.length >= 2 && rows.every((r) => String(r.cells[0].tagName).toLowerCase() === 'th' && r.cells.length >= 2)
  }
  /** 从点到的元素向上找：先看是不是一组相似卡片，再看是不是一块键值信息。 */
  const findStructured = (start: any): { root: any; kind: 'cards' | 'keyvalue'; inner?: any } | null => {
    let n = start
    for (let hop = 0; hop < 8 && n && n.nodeType === 1 && n !== doc.body && n !== doc.documentElement; hop++, n = n.parentElement) {
      const p = n.parentElement
      // 表格的行不是卡片：th/td 表单表格整张按键值读
      if (p && !/^(tr|td|th|tbody|thead|tfoot)$/i.test(String(n.tagName))) {
        const sig = sigOf(n)
        const sibs = (Array.from(p.children) as any[]).filter((c) => sigOf(c) === sig && !isHidden(c))
        if (sibs.length >= 2 && sibs.filter((c) => pairsIn(c).length >= 2).length >= Math.ceil(sibs.length * 0.7)) {
          return { root: p, kind: 'cards', inner: n }
        }
      }
      const kvTable = /^(tr|td|th|tbody)$/i.test(String(n.tagName)) ? n.closest?.('table') : null
      if (kvTable && isKvTable(kvTable)) return { root: kvTable, kind: 'keyvalue' }
      if (pairsIn(n).length >= 2) return { root: n, kind: 'keyvalue' }
    }
    return null
  }

  const buildModel = (root: any, hint: { header: 'auto' | 'first_row' | 'none'; rowSelector?: string; kind?: ReadKind }): Model | ModelError => {
    if (hint.kind === 'keyvalue') return keyvalueModel(root)
    if (hint.kind === 'cards') return cardsModel(root, hint.rowSelector)
    const shape = shapeOf(root)
    if (!shape) return { error: { code: 'TABLE_SHAPE_UNSUPPORTED', message: '这个区域不是表格或常见的表格控件' } }
    if (shape === 'easyui') return easyuiModel(root)
    if (shape === 'jqgrid') return jqgridModel(root)
    if (shape === 'extjs') return extjsModel(root)
    if (shape === 'layui') return layuiModel(root)
    if (shape === 'elementui') return elementuiModel(root)
    if (shape === 'finereport') return finereportModel(root)
    return nativeModel(root, shape as 'native' | 'aria', hint)
  }

  /**
   * 虚拟滚动 / 无限滚动的怀疑：有明确标记，或某个滚动容器（表格自身、祖先、内部 div）的总高远大于已渲染行高之和，
   * 且容器里除表格外几乎没有文字（只是撑高的占位）。
   */
  const virtualScrollSuspected = (root: any, rendered: any[]): boolean => {
    if (root.querySelector('[class*="virtual"],[class*="Virtual"],.x-grid-buffered,[class*="bufferedrenderer"]')) return true
    if (rendered.length === 0 || rendered.length >= 100) return false
    const scrollable = (node: any): boolean => {
      const st = win.getComputedStyle(node)
      return (st.overflowY === 'auto' || st.overflowY === 'scroll') && node.clientHeight > 0 && node.scrollHeight > node.clientHeight + 4
    }
    const pool: any[] = [root]
    for (let n = root.parentElement, hop = 0; n && n !== doc.body && n !== doc.documentElement && hop < 6; n = n.parentElement, hop++) pool.push(n)
    pool.push(...(Array.from(root.querySelectorAll('div')) as any[]))
    const scroller = pool.find(scrollable)
    if (!scroller) return false
    const rowsHeight = rendered.reduce((sum, r) => sum + (r?.getBoundingClientRect?.().height || 0), 0)
    const outsideText = Math.max(0, textOf(scroller).length - textOf(root).length)
    return scroller.scrollHeight > rowsHeight * 1.5 + 150 && outsideText < 50
  }

  // ---------------------------------------------------------------- 值解析
  const toHalf = (s: string): string =>
    s
      .replace(/[\uFF10-\uFF19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .replace(/\uFF0C/g, ',')
      .replace(/\uFF0E/g, '.')
      .replace(/\uFF05/g, '%')
      .replace(/[\uFF08]/g, '(')
      .replace(/[\uFF09]/g, ')')
      .replace(/[\uFF0D\u2212]/g, '-')
      .replace(/\uFF1A/g, ':')
  const PLACEHOLDERS = new Set(['', '-', '--', '—', '–', '/', 'n/a', 'null'])
  const shift = (digits: string, n: number): string => {
    const neg = digits.startsWith('-')
    const body = neg ? digits.slice(1) : digits
    const [intPart, fracPart = ''] = body.split('.')
    const padded = fracPart.padEnd(n, '0')
    const nextInt = (intPart + padded.slice(0, n)).replace(/^0+(?=\d)/, '')
    const nextFrac = padded.slice(n)
    const out = nextFrac ? `${nextInt}.${nextFrac}` : nextInt
    return neg ? `-${out}` : out
  }
  const parseNumber = (raw: string, scale: boolean): { ok: true; value: number; decimal: string } | { ok: false } => {
    let s = toHalf(raw).replace(/[¥￥$€£]/g, '').trim()
    let negative = false
    if (/^\(.*\)$/.test(s)) {
      negative = true
      s = s.slice(1, -1).trim()
    }
    if (s.startsWith('-')) {
      negative = true
      s = s.slice(1).trim()
    }
    const m = /^(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*([%‰]|[A-Za-z\u4e00-\u9fa5]{0,6})$/.exec(s)
    if (!m) return { ok: false }
    let decimal = `${(m[1] as string).replace(/,/g, '')}${m[2] ?? ''}`
    const unit = m[3] ?? ''
    if (scale) {
      if (unit.startsWith('万')) decimal = shift(decimal, 4)
      else if (unit.startsWith('亿')) decimal = shift(decimal, 8)
    }
    if (negative) decimal = `-${decimal}`
    const value = Number(decimal)
    if (!Number.isFinite(value)) return { ok: false }
    return { ok: true, value, decimal }
  }
  /** 日期规范化为不带时区的 YYYY-MM-DD / YYYY-MM-DD HH:mm:ss。 */
  const parseDate = (raw: string): string | null => {
    const s = toHalf(raw).trim()
    const compact = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2}))?$/.exec(s)
    const m = compact ?? /^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s)
    if (!m) return null
    const y = Number(m[1])
    const mo = Number(m[2])
    const d = Number(m[3])
    if (compact && (y < 1900 || y > 2100)) return null
    const probe = new Date(Date.UTC(y, mo - 1, d))
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null
    const p2 = (n: number): string => String(n).padStart(2, '0')
    const day = `${String(y).padStart(4, '0')}-${p2(mo)}-${p2(d)}`
    if (m[4] === undefined) return day
    const hh = Number(m[4])
    const mm = Number(m[5])
    const ss = Number(m[6] ?? 0)
    if (hh > 23 || mm > 59 || ss > 59) return null
    return `${day} ${p2(hh)}:${p2(mm)}:${p2(ss)}`
  }
  const TRUE_SET = new Set(['true', 'yes', 'y', '是', '真', '1', '√', '✓', '✔', '有', '启用', '开'])
  const FALSE_SET = new Set(['false', 'no', 'n', '否', '假', '0', '×', '✗', '✘', '无', '禁用', '关'])
  const cellText = (node: any): string => {
    const t = textOf(node)
    if (t) return t
    const input = node.querySelector?.('input:not([type="hidden"]):not([type="password"]),textarea,select')
    if (!input) return ''
    if (String(input.tagName).toUpperCase() === 'SELECT') {
      const opt = input.options?.[input.selectedIndex]
      return clean(opt ? opt.text : '')
    }
    if (input.type === 'checkbox' || input.type === 'radio') return input.checked ? '是' : '否'
    return clean(input.value)
  }

  // ---------------------------------------------------------------- 模式：读取
  if (req.mode === 'read') {
    const args = req.read
    const model = buildModel(el, { header: args.header, rowSelector: args.rowSelector, kind: args.kind })
    if ('error' in model) return { ok: false, code: model.error.code, message: model.error.message }
    const lower = (s: string): string => s.toLowerCase()
    const cols = model.cols
    const colIndexOf: number[] = []
    for (const spec of args.columns) {
      if (spec.selector) {
        colIndexOf.push(-1)
        continue
      }
      if (spec.source === 'index') {
        if (spec.index === undefined || spec.index >= cols.length) {
          return { ok: false, code: 'TABLE_COLUMN_NOT_FOUND', message: `列「${spec.name}」按第 ${(spec.index ?? 0) + 1} 列取，但这张表只有 ${cols.length} 列` }
        }
        colIndexOf.push(spec.index)
        continue
      }
      if (spec.field) {
        const byField = cols.map((c, i) => (c.field === spec.field ? i : -1)).filter((i) => i >= 0)
        if (byField.length === 1) {
          colIndexOf.push(byField[0] as number)
          continue
        }
      }
      if (!model.hasHeader) {
        return { ok: false, code: 'TABLE_HEADER_NOT_FOUND', message: `这张表没有表头，无法按列名找「${spec.name}」。请改为“按第几列取”` }
      }
      const want = lower(clean(spec.name))
      const all = cols.map((c, i) => (lower(c.leaf) === want || lower(c.path) === want ? i : -1)).filter((i) => i >= 0)
      const visible = all.filter((i) => !(cols[i] as ModelCol).hidden)
      const hits = visible.length > 0 ? visible : all
      if (hits.length === 0) {
        return { ok: false, code: 'TABLE_COLUMN_NOT_FOUND', message: `表头里找不到列「${spec.name}」（现有列：${cols.map((c) => c.leaf).filter(Boolean).join('、') || '无'}）` }
      }
      if (hits.length > 1) {
        return { ok: false, code: 'TABLE_COLUMN_AMBIGUOUS', message: `表头里有 ${hits.length} 列都叫「${spec.name}」，请改用“上级 / 列名”或按第几列取` }
      }
      colIndexOf.push(hits[0] as number)
    }

    const readRow = (row: ModelRow): DomRow => {
      const values: Record<string, DomField> = {}
      const digest: string[] = []
      args.columns.forEach((spec, i) => {
        if (spec.sensitive) {
          values[spec.key] = { value: null, status: 'masked' }
          digest.push(`${spec.key}:masked`)
          return
        }
        let raw = ''
        if (spec.selector) {
          const found = row.el?.querySelector?.(spec.selector)
          raw = found ? cellText(found) : ''
        } else {
          const cell = row.cells[colIndexOf[i] as number]
          raw = cell ? cellText(cell) : ''
        }
        const lowered = raw.toLowerCase()
        if (spec.valueType === 'text') {
          if (!raw) {
            values[spec.key] = { value: null, status: 'missing' }
            digest.push(`${spec.key}:missing`)
          } else {
            values[spec.key] = { value: raw, status: 'ok' }
            digest.push(`${spec.key}:${raw}`)
          }
          return
        }
        if (PLACEHOLDERS.has(lowered)) {
          values[spec.key] = { value: null, rawText: raw || undefined, status: 'missing' }
          digest.push(`${spec.key}:missing`)
          return
        }
        if (spec.valueType === 'number') {
          const parsed = parseNumber(raw, Boolean(spec.scaleUnits))
          if (!parsed.ok) {
            values[spec.key] = { value: null, rawText: raw, status: 'error' }
            digest.push(`${spec.key}:error:${raw}`)
            return
          }
          values[spec.key] = {
            value: parsed.value,
            ...(raw !== String(parsed.value) ? { rawText: raw } : {}),
            decimalValue: parsed.decimal,
            status: 'ok',
          }
          digest.push(`${spec.key}:${parsed.decimal}`)
          return
        }
        if (spec.valueType === 'date') {
          const iso = parseDate(raw)
          if (iso === null) {
            values[spec.key] = { value: null, rawText: raw, status: 'error' }
            digest.push(`${spec.key}:error:${raw}`)
          } else {
            values[spec.key] = { value: iso, ...(raw !== iso ? { rawText: raw } : {}), status: 'ok' }
            digest.push(`${spec.key}:${iso}`)
          }
          return
        }
        const v = toHalf(lowered)
        if (TRUE_SET.has(v) || FALSE_SET.has(v)) {
          values[spec.key] = { value: TRUE_SET.has(v), ...(raw !== String(TRUE_SET.has(v)) ? { rawText: raw } : {}), status: 'ok' }
          digest.push(`${spec.key}:${TRUE_SET.has(v)}`)
        } else {
          values[spec.key] = { value: null, rawText: raw, status: 'error' }
          digest.push(`${spec.key}:error:${raw}`)
        }
      })
      return { values, rawDigest: digest.join('|') }
    }

    // 合计行：手工指定优先，否则按“首列文字是 合计 / 总计 …”自动识别；移出数据行
    let manualCol = -1
    if (args.totalRow) {
      const at = args.columns.findIndex((c) => c.key === args.totalRow?.columnKey)
      manualCol = at >= 0 ? (colIndexOf[at] as number) : -1
    }
    const structuredShape = model.shape === 'cards' || model.shape === 'keyvalue'
    const isTotal = (row: ModelRow): boolean => {
      if (structuredShape) return false
      if (args.totalRow && manualCol >= 0) {
        const cell = row.cells[manualCol]
        if (cell && cellText(cell) === args.totalRow.equals) return true
      }
      const firstTexts = row.cells.slice(0, 3).map((c) => (c ? cellText(c) : '')).filter(Boolean)
      return firstTexts.length > 0 && TOTAL_RE.test(firstTexts[0] as string)
    }
    const dataRows: ModelRow[] = []
    const summary: ModelRow[] = [...model.summaryRows]
    let movedTotals = 0
    for (const row of model.dataRows) {
      if (isTotal(row)) {
        summary.push(row)
        movedTotals++
      } else dataRows.push(row)
    }
    const rows = dataRows.slice(0, Math.max(1, args.maxRows)).map(readRow)
    const summaryRows = summary.slice(0, 5).map(readRow)

    let emptyVerified = model.emptyNote || Boolean(args.emptyMeansNone)
    const parent = el.parentElement
    if (!emptyVerified && args.emptySelector) {
      emptyVerified = Boolean(el.querySelector(args.emptySelector)) || Boolean(parent?.querySelector(args.emptySelector))
    }
    const busy = model.isBusy || Boolean(args.loadingSelector && el.querySelector(args.loadingSelector))
    return {
      ok: true,
      shape: model.shape,
      isBusy: busy,
      emptyVerified,
      hasPagination: model.hasPagination,
      virtualScroll: virtualScrollSuspected(el, model.renderedRowEls),
      headerDigest: cols.map((c) => c.leaf).join('|'),
      totalDataRows: dataRows.length,
      rows,
      summaryRows,
      excluded: { ...model.excluded, footerRows: model.excluded.footerRows + movedTotals },
      colCount: cols.length,
    } satisfies ReadTableResult
  }

  // ---------------------------------------------------------------- 模式：识别
  if (req.mode === 'detect') {
    const args = req.detect
    const isTableLike = (node: any): boolean => {
      const t = String(node.tagName || '').toLowerCase()
      const r = roleOf(node)
      return t === 'table' || r === 'grid' || r === 'table' || r === 'treegrid'
    }
    const normalizeGridRoot = (node: any): any => {
      if (node.matches?.('.datagrid-view,.datagrid')) return node.closest('.datagrid-wrap') || node
      return node
    }
    // 先看是不是已知的表格控件（含从内部元素点选）
    let gridRoot: any = null
    if (args.forceRoot) {
      if (el.matches?.(GRID_SEL)) gridRoot = normalizeGridRoot(el)
    } else {
      const found = el.closest?.(GRID_SEL)
      if (found) gridRoot = normalizeGridRoot(found)
    }

    const AUTO_ID = /(\d{2,})|^(ext-|ext_|gridview|panel-|datagrid|layui-|jqg|ui-id|__|j_id|:r)/i
    const STATE_CLASS =
      /^(active|hover|selected|focus|open|show|hide|hidden|loading|checked|disabled|ng-|is-|has-|x-border|x-unselectable|x-grid-|x-panel|x-box|x-container|x-component|x-layout|x-fit)/i
    const esc = (s: string): string => (win?.CSS?.escape ? win.CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&'))
    const countOf = (sel: string): number => {
      try {
        return doc.querySelectorAll(sel).length
      } catch {
        return 0
      }
    }
    const selectorFor = (node: any): { selector: string; quality: 'stable' | 'positional' } => {
      const id = node.getAttribute('id')
      if (id && !AUTO_ID.test(id) && countOf(`#${esc(id)}`) === 1) return { selector: `#${esc(id)}`, quality: 'stable' }
      const tag = String(node.tagName).toLowerCase()
      const classes = (Array.from(node.classList || []) as string[]).filter((c) => !AUTO_ID.test(c) && !STATE_CLASS.test(c))
      for (let take = 1; take <= Math.min(2, classes.length); take++) {
        const sel = `${tag}${classes.slice(0, take).map((c) => `.${esc(c)}`).join('')}`
        if (countOf(sel) === 1) return { selector: sel, quality: 'stable' }
      }
      for (const attr of ['name', 'data-id', 'data-testid', 'data-table', 'aria-label', 'summary', 'lay-id']) {
        const v = node.getAttribute(attr)
        if (v && !AUTO_ID.test(v)) {
          const sel = `${tag}${attrSel(attr, v)}`
          if (countOf(sel) === 1) return { selector: sel, quality: 'stable' }
        }
      }
      const parts: string[] = []
      let n = node
      while (n && n.nodeType === 1 && n !== doc.documentElement) {
        const nid = n.getAttribute('id')
        if (nid && !AUTO_ID.test(nid)) {
          parts.unshift(`#${esc(nid)}`)
          break
        }
        const tg = String(n.tagName).toLowerCase()
        const same = n.parentElement ? (Array.from(n.parentElement.children) as any[]).filter((x) => x.tagName === n.tagName) : []
        parts.unshift(same.length > 1 ? `${tg}:nth-of-type(${same.indexOf(n) + 1})` : tg)
        n = n.parentElement
      }
      return { selector: parts.join(' > '), quality: 'positional' }
    }
    const titleOf = (t: any): string | undefined => {
      const cap = t.querySelector?.('caption')
      if (cap && textOf(cap)) return textOf(cap).slice(0, 40)
      const label = t.getAttribute?.('aria-label') || t.getAttribute?.('summary')
      if (label) return clean(label).slice(0, 40)
      // 控件自带的面板标题
      const panel = t.closest?.('.panel,.x-panel,.layui-card,.ui-jqgrid')
      const titleEl = panel?.querySelector?.('.panel-title,.x-panel-header-title,.x-title-text,.layui-card-header,.ui-jqgrid-title')
      if (titleEl && textOf(titleEl) && textOf(titleEl).length <= 40) return textOf(titleEl)
      let n = t
      for (let hop = 0; hop < 4 && n; hop++) {
        let sib = n.previousElementSibling
        while (sib) {
          const tg = String(sib.tagName).toLowerCase()
          if (/^h[1-6]$/.test(tg) || /(title|caption|header|heading)/i.test(String(sib.className || ''))) {
            const tt = textOf(sib)
            if (tt && tt.length <= 40) return tt
          }
          sib = sib.previousElementSibling
        }
        n = n.parentElement
      }
      return undefined
    }

    // 原生 / ARIA：向上找“最像数据表”的那一张
    const rowsOf = (t: any): any[] =>
      String(t.tagName).toLowerCase() === 'table' ? (Array.from(t.rows || []) as any[]) : (Array.from(t.querySelectorAll('[role="row"]')) as any[])
    const cellsOfTr = (tr: any): any[] =>
      String(tr.tagName).toLowerCase() === 'tr'
        ? (Array.from(tr.cells || []) as any[])
        : (Array.from(tr.querySelectorAll('[role="cell"],[role="gridcell"],[role="columnheader"]')) as any[])
    const score = (t: any): { score: number; rowCount: number; colCount: number } => {
      const rows = rowsOf(t)
      const counts = rows.map((r) => cellsOfTr(r).length)
      const colCount = counts.reduce((m, x) => Math.max(m, x), 0)
      let s = 0
      if (rows.length >= 2) s += 2
      if (colCount >= 2) s += 2
      const modeCount = counts.filter((x) => x === colCount).length
      if (rows.length > 0 && modeCount / rows.length >= 0.7) s += 2
      if (t.querySelector?.('thead th, th, [role="columnheader"]')) s += 2
      if (Array.from(t.querySelectorAll('td > table, td > div > table')).length > 0) s -= 3
      const rl = roleOf(t)
      if (rl === 'presentation' || rl === 'none') s -= 5
      return { score: s, rowCount: rows.length, colCount }
    }

    let root: any = gridRoot
    let candidates: Array<{ t: any; i: number; score: number; rowCount: number; colCount: number }> = []
    let best: (typeof candidates)[number] | null = null
    let structured: { root: any; kind: 'cards' | 'keyvalue'; inner?: any } | null = null
    if (!root) {
      const chain: any[] = []
      if (args.forceRoot) {
        if (isTableLike(el)) chain.push(el)
      } else {
        for (let n = el; n && n.nodeType === 1 && n !== doc.documentElement; n = n.parentElement) if (isTableLike(n)) chain.push(n)
      }
      let tableOk = false
      if (chain.length > 0) {
        candidates = chain.map((t, i) => ({ t, i, ...score(t) }))
        best = candidates[0] as (typeof candidates)[number]
        for (const c of candidates) if (c.score > best.score) best = c
        tableOk = !((!args.forceRoot && best.score < 3) || best.rowCount < 1) && !isKvTable(best.t)
      }
      if (tableOk && best) {
        root = best.t
      } else {
        // 不是数据表：看是不是一组卡片或一块键值信息
        if (args.forceRoot) {
          const asCards = cardsModel(el)
          const asKv = keyvalueModel(el)
          if (!('error' in asCards) && asCards.dataRows.length >= 2) structured = { root: el, kind: 'cards' }
          else if (!('error' in asKv)) structured = { root: el, kind: 'keyvalue' }
        } else {
          structured = findStructured(el)
        }
        if (!structured) {
          if (chain.length === 0) return { ok: false, code: 'TABLE_SHAPE_UNSUPPORTED', message: '点到的位置不在表格、卡片或“名称：值”信息里' }
          return { ok: false, code: 'TABLE_SHAPE_UNSUPPORTED', message: '点到的位置所在的表格看起来不是数据表（可能是页面排版用的表格）' }
        }
        root = structured.root
      }
    }

    const model = buildModel(root, structured ? { header: 'auto', kind: structured.kind } : { header: 'auto' })
    if ('error' in model) return { ok: false, code: model.error.code, message: model.error.message }
    const sampleRows = model.dataRows.slice(0, Math.max(1, args.sampleRows))
    const cols = model.cols
    const colDetected: DetectedColumn[] = []
    const seen: Record<string, number> = {}
    const DATE_LIKE = /^\d{4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}/
    cols.forEach((col, c) => {
      const cellsAt = sampleRows.map((r) => r.cells[c]).filter(Boolean) as any[]
      const texts = cellsAt.map((cell) => textOf(cell)).filter(Boolean)
      const header = col.leaf
      let excludedReason: DetectedColumn['excludedReason']
      if (col.hidden) excludedReason = 'hidden'
      else if (col.special === 'checkbox' || (cellsAt.length > 0 && cellsAt.every((cell) => cell.querySelector?.(CHECKBOX_SEL)) && !header)) excludedReason = 'checkbox'
      else if (col.special === 'index' || cellsAt.some((cell) => /row-numberer|rownumber/i.test(String(cell.className || '')))) excludedReason = 'index'
      else if (/^(操作|操作栏|选项|管理|actions?)$/i.test(header)) excludedReason = 'action'
      else if (
        cellsAt.length > 0 &&
        cellsAt.every((cell) => {
          const ctrls = Array.from(cell.querySelectorAll?.('a,button') || []) as any[]
          return (
            ctrls.length > 0 &&
            textOf(cell) === clean(ctrls.map((x) => textOf(x)).join(' ')) &&
            ctrls.every((x) => /^(编辑|删除|查看|详情|修改|审核|审批|下载|更多|详细)$/.test(textOf(x)))
          )
        })
      ) excludedReason = 'action'
      else if (/^(序号|序|行号|no\.?|#)$/i.test(header)) excludedReason = 'index'
      else if (!header && texts.length >= 2 && texts.every((tx, i) => tx === String(i + 1))) excludedReason = 'index'
      let valueType: DetectedColumn['valueType'] = 'text'
      let numericKind: DetectedColumn['numericKind']
      if (texts.length > 0) {
        const compact = texts.map((tx) => tx.replace(/[,，\s¥￥$€£%元万亿个]/g, ''))
        if (texts.every((tx) => /^(true|false|yes|no|是|否|真|假)$/i.test(tx))) valueType = 'boolean'
        else if (texts.every((tx) => DATE_LIKE.test(tx)) || texts.every((tx) => /^\d{8}(\d{6})?$/.test(toHalf(tx).trim()) && parseDate(tx) !== null)) valueType = 'date'
        else if (compact.every((x) => /^[-(]?\d+(\.\d+)?\)?$/.test(x)) && texts.some((tx) => /\d/.test(tx))) {
          valueType = 'number'
          numericKind = compact.every((x) => /^[-(]?\d+\)?$/.test(x)) ? 'integer' : 'decimal'
        }
      }
      const nameBase = header || `列${c + 1}`
      seen[nameBase] = (seen[nameBase] || 0) + 1
      colDetected.push({
        index: c,
        key: `col_${c + 1}`,
        name: nameBase,
        ...(col.path && col.path !== header ? { groupPath: col.path } : {}),
        ...(col.field ? { field: col.field } : {}),
        source: 'header',
        valueType,
        ...(numericKind ? { numericKind } : {}),
        ...(excludedReason ? { excludedReason } : {}),
      })
    })
    for (const dc of colDetected) {
      const col = cols[dc.index] as ModelCol
      const dup = (seen[dc.name] ?? 0) > 1
      // 有控件字段名时按字段名取列，不必退到“按第几列”；否则表头空 / 重名只能按序号
      if (!model.hasHeader || !col.leaf || (dup && !col.field)) {
        dc.source = 'index'
        dc.indexOnly = true
        if (model.hasHeader && dup && col.path) dc.name = col.path
      } else if (dup && col.path && col.path !== col.leaf) {
        dc.name = col.path
      }
    }

    const sel = selectorFor(root)
    const baseScore = gridRoot ? 10 : structured ? 6 : (best as NonNullable<typeof best>).score
    const mk = (t: any, level: 'inner' | 'outer' | 'chosen', sc: number, rowCount: number, colCount: number): DetectCandidate => {
      const s = t === root ? sel : selectorFor(t)
      return {
        selector: s.selector,
        selectorQuality: s.quality,
        title: titleOf(t),
        rowCount,
        colCount,
        score: sc,
        tagName: String(t.tagName).toLowerCase(),
        isNative: String(t.tagName).toLowerCase() === 'table',
        level,
      }
    }
    const chosen = mk(root, 'chosen', baseScore, model.dataRows.length, cols.length)
    const alternatives: DetectCandidate[] =
      structured && structured.kind === 'cards' && structured.inner
        ? (() => {
            const pairCount = pairsIn(structured.inner).length
            const s = selectorFor(structured.inner)
            return [{ selector: s.selector, selectorQuality: s.quality, title: titleOf(structured.inner), rowCount: 1, colCount: pairCount, score: 5, tagName: String(structured.inner.tagName).toLowerCase(), isNative: false, level: 'inner' as const }]
          })()
        : gridRoot || args.forceRoot || structured
        ? []
        : candidates
            .filter((c) => c !== best && c.score >= 3)
            .map((c) => mk(c.t, c.i < (best as NonNullable<typeof best>).i ? 'inner' : 'outer', c.score, c.rowCount, c.colCount))
    return {
      ok: true,
      chosen: { ...chosen, shape: model.shape, hasHeader: model.hasHeader, headerMode: model.hasHeader ? 'auto' : 'none', columns: colDetected },
      alternatives,
    } satisfies DetectResult
  }

  // ---------------------------------------------------------------- 模式：反馈
  // 识别失败时给开发者看的页面结构：点击位置附近一小块 DOM（保留结构属性与页面文本，去掉脚本、样式、隐藏输入框、密码框与输入值）
  let node = el
  for (let i = 0; i < 5 && node.parentElement && node.parentElement.tagName !== 'BODY'; i++) node = node.parentElement
  const clone = node.cloneNode(true)
  clone.querySelectorAll('script,style,noscript,link,meta,svg,canvas,iframe').forEach((e: any) => e.remove())
  clone.querySelectorAll('input').forEach((e: any) => {
    if (e.type === 'hidden' || e.type === 'password') e.remove()
    else e.removeAttribute('value')
  })
  const KEEP = /^(id|class|role|type|name|colspan|rowspan|field|data-field|data-index|data-columnid|lay-id|title|aria-[a-z-]+)$/
  for (const e of [clone, ...(Array.from(clone.querySelectorAll('*')) as any[])]) {
    for (const attr of Array.from(e.attributes || []) as any[]) {
      if (!KEEP.test(attr.name)) e.removeAttribute(attr.name)
    }
  }
  return { ok: true, feedback: String(clone.outerHTML || '').replace(/\s+/g, ' ').slice(0, 8000) }
}
