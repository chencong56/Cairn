import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import type { DurationReportSubscriptionDto } from '@cairn/shared'
import { useAuthStore } from '@/stores/auth-store'
import { ReportSubscriptionsButton } from './components/report-subscriptions-dialog'

const mocks = vi.hoisted(() => ({
  fetchDurationReportSubscriptions: vi.fn(),
  createDurationReportSubscription: vi.fn(),
  updateDurationReportSubscription: vi.fn(),
  deleteDurationReportSubscription: vi.fn(),
  previewDurationReportSubscription: vi.fn(),
  fetchOutboundChannels: vi.fn(),
  navigate: vi.fn(),
}))

vi.mock('@/lib/duration-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/duration-api')>()),
  fetchDurationReportSubscriptions: mocks.fetchDurationReportSubscriptions,
  createDurationReportSubscription: mocks.createDurationReportSubscription,
  updateDurationReportSubscription: mocks.updateDurationReportSubscription,
  deleteDurationReportSubscription: mocks.deleteDurationReportSubscription,
  previewDurationReportSubscription: mocks.previewDurationReportSubscription,
}))
vi.mock('@/lib/outbound-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/outbound-api')>()),
  fetchOutboundChannels: mocks.fetchOutboundChannels,
}))
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => mocks.navigate,
    Link: ({ children, to }: { children: React.ReactNode; to?: string }) => <a href={to ?? '#'}>{children}</a>,
  }
})

const TARGET_ID = '11111111-1111-4111-8111-111111111111'
const CHANNEL_ID = '33333333-3333-4333-8333-333333333333'

const existing: DurationReportSubscriptionDto = {
  id: '22222222-2222-4222-8222-222222222222',
  targetId: TARGET_ID,
  suiteId: null,
  suiteName: null,
  period: 'month',
  sendWeekday: 1,
  sendDay: 3,
  sendTime: '08:30',
  timeZone: 'Asia/Shanghai',
  trigger: 'schedule',
  channelIds: [CHANNEL_ID],
  enabled: true,
  revision: 4,
  nextSendAt: '2026-11-03T00:30:00.000Z',
  lastIssue: { periodStart: '2026-09-01', periodLabel: '2026 年 9 月', status: 'skipped', reason: 'outbound_paused', reportId: '44444444-4444-4444-8444-444444444444', outboundEventId: null, updatedAt: '2026-10-03T00:31:00.000Z' },
  createdByName: '测试',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
}

function signIn(permissions: string[]) {
  useAuthStore.getState().auth.setUser({ id: 'u1', displayName: '测试', email: null, roles: [], permissions })
}

function wrap(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

describe('定期发送周期报告', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fetchDurationReportSubscriptions.mockResolvedValue({ items: [existing] })
    mocks.fetchOutboundChannels.mockResolvedValue({
      revision: 1,
      enabled: false,
      consoleBaseUrl: '',
      smtp: null,
      channels: [
        { id: CHANNEL_ID, name: '管理群', kind: 'webhook', enabled: true, revoked: false, allowAlerts: false, targetIds: [TARGET_ID], version: 1, host: 'hooks.example.com', format: 'cairn.outbound@1', replay: 'manual_on_unknown', recipientCount: 0 },
        { id: '55555555-5555-4555-8555-555555555555', name: '旧邮箱', kind: 'email', enabled: false, revoked: false, allowAlerts: false, targetIds: [TARGET_ID], version: 1, host: '', format: 'cairn.outbound@1', replay: 'manual_on_unknown', recipientCount: 1 },
      ],
    })
    mocks.createDurationReportSubscription.mockResolvedValue(existing)
    mocks.updateDurationReportSubscription.mockResolvedValue(existing)
  })

  afterEach(() => {
    useAuthStore.getState().auth.setUser(null)
  })

  it('没有导出报告或查看消息推送权限时不显示入口', async () => {
    signIn(['report:read', 'report:export'])
    const screen = await wrap(<ReportSubscriptionsButton targetId={TARGET_ID} suites={[]} />)
    expect(screen.getByRole('button', { name: '定期发送' }).elements()).toHaveLength(0)
  })

  it('列出订阅的安排、渠道、最近一期状态与原因；开关带版本号切换启用', async () => {
    signIn(['report:read', 'report:export', 'outbound:read'])
    const screen = await wrap(<ReportSubscriptionsButton targetId={TARGET_ID} suites={[]} />)
    await screen.getByRole('button', { name: '定期发送' }).click()
    await expect.element(page.getByText('月报 · 每月 3 日 08:30')).toBeInTheDocument()
    await expect.element(page.getByText('消息推送当前未启用：订阅启用后到点仍会生成报告，但不会发出。')).toBeInTheDocument()
    await expect.element(page.getByText(/渠道：管理群/)).toBeInTheDocument()
    await expect.element(page.getByText('消息推送未启用')).toBeInTheDocument()
    await expect.element(page.getByText('已跳过')).toBeInTheDocument()
    await page.getByRole('switch', { name: '已启用' }).click()
    await vi.waitFor(() => expect(mocks.updateDurationReportSubscription).toHaveBeenCalledWith(existing.id, { expectedRevision: 4, enabled: false }))
  })

  it('新建订阅默认不启用；停用的渠道不能勾选', async () => {
    signIn(['report:read', 'report:export', 'outbound:read'])
    const screen = await wrap(<ReportSubscriptionsButton targetId={TARGET_ID} suiteId='66666666-6666-4666-8666-666666666666' suites={[{ id: '66666666-6666-4666-8666-666666666666', name: '订单集' }]} />)
    await screen.getByRole('button', { name: '定期发送' }).click()
    await page.getByRole('button', { name: '新建订阅' }).click()
    await expect.element(page.getByRole('switch', { name: '启用（到点自动生成并推送）' })).not.toBeChecked()
    const boxes = page.getByRole('checkbox').elements() as HTMLButtonElement[]
    expect(boxes[1]?.disabled).toBe(true)
    boxes[0]!.click()
    await page.getByRole('button', { name: '保存' }).click()
    await vi.waitFor(() => expect(mocks.createDurationReportSubscription).toHaveBeenCalled())
    expect(mocks.createDurationReportSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: TARGET_ID, suiteId: '66666666-6666-4666-8666-666666666666', period: 'week', sendWeekday: 1, sendTime: '09:00', trigger: 'schedule', channelIds: [CHANNEL_ID], enabled: false }),
    )
  })
})
