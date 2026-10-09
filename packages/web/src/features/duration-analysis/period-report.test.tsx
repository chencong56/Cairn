import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { DEFAULT_STATISTICS_TIME_ZONE, durationPeriodLabel, lastCompleteDurationPeriodStart, shiftLocalDate, type DurationPeriodReportBlock } from '@cairn/shared'
import { useAuthStore } from '@/stores/auth-store'
import { PeriodReportMenu } from './components/period-report-menu'
import type { DurationFilters } from './format'
import { DurationPeriodReportView } from './report-view'
import { FilterBar } from './shared'

const mocks = vi.hoisted(() => ({
  createReport: vi.fn(),
  fetchReports: vi.fn(),
  navigate: vi.fn(),
}))

vi.mock('@/lib/reports-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/reports-api')>()),
  createReport: mocks.createReport,
  fetchReports: mocks.fetchReports,
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
// 不传时区时按出厂统计时区（页面加载后用接口返回的统计时区）
const tz = DEFAULT_STATISTICS_TIME_ZONE
const latestWeek = lastCompleteDurationPeriodStart('week', new Date(), tz)

function signIn(permissions: string[]) {
  useAuthStore.getState().auth.setUser({ id: 'u1', displayName: '测试', email: null, roles: [], permissions })
}

