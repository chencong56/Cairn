import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import type { DurationNodeRow } from '@cairn/shared'
import { NodeTable } from './components/node-table'

function row(overrides: Partial<DurationNodeRow>): DurationNodeRow {
  return {
    nodeKey: 'step:a',
    parentKey: null,
    kind: 'step',
    name: '打开查询页',
    ordinal: 0,
    hasChildren: false,
    samples: 12,
    baseSamples: 12,
    activeP50: 4_000,
    modelP50: null,
    pageP50: null,
    activeP95: 4_500,
    baseP50: 4_000,
    deltaPct: 0,
    retryRate: 0,
    avgIterations: 1,
    assistedRate: 0,
    sparkline: [4_000],
    tags: [],
    insights: [],
    ...overrides,
  }
}

function wrap(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

describe('耗时节点表', () => {
  it('只有带子节点的行可展开；展开时才读子节点，读失败可重试', async () => {
    const fetchChildren = vi
      .fn<(parentKey: string) => Promise<DurationNodeRow[]>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([row({ nodeKey: 'module:login/step:user', parentKey: 'module:login', kind: 'module_step', name: '输入账号' })])
    const screen = await wrap(
      <NodeTable
        nodes={[row({}), row({ nodeKey: 'module:login', kind: 'module', name: '登录模块', ordinal: 1, hasChildren: true })]}
        onOpen={vi.fn()}
        fetchChildren={fetchChildren}
        childrenQueryKey={['test-children']}
      />,
    )
    await expect.element(screen.getByText('页面 P50')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '展开子节点' }).elements()).toHaveLength(1)
    expect(fetchChildren).not.toHaveBeenCalled()

    await screen.getByRole('button', { name: '展开子节点' }).click()
    await expect.element(screen.getByText('子节点读取失败')).toBeInTheDocument()
    await screen.getByRole('button', { name: '重试' }).click()
    await expect.element(screen.getByText('输入账号')).toBeInTheDocument()
    expect(fetchChildren).toHaveBeenCalledWith('module:login')

    await screen.getByRole('button', { name: '收起子节点' }).click()
    await expect.element(screen.getByText('输入账号')).not.toBeInTheDocument()
  })
})
