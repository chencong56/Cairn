import { createFileRoute, redirect } from '@tanstack/react-router'
import {
  entityIdSchema,
  hasPermission,
  SCENARIO_LIST_SORTS,
  scenarioHealthFilterSchema,
  scenarioStatusSchema,
} from '@cairn/shared'
import { z } from 'zod'
import { ScenariosPage } from '@/features/scenarios'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/_authenticated/scenarios/')({
  // 筛选条件放进 URL：整卡进入场景再返回时条件仍在，外部页面也能直接链接到某种筛选。
  validateSearch: z.object({
    targetId: entityIdSchema.optional().catch(undefined),
    view: z.enum(['grid', 'list']).optional().catch(undefined),
    status: scenarioStatusSchema.optional().catch(undefined),
    hasDraft: z.boolean().optional().catch(undefined),
    q: z.string().trim().max(128).optional().catch(undefined),
    health: z.array(scenarioHealthFilterSchema).min(1).optional().catch(undefined),
    schedule: z.enum(['scheduled', 'unscheduled']).optional().catch(undefined),
    sort: z.enum(SCENARIO_LIST_SORTS).optional().catch(undefined),
    createdBy: entityIdSchema.optional().catch(undefined),
    // 创建时间范围存本地日期（含两端），查询时按浏览器时区换算。
    createdFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().catch(undefined),
    createdTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().catch(undefined),
  }),
  staticData: {
    assistant: {
      routeKey: 'scenarios.index',
      pageKind: 'scenario',
    },
  },
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (!user || !hasPermission(user.permissions, 'workflow:read')) {
      throw redirect({ to: '/403' })
    }
  },
  component: ScenariosPage,
})
