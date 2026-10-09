/* eslint-disable @typescript-eslint/no-explicit-any */
import type { TableShape } from '../table-read-dom.js'

/** 统一模型：各形态适配器都输出它，列映射、合计行、数据检查等后续环节不感知控件类型。 */
export type ModelCol = { leaf: string; path: string; field?: string; hidden?: boolean; special?: 'checkbox' | 'index' }
export type ModelRow = { el: any; cells: Array<any | null> }
export type Model = {
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
  /** 适配器自己确知“只渲染了一部分行 / 列”（虚拟化）。核心把它并入虚拟滚动线索，读取不得宣称完整。 */
  virtualHint?: boolean
}
export type ModelError = { error: { code: string; message: string } }

/** 页面内通用辅助，由 makeHelpers 在页面里创建后传给每个适配器。 */
export type AdapterHelpers = {
  doc: any
  win: any
  clean: (t: any) => string
  textOf: (node: any) => string
  stripSort: (t: string) => string
  roleOf: (node: any) => string
  isHidden: (node: any) => boolean
  attrSel: (name: string, value: string) => string
  leafPath: (leaf: string, group?: string) => string
  PAGER_RE: RegExp
  EMPTY_RE: RegExp
  PAGER_SEL: string
  pagerNear: (node: any) => boolean
  TOTAL_RE: RegExp
  CHECKBOX_SEL: string
}

/**
 * 一种表格控件 = 一份适配器描述。识别、壳节点重定向、点选归一、取模型都从这里派生；
 * 新增控件只需新增一个适配器文件并登记到 registry.ts。
 */
export type TableAdapter = {
  shape: TableShape
  /** 命中即认定这个节点（或其内部结构）属于该控件，用于判定形态。 */
  claimSelector: string
  /** 用于从控件内部节点向上找控件根（closest），汇入全局 GRID 选择器。 */
  gridSelector: string
  /** 控件内部的子表：选择器或点选落在其上时，改读整个控件。 */
  innerPartSelector?: string
  /** 点到控件的某个部件时，归一到真正的根。 */
  normalizeRoot?: (node: any) => any
  /** 隐藏的原始空壳 → 渲染出来的控件根；不适用返回 null。 */
  resolveShell?: (node: any) => any | null
  model: (root: any) => Model | ModelError
}
