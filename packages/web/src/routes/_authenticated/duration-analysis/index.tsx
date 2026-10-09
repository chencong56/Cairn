import { createFileRoute, redirect } from '@tanstack/react-router'
import { hasPermission } from '@cairn/shared'
import { DurationAnalysisPage } from '@/features/duration-analysis'
import { targetDurationSearchSchema } from '@/features/duration-analysis/search'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/_authenticated/duration-analysis/')({
  validateSearch: targetDurationSearchSchema,
  staticData: {
    assistant: {
      routeKey: 'duration-analysis.index',
      pageKind: 'other',
    },
  },
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (!user || !hasPermission(user.permissions, 'run:read')) {
      throw redirect({ to: '/403' })
    }
  },
  component: DurationAnalysisPage,
})
