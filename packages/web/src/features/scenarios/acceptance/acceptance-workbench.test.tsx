import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type {
  AcceptancePreviewResponse,
  AssistantAcceptanceAuditReport,
  RunDetailDto,
} from '@cairn/shared'
import { AcceptanceAuditDialog, AcceptanceWorkbench, type AcceptanceStep } from './acceptance-workbench'

vi.mock('./acceptance-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./acceptance-api')>()
  return {
    ...actual,
    fetchScenarioAcceptanceHistory: vi.fn(),
    requestAcceptanceProposal: vi.fn(),
    previewAcceptance: vi.fn().mockResolvedValue({
      acceptable: true,
      testResult: 'PASSED',
      diagnostics: ['行数满足预期'],
      evidenceId: 'ev-table-sample-1',
      planDigest: 'd',
      sampleDigest: 's',
      sampledAt: new Date().toISOString(),
      draftRevision: 1,
      operations: [],
      proposal: {
        kind: 'authoring_proposal',
        proposalId: 'prop-1',
        scenarioId: 'sc-test',
        base: { draftRevision: 1, documentDigest: 'a', dependencyFingerprint: 't:1' },
        cards: [],
        operations: [],
        intentCoverage: [],
        diffs: [],
        diagnostics: [],
        executable: true,
        validation: { schema: 'passed', expansion: 'passed', compiler: 'passed' },
      },
    }),
  }
})

vi.mock('@/lib/runs-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runs-api')>()
  return {
    ...actual,
    renewDebugPresence: vi.fn().mockResolvedValue({
      now: new Date().toISOString(),
      holdExpiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      holdHardExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }),
    observeRun: vi.fn().mockImplementation((_runId, body) => {
      if (body.op === 'table' && body.subOp === 'discover') {
        return Promise.resolve({
          outcome: 'FOUND',
          tables: [
            {
              index: 0,
              target: { framePath: [], candidates: [{ by: 'css', value: 'table.orders' }] },
              rowCountHint: 5,
              columns: [{ key: 'col_1', name: '订单号' }],
            },
          ],
        })
      }
      if (body.op === 'table' && body.subOp === 'sample') {
        return Promise.resolve({
          outcome: 'FOUND',
          evidenceId: 'ev-table-sample-1',
          sample: {
            protocol: 'table.sample@1',
            source: { runId: 'run-hold-2', sampledAt: new Date().toISOString() },
            columns: [{ key: 'col_1', name: '订单号', valueType: 'text' }],
            rows: [{ col_1: { value: 'ORD-1001', rawText: 'ORD-1001', status: 'ok' } }],
            rowCount: 1,
            presentation: { omitted: false, previewCount: 20 },
          },
        })
      }
      return Promise.resolve({ outcome: 'FOUND' })
    }),
  }
})

const STEP_ID_1 = '11111111-1111-4111-8111-111111111111'
const STEP_ID_2 = '22222222-2222-4222-8222-222222222222'
const STEP_ID_3 = '33333333-3333-4333-8333-333333333333'

const mockObserve = {
  holding: true,
  checkpointStepId: STEP_ID_1,
  livePage: true,
  canIndicate: true,
  canHighlight: true,
  canDebugHold: true,
  enclosingTable: { framePath: [], candidates: [{ by: 'css', value: 'table.parent' }], semantic: '外层订单表' },
  setPickMode: vi.fn(),
  setTableMarkers: vi.fn(),
  highlightTarget: vi.fn(),
  pickAt: vi.fn(),
  pickEnclosingTable: vi.fn(),
  applyForTrial: vi.fn(),
  clearOverlay: vi.fn(),
  writeBack: vi.fn(),
  applyPickedToStep: vi.fn(),
  adoptAlternative: vi.fn(),
  applyAsOutcome: vi.fn(),
}

vi.mock('../authoring-observe', () => ({
  useAuthoringObserve: () => mockObserve,
}))


const sampleSteps: AcceptanceStep[] = [
  { id: STEP_ID_1, name: '提取订单金额', type: 'extract', effectType: 'READ_ONLY', outputKey: 'order_amt', isBackbone: true },
  { id: STEP_ID_2, name: '提取支付金额', type: 'extract', effectType: 'READ_ONLY', outputKey: 'pay_amt', isBackbone: true },
  { id: STEP_ID_3, name: '分支内提取', type: 'extract', effectType: 'READ_ONLY', outputKey: 'branch_val', isBackbone: false },
]

