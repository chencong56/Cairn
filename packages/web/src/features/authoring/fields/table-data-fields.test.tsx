import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { tableReadPlanSchema, TABLE_READ_PROTOCOL_V2, type Step } from '@cairn/shared'
import { TableDataFields } from './table-data-fields'
import { createPlaceholderTablePlan } from './table-plan-edit'

function stepWith(table: ReturnType<typeof createPlaceholderTablePlan> | ReturnType<typeof tableReadPlanSchema.parse>): Extract<Step, { type: 'extract' }> {
  return {
    id: '00000000-0000-4000-8000-0000000000e1',
    name: '提取表格',
    type: 'extract',
    effectType: 'READ_ONLY',
    outputKey: 'tbl',
    input: { target: table.target, as: 'table', table },
  } as Extract<Step, { type: 'extract' }>
}

describe('TableDataFields', () => {
  it('还没点选：用人话提示怎么做，不出现内部术语', async () => {
    const screen = await render(<TableDataFields step={stepWith(createPlaceholderTablePlan())} onChange={vi.fn()} />)
    await expect.element(screen.getByText('请在受管画面上点一下表格、卡片或详情信息里的任意位置', { exact: false })).toBeVisible()
    await expect.element(screen.getByRole('button', { name: '在页面上点选' })).toBeVisible()
    const text = document.body.innerText
    for (const jargon of ['root', 'profile', 'shape', 'protocol', 'table.read']) expect(text).not.toContain(jargon)
  })

  it('旧版计划：提示重新点选即可升级', async () => {
    const legacy = tableReadPlanSchema.parse({
      target: { framePath: [], candidates: [{ by: 'css', value: '#t' }] },
      columns: [{ key: 'a', name: '名称', valueType: 'text' }],
    })
    const screen = await render(<TableDataFields step={stepWith(legacy)} onChange={vi.fn()} />)
    await expect.element(screen.getByText('这一步用的是旧版读取计划', { exact: false })).toBeVisible()
  })

  it('已就绪：列出读取的列，可展开“一般不用动”', async () => {
    const ready = tableReadPlanSchema.parse({
      protocol: TABLE_READ_PROTOCOL_V2,
      target: { framePath: [], candidates: [{ by: 'css', value: '#report' }] },
      columns: [
        { key: 'col_2', name: '区域', valueType: 'text' },
        { key: 'col_3', name: '收入', valueType: 'number', numericKind: 'decimal' },
      ],
    })
    const onChange = vi.fn()
    const screen = await render(<TableDataFields step={stepWith(ready)} onChange={onChange} />)
    await expect.element(screen.getByText('已选表格 · 2 列')).toBeVisible()
    await expect.element(screen.getByRole('button', { name: '重新点选' })).toBeVisible()
    await screen.getByRole('button', { name: '一般不用动' }).click()
    await expect.element(screen.getByText('这张表空着就代表没有数据', { exact: false })).toBeVisible()
    // 取消一列：写回的输入里只剩一列，且表根与顶层 target 同步
    await screen.getByRole('checkbox', { name: '读取「收入」列' }).click()
    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0]![0] as Extract<Step, { type: 'extract' }>
    expect(next.input).toMatchObject({ as: 'table' })
    expect((next.input as { table: { columns: unknown[] } }).table.columns).toHaveLength(1)
    expect((next.input as { target: unknown }).target).toEqual((next.input as { table: { target: unknown } }).table.target)
  })

  it('卡片 / 键值：用“项”说话；换成另一张表后列显示名跟着换', async () => {
    const mk = (kind: 'table' | 'cards', names: string[]) =>
      tableReadPlanSchema.parse({
        protocol: TABLE_READ_PROTOCOL_V2,
        target: { framePath: [], candidates: [{ by: 'css', value: '#x' }] },
        ...(kind === 'cards' ? { kind } : {}),
        columns: names.map((name, i) => ({ key: `col_${i + 1}`, name, valueType: 'text' })),
      })
    const screen = await render(<TableDataFields step={stepWith(mk('table', ['区域', '收入']))} onChange={vi.fn()} />)
    await expect.element(screen.getByRole('textbox', { name: '「区域」列的显示名' })).toHaveValue('区域')
    await screen.rerender(<TableDataFields step={stepWith(mk('cards', ['标题', 'CPU']))} onChange={vi.fn()} />)
    await expect.element(screen.getByText('已选卡片 · 2 项')).toBeVisible()
    await expect.element(screen.getByRole('textbox', { name: '「标题」项的显示名' })).toHaveValue('标题')
    await expect.element(screen.getByRole('textbox', { name: '「CPU」项的显示名' })).toHaveValue('CPU')
  })

  it('树形表格：出现“读法 / 读取范围”；切回普通会记下选择，开关不消失', async () => {
    const tree = tableReadPlanSchema.parse({
      protocol: TABLE_READ_PROTOCOL_V2,
      target: { framePath: [], candidates: [{ by: 'css', value: '#tree' }] },
      layout: { mode: 'tree' },
      columns: [
        { key: 'name', name: '名称', valueType: 'text' },
        { key: 'qty', name: '数量', valueType: 'number', numericKind: 'integer' },
      ],
    })
    const onChange = vi.fn()
    const screen = await render(<TableDataFields step={stepWith(tree)} onChange={onChange} />)
    await expect.element(screen.getByRole('button', { name: '树形' })).toHaveAttribute('aria-pressed', 'true')
    await expect.element(screen.getByRole('combobox', { name: '读取范围' })).toHaveTextContent('全部已展开的行')
    await screen.getByRole('button', { name: '普通' }).click()
    const flat = onChange.mock.calls[0]![0] as Extract<Step, { type: 'extract' }>
    expect((flat.input as { table: { layout?: unknown } }).table.layout).toEqual({ mode: 'flat' })
    await screen.rerender(<TableDataFields step={flat} onChange={onChange} />)
    await expect.element(screen.getByRole('button', { name: '树形' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('combobox', { name: '读取范围' }).elements()).toHaveLength(0)
  })

  it('交叉表：读法出现“交叉表”与紧凑配置；改行维度列数 / 层名写回计划', async () => {
    const cross = tableReadPlanSchema.parse({
      protocol: TABLE_READ_PROTOCOL_V2,
      target: { framePath: [], candidates: [{ by: 'css', value: '#cross' }] },
      layout: { mode: 'crosstab', columnDims: ['指标', '月份'] },
      columns: [
        { key: 'col_1', name: '区域', valueType: 'text' },
        { key: 'col_2', name: '城市', valueType: 'text' },
      ],
    })
    const onChange = vi.fn()
    const screen = await render(<TableDataFields step={stepWith(cross)} onChange={onChange} />)
    await expect.element(screen.getByRole('button', { name: '交叉表' })).toHaveAttribute('aria-pressed', 'true')
    await expect.element(screen.getByRole('button', { name: '树形' })).toHaveAttribute('aria-pressed', 'false')
    await expect.element(screen.getByRole('spinbutton', { name: '行维度列数' })).toHaveValue(2)
    await expect.element(screen.getByRole('textbox', { name: '列头第 1 层的名字' })).toHaveValue('指标')
    await expect.element(screen.getByRole('textbox', { name: '列头第 2 层的名字' })).toHaveValue('月份')
    await expect.element(screen.getByRole('textbox', { name: '数值列的名字' })).toHaveValue('值')
    // 前几列是行维度：改成 1，写回的计划只剩第一列
    await screen.getByRole('spinbutton', { name: '行维度列数' }).fill('1')
    await screen.getByRole('textbox', { name: '列头第 1 层的名字' }).click()
    const next = onChange.mock.calls[0]![0] as Extract<Step, { type: 'extract' }>
    expect((next.input as { table: { columns: { key: string }[] } }).table.columns.map((c) => c.key)).toEqual(['col_1'])
    // 改层名 / 数值名：失焦写回 layout（fill 会先 blur 上一步点过的输入框，产生一次未变更的 commit，清掉再断言）
    onChange.mockClear()
    await screen.rerender(<TableDataFields step={next} onChange={onChange} />)
    await screen.getByRole('textbox', { name: '列头第 2 层的名字' }).fill('月份2')
    onChange.mockClear()
    await screen.getByRole('textbox', { name: '数值列的名字' }).click()
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled())
    const renamed = onChange.mock.calls[0]![0] as Extract<Step, { type: 'extract' }>
    expect((renamed.input as { table: { layout: { columnDims: string[] } } }).table.layout.columnDims).toEqual(['指标', '月份2'])
  })
})
