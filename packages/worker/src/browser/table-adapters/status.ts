/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AdapterHelpers } from './types.js'

export type StatusTone = 'success' | 'warning' | 'error' | 'info' | 'processing' | 'default' | 'unknown'

/** 一条语义规则：哪种组件（on）上满足什么条件（test）就是什么语义。id 用于一致性用例逐条核对。 */
export type StatusRule = { id: string; on: string; tone: Exclude<StatusTone, 'unknown'>; test: (el: any) => boolean }

export type StatusReader = {
  /** 认得的状态组件根：标签、徽标、进度、步骤项、告警。 */
  ITEM_SEL: string
  rules: StatusRule[]
  /** 一格里的状态组件（格本身或其后代），没有返回 null。 */
  statusIn: (node: any) => any | null
  /** 组件的语义：按规则表第一条命中为准；认得是状态组件但没有规则命中 → unknown。 */
  toneOf: (el: any) => StatusTone
  /** 命中的规则 id（一致性用例核对每条规则都有覆盖）。 */
  ruleOf: (el: any) => string | null
  /** 进度百分比（0–100），读不出返回 null。 */
  percentOf: (el: any) => number | null
  /** 状态项的文字：步骤取标题、告警取消息（不带步骤序号等图标文字）。 */
  labelOf: (el: any) => string
  /** 一个状态区域里的各项（不含嵌在别的项里的）。 */
  regionItems: (root: any) => any[]
  /** 从点到的元素找状态区域：在状态组件上才算（步骤条整体、否则组件的父节点）。 */
  findRegion: (start: any) => { root: any } | null
}

/**
 * 状态信号读取（页面内自包含：只允许使用参数 h 提供的辅助）。
 *
 * 语义只按组件库官方类名的显式映射表认（antd、Element、Bootstrap、layui、ARIA），不按颜色猜；
 * 预设颜色（如 antd 的 green / blue 标签、自定义类名）不是语义，记为 unknown。
 */
