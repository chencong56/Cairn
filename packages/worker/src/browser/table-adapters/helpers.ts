/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AdapterHelpers } from './types.js'

/**
 * Node 侧判断“合计 / 小计”表头文字（交叉表逆透视拆列维度用）。
 * makeHelpers 里的 TOTAL_RE 序列化进页面执行、不能引用模块作用域，两处必须同步改。
 */
export const TOTAL_HEADER_RE = /^(合计|总计|小计|汇总|合\s*计|总\s*计|total|sum|subtotal)\s*[:：]?$/i

/** 页面内自包含：不得引用模块作用域内的任何运行时值。 */
export function makeHelpers(doc: any): AdapterHelpers {
  const win: any = doc.defaultView
  const clean = (t: any): string =>
    String(t ?? '')
      .replace(/\u00a0/g, ' ')
      .replace(/\u3000/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  const textOf = (node: any): string => clean(node ? node.innerText || node.textContent || '' : '')
  const stripSort = (t: string): string => clean(t.replace(/[▲▼△▽↑↓⇅⇧⇩↕]+/g, ''))
  const roleOf = (node: any): string => String(node?.getAttribute?.('role') || '').toLowerCase()
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
  const CHECKBOX_SEL = 'input[type="checkbox"],input[type="radio"],.layui-form-checkbox,.x-grid-row-checker,.cbox,.datagrid-cell-check'
  const leafPath = (leaf: string, group?: string): string => (group && group !== leaf ? `${group} / ${leaf}` : leaf)
  return { doc, win, clean, textOf, stripSort, roleOf, isHidden, attrSel, leafPath, PAGER_RE, EMPTY_RE, PAGER_SEL, pagerNear, TOTAL_RE, CHECKBOX_SEL }
}
