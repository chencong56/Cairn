import { createFileRoute, redirect } from '@tanstack/react-router'
import { hasPermission } from '@cairn/shared'
import { ScenarioDurationPage } from '@/features/duration-analysis/scenario-page'
import { durationSearchSchema } from '@/features/duration-analysis/search'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/_authenticated/duration-analysis/scenarios/$scenarioId/')({
  validateSearch: durationSearchSchema,
  staticData: {
    assistant: {
      routeKey: 'duration-analysis.scenario',
      pageKind: 'scenario',
      primaryObject: { kind: 'scenario', idParam: 'scenarioId' },
    },
  },
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (!user || !hasPermission(user.permissions, 'run:read')) {
      throw redirect({ to: '/403' })
    }
  },
  component: ScenarioDurationPage,
})
