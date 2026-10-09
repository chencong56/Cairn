import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { RunDetailDto, ScenarioDto } from '@cairn/shared'
import { render } from 'vitest-browser-react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '@/stores/auth-store'
import { useQuickRunStore } from './quick-run-store'
import { runProgress } from './run-progress'
import { RunTaskDock } from './run-task-dock'
import { ScenarioRunButton } from './scenario-run-button'

const mocks = vi.hoisted(() => ({
  fetchTargetAccounts: vi.fn(),
  runs: new Map<string, unknown>(),
}))

vi.mock('@/lib/targets-api', () => ({ fetchTargetAccounts: mocks.fetchTargetAccounts }))
vi.mock('@/lib/runs-api', () => ({ cancelRun: vi.fn(async () => ({})), createRun: vi.fn() }))
vi.mock('@/features/runs/account-session-hint', () => ({ AccountSessionHint: () => null }))
vi.mock('@/features/runs/use-run-observation', () => ({
  useRunObservation: (runId: string) => ({ run: mocks.runs.get(runId) }),
}))
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return { ...actual, Link: ({ children }: { children?: React.ReactNode }) => <a href='/runs'>{children}</a> }
})

function signIn(permissions = ['workflow:read', 'target:read', 'run:read', 'run:execute', 'run:cancel']) {
  useAuthStore.getState().auth.setUser({ id: 'u1', displayName: '测试', email: null, roles: [], permissions })
}

function scenario(overrides: Partial<ScenarioDto> = {}): ScenarioDto {
  return {
    id: 'sc-1',
    targetId: 'target-1',
    name: '月结对账',
    status: 'active',
    purpose: 'user',
    latestVersionId: 'v-1',
    latestVersionNo: 7,
    stepCount: 3,
    draftDirty: false,
    runRequirements: { inputs: [], needsAccount: true },
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    ...overrides,
  }
}

function account(id: string, displayName: string) {
  return { id, displayName, username: id, status: 'active', hasPassword: true, usage: 'business' }
}

function run(overrides: Record<string, unknown> = {}): RunDetailDto {
  return {
    id: 'run-1',
    status: 'RUNNING',
    outcomeStatus: 'NOT_EVALUATED',
    evidenceStatus: 'PENDING',
    createdAt: '2026-09-28T00:00:00.000Z',
    startedAt: '2026-09-28T00:00:00.000Z',
    finishedAt: null,
    stepRuns: [
      { id: 's1', name: '打开结算系统', ordinal: 0, status: 'SUCCEEDED', attempts: [] },
      { id: 's2', name: '筛选本月结算单', ordinal: 1, status: 'RUNNING', attempts: [] },
      { id: 's3', name: '核对金额合计', ordinal: 2, status: 'PENDING', attempts: [] },
    ],
    ...overrides,
  } as unknown as RunDetailDto
}

const wrap = (node: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>
)

afterEach(() => {
  useAuthStore.getState().auth.setUser(null)
  useQuickRunStore.setState({ runs: [] })
  mocks.runs.clear()
  vi.clearAllMocks()
})

describe('runProgress', () => {
  it('报当前第几步，不报总数；失败时给出失败步与原因', () => {
    expect(runProgress(run()).current).toEqual({ ordinal: 2, name: '筛选本月结算单' })
    expect(runProgress(run()).nodes).toEqual(['done', 'live', 'pending'])

    const failed = runProgress(
      run({
        status: 'FAILED',
        stepRuns: [
          { id: 's1', name: '打开', ordinal: 0, status: 'SUCCEEDED', attempts: [] },
          { id: 's2', name: '核对', ordinal: 1, status: 'FAILED', attempts: [{ error: { code: 'ASSERTION_FAILED', safeMessage: '金额不一致' } }] },
        ],
      }),
    )
    expect(failed.phase).toBe('failed')
    expect(failed.failure?.ordinal).toBe(2)
    expect(failed.failure?.reason).toBeTruthy()
  })

  it('等待登录与待核查算等待，业务结论不通过算失败', () => {
    expect(runProgress(run({ status: 'WAITING_FOR_AUTH' })).phase).toBe('waiting')
    expect(runProgress(run({ status: 'NEEDS_REVIEW' })).phase).toBe('waiting')
    expect(runProgress(run({ status: 'SUCCEEDED', outcomeStatus: 'FAIL' })).phase).toBe('failed')
    expect(runProgress(run({ status: 'SUCCEEDED', outcomeStatus: 'WARN' })).phase).toBe('attention')
    expect(runProgress(run({ status: 'CANCELLED' })).phase).toBe('cancelled')
  })
})

