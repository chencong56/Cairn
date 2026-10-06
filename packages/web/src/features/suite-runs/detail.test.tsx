import '@/styles/index.css'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import type { SuiteRunObservation } from '@cairn/shared'
import { useAuthStore } from '@/stores/auth-store'
import { SuiteRunDetailPage } from './detail'

const SUITE_RUN_ID = 'sr-11111111-1111-4111-8111-111111111111'
const SUITE_ID = 'st-22222222-2222-4222-8222-222222222222'
const TARGET_ID = 'tgt-33333333-3333-4333-8333-333333333333'

const mocks = vi.hoisted(() => ({
  fetchSuiteRun: vi.fn(),
  fetchSuite: vi.fn(),
  fetchTarget: vi.fn(),
  fetchTargetAccounts: vi.fn(),
  cancelSuiteRun: vi.fn(),
  rerunSuiteItem: vi.fn(),
  previewDeleteSuiteRun: vi.fn(),
  deleteSuiteRun: vi.fn(),
  fetchReports: vi.fn().mockResolvedValue({ items: [] }),
  fetchReportRevision: vi.fn(),
  subscribeObservation: vi.fn().mockResolvedValue(() => {}),
  navigate: vi.fn(),
}))

vi.mock('@/lib/suites-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/suites-api')>()
  return {
    ...actual,
    fetchSuiteRun: mocks.fetchSuiteRun,
    fetchSuite: mocks.fetchSuite,
    cancelSuiteRun: mocks.cancelSuiteRun,
    rerunSuiteItem: mocks.rerunSuiteItem,
    previewDeleteSuiteRun: mocks.previewDeleteSuiteRun,
    deleteSuiteRun: mocks.deleteSuiteRun,
  }
})

vi.mock('@/lib/targets-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/targets-api')>()
  return {
    ...actual,
    fetchTarget: mocks.fetchTarget,
    fetchTargetAccounts: mocks.fetchTargetAccounts,
  }
})

vi.mock('@/lib/reports-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/reports-api')>()
  return {
    ...actual,
    fetchReports: mocks.fetchReports,
    fetchReportRevision: mocks.fetchReportRevision,
  }
})

vi.mock('@/lib/observation-stream', () => ({
  subscribeObservation: mocks.subscribeObservation,
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useParams: () => ({ suiteRunId: SUITE_RUN_ID }),
    useNavigate: () => mocks.navigate,
    Link: ({ children, to, onClick, ...props }: { children: ReactNode; to?: string; onClick?: (e: React.MouseEvent) => void }) => (
      <a href={to ?? '#'} onClick={onClick} {...props}>
        {children}
      </a>
    ),
  }
})

function sampleObservation(overrides: Partial<SuiteRunObservation> = {}): SuiteRunObservation {
  return {
    id: SUITE_RUN_ID,
    suiteId: SUITE_ID,
    suiteVersionId: 'sv-1',
    targetId: TARGET_ID,
    status: 'COMPLETED',
    verdict: 'all_pass',
    evidenceStatus: 'COMPLETE',
    cancelRequested: false,
    reason: null,
    failurePolicy: 'continue',
    executionMode: 'parallel',
    maxConcurrency: 3,
    deadlineAt: '2026-10-06T02:00:00.000Z',
    startedAt: '2026-10-06T01:00:00.000Z',
    finishedAt: '2026-10-06T01:05:00.000Z',
    wallClockMs: 300000,
    childDurationMs: 450000,
    counts: {
      planned: 2,
      succeeded: 2,
      failed: 0,
      cancelled: 0,
      skipped: 0,
      pending: 0,
      active: 0,
    },
    revision: 1,
    eventSeq: 5,
    items: [
      {
        memberId: 'm1',
        ordinal: 0,
        groupId: null,
        displayName: '登录核验',
        scenarioId: 'sc-1',
        scenarioVersionId: 'scv-1',
        childRunId: 'cr-11111111-1111-4111-8111-111111111111',
        admission: 'ACTIVE',
        skipReason: null,
        runStatus: 'SUCCEEDED',
        outcomeStatus: 'PASS',
        evidenceStatus: 'COMPLETE',
        targetAccountId: 'acc-1',
        originalRunId: null,
        rerunCount: 0,
        stageId: 'stage-1',
        stageOrdinal: 0,
      },
    ],
    readAt: '2026-10-06T01:05:00.000Z',
    createdAt: '2026-10-06T01:00:00.000Z',
    automaticReport: null,
    ...overrides,
  }
}

