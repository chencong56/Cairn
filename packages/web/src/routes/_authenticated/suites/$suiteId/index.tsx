import { createFileRoute, redirect } from '@tanstack/react-router'
import { hasPermission } from '@cairn/shared'
import { SuiteDetailPage } from '@/features/suites/detail'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/_authenticated/suites/$suiteId/')({
  staticData: {
    assistant: {
      routeKey: 'suites.$suiteId',
      pageKind: 'suite',
      primaryObject: { kind: 'suite', idParam: 'suiteId' },
    },
  },
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (!user || !hasPermission(user.permissions, 'suite:read')) {
      throw redirect({ to: '/403' })
    }
  },
  component: SuiteDetailPage,
})
