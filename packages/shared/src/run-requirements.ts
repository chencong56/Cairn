import { requiredRunInputKeys, type ScenarioDefinition, type ScenarioRunRequirements } from './scenario.js'
import { stepUsesBrowser } from './step.js'

/**
 * 已发布版本的运行前提：要填哪些输入、是否需要目标账号。
 * 与正式运行建单、调度建单同一口径：输入取 `requiredRunInputKeys`，
 * 启用的步骤里有浏览器步骤就需要账号。
 */
export function runRequirementsOf(definition: Pick<ScenarioDefinition, 'inputs' | 'steps'>): ScenarioRunRequirements {
  return {
    inputs: requiredRunInputKeys(definition),
    needsAccount: definition.steps.some((step) => !step.disabled && stepUsesBrowser(step.type)),
  }
}
