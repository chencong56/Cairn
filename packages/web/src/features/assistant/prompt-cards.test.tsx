import '@/styles/index.css'
import type { AssistantCapabilitiesResponse } from '@cairn/shared'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { PromptCards } from './prompt-cards'

function capabilities(
  available: string[],
  presentIds = ['platform.guide', 'scenario.explain', 'run.diagnose', 'run.compare'],
): AssistantCapabilitiesResponse {
  return {
    modelEnabled: true,
    items: presentIds.map((id) => ({
      id,
      label: id,
      available: available.includes(id),
      missingPermissions: [],
      requiredContext: [],
    })) as AssistantCapabilitiesResponse['items'],
  }
}

describe('PromptCards 能力与承诺', () => {
  it('只推荐有权限的入口，提问与导览能力一致', async () => {
    const onSelectPrompt = vi.fn()
    const screen = await render(
      <PromptCards pageContext={null} capabilities={capabilities(['platform.guide'], ['platform.guide'])} onSelectPrompt={onSelectPrompt} />,
    )

    await expect.element(screen.getByTestId('prompt-card-auth-create')).toBeInTheDocument()
    await expect.element(screen.getByTestId('prompt-card-auth-retry')).not.toBeInTheDocument()
    await expect.element(screen.getByRole('tab', { name: '运行排障' })).not.toBeInTheDocument()
    await screen.getByTestId('prompt-card-auth-create').click()
    expect(onSelectPrompt).toHaveBeenCalledWith('在哪里打开场景编排和场景工作区？', 'platform.guide')
  })

  it('运行页只显示当前可用的诊断能力', async () => {
    const screen = await render(
      <PromptCards
        pageContext={{ page: 'run', runId: 'run-1' }}
        capabilities={capabilities(['run.diagnose'])}
        onSelectPrompt={vi.fn()}
      />,
    )
    await expect.element(screen.getByTestId('prompt-card-diag-rootcause')).toBeInTheDocument()
    await expect.element(screen.getByTestId('prompt-card-diag-compare')).not.toBeInTheDocument()
  })

  it('没有可用能力时不显示失效推荐', async () => {
    const screen = await render(
      <PromptCards pageContext={null} capabilities={capabilities([])} onSelectPrompt={vi.fn()} />,
    )
    expect(screen.container.innerHTML).toBe('')
  })

  it('单一呈现模型：PromptCards 严格展示标准分类，不复制专属推荐标签「场景推荐」', async () => {
    const onSelectPrompt = vi.fn()
    const screen = await render(
      <PromptCards
        pageContext={{ page: 'studio', scenarioId: 'sc-1', stepId: 'step-1' }}
        boundContext={{
          page: 'studio',
          scenarioId: 'sc-1',
          selectedStepId: 'step-1',
        }}
        capabilities={capabilities(['scenario.explain'])}
        onSelectPrompt={onSelectPrompt}
      />,
    )

    // 不存在重复的场景推荐 tab
    await expect.element(screen.getByRole('tab', { name: '场景推荐' })).not.toBeInTheDocument()

    // 默认展示标准分类（场景编排）
    const authTab = screen.getByRole('tab', { name: '场景编排' })
    await expect.element(authTab).toBeInTheDocument()
    await expect.element(authTab).toHaveAttribute('aria-selected', 'true')
  })

  it('运行页泛化态：PromptCards 仅展示标准排障卡片，不复制单步诊断专有卡片', async () => {
    const screen = await render(
      <PromptCards
        pageContext={{ page: 'run', runId: 'run-fail' }}
        capabilities={capabilities(['run.diagnose'])}
        onSelectPrompt={vi.fn()}
      />,
    )

    await expect.element(screen.getByTestId('prompt-card-diag-rootcause')).toBeInTheDocument()
    await expect.element(screen.getByTestId('prompt-card-run-step-diagnose')).not.toBeInTheDocument()
  })

  it('方案B气泡流：提示词胶囊具备 tooltip 说明且类名符合紧凑药丸规范', async () => {
    const onSelectPrompt = vi.fn()
    const screen = await render(
      <PromptCards
        pageContext={null}
        capabilities={capabilities(['platform.guide'])}
        onSelectPrompt={onSelectPrompt}
      />,
    )

    const chip = screen.getByTestId('prompt-card-auth-create')
    await expect.element(chip).toBeInTheDocument()
    await expect.element(chip).toHaveAttribute('title', '查看场景和编辑步骤的位置')
    // 包含 rounded-full 与 py-1.5 气泡胶囊契约
    expect(chip.element().className).toContain('rounded-full')
    expect(chip.element().className).toContain('py-1.5')
  })
})
