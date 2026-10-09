import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { scenarioCapabilitiesFor } from '@cairn/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { RunCreateDialog } from './create-dialog'

const SCENARIO_ID = '33333333-3333-4333-8333-333333333333'
const TARGET_ID = '11111111-1111-4111-8111-111111111111'
const STEP_ID = '44444444-4444-4444-8444-444444444444'

const mocks = vi.hoisted(() => ({
  createRun: vi.fn(),
  fetchScenarios: vi.fn(),
  fetchScenario: vi.fn(),
  fetchScenarioCapabilities: vi.fn(),
  fetchTargetAccounts: vi.fn(),
  fetchTarget: vi.fn(),
  navigate: vi.fn(),
}))

vi.mock('@/lib/runs-api', () => ({ createRun: mocks.createRun }))
vi.mock('@/lib/scenarios-api', () => ({
  fetchScenarios: mocks.fetchScenarios,
  fetchScenario: mocks.fetchScenario,
  fetchScenarioCapabilities: mocks.fetchScenarioCapabilities,
}))
vi.mock('@/lib/targets-api', () => ({
  fetchTargetAccounts: mocks.fetchTargetAccounts,
  fetchTarget: mocks.fetchTarget,
}))
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return { ...actual, useNavigate: () => mocks.navigate }
})

const echoStep = (from?: string) => ({
  id: STEP_ID,
  name: '回显',
  type: 'echo' as const,
  effectType: 'READ_ONLY' as const,
  input: from ? { from } : { value: 1 },
})

function scenarioDetail(options: {
  inputs?: Array<{ key: string; label: string }>
  stepFrom?: string
  published?: boolean
  draftDirty?: boolean
}) {
  const steps = [echoStep(options.stepFrom)]
  return {
    id: SCENARIO_ID,
    targetId: TARGET_ID,
    name: '回显',
    status: 'active',
    purpose: 'user',
    latestVersionId: '55555555-5555-4555-8555-555555555555',
    latestVersionNo: 3,
    stepCount: 1,
    draftDirty: options.draftDirty ?? false,
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    steps,
    ...(options.published === false
      ? {}
      : {
          published: {
            versionId: '55555555-5555-4555-8555-555555555555',
            versionNo: 3,
            definition: { schemaVersion: 1, inputs: options.inputs ?? [], steps },
            compilerVersion: 1,
            createdAt: '2026-09-20T00:00:00.000Z',
          },
        }),
  }
}

async function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RunCreateDialog open onOpenChange={vi.fn()} />
    </QueryClientProvider>,
  )
}

async function selectScenario(screen: Awaited<ReturnType<typeof renderDialog>>) {
  await screen.getByRole('combobox', { name: '场景' }).click()
  await screen.getByRole('option', { name: '回显' }).click()
}

