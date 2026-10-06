import { describe, expect, it } from 'vitest'
import { LOCATOR_PRESETS, locatorLimitsSchema, locatorPlanSchema, locatorPlanPreset } from '../locator-plan.js'
import { resolveLocatorPlan } from '../locator-resolution.js'

const platform = {
  plan: locatorPlanPreset('rule_text_vision'),
  limits: { v: 2 as const, allowed: ['rule', 'text_ai', 'vision_ai'] as ('rule' | 'text_ai' | 'vision_ai')[] },
}

describe('定位计划 v2', () => {
  it('路线非空去重，能力上限与尝试顺序分开', () => {
    expect(() => locatorPlanSchema.parse({ v: 2, order: ['rule', 'rule'] })).toThrow()
    expect(() => locatorPlanSchema.parse({ v: 2, order: [] })).toThrow()
    expect(locatorLimitsSchema.parse({ v: 2, allowed: ['rule', 'vision_ai'] }).allowed).toEqual(['rule', 'vision_ai'])
  })

  it('完整上限下保留文本优先的真实顺序', () => {
    const result = resolveLocatorPlan({
      platform,
      step: { plan: locatorPlanPreset('text_rule') },
      textReady: true,
      visionReady: true,
    })
    expect(result.actual).toEqual(['text_ai', 'rule'])
    expect(result.source).toBe('step')
  })

  it('继承计划裁掉未就绪路线并给原因，显式选择则阻断', () => {
    const inherited = resolveLocatorPlan({ platform, textReady: false, visionReady: true })
    expect(inherited.actual).toEqual(['rule', 'vision_ai'])
    expect(inherited.skipped).toEqual([{ route: 'text_ai', reason: 'TEXT_NOT_READY' }])
    expect(() => resolveLocatorPlan({
      platform,
      step: { plan: locatorPlanPreset('text_only') },
      textReady: false,
      visionReady: true,
    })).toThrow(/平台 AI 文本模型未就绪/)
  })

  it('目标系统只能收紧平台上限，显式冲突给上限来源', () => {
    const target = { limits: { v: 2 as const, allowed: ['rule'] as ('rule' | 'text_ai' | 'vision_ai')[] } }
    expect(resolveLocatorPlan({ platform, target, textReady: true, visionReady: true }).actual).toEqual(['rule'])
    expect(() => resolveLocatorPlan({
      platform, target, step: { plan: locatorPlanPreset('vision_only') }, textReady: true, visionReady: true,
    })).toThrow(/目标系统定位能力上限/)
  })

  it('九种预设的执行顺序与用户选择完全一致', () => {
    for (const preset of Object.values(LOCATOR_PRESETS)) {
      const actual = resolveLocatorPlan({ platform, step: { plan: { v: 2, order: [...preset.order] } }, textReady: true, visionReady: true })
      expect(actual.actual).toEqual(preset.order)
    }
  })

})
