import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import type { OutcomeContract } from '@cairn/shared'
import { OutcomeListEditor } from './outcome-editor'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const requestContract = (): OutcomeContract => ({
  id: id(1),
  scope: 'step',
  meaning: '这一步之后应出现请求：POST /api/order 返回 2xx',
  severity: 'MUST',
  onViolation: 'halt',
  provenance: 'manual',
  rule: { kind: 'page_request', match: '/api/order', method: 'POST', status: '2xx' },
})
const plainContract = (): OutcomeContract => ({
  id: id(2),
  scope: 'step',
  meaning: '按钮可见',
  severity: 'MUST',
  onViolation: 'halt',
  provenance: 'manual',
  rule: { kind: 'deterministic', expect: { kind: 'visible' } },
})

describe('页面请求条件（高级，默认折叠）', () => {
  it('默认折叠、标明一般不用配；有条件时标题显示数量但仍折叠，不混进普通成功条件', async () => {
    const empty = await render(<OutcomeListEditor outcomes={[]} scope='step' onChange={() => undefined} />)
    const text = empty.container.textContent ?? ''
    expect(text).toMatch(/页面请求检查/)
    expect(text).toMatch(/一般不用配/)
    expect(text).not.toMatch(/请求方式|请求地址/)
    const withOne = await render(<OutcomeListEditor outcomes={[plainContract(), requestContract()]} scope='step' onChange={() => undefined} />)
    const t2 = withOne.container.textContent ?? ''
    expect(t2).toMatch(/1 条/)
    expect(t2).not.toMatch(/请求方式|请求地址/)
    expect(t2).toMatch(/按钮可见|成功条件/)
  })

  it('场景级成功条件里不出现这个区块', async () => {
    const screen = await render(<OutcomeListEditor outcomes={[]} scope='scenario' onChange={() => undefined} />)
    expect(screen.container.textContent).not.toMatch(/页面请求检查/)
  })

  it('展开后添加：生成严重级别「必须」且停止的页面请求条件，并与其他条件合并回传', async () => {
    const onChange = vi.fn()
    const screen = await render(<OutcomeListEditor outcomes={[plainContract()]} scope='step' onChange={onChange} />)
    await screen.getByRole('button', { name: '页面请求检查' }).click()
    await screen.getByRole('button', { name: '添加请求条件' }).click()
    const next = onChange.mock.calls[0]![0] as OutcomeContract[]
    expect(next).toHaveLength(2)
    expect(next[0]!.id).toBe(id(2))
    expect(next[1]).toMatchObject({ scope: 'step', severity: 'MUST', onViolation: 'halt', rule: { kind: 'page_request', status: '2xx' } })
    expect(next[1]!.meaning).toContain('这一步之后应出现请求')
  })

  it('改成「只记警告」写回 SHOULD + continue，并保留其他条件', async () => {
    const onChange = vi.fn()
    const screen = await render(<OutcomeListEditor outcomes={[requestContract(), plainContract()]} scope='step' onChange={onChange} />)
    await screen.getByRole('button', { name: '页面请求检查' }).click()
    await screen.getByRole('combobox', { name: '没出现或没成功时' }).click()
    await screen.getByRole('option', { name: '只记警告，继续往下跑' }).click()
    const next = onChange.mock.calls[0]![0] as OutcomeContract[]
    expect(next.map((item) => item.id).sort()).toEqual([id(1), id(2)])
    expect(next.find((item) => item.id === id(1))).toMatchObject({ severity: 'SHOULD', onViolation: 'continue' })
  })
})