describe('ScenarioRunButton', () => {
  it('不需要输入且只有一个可用账号时直接运行', async () => {
    signIn()
    mocks.fetchTargetAccounts.mockResolvedValue({ items: [account('acc-1', '张晓')] })
    const start = vi.fn(async () => ({ ok: true as const, runId: 'run-9' }))
    const screen = await render(
      wrap(<ScenarioRunButton scenario={scenario()} start={start} pending={false} onOpenRun={vi.fn()} onMoreOptions={vi.fn()} />),
    )

    await screen.getByRole('button', { name: '运行：月结对账' }).click()
    await vi.waitFor(() => expect(start).toHaveBeenCalledWith(expect.objectContaining({ id: 'sc-1' }), { targetAccountId: 'acc-1' }))
  })

  it('多个可用账号时先弹气泡选账号，预选优先账号', async () => {
    signIn()
    mocks.fetchTargetAccounts.mockResolvedValue({ items: [account('acc-1', '张晓'), account('acc-2', '李然')] })
    const start = vi.fn(async () => ({ ok: true as const, runId: 'run-9' }))
    const screen = await render(
      wrap(<ScenarioRunButton scenario={scenario({ draftDirty: true })} start={start} pending={false} onOpenRun={vi.fn()} onMoreOptions={vi.fn()} />),
    )

    await screen.getByRole('button', { name: '运行：月结对账' }).click()
    await expect.element(screen.getByText('运行已发布 v7')).toBeInTheDocument()
    await expect.element(screen.getByText('场景里还有未发布的修改，这次不会带上。')).toBeInTheDocument()
    expect(start).not.toHaveBeenCalled()
    await screen.getByRole('button', { name: '开始运行' }).click()
    await vi.waitFor(() => expect(start).toHaveBeenCalledWith(expect.objectContaining({ id: 'sc-1' }), { targetAccountId: 'acc-1', input: undefined }))
  })

  it('多个可用账号但目标设了默认账号时直接用默认账号运行', async () => {
    signIn()
    mocks.fetchTargetAccounts.mockResolvedValue({ items: [account('acc-1', '张晓'), account('acc-2', '李然')] })
    const start = vi.fn(async () => ({ ok: true as const, runId: 'run-9' }))
    const screen = await render(
      wrap(
        <ScenarioRunButton
          scenario={scenario()}
          targetDefaultAccountId='acc-2'
          start={start}
          pending={false}
          onOpenRun={vi.fn()}
          onMoreOptions={vi.fn()}
        />,
      ),
    )

    await screen.getByRole('button', { name: '运行：月结对账' }).click()
    await vi.waitFor(() => expect(start).toHaveBeenCalledWith(expect.objectContaining({ id: 'sc-1' }), { targetAccountId: 'acc-2' }))
  })

  it('有必填输入时在气泡里补齐，留空不提交', async () => {
    signIn()
    const start = vi.fn(async () => ({ ok: true as const, runId: 'run-9' }))
    const screen = await render(
      wrap(
        <ScenarioRunButton
          scenario={scenario({ runRequirements: { inputs: [{ key: 'title', label: '工单标题' }], needsAccount: false } })}
          start={start}
          pending={false}
          onOpenRun={vi.fn()}
          onMoreOptions={vi.fn()}
        />,
      ),
    )

    await screen.getByRole('button', { name: '运行：月结对账' }).click()
    await screen.getByRole('button', { name: '开始运行' }).click()
    await expect.element(screen.getByRole('alert')).toHaveTextContent('请填写「工单标题」')
    expect(start).not.toHaveBeenCalled()
    await screen.getByRole('textbox', { name: '工单标题' }).fill('打印机无法连接')
    await screen.getByRole('button', { name: '开始运行' }).click()
    await vi.waitFor(() =>
      expect(start).toHaveBeenCalledWith(expect.objectContaining({ id: 'sc-1' }), { targetAccountId: undefined, input: { title: '打印机无法连接' } }),
    )
  })

  it('未发布、已停用时不可运行；无执行权限时不显示', async () => {
    signIn()
    const screen = await render(
      wrap(
        <>
          <ScenarioRunButton scenario={scenario({ id: 'a', name: '草稿场景', latestVersionId: null, latestVersionNo: null })} start={vi.fn()} pending={false} onOpenRun={vi.fn()} onMoreOptions={vi.fn()} />
          <ScenarioRunButton scenario={scenario({ id: 'b', name: '停用场景', status: 'disabled' })} start={vi.fn()} pending={false} onOpenRun={vi.fn()} onMoreOptions={vi.fn()} />
        </>,
      ),
    )
    await expect.element(screen.getByRole('button', { name: '运行：草稿场景' })).toBeDisabled()
    await expect.element(screen.getByRole('button', { name: '运行：停用场景' })).toBeDisabled()
  })

  it('本人发起且仍在进行时变成「查看运行」', async () => {
    signIn()
    useQuickRunStore.setState({
      runs: [{ runId: 'run-5', scenarioId: 'sc-1', scenarioName: '月结对账', versionNo: 7, startedAt: Date.now(), status: 'RUNNING' }],
    })
    const onOpenRun = vi.fn()
    const screen = await render(
      wrap(<ScenarioRunButton scenario={scenario()} start={vi.fn()} pending={false} onOpenRun={onOpenRun} onMoreOptions={vi.fn()} />),
    )
    await screen.getByRole('button', { name: '查看运行' }).click()
    expect(onOpenRun).toHaveBeenCalledWith('run-5')
  })
})

