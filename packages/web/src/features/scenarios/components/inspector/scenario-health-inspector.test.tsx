import '@/styles/index.css'
import { render } from 'vitest-browser-react'
import { describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { makeRepairCandidate } from '@/test-utils/repair-candidate'
import { ScenarioHealthInspector } from './scenario-health-inspector'
import * as scenariosApi from '@/lib/scenarios-api'

vi.mock('@/lib/scenarios-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/scenarios-api')>()
  return {
    ...actual,
    fetchScenarioResolutionStats: vi.fn(),
  }
})

const mockFetchStats = vi.mocked(scenariosApi.fetchScenarioResolutionStats)

describe('ScenarioHealthInspector - 场景定位健康与自愈工作区', () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })

  it('展示 100% 稳定状态与步骤返回按钮', async () => {
    mockFetchStats.mockResolvedValueOnce({
      items: [
        {
          stepId: 'step-1',
          scenarioVersionId: 'v1',
          targetId: 't1',
          deterministic: 5,
          map: 0,
          ai: 0,
          failed: 0,
          fallbackRate: 0,
        },
      ],
    })

    const onReturnToStep = vi.fn()

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ScenarioHealthInspector
          scenarioId='sc-1'
          steps={[{ id: 'step-1', name: '点击支付按钮' }]}
          focusedStepId='step-1'
          focusedStepIndex={0}
          onReturnToStep={onReturnToStep}
          locatorHealth={{
            healthMap: new Map(),
            overallScore: 100,
            healthyCount: 1,
            warningCount: 0,
            failingCount: 0,
            candidateCount: 0,
            candidates: [],
            isLoading: false,
            isError: false,
            adoptCandidate: vi.fn(),
            rejectCandidate: vi.fn(),
            batchAdoptAll: vi.fn(),
          }}
        />
      </QueryClientProvider>,
    )

    await expect.element(screen.getByText('全部规则 100% 稳定')).toBeInTheDocument()
    await expect.element(screen.getByText('100% 稳定', { exact: true })).toBeInTheDocument()

    const returnBtn = screen.getByTestId('health-inspector-return-step-btn')
    await expect.element(returnBtn).toBeInTheDocument()
    await returnBtn.click()
    expect(onReturnToStep).toHaveBeenCalledTimes(1)
  })

  it('存在规则衰减与自愈建议时，展示自愈横幅并触发一键自愈', async () => {
    mockFetchStats.mockResolvedValueOnce({
      items: [
        {
          stepId: 'step-1',
          scenarioVersionId: 'v1',
          targetId: 't1',
          deterministic: 1,
          map: 0,
          ai: 3,
          failed: 0,
          fallbackRate: 0.75,
        },
      ],
    })

    const onBatchAdopt = vi.fn()
    const onSelectStep = vi.fn()

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ScenarioHealthInspector
          scenarioId='sc-1'
          steps={[{ id: 'step-1', name: '点击支付按钮' }]}
          locatorHealth={{
            healthMap: new Map(),
            overallScore: 25,
            healthyCount: 0,
            warningCount: 1,
            failingCount: 0,
            candidateCount: 1,
            candidates: [makeRepairCandidate()],
            isLoading: false,
            isError: false,
            adoptCandidate: vi.fn(),
            rejectCandidate: vi.fn(),
            batchAdoptAll: vi.fn(),
          }}
          onBatchAdopt={onBatchAdopt}
          onSelectStep={onSelectStep}
        />
      </QueryClientProvider>,
    )

    await expect.element(screen.getByText('1 个步骤规则衰减')).toBeInTheDocument()
    await expect.element(screen.getByText('1 步需维护')).toBeInTheDocument()

    const batchAdoptBtn = screen.getByTestId('batch-adopt-all-btn')
    await expect.element(batchAdoptBtn).toBeInTheDocument()
    await batchAdoptBtn.click()
    expect(onBatchAdopt).toHaveBeenCalledTimes(1)
  })

  it('零运行样本冷启动时，展示空态说明与待试跑引导', async () => {
    mockFetchStats.mockResolvedValueOnce({ items: [] })

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ScenarioHealthInspector
          scenarioId='sc-1'
          steps={[{ id: 'step-1', name: '打开百度' }]}
        />
      </QueryClientProvider>,
    )

    await expect.element(screen.getByText('尚未产生运行样本')).toBeInTheDocument()
    await expect.element(screen.getByText('待试跑')).toBeInTheDocument()
    await expect.element(screen.getByTestId('health-empty-guidance')).toBeInTheDocument()
    await expect.element(screen.getByText('通过试跑获取定位稳定性')).toBeInTheDocument()
  })
})