export function makeStatusReader(h: AdapterHelpers): StatusReader {
  const { clean, isHidden, textOf } = h
  const has = (el: any, cls: string): boolean => Boolean(el?.classList?.contains(cls))
  const any = (el: any, sel: string): boolean => Boolean(el?.matches?.(sel) || el?.querySelector?.(sel))
  const classes = (el: any): string[] => Array.from(el?.classList ?? []) as string[]

  const COMPONENTS = [
    '.ant-tag',
    '.ant-badge-status',
    '.ant-progress',
    '.ant-steps-item',
    '.ant-alert',
    '.el-tag',
    '.el-progress',
    '.el-step',
    '.el-alert',
    '.badge',
    '.alert',
    '.progress',
    '.layui-badge',
    '.layui-badge-dot',
    '.layui-badge-rim',
    '.layui-progress',
    '[role="progressbar"]',
  ]
  const ITEM_SEL = COMPONENTS.join(',')

  const rule = (id: string, on: string, tone: StatusRule['tone'], test: (el: any) => boolean): StatusRule => ({ id, on, tone, test })
  const bootstrapTone = (prefix: string): Array<[string, StatusRule['tone']]> => [
    [`${prefix}success`, 'success'],
    [`${prefix}danger`, 'error'],
    [`${prefix}warning`, 'warning'],
    [`${prefix}info`, 'info'],
    [`${prefix}primary`, 'default'],
    [`${prefix}secondary`, 'default'],
    [`${prefix}light`, 'default'],
    [`${prefix}dark`, 'default'],
  ]
  const ANTD_COLOR = /^ant-tag-(magenta|red|volcano|orange|gold|lime|green|cyan|blue|geekblue|purple|has-color)$/
  const LAYUI: Array<[string, StatusRule['tone']]> = [
    ['layui-bg-green', 'success'],
    ['layui-bg-orange', 'warning'],
    ['layui-bg-red', 'error'],
    ['layui-bg-blue', 'info'],
    ['layui-bg-gray', 'default'],
    ['layui-bg-cyan', 'default'],
    ['layui-bg-black', 'default'],
  ]

  const rules: StatusRule[] = [
    // antd：Tag 的状态色、Badge 状态点、Progress 状态、Steps 项状态、Alert 类型
    ...(['success', 'processing', 'error', 'warning', 'default'] as const).map((t) => rule(`antd-tag-${t}`, '.ant-tag', t, (el) => has(el, `ant-tag-${t}`))),
    rule('antd-tag-plain', '.ant-tag', 'default', (el) => !classes(el).some((c) => ANTD_COLOR.test(c) || /^ant-tag-(success|processing|error|warning|default)$/.test(c))),
    ...(['success', 'processing', 'error', 'warning', 'default'] as const).map((t) => rule(`antd-badge-${t}`, '.ant-badge-status', t, (el) => any(el, `.ant-badge-status-${t}`))),
    rule('antd-progress-success', '.ant-progress', 'success', (el) => has(el, 'ant-progress-status-success')),
    rule('antd-progress-exception', '.ant-progress', 'error', (el) => has(el, 'ant-progress-status-exception')),
    rule('antd-progress-active', '.ant-progress', 'processing', (el) => has(el, 'ant-progress-status-active')),
    rule('antd-progress-normal', '.ant-progress', 'default', (el) => has(el, 'ant-progress-status-normal')),
    rule('antd-steps-finish', '.ant-steps-item', 'success', (el) => has(el, 'ant-steps-item-finish')),
    rule('antd-steps-process', '.ant-steps-item', 'processing', (el) => has(el, 'ant-steps-item-process')),
    rule('antd-steps-error', '.ant-steps-item', 'error', (el) => has(el, 'ant-steps-item-error')),
    rule('antd-steps-wait', '.ant-steps-item', 'default', (el) => has(el, 'ant-steps-item-wait')),
    ...(['success', 'info', 'warning', 'error'] as const).map((t) => rule(`antd-alert-${t}`, '.ant-alert', t, (el) => has(el, `ant-alert-${t}`))),
    // Element：el-tag 类型（无类型＝默认）、el-progress 状态、el-step 头部状态、el-alert 类型
    rule('element-tag-success', '.el-tag', 'success', (el) => has(el, 'el-tag--success')),
    rule('element-tag-warning', '.el-tag', 'warning', (el) => has(el, 'el-tag--warning')),
    rule('element-tag-danger', '.el-tag', 'error', (el) => has(el, 'el-tag--danger')),
    rule('element-tag-info', '.el-tag', 'info', (el) => has(el, 'el-tag--info')),
    rule('element-tag-plain', '.el-tag', 'default', (el) => !classes(el).some((c) => /^el-tag--(success|warning|danger|info)$/.test(c))),
    rule('element-progress-success', '.el-progress', 'success', (el) => has(el, 'is-success')),
    rule('element-progress-exception', '.el-progress', 'error', (el) => has(el, 'is-exception')),
    rule('element-progress-warning', '.el-progress', 'warning', (el) => has(el, 'is-warning')),
    rule('element-progress-plain', '.el-progress', 'default', (el) => !classes(el).some((c) => /^is-/.test(c))),
    rule('element-step-success', '.el-step', 'success', (el) => any(el, '.el-step__head.is-success, .el-step__head.is-finish')),
    rule('element-step-process', '.el-step', 'processing', (el) => any(el, '.el-step__head.is-process')),
    rule('element-step-error', '.el-step', 'error', (el) => any(el, '.el-step__head.is-error')),
    rule('element-step-wait', '.el-step', 'default', (el) => any(el, '.el-step__head.is-wait')),
    ...(['success', 'info', 'warning', 'error'] as const).map((t) => rule(`element-alert-${t}`, '.el-alert', t, (el) => has(el, `el-alert--${t}`))),
    // Bootstrap 4 / 5：badge、alert、progress-bar 的上下文色
    ...[...bootstrapTone('bg-'), ...bootstrapTone('text-bg-'), ...bootstrapTone('badge-')].map(([cls, t]) => rule(`bootstrap-badge-${cls}`, '.badge', t, (el) => has(el, cls))),
    ...bootstrapTone('alert-').map(([cls, t]) => rule(`bootstrap-${cls}`, '.alert', t, (el) => has(el, cls))),
    ...bootstrapTone('bg-').map(([cls, t]) => rule(`bootstrap-progress-${cls}`, '.progress', t, (el) => any(el, `.progress-bar.${cls}`))),
    rule('bootstrap-progress-plain', '.progress', 'default', (el) => {
      const bar = el.querySelector?.('.progress-bar')
      return Boolean(bar) && !classes(bar).some((c) => /^bg-/.test(c))
    }),
    // layui：徽章与进度条的官方颜色类
    ...LAYUI.map(([cls, t]) => rule(`layui-badge-${cls}`, '.layui-badge,.layui-badge-dot,.layui-badge-rim', t, (el) => has(el, cls))),
    ...LAYUI.map(([cls, t]) => rule(`layui-progress-${cls}`, '.layui-progress', t, (el) => any(el, `.layui-progress-bar.${cls}`))),
    rule('layui-progress-plain', '.layui-progress', 'default', (el) => {
      const bar = el.querySelector?.('.layui-progress-bar')
      return Boolean(bar) && !classes(bar).some((c) => /^layui-bg-/.test(c))
    }),
    // ARIA：进度条本身没有语义，只给进度（组件库的进度条按它自己的类名认，认不出就是未识别）
    rule('aria-progressbar', '[role="progressbar"]', 'default', (el) => !el.matches?.('.ant-progress, .el-progress, .progress, .layui-progress')),
  ]

  const componentOf = (el: any): string | null => COMPONENTS.find((sel) => el?.matches?.(sel)) ?? null

  const ruleFor = (el: any): StatusRule | null => {
    if (!el) return null
    for (const r of rules) {
      try {
        if (el.matches?.(r.on) && r.test(el)) return r
      } catch {
        // 规则出错就当没命中
      }
    }
    return null
  }
  const toneOf = (el: any): StatusTone => ruleFor(el)?.tone ?? 'unknown'
  const ruleOf = (el: any): string | null => ruleFor(el)?.id ?? null

  const statusIn = (node: any): any | null => {
    if (!node) return null
    if (componentOf(node)) return node
    const found = (Array.from(node.querySelectorAll?.(ITEM_SEL) ?? []) as any[]).find((n) => !isHidden(n))
    return found ?? null
  }

  const pct = (text: string): number | null => {
    const m = /(-?\d+(?:\.\d+)?)\s*%/.exec(clean(text))
    if (!m) return null
    const n = Number(m[1])
    return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null
  }
  const percentOf = (el: any): number | null => {
    if (!el) return null
    const bar = el.matches?.('[role="progressbar"]') ? el : el.querySelector?.('[role="progressbar"]')
    if (bar && bar.getAttribute('aria-valuenow') !== null) {
      const now = Number(bar.getAttribute('aria-valuenow'))
      const min = Number(bar.getAttribute('aria-valuemin') ?? 0)
      const max = Number(bar.getAttribute('aria-valuemax') ?? 100)
      if (Number.isFinite(now) && max > min) return Math.round(((now - min) / (max - min)) * 10000) / 100
    }
    const lay = el.matches?.('.layui-progress-bar') ? el : el.querySelector?.('.layui-progress-bar')
    if (lay?.getAttribute('lay-percent')) return pct(lay.getAttribute('lay-percent'))
    const text = el.querySelector?.('.ant-progress-text, .el-progress__text')
    if (text) {
      const n = pct(textOf(text))
      if (n !== null) return n
      // antd / Element 完成时文字换成对勾：状态为成功即 100%
      if (has(el, 'ant-progress-status-success') || has(el, 'is-success')) return 100
    }
    const bsBar = el.matches?.('.progress-bar') ? el : el.querySelector?.('.progress-bar')
    if (bsBar) {
      const w = /(-?\d+(?:\.\d+)?)%/.exec(String(bsBar.style?.width ?? ''))
      if (w) return Number(w[1])
    }
    return pct(textOf(el))
  }

  const labelOf = (el: any): string => {
    const title = el?.querySelector?.('.ant-steps-item-title, .el-step__title, .ant-alert-message, .el-alert__title')
    return textOf(title ?? el)
  }

  const regionItems = (root: any): any[] => {
    const all = (Array.from(root?.querySelectorAll?.(ITEM_SEL) ?? []) as any[]).filter((n) => !isHidden(n))
    if (root && componentOf(root)) all.unshift(root)
    return all.filter((n) => !all.some((o) => o !== n && o.contains(n)))
  }

  const findRegion = (start: any): { root: any } | null => {
    const item = start?.closest?.(ITEM_SEL)
    if (!item) return null
    const steps = item.closest?.('.ant-steps, .el-steps')
    if (steps) return { root: steps }
    return { root: item.parentElement ?? item }
  }

  return { ITEM_SEL, rules, statusIn, toneOf, ruleOf, percentOf, labelOf, regionItems, findRegion }
}
