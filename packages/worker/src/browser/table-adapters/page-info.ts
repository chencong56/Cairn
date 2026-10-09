/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AdapterHelpers, PageInfoDom } from './types.js'

/**
 * 分页条读数（页面内自包含：只允许使用参数 h 提供的辅助）。
 *
 * 只读分页条上直接显示的数字：总条数、当前页、每页条数、总页数、“第 x 到 y 条”。读不到的字段不给，不推算；
 * 同一字段出现互相矛盾的数字（例如上下两个分页条不一致）也不给。分页条里的输入框（“第 [1] 页”）
 * 与下拉框（每页条数）按其当前值参与读数。
 */
export function makePageInfoReader(h: AdapterHelpers): (root: any, pagerSelector?: string) => PageInfoDom | undefined {
  const { clean, isHidden, PAGER_SEL } = h

  /** 分页条的文字：跳过隐藏节点与图标，输入框 / 下拉框取当前值。 */
  const pagerText = (node: any): string => {
    const parts: string[] = []
    const walk = (n: any): void => {
      if (n.nodeType === 3) {
        parts.push(n.nodeValue ?? '')
        return
      }
      if (n.nodeType !== 1) return
      const tag = String(n.tagName).toUpperCase()
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'SVG' || tag === 'TEMPLATE') return
      if (isHidden(n)) return
      if (tag === 'INPUT') {
        const type = String(n.type || '').toLowerCase()
        if (!['hidden', 'checkbox', 'radio', 'button', 'submit'].includes(type) && n.value) parts.push(` ${n.value} `)
        return
      }
      if (tag === 'SELECT') {
        const opt = n.options?.[n.selectedIndex]
        if (opt) parts.push(` ${opt.text} `)
        return
      }
      parts.push(' ')
      for (const child of Array.from(n.childNodes) as any[]) walk(child)
      parts.push(' ')
    }
    walk(node)
    return clean(parts.join(''))
  }

  /** “1,234” / “1.2万” → 整数；不是整数就不认。 */
  const count = (raw: string): number | undefined => {
    const m = /^(\d[\d,]*(?:\.\d+)?)\s*(万|亿)?$/.exec(raw.trim())
    if (!m) return undefined
    const n = Number((m[1] as string).replace(/,/g, '')) * (m[2] === '亿' ? 1e8 : m[2] === '万' ? 1e4 : 1)
    const rounded = Math.round(n)
    return Number.isFinite(n) && Math.abs(n - rounded) < 1e-6 ? rounded : undefined
  }

  const NUM = String.raw`(\d[\d,]*(?:\.\d+)?\s*[万亿]?)`
  const ROW_UNIT = String.raw`(?:条|项|记录|行|笔|个)`
  const RANGE = [new RegExp(String.raw`(\d[\d,]*)\s*(?:到|至|-|–|—|~|to)\s*(\d[\d,]*)\s*${ROW_UNIT}?\s*(?:结果)?\s*[,，;；]?\s*(?:共|总共|总计|of)\s*${NUM}`, 'gi')]
  const TOTAL = [
    new RegExp(String.raw`(?:共|总共|总计|合计)\s*[:：]?\s*${NUM}\s*${ROW_UNIT}`, 'g'),
    new RegExp(String.raw`total\s*[:：]?\s*(\d[\d,]*)\s*(?:items?|records?|rows?|entries)?`, 'gi'),
    new RegExp(String.raw`(\d[\d,]*)\s*(?:items?|records?|entries)\s*in\s*total`, 'gi'),
  ]
  const PAGES = [
    /共\s*(\d+)\s*页/g,
    /page\s*\d+\s*of\s*(\d+)/gi,
    /第\s*\d+\s*[/／]\s*(\d+)\s*页/g,
  ]
  const CURRENT = [/第\s*(\d+)\s*(?:[/／]\s*\d+\s*)?页/g, /page\s*(\d+)\s*of\s*\d+/gi, /当前\s*第?\s*(\d+)\s*页/g]
  const SIZE = [
    /(\d+)\s*条\s*[/／]\s*页/g,
    /每页\s*(?:显示)?\s*[:：]?\s*(\d+)\s*(?:条|行|项|个)?/g,
    /(\d+)\s*条每页/g,
    /(\d+)\s*(?:items?\s*)?[/／]\s*page/gi,
    /page\s*size\s*[:：]?\s*(\d+)/gi,
  ]
  const ACTIVE_PAGE =
    '.ant-pagination-item-active,.el-pager .is-active,.el-pager .active,.layui-laypage-curr,[aria-current="page"],li.active,li.current,.pagination .active,.page-item.active,span.current'

  return (root: any, pagerSelector?: string): PageInfoDom | undefined => {
    const sel = pagerSelector ? `${PAGER_SEL},${pagerSelector}` : PAGER_SEL
    const hits = (n: any): any[] => {
      if (!n || n.nodeType !== 1) return []
      const out: any[] = []
      if (n.matches?.(sel)) out.push(n)
      out.push(...(Array.from(n.querySelectorAll?.(sel) ?? []) as any[]))
      return out
    }
    // 表内的分页条，或紧挨着的前 / 后兄弟（与 pagerNear 的范围一致，不去整个父容器里找）
    let pagers = [...hits(root).filter((n) => n !== root), ...hits(root.nextElementSibling), ...hits(root.previousElementSibling)].filter(
      (n) => !isHidden(n),
    )
    pagers = pagers.filter((n) => !pagers.some((o) => o !== n && o.contains(n)))
    if (pagers.length === 0) return undefined

    const found: Record<'totalRows' | 'currentPage' | 'pageSize' | 'totalPages', Set<number>> = {
      totalRows: new Set(),
      currentPage: new Set(),
      pageSize: new Set(),
      totalPages: new Set(),
    }
    const ranges = new Set<string>()
    const texts: string[] = []
    const scan = (text: string, patterns: RegExp[], into: Set<number>, group = 1): void => {
      for (const re of patterns) {
        re.lastIndex = 0
        for (let m = re.exec(text); m; m = re.exec(text)) {
          const n = count(m[group] ?? '')
          if (n !== undefined) into.add(n)
        }
      }
    }
    for (const pager of pagers) {
      const text = pagerText(pager)
      if (!text) continue
      texts.push(text)
      // 先取“第 x 到 y 条，共 N 条”，再把它从文字里去掉，避免其中的数字被别的规则误读
      let rest = text
      for (const re of RANGE) {
        re.lastIndex = 0
        for (let m = re.exec(text); m; m = re.exec(text)) {
          const from = count(m[1] ?? '')
          const to = count(m[2] ?? '')
          const total = count(m[3] ?? '')
          if (from !== undefined && to !== undefined && to >= from) ranges.add(`${from}-${to}`)
          if (total !== undefined) found.totalRows.add(total)
          rest = rest.replace(m[0], ' ')
        }
      }
      scan(rest, TOTAL, found.totalRows)
      scan(rest, PAGES, found.totalPages)
      scan(rest, CURRENT, found.currentPage)
      scan(rest, SIZE, found.pageSize)
      // 当前页：高亮的页码按钮
      const active = pager.querySelector?.(ACTIVE_PAGE)
      const activeText = active ? clean(active.innerText || active.textContent || '') : ''
      if (/^\d+$/.test(activeText)) found.currentPage.add(Number(activeText))
      // 每页条数：分页条里选项全是数字的下拉框（easyui pagination-page-list、jqGrid ui-pg-selbox 等）
      for (const s of Array.from(pager.querySelectorAll?.('select') ?? []) as any[]) {
        const opts = Array.from(s.options ?? []) as any[]
        if (opts.length > 0 && opts.every((o) => /^\s*\d+\s*$/.test(o.text))) {
          const v = count(opts[s.selectedIndex]?.text ?? '')
          if (v !== undefined) found.pageSize.add(v)
        }
      }
    }
    const one = (set: Set<number>): number | undefined => (set.size === 1 ? (Array.from(set)[0] as number) : undefined)
    const info: PageInfoDom = { rawText: texts.join(' | ').slice(0, 240) }
    const totalRows = one(found.totalRows)
    const currentPage = one(found.currentPage)
    const pageSize = one(found.pageSize)
    const totalPages = one(found.totalPages)
    if (totalRows !== undefined) info.totalRows = totalRows
    if (currentPage !== undefined && currentPage > 0) info.currentPage = currentPage
    if (pageSize !== undefined && pageSize > 0) info.pageSize = pageSize
    if (totalPages !== undefined && totalPages > 0) info.totalPages = totalPages
    if (ranges.size === 1) {
      const [from, to] = (Array.from(ranges)[0] as string).split('-').map(Number) as [number, number]
      info.rowRange = { from, to }
    }
    const ambiguous = [found.totalRows, found.currentPage, found.pageSize, found.totalPages].some((s) => s.size > 1) || ranges.size > 1
    if (ambiguous) info.ambiguous = true
    const anyField = info.totalRows !== undefined || info.currentPage !== undefined || info.pageSize !== undefined || info.totalPages !== undefined || info.rowRange
    return anyField || ambiguous ? info : undefined
  }
}
