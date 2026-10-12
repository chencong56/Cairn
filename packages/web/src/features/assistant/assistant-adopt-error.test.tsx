import '@/styles/index.css'
import type { AssistantProposal, AssistantTurn } from '@cairn/shared'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { useAssistantStore } from '@/stores/assistant-store'
import { useAuthStore } from '@/stores/auth-store'
import { AssistantHost } from './host'

/**
 * 采纳/撤销处理器抛异常（如明文 HTTP 非安全上下文下摘要计算失败）时，
 * 面板必须把异常转成 toast 反馈，而不是静默吞掉未处理 rejection——
 * 否则用户「点击采纳后毫无反应」。
 */

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))
const { navigate } = vi.hoisted(() => ({ navigate: vi.fn(async () => undefined) }))

vi.mock('sonner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sonner')>()
  return {
    ...actual,
    toast: {
      ...actual.toast,
      error: toastError,
    },
  }
})

vi.mock('@/lib/assistant-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/assistant-api')>()
  return {
    ...actual,
    fetchAssistantCapabilities: vi.fn(async () => ({
      items: [],
      modelEnabled: true,
    })),
    fetchAssistantTurns: vi.fn(async () => []),
  }
})

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => navigate,
    useRouterState: () => ({
      location: { pathname: '/scenarios/scenario-1' },
    }),
  }
})

function buildTurn(result: AssistantTurn['result'], question: string): AssistantTurn {
  return {
    id: 'turn-adopt-error-1',
    conversationId: 'conv-adopt-error',
    clientTurnId: 'client-adopt-error-1',
    parentTurnId: null,
    question,
    capabilityId: 'scenario.propose-step',
    status: 'COMPLETED',
    deadlineAt: '2026-10-09T00:01:00.000Z',
    result,
    createdAt: '2026-10-09T00:00:00.000Z',
    updatedAt: '2026-10-09T00:00:00.000Z',
  }
}

const proposalResult: AssistantProposal = {
  kind: 'proposal',
  change: { kind: 'ai_instruction', instruction: '修正提交按钮定位器' },
  document: { steps: [] } as unknown as AssistantProposal['document'],
  stepId: 'step-submit',
  draftRevision: 1,
  documentDigest: '0'.repeat(64),
  reason: '修正提交按钮定位器',
  executable: true,
  diffs: [],
  diagnostics: [],
}

describe('识途助手：采纳/撤销异常必须有可见反馈', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    localStorage.clear()
    await page.viewport(1440, 900)

    useAuthStore.getState().auth.reset()
    useAuthStore.getState().auth.setUser({
      id: 'tester-admin',
      displayName: '测试工程师',
      email: 'tester@cairn.local',
      roles: ['admin'],
      permissions: ['ai:assist', 'workflow:read', 'workflow:write'],
    })

    useAssistantStore.setState({
      open: false,
      mode: 'floating',
      conversationId: 'conv-adopt-error',
      turns: [buildTurn(proposalResult, '修复提交按钮定位失败问题')],
      question: '',
      busy: false,
      error: null,
      pageContext: { page: 'studio', scenarioId: 'scenario-1' },
      boundContext: null,
      activeQuote: null,
      activeStage: null,
      thinkingText: undefined,
      capabilityHint: undefined,
      capabilities: null,
      adoptHandler: null,
      rollbackHandler: null,
      lastAdoptedProposalId: null,
      previewStepId: null,
    })

    await render(<AssistantHost />)
    const openBtn = page.getByRole('button', { name: '打开识途助手' })
    await openBtn.click()
  })

  afterEach(() => {
    useAssistantStore.getState().cancel()
    useAssistantStore.getState().closePanel()
    useAuthStore.getState().auth.setUser(null)
  })

  it('adoptHandler 抛异常时 toast 报错，不再静默无响应', async () => {
    useAssistantStore.setState({
      adoptHandler: vi.fn(async () => {
        throw new TypeError("Cannot read properties of undefined (reading 'digest')")
      }),
    })

    const adoptBtn = page.getByRole('button', { name: '采纳到本地草稿' })
    await adoptBtn.click()

    expect(toastError).toHaveBeenCalledWith(
      expect.stringContaining('采纳失败'),
    )
    // 未采纳成功时不应进入“已放入草稿”状态
    expect(useAssistantStore.getState().lastAdoptedProposalId).toBeNull()
  })

  it('rollbackHandler 抛异常时 toast 报错', async () => {
    useAssistantStore.setState({
      lastAdoptedProposalId: 'step-submit',
      rollbackHandler: vi.fn(async () => {
        throw new Error('撤销时快照缺失')
      }),
    })

    const rollbackBtn = page.getByRole('button', { name: '撤销采纳' })
    await rollbackBtn.click()

    expect(toastError).toHaveBeenCalledWith(
      expect.stringContaining('撤销失败'),
    )
  })
})