describe('RunCreateDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fetchScenarios.mockResolvedValue({
      items: [{ id: SCENARIO_ID, name: '回显', targetId: TARGET_ID, status: 'active' }],
    })
    mocks.fetchScenario.mockResolvedValue(scenarioDetail({}))
    mocks.fetchScenarioCapabilities.mockResolvedValue(scenarioCapabilitiesFor({ browserAiEnabled: false }))
    mocks.fetchTargetAccounts.mockResolvedValue({ items: [] })
    mocks.fetchTarget.mockResolvedValue({
      id: TARGET_ID,
      authMethod: 'form',
      captchaMode: 'none',
    })
    mocks.createRun.mockResolvedValue({ id: 'run-1' })
  })

  it('未改采集方式时不提交 evidencePolicy，证据采集默认收起', async () => {
    const screen = await renderDialog()
    expect(screen.getByText('录像采集').elements()).toHaveLength(0)
    await screen.getByRole('button', { name: /高级：证据采集/ }).click()
    await expect.element(screen.getByText('录像采集')).toBeInTheDocument()
    expect(document.body.innerText).toContain('继承平台默认（始终）')
    await expect.element(screen.getByText('继承平台默认（关闭）')).toBeInTheDocument()
    await selectScenario(screen)
    await screen.getByRole('button', { name: '创建运行' }).click()
    await vi.waitFor(() => expect(mocks.createRun).toHaveBeenCalledTimes(1))
    expect(mocks.createRun.mock.calls[0]![0]).not.toHaveProperty('evidencePolicy')
  })

  it('只有一个可用身份时只读显示运行账号，不让人选', async () => {
    mocks.fetchTargetAccounts.mockResolvedValue({
      items: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          displayName: '值班账号',
          username: 'ops',
          status: 'active',
          hasPassword: true,
        },
      ],
    })
    const screen = await renderDialog()
    await selectScenario(screen)
    await expect.element(screen.getByText('值班账号 (ops)')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '运行账号' }).elements()).toHaveLength(0)
    await screen.getByRole('button', { name: '创建运行' }).click()
    await vi.waitFor(() => expect(mocks.createRun).toHaveBeenCalledTimes(1))
    // 不改选时不带账号，由服务端按「场景指定 → 目标默认 → 唯一可用」取，快照里来源才准确。
    expect(mocks.createRun.mock.calls[0]![0].targetAccountId).toBeUndefined()
  })

  it('多个可用身份时预选目标默认，改选成访客给出提示', async () => {
    mocks.fetchTargetAccounts.mockResolvedValue({
      items: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          displayName: '值班账号',
          username: 'ops',
          status: 'active',
          hasPassword: true,
          isDefault: true,
        },
        {
          id: '33333333-3333-4333-8333-333333333333',
          displayName: '访客',
          username: null,
          identityKind: 'visitor',
          status: 'active',
          hasPassword: false,
        },
      ],
    })
    const screen = await renderDialog()
    await selectScenario(screen)
    const picker = screen.getByRole('combobox', { name: '运行账号' })
    await expect.element(picker).toHaveTextContent('值班账号 (ops) · 目标默认')
    await picker.click()
    await screen.getByRole('option', { name: '访客' }).click()
    await expect.element(screen.getByText(/本场景默认以登录账号运行，这次将以\s*访客运行/)).toBeInTheDocument()
    await screen.getByRole('button', { name: '创建运行' }).click()
    await vi.waitFor(() => expect(mocks.createRun).toHaveBeenCalledTimes(1))
    expect(mocks.createRun.mock.calls[0]![0].targetAccountId).toBe('33333333-3333-4333-8333-333333333333')
  })

  it('按已发布定义的标签出字段，提交对象 input，不出现 JSON 框', async () => {
    mocks.fetchScenario.mockResolvedValue(
      scenarioDetail({ inputs: [{ key: 'orderId', label: '订单号' }], stepFrom: 'orderId' }),
    )
    const screen = await renderDialog()
    await selectScenario(screen)
    await expect.element(screen.getByText('订单号')).toBeInTheDocument()
    expect(document.body.innerText).not.toContain('JSON')
    await screen.getByLabelText('订单号').fill('A-1')
    await screen.getByRole('button', { name: '创建运行' }).click()
    await vi.waitFor(() => expect(mocks.createRun).toHaveBeenCalledTimes(1))
    expect(mocks.createRun.mock.calls[0]![0]).toMatchObject({ input: { orderId: 'A-1' } })
  })

  it('步骤引用但未声明的键也出现为字段', async () => {
    mocks.fetchScenario.mockResolvedValue(scenarioDetail({ stepFrom: 'orderId' }))
    const screen = await renderDialog()
    await selectScenario(screen)
    await expect.element(screen.getByLabelText('orderId')).toBeInTheDocument()
  })

  it('必需字段留空时不能提交', async () => {
    mocks.fetchScenario.mockResolvedValue(
      scenarioDetail({ inputs: [{ key: 'orderId', label: '订单号' }], stepFrom: 'orderId' }),
    )
    const screen = await renderDialog()
    await selectScenario(screen)
    await expect.element(screen.getByRole('button', { name: '创建运行' })).toBeDisabled()
    await screen.getByLabelText('订单号').fill('A-1')
    await expect.element(screen.getByRole('button', { name: '创建运行' })).not.toBeDisabled()
  })

  it('展示已发布版本号，草稿未发布时给出警告', async () => {
    mocks.fetchScenario.mockResolvedValue(scenarioDetail({ draftDirty: true }))
    const screen = await renderDialog()
    await selectScenario(screen)
    await expect.element(screen.getByText('将运行已发布版本 v3')).toBeInTheDocument()
    await expect
      .element(screen.getByText('场景里还有未发布的修改，这次不会带上。'))
      .toBeInTheDocument()
  })

  it('没有已发布版本时不能提交并说明先发布', async () => {
    mocks.fetchScenario.mockResolvedValue(scenarioDetail({ published: false }))
    const screen = await renderDialog()
    await selectScenario(screen)
    await expect
      .element(screen.getByText('这个场景还没有发布过版本，先到场景里发布再创建运行。'))
      .toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '创建运行' })).toBeDisabled()
  })

  it('账号被滤掉时说明真实原因', async () => {
    mocks.fetchTargetAccounts.mockResolvedValue({
      items: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          displayName: '采集号',
          username: 'map',
          status: 'active',
          hasPassword: true,
          usage: 'map',
        },
      ],
    })
    const screen = await renderDialog()
    await selectScenario(screen)
    await expect
      .element(screen.getByText('这个系统的账号被标成仅知识采集，不能用来跑场景。'))
      .toBeInTheDocument()
    expect(document.body.innerText).not.toContain('不要求事先保存口令')
  })
})
