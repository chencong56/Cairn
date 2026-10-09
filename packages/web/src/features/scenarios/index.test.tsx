import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ScenarioDto, ScenarioSummaryDto } from '@cairn/shared'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '@/stores/auth-store'
import { ScenariosPage } from './index'

const mocks = vi.hoisted(() => ({
  search: {} as Record<string, unknown>,
  fetchScenarios: vi.fn(),
  fetchScenarioSummary: vi.fn(async (): Promise<ScenarioSummaryDto> => ({
    total: 3,
    byHealth: { failing: 2, warning: 0, running: 0, passing: 1, cancelled: 0, never: 0 },
  })),
  fetchTargets: vi.fn(async () => ({
    items: [{ id: 'target-1', name: '商城后台', iconKey: 'database', accentKey: 'amber' }],
    nextCursor: undefined,
  })),
  previewDeleteScenario: vi.fn(async () => ({ impact: 'none' })),
  deleteScenario: vi.fn(async () => ({ success: true })),
  copyScenario: vi.fn(),
  updateScenario: vi.fn(async () => ({})),
  navigate: vi.fn(),
  navigateList: vi.fn(),
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}))

vi.mock('sonner', () => ({ toast: mocks.toast }))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => mocks.navigate,
    getRouteApi: () => ({
      useSearch: () => mocks.search,
      useNavigate: () => mocks.navigateList,
    }),
    Link: ({
      children,
      to,
      className,
      title,
      'aria-label': ariaLabel,
    }: {
      children?: React.ReactNode
      to: string
      className?: string
      title?: string
      'aria-label'?: string
    }) => (
      <a href={String(to)} className={className} title={title} aria-label={ariaLabel}>
        {children}
      </a>
    ),
  }
})

vi.mock('@/lib/scenarios-api', () => ({
  fetchScenarios: mocks.fetchScenarios,
  fetchScenarioSummary: mocks.fetchScenarioSummary,
  previewDeleteScenario: mocks.previewDeleteScenario,
  deleteScenario: mocks.deleteScenario,
  copyScenario: mocks.copyScenario,
  updateScenario: mocks.updateScenario,
  createScenario: vi.fn(),
  fetchScenario: vi.fn(),
  fetchScenarioCapabilities: vi.fn(async () => ({})),
}))

vi.mock('@/lib/targets-api', () => ({
  fetchTargets: mocks.fetchTargets,
  fetchTarget: vi.fn(),
  fetchTargetAccounts: vi.fn(async () => ({ items: [], nextCursor: undefined })),
}))

vi.mock('@/features/assistant/use-assistant-context-binding', () => ({
  useAssistantContextBinding: vi.fn(),
}))

const ALL_PERMISSIONS = ['workflow:read', 'workflow:write', 'run:read', 'workflow:delete', 'target:read']

function signIn(permissions: string[]) {
  useAuthStore.getState().auth.setUser({ id: 'u1', displayName: '测试工程师', email: null, roles: [], permissions })
}

function scenario(overrides: Partial<ScenarioDto> = {}): ScenarioDto {
  return {
    id: 'sc-1',
    targetId: 'target-1',
    name: '商品创建端到端验收',
    status: 'active',
    purpose: 'user',
    latestVersionId: 'v-1',
    latestVersionNo: 3,
    stepCount: 8,
    draftDirty: false,
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T02:00:00.000Z',
    ...overrides,
  }
}

async function renderPage(items: ScenarioDto[]) {
  mocks.fetchScenarios.mockResolvedValue({ items, nextCursor: undefined })
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ScenariosPage />
    </QueryClientProvider>,
  )
}

