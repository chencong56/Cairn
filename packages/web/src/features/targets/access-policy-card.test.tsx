import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@/styles/index.css'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { useAuthStore } from '@/stores/auth-store'
import { AccessPolicyCard } from './access-policy-card'

const TARGET_ID = '11111111-1111-4111-8111-111111111111'

const mocks = vi.hoisted(() => ({
  fetchTargetAccessPolicy: vi.fn(),
  updateTargetAccessPolicy: vi.fn(),
}))

vi.mock('@/lib/targets-api', () => mocks)

function signIn(permissions = ['target:read', 'target:write', 'map:read']) {
  useAuthStore.getState().auth.setUser({
    id: 'u1',
    displayName: '测试',
    email: null,
    roles: [],
    permissions,
  })
}

async function renderCard() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <AccessPolicyCard targetId={TARGET_ID} />
    </QueryClientProvider>
  )
}

describe('地图采集只读规则卡片', () => {
  beforeEach(async () => {
    await page.viewport(1440, 900)
    vi.clearAllMocks()
    signIn()
    mocks.fetchTargetAccessPolicy.mockResolvedValue({
      targetId: TARGET_ID,
      revision: 0,
      policy: {
        schemaVersion: 1,
        policyVersion: 1,
        rules: [],
        readOnlyRequests: [],
      },
      seeded: true,
      resourceLoadsUnrestricted: true,
      updatedAt: '1970-01-01T00:00:00.000Z',
    })
  })

  it('只展示地图采集只读规则，不再有授权边界与规则表单', async () => {
    await renderCard()
    await expect.element(page.getByText('地图采集只读规则')).toBeVisible()
    expect(page.getByText(/已配置授权边界/).elements()).toHaveLength(0)
    expect(page.getByLabelText('Origin').elements()).toHaveLength(0)
    expect(page.getByRole('button', { name: '保存授权' }).elements()).toHaveLength(0)
  })

  it('添加只读 POST 规则时不再提交 rules', async () => {
    const screen = await renderCard()
    await screen.getByLabelText('来源站点', { exact: true }).fill('https://shop.example')
    await screen.getByLabelText('精确路径', { exact: true }).fill('/api/list')
    await screen.getByRole('button', { name: '添加只读规则' }).click()
    const body = mocks.updateTargetAccessPolicy.mock.calls[0]?.[1]
    expect(body).toEqual(expect.objectContaining({
      expectedRevision: 0,
      readOnlyRequests: [{ method: 'POST', origin: 'https://shop.example', pathPattern: '/api/list' }],
    }))
    expect(body).not.toHaveProperty('rules')
  })

  it('提交核实依据与精确 XHR 请求规则，不把它加入放行列表', async () => {
    const screen = await renderCard()
    await screen.getByLabelText('请求来源站点').fill('https://metrics.example/other')
    await screen.getByLabelText('请求精确路径').fill('/collect?x=1')
    await screen.getByLabelText('核实依据').fill('已核对前端调用，仅上报访问统计，不参与页面内容')
    await expect.element(screen.getByRole('button', { name: '添加核实规则' })).toBeDisabled()
    await screen.getByLabelText('请求来源站点').fill('https://metrics.example')
    await screen.getByLabelText('请求精确路径').fill('/collect')
    await screen.getByRole('button', { name: '添加核实规则' }).click()
    expect(mocks.updateTargetAccessPolicy).toHaveBeenCalledWith(TARGET_ID, expect.objectContaining({
      readOnlyRequests: [],
      verifiedNonContentRequests: [{ method: 'POST', resourceType: 'xhr', origin: 'https://metrics.example',
        pathPattern: '/collect', evidence: '已核对前端调用，仅上报访问统计，不参与页面内容' }],
    }))
  })

  it('显式启用平衡模式并说明推断不等于已证明只读', async () => {
    const screen = await renderCard()
    await expect.element(screen.getByText(/推断不等于已证明只读/)).toBeVisible()
    await page.viewport(390, 844)
    await expect.element(screen.getByRole('button', { name: '启用平衡模式' })).toBeVisible()
    await screen.getByRole('button', { name: '启用平衡模式' }).click()
    expect(mocks.updateTargetAccessPolicy).toHaveBeenCalledWith(TARGET_ID,
      expect.objectContaining({ postReadMode: 'balanced' }))
  })
})
