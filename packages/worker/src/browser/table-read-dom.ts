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

import type { AdapterHelpers, Model, ModelCol, ModelError, ModelRow, TableAdapter } from './table-adapters/types.js'
import { makeHelpers } from './table-adapters/helpers.js'
import { ADAPTER_FACTORIES } from './table-adapters/registry.js'

export type TableShape = 'native' | 'aria' | 'easyui' | 'jqgrid' | 'extjs' | 'layui' | 'elementui' | 'finereport' | 'aggrid' | 'antd' | 'handsontable' | 'cards' | 'keyvalue' | 'listgrid'
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

/**
 * 页面内核心逻辑：读取 / 识别 / 反馈。控件适配器（easyui、jqGrid…）不在这里，由注册表提供；
 * 核心只通过 TableAdapter 描述认出控件、归一壳节点、取统一模型。原生表格 / ARIA / 卡片 / 键值 / 列表式作为兜底仍在核心里。
 */
export function tableDomCore(el: any, req: TableDomRequest, h: AdapterHelpers, adapters: TableAdapter[]): any {
  // ---------------------------------------------------------------- 通用辅助
  const { doc, win, clean, textOf, stripSort, roleOf, isHidden, attrSel, leafPath, PAGER_RE, EMPTY_RE, PAGER_SEL, pagerNear, TOTAL_RE, CHECKBOX_SEL } = h
  void stripSort
  const GRID_SEL = adapters.map((a) => a.gridSelector).join(',')
  /**
   * 控件初始化后原始 <table> 常被留作隐藏的空壳，真正渲染的结构在别处；控件内部的子表也不是完整表格。
   * 选择器或点选落在这些节点上时，改读完整的控件根。
   */
  const resolveShell = (node: any): any => {
    if (!node?.matches) return node
    for (const a of adapters) {
      const rendered = a.resolveShell?.(node)
      if (rendered) return rendered
      if (a.innerPartSelector && node.matches(a.innerPartSelector)) return node.closest(a.gridSelector) || node
    }
    return node
  }

  const shapeOf = (root: any): TableShape | null => {
    for (const a of adapters) if (root.matches?.(a.claimSelector)) return a.shape
    const tag = String(root.tagName || '').toLowerCase()
    if (tag === 'table') return 'native'
    const r = roleOf(root)
    if (r === 'grid' || r === 'table' || r === 'treegrid') return 'aria'
    return null
  }


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

  // ---------------------------------------------------------------- 列表式表格适配器
  // 老系统用 ul/li + div 模拟表格：表头是单独的一个 ul（一个 li），数据行是另一个 ul 里的多个 li，
  // 每个 li 的直接子元素是一格。没有“名称：值”可配对，靠“表头 li 与数据 li 格数一致”识别。
  const listgridModel = (root: any, rowSelector?: string): Model | ModelError => {
    const fail: ModelError = { error: { code: 'TABLE_SHAPE_UNSUPPORTED', message: '这个区域里没有找到用列表（ul/li）搭成的表格' } }
    const cellsOf = (li: any): any[] =>
      (Array.from(li.children || []) as any[]).filter((c) => !/^(script|style|link|template)$/i.test(String(c.tagName)) && !isHidden(c))
    let candidates: any[]
    try {
      candidates = Array.from(root.querySelectorAll(rowSelector || 'li')) as any[]
    } catch {
      return fail
    }
    const rowEls = candidates.filter((li) => !isHidden(li) && !(rowSelector ? false : li.querySelector('li')) && cellsOf(li).length >= 2)
    const groups = new Map<any, any[]>()
    for (const li of rowEls) {
      const g = groups.get(li.parentElement)
      if (g) g.push(li)
      else groups.set(li.parentElement, [li])
    }
    let dataParent: any = null
    let dataRowsAll: any[] = []
    for (const [parent, rows] of groups) if (rows.length >= dataRowsAll.length) { dataParent = parent; dataRowsAll = rows }
    if (!dataParent || dataRowsAll.length < 2) return fail
    const counts: Record<number, number> = {}
    for (const r of dataRowsAll) counts[cellsOf(r).length] = (counts[cellsOf(r).length] || 0) + 1
    let width = 0
    for (const [k, v] of Object.entries(counts)) if (v > (counts[width] || 0)) width = Number(k)
    const rows = dataRowsAll.filter((r) => cellsOf(r).length === width)
    if (rows.length < 2 || rows.length / dataRowsAll.length < 0.7) return fail
    // 表头：数据行之前、只有一行、格数相同的另一个列表（取离数据最近的一个）
    let headerLi: any = null
    for (const [parent, hrows] of groups) {
      if (parent === dataParent || hrows.length !== 1 || cellsOf(hrows[0]).length !== width) continue
      if (!(parent.compareDocumentPosition(dataParent) & 4)) continue
      if (cellsOf(hrows[0]).every((c) => !textOf(c))) continue
      headerLi = hrows[0]
    }
    const heads = headerLi ? cellsOf(headerLi).map((c) => textOf(c)) : null
    const cols: ModelCol[] = Array.from({ length: width }, (_, i) => {
      const h = heads ? (heads[i] as string) : ''
      return { leaf: h, path: h }
    })
    return {
      shape: 'listgrid',
      cols,
      hasHeader: Boolean(heads),
      dataRows: rows.map((r) => ({ el: r, cells: cellsOf(r) })),
      summaryRows: [],
      excluded: { mergedRows: 0, paginationRows: 0, footerRows: 0 },
      hasPagination: pagerNear(root),
      isBusy: Array.from(root.querySelectorAll?.('.loading,[aria-busy="true"],.layui-layer-loading') || []).some((m: any) => !isHidden(m)),
      emptyNote: false,
      renderedRowEls: rows,
    }
  }
  /** 从点到的元素向上找：优先停在带表头的那一层，找不到表头就用第一个能读出行的层。 */
  const findListgrid = (start: any): any => {
    let first: any = null
    let n = start
    for (let hop = 0; hop < 8 && n && n.nodeType === 1 && n !== doc.body && n !== doc.documentElement; hop++, n = n.parentElement) {
      const m = listgridModel(n)
      if ('error' in m) continue
      if (m.hasHeader) return n
      if (!first) first = n
    }
    return first
  }

  const buildModel = (root: any, hint: { header: 'auto' | 'first_row' | 'none'; rowSelector?: string; kind?: ReadKind }): Model | ModelError => {
    if (hint.kind === 'keyvalue') return keyvalueModel(root)
    if (hint.kind === 'cards') return cardsModel(root, hint.rowSelector)
    const shape = shapeOf(root)
    if (!shape) {
      const asList = listgridModel(root, hint.rowSelector)
      if (!('error' in asList)) return asList
    }
    if (!shape) return { error: { code: 'TABLE_SHAPE_UNSUPPORTED', message: '这个区域不是表格或常见的表格控件' } }
    const adapter = adapters.find((a) => a.shape === shape)
    if (adapter) return adapter.model(root)
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
    const rootEl = resolveShell(el)
    const model = buildModel(rootEl, { header: args.header, rowSelector: args.rowSelector, kind: args.kind })
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
    const parent = rootEl.parentElement
    if (!emptyVerified && args.emptySelector) {
      emptyVerified = Boolean(rootEl.querySelector(args.emptySelector)) || Boolean(parent?.querySelector(args.emptySelector))
    }
    const busy = model.isBusy || Boolean(args.loadingSelector && rootEl.querySelector(args.loadingSelector))
    return {
      ok: true,
      shape: model.shape,
      isBusy: busy,
      emptyVerified,
      hasPagination: model.hasPagination,
      virtualScroll: Boolean(model.virtualHint) || virtualScrollSuspected(rootEl, model.renderedRowEls),
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
      for (const a of adapters) if (a.normalizeRoot && node.matches?.(a.claimSelector)) return a.normalizeRoot(node)
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
        let listRoot: any = null
        if (!structured) {
          if (args.forceRoot) listRoot = 'error' in listgridModel(el) ? null : el
          else listRoot = findListgrid(el)
        }
        if (listRoot) {
          root = listRoot
        } else if (!structured) {
          if (chain.length === 0) return { ok: false, code: 'TABLE_SHAPE_UNSUPPORTED', message: '点到的位置不在表格、卡片或“名称：值”信息里' }
          return { ok: false, code: 'TABLE_SHAPE_UNSUPPORTED', message: '点到的位置所在的表格看起来不是数据表（可能是页面排版用的表格）' }
        }
        else root = structured.root
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
    const baseScore = gridRoot ? 10 : structured ? 6 : best && root === best.t ? best.score : 6
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
        : gridRoot || args.forceRoot || structured || !best || root !== best.t
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

const ENTRY_SOURCE = `(el, req) => {
  const h = (${makeHelpers.toString()})(el.ownerDocument);
  const adapters = [${ADAPTER_FACTORIES.map((f) => `(${f.toString()})(h)`).join(',')}];
  return (${tableDomCore.toString()})(el, req, h, adapters);
}`

/**
 * 页面内入口。辅助、各适配器和核心在这里用 Function.toString 拼成一个自包含的函数；
 * Playwright 序列化函数时取其 toString()，所以页面里不需要 eval，也不受页面 CSP 影响。
 * mode=read 在表根上执行；mode=detect / feedback 在被点到的元素上执行。
 */
export const tableDomEntry: (el: any, req: TableDomRequest) => any = Object.assign((_el: any, _req: TableDomRequest): any => undefined, {
  toString: () => ENTRY_SOURCE,
})
