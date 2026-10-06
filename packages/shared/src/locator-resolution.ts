import {
  LOCATOR_ROUTE_LABELS,
  locatorPlanSchema,
  type LocatorLimits,
  type LocatorPlan,
  type LocatorRoute,
  type LocatorSkip,
} from './locator-plan.js'
import type { PlatformConfigDocument } from './platform-config.js'
import type { TargetResolutionPolicy } from './resolution-policy.js'
import { isAiStepType } from './step.js'

export type LocatorLayer = { plan?: LocatorPlan }
export type LocatorLimitLayer = { limits?: LocatorLimits }

export type LocatorResolutionInput = {
  platform: { plan: LocatorPlan; limits: LocatorLimits }
  target?: LocatorLayer & LocatorLimitLayer
  scenario?: LocatorLayer
  step?: LocatorLayer
  textReady: boolean
  visionReady: boolean
}

export type LocatorResolution = {
  requested: LocatorRoute[]
  actual: LocatorRoute[]
  skipped: LocatorSkip[]
  allowed: LocatorRoute[]
  source: 'step' | 'scenario' | 'target' | 'platform'
}

export class LocatorPlanError extends Error {
  readonly code = 'LOCATOR_ROUTE_UNAVAILABLE'
  constructor(message: string, readonly route?: LocatorRoute) {
    super(message)
    this.name = 'LocatorPlanError'
  }
}

export function resolveLocatorPlan(input: LocatorResolutionInput): LocatorResolution {
  const platformAllowed = input.platform.limits.allowed
  const targetAllowed = input.target?.limits?.allowed ?? platformAllowed
  const allowed = platformAllowed.filter((route) => targetAllowed.includes(route))

  const layer = input.step?.plan ? input.step
    : input.scenario?.plan ? input.scenario
    : input.target?.plan ? input.target
    : input.platform
  const source: LocatorResolution['source'] = layer === input.step ? 'step'
    : layer === input.scenario ? 'scenario'
    : layer === input.target ? 'target' : 'platform'
  const requested = [...locatorPlanSchema.parse(layer.plan).order]
  const explicit = source === 'step' || source === 'scenario'
  const skipped: LocatorSkip[] = []
  const actual: LocatorRoute[] = []
  for (const route of requested) {
    const reason = !platformAllowed.includes(route) ? 'PLATFORM_LIMIT'
      : !targetAllowed.includes(route) ? 'TARGET_LIMIT'
      : route === 'text_ai' && !input.textReady ? 'TEXT_NOT_READY'
      : route === 'vision_ai' && !input.visionReady ? 'VISION_NOT_READY' : undefined
    if (!reason) { actual.push(route); continue }
    if (explicit) {
      const detail = reason === 'TEXT_NOT_READY' ? '平台 AI 文本模型未就绪，请检查启用状态、地址、模型和绑定密钥'
        : reason === 'VISION_NOT_READY' ? '浏览器 AI 视觉模型未就绪，请检查启用状态、地址、模型和绑定密钥'
        : reason === 'TARGET_LIMIT' ? '目标系统定位能力上限不允许此路线' : '平台定位能力上限不允许此路线'
      throw new LocatorPlanError(`${detail}：${LOCATOR_ROUTE_LABELS[route]}`, route)
    }
    skipped.push({ route, reason })
  }
  if (actual.length === 0) throw new LocatorPlanError('定位计划没有可用路线，请检查平台 AI / 浏览器 AI 配置与能力上限')
  return { requested, actual, skipped, allowed, source }
}

export function locatorReadiness(document: PlatformConfigDocument): { textReady: boolean; visionReady: boolean } {
  return {
    textReady: Boolean(document.platformAi.enabled && document.platformAi.baseUrl && document.platformAi.model && document.platformAi.secretRef),
    visionReady: Boolean(document.browserAi.enabled && document.browserAi.baseUrl && document.browserAi.model && document.browserAi.modelFamily && document.browserAi.secretRef),
  }
}

export function resolveLocatorPlansForSteps(input: {
  steps: readonly { id: string; type?: string; input?: unknown; disabled?: boolean; policy?: { locatorPlan?: LocatorPlan } }[]
  document: PlatformConfigDocument
  target?: TargetResolutionPolicy | null
  scenarioPlan?: LocatorPlan
}): Record<string, LocatorResolution> {
  const readiness = locatorReadiness(input.document)
  const platform = {
    plan: input.document.locator.defaultPlan,
    limits: input.document.locator.limits,
  }
  const target = input.target ? {
    plan: input.target.plan,
    limits: input.target.limits,
  } : undefined
  const out: Record<string, LocatorResolution> = {}
  for (const step of input.steps) {
    if (step.disabled || !stepHasActionTarget(step)) continue
    out[step.id] = resolveLocatorPlan({
      platform,
      target,
      scenario: { plan: input.scenarioPlan },
      step: { plan: step.policy?.locatorPlan },
      ...readiness,
    })
  }
  return out
}

/** 不给导航、显式 AI 步骤或规则成功条件预留模型定位预算。 */
export function stepHasActionTarget(step: { type?: string; input?: unknown }): boolean {
  if (step.type === 'assert') return false
  if (step.input === undefined) return true
  return Boolean(step.input && typeof step.input === 'object' && 'target' in step.input && step.input.target)
}

/** 冻结的定位计划里只要实际会走模型路线，运行就需要 AI 执行权限。 */
export function locatorPlansNeedAiExecute(plans: Record<string, LocatorResolution>): boolean {
  return Object.values(plans).some((plan) => plan.actual.some((route) => route !== 'rule'))
}

/**
 * 运行创建与凭据权限共用的判定：显式 AI 步骤一定需要 AI；
 * 普通步骤按继承的定位计划解析，实际会走模型路线才算需要。
 * 定位计划解析失败按需要 AI 处理（运行本身也会因计划不可用而失败）。
 */
export function stepsNeedLocatorAiExecute(input: {
  steps: readonly { id?: string; type: string; disabled?: boolean; policy?: { locatorPlan?: LocatorPlan } }[]
  document: PlatformConfigDocument
  target?: TargetResolutionPolicy | null
  scenarioPlan?: LocatorPlan
}): boolean {
  if (input.steps.some((step) => !step.disabled && isAiStepType(step.type))) return true
  try {
    return locatorPlansNeedAiExecute(resolveLocatorPlansForSteps({
      document: input.document,
      target: input.target,
      scenarioPlan: input.scenarioPlan,
      steps: input.steps.map((step, index) => ({ ...step, id: step.id ?? String(index) })),
    }))
  } catch {
    return true
  }
}
