import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AssistantAcceptanceAuditReport } from '@cairn/shared'
import { AcceptanceAuditDialog, AcceptanceWorkbench, type AcceptanceStep } from './acceptance-workbench'

vi.mock('./acceptance-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./acceptance-api')>()
  return {
    ...actual,
    fetchScenarioAcceptanceHistory: vi.fn(),
  }
})

const sampleSteps: AcceptanceStep[] = [
  { id: 'step-1', name: '提取订单金额', type: 'extract', effectType: 'READ_ONLY', outputKey: 'order_amt', isBackbone: true },
  { id: 'step-2', name: '提取支付金额', type: 'extract', effectType: 'READ_ONLY', outputKey: 'pay_amt', isBackbone: true },
  { id: 'step-3', name: '分支内提取', type: 'extract', effectType: 'READ_ONLY', outputKey: 'branch_val', isBackbone: false },
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
          stepId: 'step-1',
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
    expect(onLocateStep).toHaveBeenCalledWith('step-1')

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
    await expect.element(screen.getByRole('button', { name: '采纳' })).toBeInTheDocument()

    // 点击采纳调优
    const adoptBtn = screen.getByRole('button', { name: '采纳' })
    await adoptBtn.click()

    expect(onApplyUpdateOutcome).toHaveBeenCalledWith('contract-duration-1', {
      rule: { kind: 'duration_budget', maxMs: 3000 },
    })
  })
})
