import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { createRuntimeInvariant, type RuntimeInvariant } from '@cairn/shared'
import { RuntimeInvariantEditor } from './invariant-editor'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

describe('RuntimeInvariantEditor 页面健康约束', () => {
  it('展示接口与脚本两种约束的配置，且不出现求值时机', async () => {
    const invariants: RuntimeInvariant[] = [
      createRuntimeInvariant('network_health', id(1)),
      createRuntimeInvariant('script_errors', id(2)),
    ]
    const screen = await render(<RuntimeInvariantEditor invariants={invariants} onChange={() => undefined} />)
    const text = screen.container.textContent ?? ''
    expect(text).toMatch(/页面接口不得报错/)
    expect(text).toMatch(/页面脚本不得出现未捕获异常/)
    expect(text).toMatch(/4xx 客户端错误/)
    expect(text).toMatch(/也检查外部地址/)
    expect(text).toMatch(/同时检查控制台 error 日志/)
    expect(text).not.toMatch(/求值时机/)
  })

  it('改状态类别写回约束配置，且至少保留一类', async () => {
    const onChange = vi.fn()
    const screen = await render(
      <RuntimeInvariantEditor invariants={[createRuntimeInvariant('network_health', id(1))]} onChange={onChange} />,
    )
    await screen.getByLabelText('4xx 客户端错误（404、401 等）').click()
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0]![0][0].network.statusClasses).toEqual(['5xx'])
  })
})
