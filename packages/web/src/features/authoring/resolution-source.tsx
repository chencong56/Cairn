import { createContext, useContext, type ReactNode } from 'react'
import type { LocatorPlan, Step } from '@cairn/shared'

/** 编辑器上下文：目标、场景、当前草稿里的步骤（供文件来源选择“本步之前的下载步骤”、发起预览）。 */
type ResolutionSource = { targetId?: string; scenarioPlan?: LocatorPlan; scenarioId?: string; steps?: readonly Step[] }
const ResolutionSourceContext = createContext<ResolutionSource>({})

export function ResolutionSourceProvider({
  targetId,
  scenarioPlan,
  scenarioId,
  steps,
  children,
}: ResolutionSource & { children: ReactNode }) {
  return <ResolutionSourceContext.Provider value={{ targetId, scenarioPlan, scenarioId, steps }}>{children}</ResolutionSourceContext.Provider>
}

export function useResolutionTargetId() {
  return useContext(ResolutionSourceContext).targetId
}

export function useResolutionSource() { return useContext(ResolutionSourceContext) }
