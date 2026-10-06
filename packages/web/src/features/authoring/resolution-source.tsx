import { createContext, useContext, type ReactNode } from 'react'
import type { LocatorPlan } from '@cairn/shared'

type ResolutionSource = { targetId?: string; scenarioPlan?: LocatorPlan }
const ResolutionSourceContext = createContext<ResolutionSource>({})

export function ResolutionSourceProvider({
  targetId,
  scenarioPlan,
  children,
}: ResolutionSource & { children: ReactNode }) {
  return <ResolutionSourceContext.Provider value={{ targetId, scenarioPlan }}>{children}</ResolutionSourceContext.Provider>
}

export function useResolutionTargetId() {
  return useContext(ResolutionSourceContext).targetId
}

export function useResolutionSource() { return useContext(ResolutionSourceContext) }
