import '@/styles/index.css'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { TargetOverviewPanel } from './target-overview-panel'
import type { TargetOverviewItem } from './target-overview-display'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a>,
}))

const sampleItem: TargetOverviewItem = {
  target: {
    id: 'target-1',
    code: 'oa-system',
    name: '内部 OA 协同系统',
    status: 'active',
    entryUrl: 'http://192.168.1.100:8080/oa',
    authMethod: 'password',
    captchaMode: 'none',
    iconKey: 'globe',
    accentKey: 'blue',
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-20T00:00:00Z',
  },
  readiness: {
    state: 'available',
    value: {
      state: 'ready',
      reason: '有空闲登录会话',
      nextAction: { kind: 'manage_sessions' },
    },
  },
  accounts: {
    state: 'available',
    value: {
      configuredTotal: 1,
      eligibleBusinessTotal: 1,
      readyAccounts: 1,
      needLoginAccounts: 0,
      attentionAccounts: 0,
      needsCheckAccounts: 0,
      identityMismatchAccounts: 0,
      lostAccounts: 0,
      unpreparedAccounts: 0,
      maintenanceAccounts: 0,
      occupiedAccounts: 0,
      preview: [],
      hiddenAttentionCount: 0,
    },
  },
  scenarios: { state: 'available', value: { total: 10, active: 8 } },
  knowledge: { state: 'available' },
  runs: { state: 'available', value: { running: 0 } },
  activities: { state: 'available', value: { sources: [], items: [] } },
}

describe('TargetOverviewPanel 复制系统入口', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('点击复制按钮在非安全上下文（navigator.clipboard 未定义）下回退成功复制', async () => {
    // 模拟非安全上下文（如局域网 HTTP 访问），navigator.clipboard 不存在
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
      writable: true,
    })

    const execCommandSpy = vi.fn().mockReturnValue(true)
    Object.defineProperty(document, 'execCommand', {
      value: execCommandSpy,
      configurable: true,
      writable: true,
    })

    await render(
      <TargetOverviewPanel
        item={sampleItem}
        onDelete={vi.fn()}
      />
    )

    const copyBtn = page.getByRole('button', { name: '复制系统入口' })
    await expect.element(copyBtn).toBeVisible()
    await copyBtn.click()

    expect(execCommandSpy).toHaveBeenCalledWith('copy')
  })

  it('点击复制按钮在安全上下文（navigator.clipboard 正常可用）下直接复制', async () => {
    const writeTextSpy = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextSpy },
      configurable: true,
      writable: true,
    })

    await render(
      <TargetOverviewPanel
        item={sampleItem}
        onDelete={vi.fn()}
      />
    )

    const copyBtn = page.getByRole('button', { name: '复制系统入口' })
    await expect.element(copyBtn).toBeVisible()
    await copyBtn.click()

    expect(writeTextSpy).toHaveBeenCalledWith('http://192.168.1.100:8080/oa')
  })
})
