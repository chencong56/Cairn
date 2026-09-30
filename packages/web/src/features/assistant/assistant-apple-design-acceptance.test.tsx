import '@/styles/index.css'
import type { AssistantExplanation } from '@cairn/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { useAssistantStore } from '@/stores/assistant-store'
import { useAuthStore } from '@/stores/auth-store'
import { AssistantHost } from './host'

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useRouterState: () => ({ location: { pathname: '/scenarios/sc-demo' } }),
  }
})

vi.mock('@/lib/assistant-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/assistant-api')>()
  return {
    ...actual,
    fetchAssistantCapabilities: vi.fn(async () => ({
      items: [
        { id: 'platform.guide', label: '功能导览', available: true, missingPermissions: [], requiredContext: [] },
        { id: 'scenario.explain', label: '场景解释', available: true, missingPermissions: [], requiredContext: [] },
        { id: 'scenario.propose-step', label: '修改建议', available: true, missingPermissions: [], requiredContext: [] },
        { id: 'run.diagnose', label: '运行诊断', available: true, missingPermissions: [], requiredContext: [] },
      ],
      modelEnabled: true,
    })),
    fetchAssistantConversations: vi.fn(async () => ({ items: [] })),
    createAssistantConversation: vi.fn(async () => ({
      id: 'conv-ui-acceptance-1',
      title: 'UI验收对话',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
    createAssistantTurn: vi.fn(async () => ({
      turnId: 'turn-ui-1',
      stage: 'accepted',
      queuePosition: null,
    })),
    observeAssistantTurn: vi.fn(() => () => {}),
    cancelAssistantTurn: vi.fn(),
    fetchAssistantTurn: vi.fn(),
    fetchAssistantTurns: vi.fn(async () => ({ items: [] })),
  }
})

describe('Apple Design UI 视觉与交互验收：识途助手感知去重与 Markdown 排版', () => {
  beforeEach(async () => {
    await page.viewport(1280, 800)
    useAuthStore.getState().auth.setUser({
      id: 'u-designer',
      displayName: '设计体验专家',
      email: 'designer@example.com',
      roles: ['author'],
      permissions: ['ai:assist', 'workflow:write', 'workflow:read', 'target:read', 'run:read'],
    })

    useAssistantStore.setState({
      open: true,
      conversationId: 'conv-ui-acceptance-1',
      turns: [],
      question: '',
      busy: false,
      cancelling: false,
      error: null,
      pageContext: { page: 'studio', scenarioId: 'sc-demo', stepId: 'step-open-page' },
      capabilityHint: undefined,
      capabilities: {
        modelEnabled: true,
        items: [
          { id: 'scenario.explain', label: '场景解释', available: true, missingPermissions: [], requiredContext: [] },
          { id: 'scenario.propose-step', label: '修改建议', available: true, missingPermissions: [], requiredContext: [] },
        ],
      },
      mode: 'floating',
      dockWidth: 420,
      activeQuote: null,
      boundContext: null,
      conversations: [],
      historyOpen: false,
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('验收 1 (Apple Design 规范·Simplicity & Purpose)：感知页面去除主视口重复卡片，呈现呼吸感情境连接', async () => {
    useAssistantStore.setState({
      boundContext: {
        page: 'studio',
        scenarioId: 'sc-demo',
        selectedStepId: 'step-open-page',
        summaryText: '已聚焦步骤「打开页面」，可向助手提问选择器诊断、耗时优化或预期断言',
        chips: [
          { id: 'studio-step-propose', label: '✏️ 修改建议', question: '请对当前步骤提出编写建议', capabilityHint: 'scenario.propose-step' },
          { id: 'studio-step-accept', label: '🎯 验收此步骤', question: '为当前步骤配置验收条件', capabilityHint: 'scenario.propose-step' },
          { id: 'studio-step-explain', label: '📖 解释此步骤', question: '请解释此步骤的操作意图', capabilityHint: 'scenario.explain' },
        ],
      },
    })

    render(<AssistantHost />)

    // 1. 验证上方 ContextCapsule 优雅承接所有推荐 Chips
    await expect.element(page.getByText('已聚焦步骤「打开页面」')).toBeVisible()
    await expect.element(page.getByRole('button', { name: '✏️ 修改建议', exact: true })).toBeVisible()
    await expect.element(page.getByRole('button', { name: '🎯 验收此步骤', exact: true })).toBeVisible()
    await expect.element(page.getByRole('button', { name: '📖 解释此步骤', exact: true })).toBeVisible()

    // 2. 验证下方重复的 PromptCards 彻底隐退，消灭双胞胎卡片
    await expect.element(page.getByTestId('assistant-prompt-cards')).not.toBeInTheDocument()
    await expect.element(page.getByText('有什么可以帮你？')).not.toBeInTheDocument()

    // 3. 验证主视口呈现精致的 ContextFocusIndicator
    const focusIndicator = page.getByTestId('context-focus-indicator')
    await expect.element(focusIndicator).toBeVisible()
    await expect.element(focusIndicator.getByText('已连接场景')).toBeVisible()
    await expect.element(focusIndicator.getByText('可直接在下方输入框提问，或点击上方感知建议快捷操作')).toBeVisible()

    // 截图保存以供 Apple Design 视觉走查
    await page.screenshot({ path: '__screenshots__/apple-design-context-deduplicated.png' })
  })

  it('验收 2 (Apple Design 规范·Typography & Hierarchy)：长文回答排版分明，Markdown 格式化彻底告别生字块', async () => {
    const formattedExplanation: AssistantExplanation = {
      kind: 'explanation',
      summary: `该场景主要完成电商管理后台的核心交易闭环。

**核心业务动线**：
1. 打开后台登录首页并进入工作台
2. 进入 \`Orders\` 订单中心，检索指定租户的待结算记录
3. 点击 **立即结算** 按钮，校验金额与库存扣减状态

> 提示：本场景绑定目标系统 **ERP中转网关**，属于 **MUST** 核心成功判定路径。`,
      stepSummary: '打开页面并验证标题',
      references: [],
      diagnostics: [],
      executable: true,
    }

    useAssistantStore.setState({
      turns: [
        {
          id: 'turn-markdown-demo-1',
          conversationId: 'conv-ui-acceptance-1',
          clientTurnId: 'c-turn-1',
          parentTurnId: null,
          question: '请帮我解释一下这个场景主要做了什么事情？',
          capabilityId: 'scenario.explain',
          status: 'COMPLETED',
          stage: 'persisting',
          deadlineAt: new Date(Date.now() + 60000).toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          result: formattedExplanation,
        },
      ],
      busy: false,
    })

    render(<AssistantHost />)

    // 1. 验证用户发问气泡与助手标识
    await expect.element(page.getByText('请帮我解释一下这个场景主要做了什么事情？')).toBeVisible()
    await expect.element(page.getByText('打开页面并验证标题')).toBeVisible()

    // 2. 验证 Markdown 格式化元素全部正确渲染，而非生字块
    const markdownContainer = page.getByTestId('assistant-markdown').first()
    await expect.element(markdownContainer).toBeVisible()

    // 验证粗体重点
    await expect.element(markdownContainer.getByText('核心业务动线')).toBeVisible()
    await expect.element(markdownContainer.getByText('立即结算')).toBeVisible()
    await expect.element(markdownContainer.getByText('ERP中转网关')).toBeVisible()
    await expect.element(markdownContainer.getByText('MUST')).toBeVisible()

    // 验证有序列表
    await expect.element(page.getByRole('list')).toBeVisible()
    await expect.element(markdownContainer.getByText('打开后台登录首页并进入工作台')).toBeVisible()

    // 验证行内代码标签
    await expect.element(markdownContainer.getByText('Orders')).toBeVisible()

    // 截图保存以供 Apple Design 视觉走查
    await page.screenshot({ path: '__screenshots__/apple-design-markdown-explanation.png' })
  })
})