function signIn(permissions: string[]) {
  useAuthStore.getState().auth.setUser({
    id: 'u1',
    displayName: '测试员',
    email: null,
    roles: [],
    permissions,
  })
}

async function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <SuiteRunDetailPage />
    </QueryClientProvider>,
  )
}

describe('SuiteRunDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fetchSuiteRun.mockResolvedValue(sampleObservation())
    mocks.fetchSuite.mockResolvedValue({ id: SUITE_ID, name: '电商核心链路巡检' })
    mocks.fetchTarget.mockResolvedValue({ id: TARGET_ID, name: '演示电商系统' })
    mocks.fetchTargetAccounts.mockResolvedValue({
      items: [{ id: 'acc-1', displayName: '电商测试账号' }],
    })
  })

  afterEach(() => {
    useAuthStore.getState().auth.setUser(null)
  })

  it('展示 Apple 风格 Hero 标头、短 ID、真实场景集名称与元数据', async () => {
    signIn(['suite:read', 'run:read'])
    const screen = await renderPage()

    // 真实场景集名称
    await expect.element(screen.getByText('电商核心链路巡检')).toBeVisible()
    // 返回集合运行链接
    await expect.element(screen.getByText('返回场景集运行')).toBeVisible()
    // 短 ID 胶囊
    await expect.element(screen.getByText(`#${SUITE_RUN_ID.slice(0, 8)}`)).toBeVisible()
    // 目标系统
    await expect.element(screen.getByText('演示电商系统')).toBeVisible()
    // 执行模式
    await expect.element(screen.getByText('受控并发 (上限 3)').first()).toBeVisible()
    // 节约百分比
    await expect.element(screen.getByText('(节约 33%)').first()).toBeVisible()
  })

  it('分段导航支持「执行明细」与「综合报表」，执行明细包含 KPI、内联提示与成员表', async () => {
    signIn(['suite:read', 'run:read'])
    const screen = await renderPage()

    // Tabs
    await expect.element(screen.getByRole('tab', { name: '执行明细' })).toBeVisible()
    await expect.element(screen.getByRole('tab', { name: '综合报表' })).toBeVisible()

    // KPI 指标
    await expect.element(screen.getByText('计划成员')).toBeVisible()
    await expect.element(screen.getByText('成功 / 失败 / 跳过')).toBeVisible()

    // 内联调度提示（取代孤儿文本）
    await expect.element(screen.getByText(/成员间隙不预留账号，调度期间同一账号可能被并发运行借调/)).toBeVisible()

    // 成员表格表头含操作列
    await expect.element(screen.getByText('操作')).toBeInTheDocument()

    // 成员名称与账号显示名
    await expect.element(screen.getByText('登录核验')).toBeVisible()
    await expect.element(screen.getByText('电商测试账号')).toBeVisible()

    // 操作按钮
    await expect.element(screen.getByRole('link', { name: '打开子运行' })).toBeInTheDocument()
  })

  it('终态且具有 run:delete 权限时，「更多」菜单展示删除按钮且可弹出删除确认框', async () => {
    signIn(['suite:read', 'run:read', 'run:delete'])
    mocks.previewDeleteSuiteRun.mockResolvedValue({
      previewToken: 'p-1',
      counts: { suiteRuns: 1, runs: 1, reports: 0, storedObjects: 0, totalBytes: 0 },
      blockers: [],
    })

    const screen = await renderPage()

    // 打开更多菜单
    const moreButton = screen.getByRole('button', { name: '更多操作' })
    await userEvent.click(moreButton)

    // 验证菜单项
    await expect.element(screen.getByText('复制完整编号')).toBeVisible()
    await expect.element(screen.getByText('在结果与报告中查看')).toBeVisible()
    const deleteMenuItem = screen.getByText('删除场景集运行')
    await expect.element(deleteMenuItem).toBeVisible()

    // 点击删除场景集运行弹出 ResourceDeleteDialog
    await userEvent.click(deleteMenuItem)
    await expect.element(screen.getByRole('heading', { name: '删除场景集运行' })).toBeVisible()
    await expect.element(screen.getByText(/该场景集运行及其包含的/)).toBeVisible()
  })
})