describe('场景编排主列表', () => {
  afterEach(() => {
    useAuthStore.getState().auth.setUser(null)
    mocks.search = {}
    vi.clearAllMocks()
    try {
      localStorage.removeItem('cairn:scenarios:view')
    } catch {
      // 浏览器存储不可用时不影响用例。
    }
  })

  it('默认卡片视图：身份图标、元信息、例外标签、调度与最近运行结论，不再显示用途与回填的创建人', async () => {
    signIn(ALL_PERMISSIONS)
    const screen = await renderPage([
      scenario({
        draftDirty: true,
        latestRun: { id: 'run-101', status: 'SUCCEEDED', outcomeStatus: 'PASS', createdAt: '2026-09-28T03:00:00.000Z' },
        schedule: { id: 'sch-1', name: '夜间定时冒烟', summary: '每天 02:00', enabled: true },
      }),
    ])

    await expect.element(screen.getByRole('heading', { name: '场景编排', exact: true })).toBeInTheDocument()
    const card = screen.getByRole('article', { name: '商品创建端到端验收' })
    await expect.element(card).toBeInTheDocument()
    await expect.element(card.getByRole('link', { name: '商品创建端到端验收' })).toBeInTheDocument()
    await expect.element(card.getByRole('button', { name: '商城后台' })).toBeInTheDocument()
    await expect.element(card.getByText('8 个步骤')).toBeInTheDocument()
    await expect.element(card.getByText('有未发布修改')).toBeInTheDocument()
    await expect.element(card.getByText('每天 02:00')).toBeInTheDocument()
    await expect.element(card.getByTitle('查看这次运行')).toHaveTextContent(/通过/)
    await expect.element(screen.getByText('业务场景')).not.toBeInTheDocument()
    await expect.element(screen.getByText('管理员')).not.toBeInTheDocument()
    await expect.element(screen.getByText('已启用', { exact: true }).nth(1)).not.toBeInTheDocument()
  })

  it('运行结论按执行状态与业务结论分开表达，待核查不再显示成正常', async () => {
    signIn(ALL_PERMISSIONS)
    const screen = await renderPage([
      scenario({ id: 'a', name: '待核查场景', latestRun: { id: 'r1', status: 'NEEDS_REVIEW', outcomeStatus: 'NOT_EVALUATED', createdAt: '2026-09-28T03:00:00.000Z' } }),
      scenario({ id: 'b', name: '结论不通过场景', latestRun: { id: 'r2', status: 'SUCCEEDED', outcomeStatus: 'FAIL', createdAt: '2026-09-28T03:00:00.000Z' } }),
      scenario({ id: 'c', name: '执行失败场景', latestRun: { id: 'r3', status: 'FAILED', outcomeStatus: 'NOT_EVALUATED', createdAt: '2026-09-28T03:00:00.000Z' } }),
      scenario({ id: 'd', name: '有警告场景', latestRun: { id: 'r4', status: 'SUCCEEDED', outcomeStatus: 'WARN', createdAt: '2026-09-28T03:00:00.000Z' } }),
      scenario({ id: 'e', name: '没运行过的场景' }),
    ])

    await expect.element(screen.getByRole('article', { name: '待核查场景' }).getByText('待核查', { exact: true })).toBeInTheDocument()
    await expect.element(screen.getByRole('article', { name: '结论不通过场景' }).getByText('检查未通过', { exact: true })).toBeInTheDocument()
    await expect.element(screen.getByRole('article', { name: '执行失败场景' }).getByText('执行失败', { exact: true })).toBeInTheDocument()
    await expect.element(screen.getByRole('article', { name: '有警告场景' }).getByText('有警告', { exact: true })).toBeInTheDocument()
    await expect.element(screen.getByRole('article', { name: '没运行过的场景' }).getByText('还没有运行')).toBeInTheDocument()
  })

  it('最近正式运行显示为 5 段分段条，证据不全另有标记', async () => {
    signIn(ALL_PERMISSIONS)
    const screen = await renderPage([
      scenario({
        name: '有历史的场景',
        latestRun: { id: 'trial-1', status: 'FAILED', outcomeStatus: 'NOT_EVALUATED', createdAt: '2026-09-28T05:00:00.000Z' },
        recentRuns: [
          { id: 'r1', status: 'SUCCEEDED', outcomeStatus: 'PASS', evidenceStatus: 'COMPLETE', triggerSource: 'schedule', createdAt: '2026-09-28T01:00:00.000Z' },
          { id: 'r2', status: 'SUCCEEDED', outcomeStatus: 'PASS', evidenceStatus: 'INCOMPLETE', triggerSource: 'manual', createdAt: '2026-09-28T02:00:00.000Z' },
        ],
      }),
    ])

    const card = screen.getByRole('article', { name: '有历史的场景' })
    // 以正式运行为准：较新的试跑失败不影响结论。
    await expect.element(card.getByText('通过', { exact: true })).toBeInTheDocument()
    const strip = card.getByRole('group', { name: '最近 2 次正式运行，最近一次通过' })
    await expect.element(strip).toBeInTheDocument()
    expect(strip.element().children).toHaveLength(5)
    // 有运行查看权限时，每一段都能点进那次运行，提示里写明触发方式。
    await expect.element(strip.getByRole('link', { name: /通过 · .* · 定时触发/ })).toBeInTheDocument()
    await expect.element(card.getByText('证据不全')).toBeInTheDocument()
  })

  it('卡片第二行显示创建人、创建日期与更新时间，当前排序依据的时间加强显示', async () => {
    signIn(ALL_PERMISSIONS)
    mocks.search = { sort: 'updated' }
    const screen = await renderPage([
      scenario({
        name: '有创建人的场景',
        createdAt: '2026-03-05T02:00:00.000Z',
        createdBy: { id: 'acc-1', displayName: '张晓', avatar: null },
      }),
      scenario({ id: 'sc-2', name: '系统创建的场景', createdBy: null }),
    ])

    const card = screen.getByRole('article', { name: '有创建人的场景' })
    await expect.element(card.getByTitle('创建人：张晓')).toBeInTheDocument()
    await expect.element(card.getByText('3月5日创建')).toBeInTheDocument()
    await expect.element(card.getByText(/更新$/)).toHaveClass(/font-medium/)
    await expect.element(card.getByText('3月5日创建')).not.toHaveClass(/font-medium/)
    await expect.element(screen.getByRole('article', { name: '系统创建的场景' }).getByText('管理员')).not.toBeInTheDocument()
  })

  it('列表视图有创建人列', async () => {
    signIn(ALL_PERMISSIONS)
    mocks.search = { view: 'list' }
    const screen = await renderPage([scenario({ createdBy: { id: 'acc-1', displayName: '张晓', avatar: null } })])

    const table = screen.getByRole('table')
    await expect.element(table.getByText('创建人')).toBeInTheDocument()
    await expect.element(table.getByText('张晓', { exact: true }).first()).toBeInTheDocument()
  })

  it('创建人与创建时间筛选：查询换算成时刻，条件可移除', async () => {
    signIn(ALL_PERMISSIONS)
    mocks.fetchScenarioSummary.mockResolvedValue({
      total: 3,
      byHealth: { failing: 2, warning: 0, running: 0, passing: 1, cancelled: 0, never: 0 },
      creators: [{ id: 'acc-1', displayName: '张晓', avatar: null, count: 2 }],
    })
    mocks.search = { createdBy: 'acc-1', createdFrom: '2026-10-01', createdTo: '2026-10-07' }
    const screen = await renderPage([scenario()])

    await expect.element(screen.getByRole('button', { name: '移除条件：创建人：张晓' })).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '移除条件：创建时间：2026-10-01 ~ 2026-10-07' })).toBeInTheDocument()
    expect(mocks.fetchScenarios).toHaveBeenCalledWith(
      expect.objectContaining({
        createdBy: 'acc-1',
        createdFrom: new Date(2026, 9, 1).toISOString(),
        createdTo: new Date(2026, 9, 8).toISOString(),
      }),
    )

    await screen.getByRole('button', { name: '移除条件：创建时间：2026-10-01 ~ 2026-10-07' }).click()
    const { search } = mocks.navigateList.mock.calls[mocks.navigateList.mock.calls.length - 1]![0] as { search: (prev: object) => object }
    expect(search({ createdFrom: '2026-10-01', createdTo: '2026-10-07' })).toEqual({ createdFrom: undefined, createdTo: undefined })
  })

  it('「异常 N」来自计数接口，点一下只看异常', async () => {
    signIn(ALL_PERMISSIONS)
    const screen = await renderPage([scenario()])

    const pill = screen.getByRole('button', { name: /异常\s*2/ })
    await expect.element(pill).toHaveAttribute('aria-pressed', 'false')
    await pill.click()
    const { search } = mocks.navigateList.mock.calls[mocks.navigateList.mock.calls.length - 1]![0] as { search: (prev: object) => object }
    expect(search({})).toEqual({ health: ['failing'] })
    expect(mocks.fetchScenarioSummary).toHaveBeenCalledWith(expect.not.objectContaining({ health: expect.anything() }))
  })

  it('健康度与调度筛选显示为可移除的条件，并给出匹配数', async () => {
    signIn(ALL_PERMISSIONS)
    mocks.search = { health: ['failing', 'passing'], schedule: 'scheduled' }
    const screen = await renderPage([scenario()])

    await expect.element(screen.getByRole('button', { name: '移除条件：健康度：异常' })).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '移除条件：有定时调度' })).toBeInTheDocument()
    await expect.element(screen.getByText('找到 3 个场景')).toBeInTheDocument()
    expect(mocks.fetchScenarios).toHaveBeenCalledWith(expect.objectContaining({ health: ['failing', 'passing'], schedule: 'scheduled', sort: 'created' }))

    await screen.getByRole('button', { name: '移除条件：健康度：异常' }).click()
    const { search } = mocks.navigateList.mock.calls[mocks.navigateList.mock.calls.length - 1]![0] as { search: (prev: object) => object }
    expect(search({ health: ['failing', 'passing'] })).toEqual({ health: ['passing'] })
  })

  it('列表视图只显示例外状态，调度单独成列', async () => {
    signIn(ALL_PERMISSIONS)
    mocks.search = { view: 'list' }
    const screen = await renderPage([
      scenario({ id: 'a', name: '启用中的场景' }),
      scenario({ id: 'b', name: '停用的场景', status: 'disabled' }),
    ])

    const table = screen.getByRole('table')
    await expect.element(table.getByText('定时调度')).toBeInTheDocument()
    await expect.element(table.getByText('已停用')).toBeInTheDocument()
    await expect.element(table.getByText('已启用')).not.toBeInTheDocument()
    await expect.element(table.getByRole('link', { name: '启用中的场景' })).toBeInTheDocument()
  })

  it('切换视图写入 URL 并记住偏好', async () => {
    signIn(ALL_PERMISSIONS)
    const screen = await renderPage([scenario()])

    await screen.getByRole('button', { name: '列表视图' }).click()

    expect(mocks.navigateList).toHaveBeenCalled()
    const { search } = mocks.navigateList.mock.calls[mocks.navigateList.mock.calls.length - 1]![0] as { search: (prev: object) => object }
    expect(search({})).toEqual({ view: 'list' })
    expect(localStorage.getItem('cairn:scenarios:view')).toBe('list')
  })

  it('权限受限用户看不到更多操作菜单', async () => {
    signIn(['workflow:read', 'target:read'])
    const screen = await renderPage([scenario({ name: '仅查看场景', status: 'disabled' })])

    await expect.element(screen.getByText('仅查看场景')).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '更多操作：仅查看场景' })).not.toBeInTheDocument()
  })

  it('更多操作：复制场景后刷新列表，提示里可打开副本，未复制的配置逐条提醒', async () => {
    signIn(['workflow:read', 'workflow:write', 'target:read'])
    mocks.copyScenario.mockResolvedValue({
      id: 'sc-copy',
      name: '月结对账-copy-1',
      notCopied: [{ item: 'outbound_policy', reason: '缺少运行查看权限，副本未复制消息推送设置' }],
    })
    const screen = await renderPage([scenario({ id: 'sc-3', name: '月结对账' })])

    await screen.getByRole('button', { name: '更多操作：月结对账' }).click()
    await expect.element(screen.getByRole('menuitem', { name: '运行记录' })).not.toBeInTheDocument()
    await screen.getByRole('menuitem', { name: '复制场景' }).click()

    await vi.waitFor(() => expect(mocks.copyScenario).toHaveBeenCalledWith('sc-3'))
    await vi.waitFor(() => expect(mocks.fetchScenarios).toHaveBeenCalledTimes(2))
    expect(mocks.toast.warning).toHaveBeenCalledWith('缺少运行查看权限，副本未复制消息推送设置')
    const [message, options] = mocks.toast.success.mock.calls[0]!
    expect(message).toBe('已复制为「月结对账-copy-1」')
    options.action.onClick()
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/scenarios/$scenarioId', params: { scenarioId: 'sc-copy' } })
  })

  it('更多操作：重命名只提交名称', async () => {
    signIn(ALL_PERMISSIONS)
    const screen = await renderPage([scenario({ name: '旧名称' })])

    await screen.getByRole('button', { name: '更多操作：旧名称' }).click()
    await screen.getByRole('menuitem', { name: '重命名' }).click()
    const input = screen.getByRole('textbox', { name: /场景名称/ })
    await input.fill('新名称')
    await screen.getByRole('button', { name: '保存' }).click()

    await vi.waitFor(() => expect(mocks.updateScenario).toHaveBeenCalledWith('sc-1', { name: '新名称' }))
  })

  it('更多操作：停用前确认，启用直接生效', async () => {
    signIn(ALL_PERMISSIONS)
    const screen = await renderPage([
      scenario({ id: 'on', name: '在用场景' }),
      scenario({ id: 'off', name: '停用场景', status: 'disabled' }),
    ])

    await screen.getByRole('button', { name: '更多操作：在用场景' }).click()
    await screen.getByRole('menuitem', { name: '停用场景' }).click()
    await expect.element(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(mocks.updateScenario).not.toHaveBeenCalled()
    await screen.getByRole('alertdialog').getByRole('button', { name: '停用' }).click()
    await vi.waitFor(() => expect(mocks.updateScenario).toHaveBeenCalledWith('on', { status: 'disabled' }))

    await screen.getByRole('button', { name: '更多操作：停用场景' }).click()
    await screen.getByRole('menuitem', { name: '启用场景' }).click()
    await vi.waitFor(() => expect(mocks.updateScenario).toHaveBeenCalledWith('off', { status: 'active' }))
  })

  it('更多操作：删除拉起二次确认', async () => {
    signIn(ALL_PERMISSIONS)
    const screen = await renderPage([scenario()])

    await screen.getByRole('button', { name: '更多操作：商品创建端到端验收' }).click()
    await screen.getByRole('menuitem', { name: '删除场景' }).click()
    await expect.element(screen.getByRole('alertdialog')).toBeInTheDocument()
  })

  it('按「/」聚焦搜索框，输入框里不抢键', async () => {
    signIn(ALL_PERMISSIONS)
    const screen = await renderPage([scenario()])
    await expect.element(screen.getByRole('article')).toBeInTheDocument()

    await userEvent.keyboard('/')
    await expect.element(screen.getByRole('textbox', { name: '搜索场景' })).toHaveFocus()
    await userEvent.keyboard('/')
    await expect.element(screen.getByRole('textbox', { name: '搜索场景' })).toHaveValue('/')
  })
})
