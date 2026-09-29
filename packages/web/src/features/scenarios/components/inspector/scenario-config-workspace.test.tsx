import '@/styles/index.css'
import { render } from 'vitest-browser-react'
import { describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ScenarioAuthoringDocumentV2, Step } from '@cairn/shared'
import { ScenarioConfigWorkspace } from './scenario-config-workspace'

describe('ScenarioConfigWorkspace - 净化场景配置工作区', () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })

  const mockDoc: ScenarioAuthoringDocumentV2 = {
    schemaVersion: 1,
    authoringSchemaVersion: 2,
    inputs: [
      {
        key: 'orderId',
        label: '订单编号',
        type: 'string',
        required: true,
      },
    ],
    outputs: {
      metrics: [],
      dataRowFields: [],
    },
    nodes: [
      {
        kind: 'step',
        step: {
          id: 'step-1',
          name: '点击支付按钮',
          type: 'click',
          effectType: 'SIDE_EFFECT',
          input: { target: { framePath: [], candidates: [{ by: 'text', value: '支付' }] } },
        } as Step,
      },
    ],
  }

  it('仅渲染纯净 4 分区，不包含稳定性分区与 Tab', async () => {
    const onOpenHealth = vi.fn()

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ScenarioConfigWorkspace
          scenarioId='sc-1'
          targetId='t1'
          document={mockDoc}
          onOpenHealth={onOpenHealth}
          onReturnToSteps={vi.fn()}
          onUpdateInputs={vi.fn()}
          onUpdateOutputs={vi.fn()}
          onUpdateScenarioOutcomes={vi.fn()}
          onUpdateRuntimeInvariants={vi.fn()}
          onUpdateDocument={vi.fn()}
        />
      </QueryClientProvider>,
    )

    // 确认四个纯配置 Tab 存在
    await expect.element(screen.getByTestId('scenario-config-tab-inputs')).toBeInTheDocument()
    await expect.element(screen.getByTestId('scenario-config-tab-outcomes')).toBeInTheDocument()
    await expect.element(screen.getByTestId('scenario-config-tab-outputs')).toBeInTheDocument()
    await expect.element(screen.getByTestId('scenario-config-tab-settings')).toBeInTheDocument()

    // 确认已解耦：不存在 stability Tab 与分区
    expect(document.querySelector('[data-testid="scenario-config-tab-stability"]')).toBeNull()
    expect(document.querySelector('[data-partition="stability"]')).toBeNull()

    // 确认四个纯分区存在
    expect(document.querySelector('[data-partition="inputs"]')).not.toBeNull()
    expect(document.querySelector('[data-partition="outcomes"]')).not.toBeNull()
    expect(document.querySelector('[data-partition="outputs"]')).not.toBeNull()
    expect(document.querySelector('[data-partition="settings"]')).not.toBeNull()
  })

  it('展示平滑转场引导卡，点击触发 onOpenHealth', async () => {
    const onOpenHealth = vi.fn()

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ScenarioConfigWorkspace
          scenarioId='sc-1'
          targetId='t1'
          document={mockDoc}
          onOpenHealth={onOpenHealth}
          onReturnToSteps={vi.fn()}
          onUpdateInputs={vi.fn()}
          onUpdateOutputs={vi.fn()}
          onUpdateScenarioOutcomes={vi.fn()}
          onUpdateRuntimeInvariants={vi.fn()}
          onUpdateDocument={vi.fn()}
        />
      </QueryClientProvider>,
    )

    const transitionCard = screen.getByTestId('scenario-config-health-transition-card')
    await expect.element(transitionCard).toBeInTheDocument()
    await expect.element(screen.getByText('定位健康度与规则自愈已独立升级')).toBeInTheDocument()

    const jumpBtn = screen.getByText('查看场景健康')
    await jumpBtn.click()
    expect(onOpenHealth).toHaveBeenCalledTimes(1)
  })
})