describe('AcceptanceWorkbench UI', () => {
  it('渲染补全验收面板头部、验收体检按钮与自然语言描述输入框', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <AcceptanceWorkbench
          scenarioId='sc-test'
          steps={sampleSteps}
          ensureDraftSaved={vi.fn().mockResolvedValue(1)}
          onStartBaseline={vi.fn()}
          onStartVerification={vi.fn()}
          onLocateStep={vi.fn()}
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    )

    // 检查头部体检按钮
    const auditBtn = screen.getByRole('button', { name: /验收体检/ })
    expect(auditBtn).toBeDefined()

    // 检查自然语言描述输入框
    const textarea = screen.getByPlaceholder('可直接描述验收要求（≤500字），例如：“检查订单列表必须有数据，全程耗时不超过1分钟，结算金额与支付金额一致”')
    expect(textarea).toBeDefined()
    expect(screen.getByText('0/500')).toBeDefined()
  })

  it('AcceptanceAuditDialog 正确展示体检发现与智能补全建议清单', async () => {
    const mockReport: AssistantAcceptanceAuditReport = {
      kind: 'acceptance_audit_report',
      scenarioId: 'sc-test',
      findings: [
        {
          id: 'f1',
          source: 'audit',
          code: 'UNREPORTED_EXTRACT',
          severity: 'warning',
          message: '步骤提取了数据但未被任何验收规则引用',
          stepId: STEP_ID_1,
          stepName: '提取订单金额',
          rationale: '产出 order_amt 建议纳入验收',
        },
      ],
      suggestedIntents: [
        {
          id: 'sug-1',
          label: '全程耗时监控',
          rationale: '建议增加全场景执行耗时兜底',
          needsTarget: false,
          source: 'deterministic',
          intent: {
            key: 'q1',
            kind: 'scenario_duration',
            maxMs: 60000,
            severity: 'SHOULD',
          },
        },
      ],
      coverage: {
        browserStepCoverage: 1,
        outputMetricCoverage: 1,
        browserStepsCount: 1,
        coveredBrowserStepsCount: 1,
        outputsCount: 1,
        coveredOutputsCount: 1,
      },
    }

    const onApply = vi.fn()
    const onLocateStep = vi.fn()
    const screen = await render(
      <AcceptanceAuditDialog
        scenarioId='sc-test'
        open={true}
        onOpenChange={vi.fn()}
        loading={false}
        report={mockReport}
        stepName={(id) => sampleSteps.find((s) => s.id === id)?.name ?? id}
        onLocateStep={onLocateStep}
        maxAddable={3}
        onApplySuggestedIntents={onApply}
      />,
    )

    // 检查标题与概览（真实覆盖度而非硬编码规则数）
    expect(screen.getByText(/场景验收体检与历史洞察/)).toBeDefined()
    expect(screen.getByText('步骤提取了数据但未被任何验收规则引用')).toBeDefined()
    expect(screen.getByText('全程耗时监控')).toBeDefined()
    expect(screen.getByText('有成功条件的浏览器步骤：')).toBeDefined()
    expect(screen.getByText(/1\/1（100%）/)).toBeDefined()
    expect(screen.getByText(/还可加入 3 项意图/)).toBeDefined()

    // 缺口可跳转到对应步骤
    const locateBtn = screen.getByRole('button', { name: /提取订单金额/ })
    await locateBtn.click()
    expect(onLocateStep).toHaveBeenCalledWith(STEP_ID_1)

    // 检查加入建议按钮
    const applyBtn = screen.getByRole('button', { name: /把勾选建议加入意图/ })
    expect(applyBtn).toBeDefined()
  })

  it('AcceptanceAuditDialog 历史洞察支持查看调优建议并采纳', async () => {
    const mockHistory = {
      scenarioId: 'sc-test',
      insights: [
        {
          contractId: 'contract-duration-1',
          meaning: '全流程耗时检查',
          scope: 'scenario',
          sampleCount: 10,
          sampleBreakdown: { manual: 0, test: 0, runThrough: 10 },
          passCount: 10,
          failCount: 0,
          unknownCount: 0,
          inspectionalFailCount: 0,
          suggestions: [
            {
              kind: 'tighten_threshold',
              ruleName: '收紧耗时预算至 3,000ms',
              rationale: '近 10 次耗时平稳（P95=1,800ms），现阈值 10,000ms 过度宽松',
              sampleCount: 10,
              fromValue: 10000,
              toValue: 3000,
              suggestedPatch: {
                rule: { kind: 'duration_budget', maxMs: 3000 },
              },
            },
          ],
        },
      ],
    }

    const { fetchScenarioAcceptanceHistory } = await import('./acceptance-api')
    vi.mocked(fetchScenarioAcceptanceHistory).mockResolvedValue(
      mockHistory as unknown as Awaited<ReturnType<typeof fetchScenarioAcceptanceHistory>>,
    )

    const onApplyUpdateOutcome = vi.fn().mockResolvedValue({ ok: true })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <AcceptanceAuditDialog
          scenarioId='sc-test'
          open={true}
          onOpenChange={vi.fn()}
          loading={false}
          report={null}
          stepName={(id) => id}
          onLocateStep={vi.fn()}
          maxAddable={3}
          onApplySuggestedIntents={vi.fn()}
          onApplyUpdateOutcome={onApplyUpdateOutcome}
        />
      </QueryClientProvider>,
    )

    // 点击历史洞察 Tab
    const historyTab = screen.getByRole('tab', { name: /历史洞察/ })
    await historyTab.click()

    await expect.element(screen.getByText('全流程耗时检查')).toBeInTheDocument()
    // 样本来源构成随洞察呈现
    await expect.element(screen.getByText(/来源构成：/)).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '采纳' })).toBeInTheDocument()

    // 点击采纳调优
    const adoptBtn = screen.getByRole('button', { name: '采纳' })
    await adoptBtn.click()

    expect(onApplyUpdateOutcome).toHaveBeenCalledWith('contract-duration-1', {
      rule: { kind: 'duration_budget', maxMs: 3000 },
    })
  })

  it('挂起状态下向服务端发送 debug hold 心跳并在头部显示挂起截止时间', async () => {
    const { renewDebugPresence } = await import('@/lib/runs-api')
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    const mockRun = {
      id: 'run-hold-1',
      status: 'HOLDING',
      snapshot: { steps: [] },
      outcomeResults: [],
      checkpoint: {
        stepId: STEP_ID_1,
        reason: 'step_succeeded',
        fencingToken: 'f-tok',
        timestamp: '2026-09-30T10:00:00.000Z',
        holdId: 'hold-uuid-1',
        heldAt: '2026-09-30T10:00:00.000Z',
        holdExpiresAt: '2026-09-30T10:15:00.000Z',
        holdHardExpiresAt: '2026-09-30T11:00:00.000Z',
      },
    } as unknown as RunDetailDto

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <AcceptanceWorkbench
          scenarioId='sc-test'
          steps={sampleSteps}
          run={mockRun}
          baselineRunId='run-hold-1'
          ensureDraftSaved={vi.fn().mockResolvedValue(1)}
          onStartBaseline={vi.fn()}
          onStartVerification={vi.fn()}
          onLocateStep={vi.fn()}
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    )

    expect(renewDebugPresence).toHaveBeenCalledWith('run-hold-1', expect.objectContaining({ holdId: 'hold-uuid-1', fencingToken: 'f-tok' }))
    await expect.element(screen.getByText(/挂起至/)).toBeInTheDocument()
  })

  it('表格验收意图卡支持探测页面表格与执行规则预览', async () => {
    const { observeRun } = await import('@/lib/runs-api')
    const { previewAcceptance } = await import('./acceptance-api')
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    const mockRun = {
      id: 'run-hold-2',
      status: 'HOLDING',
      snapshot: { steps: [] },
      outcomeResults: [],
      checkpoint: {
        stepId: STEP_ID_1,
        reason: 'step_succeeded',
        fencingToken: 'f-tok',
        sessionGeneration: 1,
        timestamp: '2026-09-30T10:00:00.000Z',
        holdId: 'hold-uuid-2',
      },
    } as unknown as RunDetailDto

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <AcceptanceWorkbench
          scenarioId='sc-test'
          steps={sampleSteps}
          run={mockRun}
          baselineRunId='run-hold-2'
          ensureDraftSaved={vi.fn().mockResolvedValue(1)}
          onStartBaseline={vi.fn()}
          onStartVerification={vi.fn()}
          onLocateStep={vi.fn()}
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    )

    // 添加验收项
    const addIntentSelect = screen.getByRole('combobox')
    await addIntentSelect.click()

    const tableAcceptanceOption = screen.getByRole('option', { name: /表格验收/ })
    await tableAcceptanceOption.click()

    // 检查表格探测按钮
    const discoverBtn = screen.getByRole('button', { name: /探测页面表格/ })
    await expect.element(discoverBtn).toBeInTheDocument()

    // 点击探测表格
    await discoverBtn.click()
    expect(observeRun).toHaveBeenCalledWith('run-hold-2', { op: 'table', subOp: 'discover' })

    // 选用探测到的表格
    const adoptTableBtn = screen.getByRole('button', { name: '选用', exact: true })
    await adoptTableBtn.click()

    // 测试验收规则
    const previewBtn = screen.getByRole('button', { name: /测试验收规则/ })
    await expect.element(previewBtn).toBeInTheDocument()
    await previewBtn.click()

    expect(previewAcceptance).toHaveBeenCalledWith('sc-test', expect.objectContaining({
      evidenceId: 'ev-table-sample-1',
      intents: [expect.objectContaining({
        kind: 'table_acceptance',
      })],
    }))

    // 检查预览结果
    await expect.element(screen.getByText('预览通过')).toBeInTheDocument()
    await expect.element(screen.getByText('ORD-1001')).toBeInTheDocument()
    await expect.element(screen.getByText('行数满足预期')).toBeInTheDocument()
  })
  it('模型关闭时结构化意图走人工预览端点生成（模型调用为 0）', async () => {
    const { previewAcceptance } = await import('./acceptance-api')
    const { useAssistantStore } = await import('@/stores/assistant-store')
    const { requestAcceptanceProposal } = await import('./acceptance-api')
    vi.mocked(previewAcceptance).mockResolvedValueOnce({
      proposal: {
        kind: 'authoring_proposal',
        proposalId: 'prop-manual-1',
        scenarioId: 'sc-test',
        base: { draftRevision: 1, documentDigest: 'd', dependencyFingerprint: 't:1' },
        operations: [],
        candidateDigest: 'cd',
        intentCoverage: [],
        diffs: [],
        diagnostics: [],
        executable: true,
        validation: { schema: 'passed', expansion: 'passed', compiler: 'passed' },
        source: 'acceptance',
        cards: [
          {
            id: 'card-manual-1',
            intentKey: 'i1',
            intentKind: 'page_duration',
            meaning: '耗时不超过 5000 ms',
            stepId: STEP_ID_1,
            severity: 'SHOULD',
            onViolation: 'continue',
            operationIds: [],
            testResult: 'NOT_REQUIRED',
          },
        ],
      },
      operations: [],
      testResult: 'NOT_REQUIRED',
      diagnostics: [],
      acceptable: true,
      draftRevision: 1,
    } as unknown as AcceptancePreviewResponse)
    useAssistantStore.setState({ capabilities: { items: [], modelEnabled: false } })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <AcceptanceWorkbench
          scenarioId='sc-test'
          steps={sampleSteps}
          run={undefined}
          ensureDraftSaved={vi.fn().mockResolvedValue(1)}
          onStartBaseline={vi.fn()}
          onStartVerification={vi.fn()}
          onLocateStep={vi.fn()}
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    )

    // 添加一项不依赖页面对象的结构化意图（步骤耗时）
    const addIntentSelect = screen.getByRole('combobox')
    await addIntentSelect.click()
    const durationOption = screen.getByRole('option', { name: '页面耗时' })
    await durationOption.click()

    const generateBtn = screen.getByRole('button', { name: /生成验收方案/ })
    await generateBtn.click()

    await vi.waitFor(() => {
      expect(previewAcceptance).toHaveBeenCalledWith('sc-test', expect.objectContaining({ intents: [expect.objectContaining({ kind: 'page_duration' })] }))
    })
    expect(requestAcceptanceProposal).not.toHaveBeenCalled()
    await expect.element(screen.getByText('耗时不超过 5000 ms')).toBeInTheDocument()

    useAssistantStore.setState({ capabilities: null })
  })
})