describe('RunTaskDock', () => {
  it('最多实时跟踪 3 个，失败的给出原因与复盘入口', async () => {
    signIn()
    const entries = ['r1', 'r2', 'r3', 'r4'].map((runId, index) => ({
      runId,
      scenarioId: `sc-${index}`,
      scenarioName: `场景${index + 1}`,
      versionNo: 1,
      startedAt: Date.now(),
    }))
    useQuickRunStore.setState({ runs: entries })
    mocks.runs.set('r2', run({ id: 'r2' }))
    mocks.runs.set('r3', run({ id: 'r3', status: 'WAITING_FOR_AUTH' }))
    mocks.runs.set(
      'r4',
      run({
        id: 'r4',
        status: 'FAILED',
        finishedAt: '2026-09-28T00:00:05.000Z',
        stepRuns: [{ id: 's1', name: '核对', ordinal: 0, status: 'FAILED', attempts: [{ error: { code: 'ASSERTION_FAILED', safeMessage: 'x' } }] }],
      }),
    )
    const onOpen = vi.fn()
    const screen = await render(wrap(<RunTaskDock onOpen={onOpen} />))

    await expect.element(screen.getByText('另有 1 个运行 · 在运行记录里查看')).toBeInTheDocument()
    await expect.element(screen.getByText('第 2 步 · 筛选本月结算单')).toBeInTheDocument()
    await expect.element(screen.getByText('等待登录目标系统')).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '去登录' })).toBeInTheDocument()
    await screen.getByRole('button', { name: '查看复盘' }).click()
    expect(onOpen).toHaveBeenCalledWith('r4')
    await expect.element(screen.getByText(/第 1 步失败/)).toBeInTheDocument()
  })

  it('终止前二次确认', async () => {
    signIn()
    useQuickRunStore.setState({ runs: [{ runId: 'r1', scenarioId: 'sc-1', scenarioName: '月结对账', versionNo: 7, startedAt: Date.now() }] })
    mocks.runs.set('r1', run({ id: 'r1' }))
    const screen = await render(wrap(<RunTaskDock onOpen={vi.fn()} />))

    await screen.getByRole('button', { name: '终止' }).click()
    await expect.element(screen.getByRole('alertdialog')).toHaveTextContent('已经执行的步骤不会回滚')
  })
})
