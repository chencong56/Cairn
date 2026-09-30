import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@/styles/index.css'
import { expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { useAuthStore } from '@/stores/auth-store'
import { WorkerDetailPage } from './detail'

const fetchWorker = vi.fn()

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  getRouteApi: () => ({ useParams: () => ({ workerId: 'worker-a' }) }),
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}))
vi.mock('@/lib/workers-api', () => ({
  fetchWorker: (...args: unknown[]) => fetchWorker(...args),
  fetchWorkerNodeHealth: vi.fn().mockResolvedValue({
    reachable: true,
    health: {
      status: 'ok',
      service: 'cairn-worker',
      uptimeSeconds: 120,
      checks: { database: 'up' },
      node: {
        workerId: 'worker-a',
        instanceId: '11111111-1111-4111-8111-111111111111',
        lastTickAt: '2026-09-14T00:00:00.000Z',
        loopAlive: true,
        runningRunCount: 0,
        liveHandleCount: 0,
        shuttingDown: false,
      },
      browserPrewarm: {
        mode: 'fixed',
        policyRevision: 25,
        configuredTarget: 2,
        effectiveTarget: 2,
        actualIdleCount: 2,
        startingCount: 0,
        activeCount: 2,
        drainingCount: 0,
        contextsCount: 0,
        warmHits: 10,
        coldMisses: 2,
        reuseHits: 5,
        underMemoryPressure: false,
        memoryBudgetMb: 2048,
        managedRssBytes: 157286400,
      },
    },
  }),
  disposeWorkerSession: vi.fn(),
  disableWorker: vi.fn(),
  enableWorker: vi.fn(),
  removeWorker: vi.fn(),
}))

it('详情展示内部入口与可处置占用，页头不用会话', async () => {
  useAuthStore.getState().auth.setUser({
    id: 'u1',
    displayName: '运维',
    email: null,
    roles: [],
    permissions: ['session:read', 'session:dispose'],
  })
  fetchWorker.mockResolvedValue({
    worker: {
      workerId: 'worker-a',
      instanceId: '11111111-1111-4111-8111-111111111111',
      status: 'STOPPED',
      heartbeatAt: '2026-09-14T00:00:00.000Z',
      lostAfterSeconds: 60,
      heartbeatExpiresAt: '2026-09-14T00:01:00.000Z',
      heartbeatFresh: true,
      capacity: 2,
      maxSessions: 2,
      counts: {
        occupiedSlots: 0,
        lostOccupied: 1,
        executingSlots: 0,
        running: 0,
        holding: 0,
        waitingForAuth: 0,
        leftoverAuthHolds: 0,
        expiredLeaseResidue: 0,
        runCapacityUsed: 0,
      },
      handleSample: {
        liveHandleCount: null,
        sampledSlotCount: null,
        handleMismatchStreak: 0,
        handleSampledAt: null,
        mismatchState: 'unknown',
      },
      routeAvailability: 'unavailable',
      routeReason: 'worker_not_ready',
      endpointSource: 'none',
      internalEndpoint: {
        baseUrl: 'http://127.0.0.1:8091',
        host: '127.0.0.1',
        port: 8091,
        protocol: 'http',
      },
    },
    sessions: {
      items: [
        {
          id: '77777777-7777-4777-8777-777777777777',
          targetId: '11111111-1111-4111-8111-111111111111',
          targetAccountId: '22222222-2222-4222-8222-222222222222',
          status: 'LOST',
          health: 'UNKNOWN',
          authState: 'UNKNOWN',
          ownerWorkerId: 'worker-a',
          ownerWorkerInstanceId: null,
          generation: 1,
          reusePolicy: 'NEW_PAGE',
          profileKey: 'target/account',
          idleTtlSeconds: 600,
          lastUsedAt: '2026-09-14T00:00:00.000Z',
          expiresAt: '2026-09-14T01:00:00.000Z',
          authHold: null,
          authControl: { epoch: 0, actorId: null, expiresAt: null },
          closeReason: 'owner_instance_replaced',
          createdAt: '2026-09-14T00:00:00.000Z',
          updatedAt: '2026-09-14T00:00:00.000Z',
          targetName: '测试系统',
          accountDisplayName: '管理员账号',
          activeLease: null,
          disposable: true,
        },
      ],
    },
    asOf: '2026-09-14T00:00:00.000Z',
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const screen = await render(
    <QueryClientProvider client={client}>
      <WorkerDetailPage />
    </QueryClientProvider>,
  )
  await expect.element(screen.getByRole('heading', { name: 'worker-a' })).toBeInTheDocument()
  await expect.element(screen.getByText('已停止')).toBeInTheDocument()
  await expect.element(screen.getByText('http://127.0.0.1:8091')).toBeInTheDocument()
  await expect.element(screen.getByText('测试系统 · 管理员账号')).toBeInTheDocument()
  await expect.element(screen.getByText('槽位 #1 · 会话失联 · 代次 #1')).toBeInTheDocument()
  await expect.element(screen.getByRole('button', { name: '处置' })).toBeInTheDocument()

  // 验证浏览器宿主池与预热卡片正常渲染且包含关键指标
  await expect.element(screen.getByText('浏览器宿主池与预热')).toBeInTheDocument()
  await expect.element(screen.getByText('策略：固定备用 (r25)')).toBeInTheDocument()
  await expect.element(screen.getByText('预热备用 (空闲)')).toBeInTheDocument()
  await expect.element(screen.getByText('83%')).toBeInTheDocument()
  await expect.element(screen.getByText('150 MB')).toBeInTheDocument()

  const headings = [...screen.container.querySelectorAll('h1, h2')].map((node) => node.textContent ?? '')
  expect(headings.join('')).not.toContain('会话')
  useAuthStore.getState().auth.reset()
})
