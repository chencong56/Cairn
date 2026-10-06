import { z } from 'zod'
import { entityIdSchema } from './wire.js'
import type { LocatorCandidate } from './target-descriptor.js'
import { locatorLimitsSchema, locatorPlanSchema } from './locator-plan.js'

/**
 * 解析决策记录的有效策略标签：由定位路线反向归并出一个紧凑档位，
 * 只用于决策事实的展示与统计，不参与运行时的定位计划解析。
 */
export const RESOLUTION_POLICIES = [
  'deterministic_only',
  'prefer_deterministic_text',
  'prefer_deterministic',
  'prefer_text_ai',
  'prefer_ai',
  'ai_only',
] as const
export type ResolutionPolicy = (typeof RESOLUTION_POLICIES)[number]
export const resolutionPolicySchema = z.enum(RESOLUTION_POLICIES)

export const targetResolutionPolicySchema = z
  .strictObject({
    plan: locatorPlanSchema.optional(),
    limits: locatorLimitsSchema.optional(),
  })
  .refine((value) => value.plan !== undefined || value.limits !== undefined, {
    message: '至少指定该系统默认定位顺序或允许的定位能力',
  })
export type TargetResolutionPolicy = z.infer<typeof targetResolutionPolicySchema>

export const targetResolutionPolicyPatchSchema = z.strictObject({
  plan: locatorPlanSchema.nullable().optional(),
  limits: locatorLimitsSchema.nullable().optional(),
})
export type TargetResolutionPolicyPatch = z.infer<typeof targetResolutionPolicyPatchSchema>

export function parseTargetResolutionPolicy(value: unknown): TargetResolutionPolicy | null {
  if (value == null) return null
  const parsed = z
    .strictObject({
      plan: locatorPlanSchema.optional(),
      limits: locatorLimitsSchema.optional(),
    })
    .parse(value)
  if (parsed.plan === undefined && parsed.limits === undefined) return null
  return targetResolutionPolicySchema.parse(parsed)
}

export function applyTargetResolutionPolicyPatch(
  current: TargetResolutionPolicy | null,
  patch: TargetResolutionPolicyPatch,
): TargetResolutionPolicy | null {
  const next: { plan?: import('./locator-plan.js').LocatorPlan; limits?: import('./locator-plan.js').LocatorLimits } = { ...current }
  if (patch.plan === null) delete next.plan
  else if (patch.plan !== undefined) next.plan = patch.plan
  if (patch.limits === null) delete next.limits
  else if (patch.limits !== undefined) next.limits = patch.limits
  return parseTargetResolutionPolicy(next)
}

const ROLE_LABELS: Record<string, string> = {
  button: '按钮',
  heading: '标题',
  link: '链接',
  menuitem: '菜单项',
  textbox: '文本框',
  searchbox: '搜索框',
  combobox: '下拉框',
  checkbox: '复选框',
  radio: '单选',
  tab: '页签',
  option: '选项',
}

/** 图标字体、私用区和零宽字符不能当给人看的定位名，也会干扰角色名匹配。 */
export function sanitizeLocatorLabel(value: string): string {
  return value
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\uE000-\uF8FF]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/([「『])\s+/g, '$1')
    .replace(/\s+([」』])/g, '$1')
    .trim()
}

export function describeLocatorCandidates(candidates: readonly LocatorCandidate[]): string {
  const preferred = candidates.find((candidate) => candidate.by !== 'css') ?? candidates[0]
  if (!preferred) return ''
  if (preferred.by === 'role') {
    const role = ROLE_LABELS[preferred.value] ?? preferred.value
    const name = preferred.name ? sanitizeLocatorLabel(preferred.name) : ''
    return name ? `名为「${name}」的${role}` : role
  }
  if (preferred.by === 'label') return `标签为「${sanitizeLocatorLabel(preferred.value)}」的元素`
  if (preferred.by === 'text') return `文本为「${sanitizeLocatorLabel(preferred.value)}」的元素`
  if (preferred.by === 'title') return `标题为「${sanitizeLocatorLabel(preferred.value)}」的元素`
  if (preferred.by === 'testId') return `测试标识为「${preferred.value}」的元素`
  return `选择器为「${preferred.value}」的元素`
}

export function normalizeCrossCheckText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, '').toLowerCase()
}

export const CROSS_CHECK_CONTAINER_TAGS = [
  'DIV',
  'SECTION',
  'ARTICLE',
  'MAIN',
  'ASIDE',
  'NAV',
  'HEADER',
  'FOOTER',
  'FORM',
  'TABLE',
  'TBODY',
  'THEAD',
  'TFOOT',
  'TR',
  'TD',
  'TH',
  'UL',
  'OL',
  'DL',
  'BODY',
  'HTML',
  'FIELDSET',
] as const

export function isCrossCheckContainerTag(tagName: string): boolean {
  return (CROSS_CHECK_CONTAINER_TAGS as readonly string[]).includes(tagName.toUpperCase())
}

export function crossCheckMatches(
  elementTexts: readonly string[],
  candidates: readonly LocatorCandidate[],
): boolean {
  const hay = elementTexts.map(normalizeCrossCheckText).filter(Boolean)
  return candidates.some((candidate) => {
    if (candidate.by === 'css' || candidate.by === 'testId') return false
    const needles = (candidate.by === 'role' ? [candidate.name] : [candidate.value])
      .filter((item): item is string => Boolean(item))
      .map(normalizeCrossCheckText)
    return needles.some((needle) => needle && hay.some((item) => item.includes(needle)))
  })
}
