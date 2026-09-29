import {
  DomainError,
  forbidden,
} from '@cairn/db'
import {
  FACTORY_PLATFORM_CONFIG,
  executableStepTypesFor,
  hasPermission,
  platformRuntimeDefaultsFrom,
  resolutionCapabilitiesFromPlatform,
  resolveLocatorPlansForSteps,
  resolveAiExecutionFromPlatform,
  runNeedsAiExecute,
  scenarioCapabilitiesFor,
  type AiExecutionConfig,
  type PlatformConfigDocument,
  type ResolutionPolicy,
  type LocatorPlan,
  type TargetResolutionPolicy,
  type ScenarioCapabilities,
} from '@cairn/shared'
import { config } from './env'
import type { RequestAccount } from '../common/request-account'

export function browserAiCapabilitiesFrom(
  document: PlatformConfigDocument,
  revision: number,
): ScenarioCapabilities {
  return scenarioCapabilitiesFor({
    browserAiEnabled: document.browserAi.enabled,
    fixtureStepsEnabled: document.fixtureStepsEnabled,
    defaults: platformRuntimeDefaultsFrom(document, revision),
    resolution: resolutionCapabilitiesFromPlatform(document),
  })
}

export function executableTypesFrom(document: PlatformConfigDocument = FACTORY_PLATFORM_CONFIG) {
  return executableStepTypesFor(document.browserAi.enabled, document.fixtureStepsEnabled)
}

export function resolveAiExecution(
  steps: readonly { type: string; policy?: { timeoutMs?: number; retryLimit?: number } }[],
  document: PlatformConfigDocument,
  extras: { revision: number; hangWaitMs?: number },
): AiExecutionConfig | undefined {
  try {
    return resolveAiExecutionFromPlatform(steps, document, {
      revision: extras.revision,
      hangWaitMs: extras.hangWaitMs ?? config.CAIRN_BROWSER_AI_HANG_WAIT_MS,
    })
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error ? String(error.code) : 'AI_CONFIG_INVALID'
    throw new DomainError(
      'bad_request',
      code,
      error instanceof Error ? error.message : '浏览器仿真 AI 配置无效',
    )
  }
}

export function assertAiExecutePermission(
  actor: RequestAccount,
  steps: readonly { id?: string; type: string; policy?: { resolution?: ResolutionPolicy; locatorPlan?: LocatorPlan } }[],
  extras?: {
    document?: PlatformConfigDocument
    documentResolution?: ResolutionPolicy
    targetCeiling?: ResolutionPolicy
    targetPreference?: ResolutionPolicy
    documentLocatorPlan?: LocatorPlan
    locatorProtocol?: 2
    targetPolicy?: TargetResolutionPolicy | null
  },
): void {
  const document = extras?.document ?? FACTORY_PLATFORM_CONFIG
  const v2 = Boolean(extras?.locatorProtocol === 2 || extras?.documentLocatorPlan || steps.some((step) => step.policy?.locatorPlan))
  const needsAi = v2
    ? steps.some((step) => step.type.startsWith('ai_')) || Object.values(resolveLocatorPlansForSteps({
      steps: steps.map((step, index) => ({ ...step, id: step.id ?? String(index) })),
      document,
      target: extras?.targetPolicy,
      scenarioPlan: extras?.documentLocatorPlan,
      scenarioPolicy: extras?.documentResolution,
    })).some((plan) => plan.actual.some((route) => route !== 'rule'))
    : runNeedsAiExecute({
    steps,
    document,
    documentResolution: extras?.documentResolution,
    targetCeiling: extras?.targetCeiling,
    targetPreference: extras?.targetPreference,
  })
  if (!needsAi) return
  if (!hasPermission(actor.permissions, 'ai:execute')) {
    throw forbidden('AI_EXECUTE_FORBIDDEN', '缺少 ai:execute，不能运行含 AI 步骤或 AI 解析档位的场景')
  }
}