function wrap(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

const rolling: DurationFilters = { days: 30, granularity: 'week', compare: 'last_week', trigger: 'schedule' }

describe('耗时分析的自然周期与周期报告', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fetchReports.mockResolvedValue({ items: [], nextCursor: undefined })
  })

  afterEach(() => {
    useAuthStore.getState().auth.setUser(null)
  })

  it('时间窗选「上周」进入自然周期：按天、对比方式收窄为环比 / 去年同期', async () => {
    const onChange = vi.fn()
    const screen = await wrap(<FilterBar value={rolling} onChange={onChange} />)
    await screen.getByRole('combobox', { name: '时间窗' }).click()
    await page.getByRole('option', { name: '上周（自然周）' }).click()
    expect(onChange).toHaveBeenLastCalledWith({ period: 'week', periodStart: undefined, granularity: 'day', compare: 'prev_period' })
  })

  it('周期翻页：最新一周不能往后翻，往前翻写入起点；对比选项只有环比与去年同期', async () => {
    const onChange = vi.fn()
    const screen = await wrap(<FilterBar value={{ ...rolling, period: 'week', granularity: 'day', compare: 'prev_period' }} onChange={onChange} />)
    await expect.element(screen.getByText(durationPeriodLabel('week', latestWeek))).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '下一周' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: '粒度' }).elements()).toHaveLength(0)
    await screen.getByRole('button', { name: '上一周' }).click()
    expect(onChange).toHaveBeenLastCalledWith({ periodStart: shiftLocalDate(latestWeek, -7) })

    await screen.getByRole('combobox', { name: '对比方式' }).click()
    const options = page.getByRole('option').elements().map((el) => el.textContent)
    expect(options).toEqual(['环比·上周', '同比·去年同周'])
  })

  it('自然周期下「生成周报」为所看的周期创建报告并进入详情；没有导出权限不显示', async () => {
    signIn(['report:read', 'report:export', 'run:read'])
    mocks.createReport.mockResolvedValue({ id: '99999999-9999-4999-8999-999999999999' })
    const filters: DurationFilters = { ...rolling, period: 'week', granularity: 'day', compare: 'prev_period' }
    const screen = await wrap(<PeriodReportMenu targetId={TARGET_ID} filters={filters} />)
    await screen.getByRole('button', { name: '生成周报' }).click()
    await vi.waitFor(() => expect(mocks.navigate).toHaveBeenCalled())
    expect(mocks.createReport).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: { kind: 'DURATION_PERIOD', targetId: TARGET_ID, period: 'week', periodStart: latestWeek, timeZone: tz, trigger: 'schedule' },
        scope: 'duration_period',
        stage: 'final',
      }),
    )
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/reports/$reportId', params: { reportId: '99999999-9999-4999-8999-999999999999' } })

    signIn(['report:read', 'run:read'])
    const readonly = await wrap(<PeriodReportMenu targetId={TARGET_ID} filters={filters} />)
    expect(readonly.getByRole('button', { name: '生成周报' }).elements()).toHaveLength(0)
  })

  it('报告视图：结论、概况对比、变慢场景原因、月报同比列与数据缺口', async () => {
    const comparison = (current: number | null, base: number | null, deltaPct: number | null, samples = 12) => ({ current, base, deltaPct, currentSamples: samples, baseSamples: samples })
    const report: DurationPeriodReportBlock = {
      type: 'duration_period_report',
      version: 1,
      target: { id: TARGET_ID, name: '商城' },
      suite: null,
      period: { kind: 'month', start: '2026-09-01', end: '2026-10-01', label: '2026 年 9 月', timeZone: 'Asia/Shanghai' },
      trigger: 'all',
      comparisons: [
        { mode: 'prev_period', label: '上月', start: '2026-08-01', end: '2026-09-01' },
        { mode: 'last_year', label: '去年同月', start: '2025-09-01', end: '2025-10-01' },
      ],
      kpis: {
        runs: 24,
        succeeded: 24,
        failed: 0,
        activeP50: comparison(13_000, 10_000, 30),
        activeP50Yoy: comparison(13_000, null, null, 0),
        activeP95: comparison(20_000, 15_000, 33.3),
        waitRatio: comparison(0, 0, 0),
        queueP50: comparison(1_000, 1_000, 0),
        slower: 1,
        faster: 0,
        insightCount: 0,
        triggers: { schedule: 12, manual: 12, service: 0 },
      },
      conclusion: ['本月整体执行耗时 P50 为 13s，比上月慢 30%。'],
      slower: [
        {
          scenarioId: '33333333-3333-4333-8333-333333333333',
          name: '订单巡检',
          current: 13_000,
          base: 10_000,
          deltaPct: 30,
          samples: 12,
          baseSamples: 12,
          summary: '本月比上月慢 3.0s：执行 +3.0s',
          causes: ['『查询订单』+3.0s（重试 0→1 次）'],
        },
      ],
      faster: [],
      slowerSteps: [],
      insights: [],
      buckets: ['2026-09-29', '2026-09-30'],
      scenarios: [
        { scenarioId: '33333333-3333-4333-8333-333333333333', name: '订单巡检', runs: 12, succeeded: 12, samples: 12, activeP50: 13_000, activeP95: 20_000, deltaPct: 30, yoyDeltaPct: null, waitRatio: 0, series: [12_000, 14_000], insightCount: 0 },
      ],
      suiteSummary: null,
      gaps: ['有 1 次运行的耗时尚未计算，未计入本报告'],
      consolePath: `/duration-analysis?targetId=${TARGET_ID}&period=month&periodStart=2026-09-01`,
    }
    const screen = await wrap(<DurationPeriodReportView report={report} />)
    await expect.element(screen.getByText('本月整体执行耗时 P50 为 13s，比上月慢 30%。')).toBeInTheDocument()
    await expect.element(screen.getByText('本月比上月慢 3.0s：执行 +3.0s')).toBeInTheDocument()
    await expect.element(screen.getByText('· 『查询订单』+3.0s（重试 0→1 次）')).toBeInTheDocument()
    await expect.element(screen.getByText('去年同月：无同期数据')).toBeInTheDocument()
    const headers = [...document.querySelectorAll('thead th')].map((th) => th.textContent?.trim())
    expect(headers).toContain('去年同月')
    await expect.element(screen.getByText('数据缺口：有 1 次运行的耗时尚未计算，未计入本报告。')).toBeInTheDocument()
    await expect.element(screen.getByText('调度 12 · 手动 12 · 接口 0')).toBeInTheDocument()
  })
})
