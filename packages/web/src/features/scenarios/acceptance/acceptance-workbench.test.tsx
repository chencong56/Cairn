import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AssistantAcceptanceAuditReport } from '@cairn/shared'
import { AcceptanceAuditDialog, AcceptanceWorkbench, type AcceptanceStep } from './acceptance-workbench'

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
    const screen = await render(
      <AcceptanceAuditDialog
        open={true}
        onOpenChange={vi.fn()}
        loading={false}
        report={mockReport}
        onApplySuggestedIntents={onApply}
      />,
    )

    // 检查标题与概览
    expect(screen.getByText('场景验收体检报告')).toBeDefined()
    expect(screen.getByText('步骤提取了数据但未被任何验收规则引用')).toBeDefined()
    expect(screen.getByText('全程耗时监控')).toBeDefined()

    // 检查加入建议按钮
    const applyBtn = screen.getByRole('button', { name: /把勾选建议加入意图/ })
    expect(applyBtn).toBeDefined()
  })
})
