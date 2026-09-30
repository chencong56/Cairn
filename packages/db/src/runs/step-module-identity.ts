import type { RunSnapshot } from '@cairn/shared'

export interface StepModuleIdentity {
  moduleId: string | null
  implementationKey: string | null
  internalStepId: string | null
}

/**
 * 依据 Run 快照内冻结的 moduleManifest 与 candidateGroups 映射，
 * 确定该展开步骤是否归属动作模块内部步骤及其对应的实现三元组。
 */
export function resolveStepModuleIdentity(
  stepId: string,
  snapshot?: RunSnapshot | null,
): StepModuleIdentity {
  if (!snapshot?.moduleManifest?.entries?.length) {
    return { moduleId: null, implementationKey: null, internalStepId: null }
  }

  for (const entry of snapshot.moduleManifest.entries) {
    // 1. 优先查 internalToExpanded 明确的内部步骤映射
    if (entry.internalToExpanded) {
      for (const [key, expId] of Object.entries(entry.internalToExpanded)) {
        if (expId === stepId) {
          if (key.includes(':')) {
            const colonIdx = key.indexOf(':')
            const implKey = key.slice(0, colonIdx)
            const intStepId = key.slice(colonIdx + 1)
            return {
              moduleId: entry.moduleId,
              implementationKey: implKey || entry.implementationKey,
              internalStepId: intStepId || null,
            }
          }
          return {
            moduleId: entry.moduleId,
            implementationKey: entry.implementationKey,
            internalStepId: key,
          }
        }
      }
    }

    // 2. 检查多实现备选组 candidateGroups
    const candidateGroups =
      snapshot.candidateGroups?.groups ??
      (entry as unknown as { candidateGroups?: Array<{ invocationId: string; alternatives: Array<{ implementationKey: string; stepIds: string[] }> }> }).candidateGroups ??
      []
    for (const group of candidateGroups) {
      if (group.invocationId === entry.invocationId) {
        for (const alt of group.alternatives) {
          if (alt.stepIds.includes(stepId)) {
            return {
              moduleId: entry.moduleId,
              implementationKey: alt.implementationKey,
              internalStepId: null,
            }
          }
        }
      }
    }

    // 3. 兜底判定 expandedStepIds
    if (entry.expandedStepIds?.includes(stepId)) {
      return {
        moduleId: entry.moduleId,
        implementationKey: entry.implementationKey,
        internalStepId: null,
      }
    }
  }

  return { moduleId: null, implementationKey: null, internalStepId: null }
}
