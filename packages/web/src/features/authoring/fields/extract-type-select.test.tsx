import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { tableReadPlanSchema, TABLE_READ_PROTOCOL_V2, type Step } from '@cairn/shared'
import { ExtractTypeSelect } from './extract-type-select'

type ExtractStep = Extract<Step, { type: 'extract' }>
const base = { id: '00000000-0000-4000-8000-0000000000e3', name: '提取', type: 'extract', effectType: 'READ_ONLY', outputKey: 'rows' } as const
const TOTAL = { framePath: [], candidates: [{ by: 'css' as const, value: '#total' }] }
const textStep = { ...base, input: { target: TOTAL, as: 'text' } } as unknown as ExtractStep
const configured = tableReadPlanSchema.parse({
  protocol: TABLE_READ_PROTOCOL_V2,
  target: { framePath: [], candidates: [{ by: 'css', value: '#grid' }] },
  columns: [{ key: 'a', name: '名称', valueType: 'text' }],
})
const tableStep = { ...base, input: { target: configured.target, as: 'table', table: configured } } as unknown as ExtractStep

describe('ExtractTypeSelect', () => {
  it('分组列出：取一个值 / 取一组数据，每项带说明；收起时显示名称与说明', async () => {
    const screen = await render(<ExtractTypeSelect step={textStep} onChange={vi.fn()} onRequestAiExtract={vi.fn()} />)
    await expect.element(screen.getByRole('combobox', { name: '提取类型' })).toHaveTextContent('文本· 例：订单号、页面提示语')
    await screen.getByRole('combobox', { name: '提取类型' }).click()
    await expect.element(screen.getByText('取一个值')).toBeVisible()
    await expect.element(screen.getByText('取一组数据（可做数据检查）')).toBeVisible()
    await expect.element(screen.getByText('导出的 CSV、Excel')).toBeVisible()
    await expect.element(screen.getByText('页面看不出结构？改用 AI 提取步骤 →')).toBeVisible()
  })

  it('没有配好的读取计划：直接切换，保留页面目标', async () => {
    const onChange = vi.fn()
    const screen = await render(<ExtractTypeSelect step={textStep} onChange={onChange} />)
    await screen.getByRole('combobox', { name: '提取类型' }).click()
    await screen.getByRole('option', { name: '输入框的值' }).click()
    expect(onChange).toHaveBeenCalledTimes(1)
    expect((onChange.mock.calls[0]![0] as ExtractStep).input).toMatchObject({ as: 'value', target: TOTAL })
  })

  it('已配好表格读取：先确认；“保留”不改，“切换”才改', async () => {
    const onChange = vi.fn()
    const screen = await render(<ExtractTypeSelect step={tableStep} onChange={onChange} />)
    await screen.getByRole('combobox', { name: '提取类型' }).click()
    await screen.getByRole('option', { name: '下载文件里的数据' }).click()
    await expect.element(screen.getByRole('alertdialog', { name: '切换提取类型' })).toHaveTextContent('保存结果为「rows」保留不变')
    await screen.getByRole('button', { name: '保留现在的设置' }).click()
    expect(onChange).not.toHaveBeenCalled()
    await screen.getByRole('combobox', { name: '提取类型' }).click()
    await screen.getByRole('option', { name: '下载文件里的数据' }).click()
    await screen.getByRole('button', { name: '切换' }).click()
    expect((onChange.mock.calls[0]![0] as ExtractStep).input).toMatchObject({ as: 'table', source: 'file' })
  })

  it('改用 AI 提取：走换类型回调；没有回调时不显示入口', async () => {
    const onAi = vi.fn()
    const screen = await render(<ExtractTypeSelect step={textStep} onChange={vi.fn()} onRequestAiExtract={onAi} />)
    await screen.getByRole('combobox', { name: '提取类型' }).click()
    await screen.getByRole('option', { name: '改用 AI 提取步骤' }).click()
    expect(onAi).toHaveBeenCalledTimes(1)
    screen.unmount()
    const plain = await render(<ExtractTypeSelect step={textStep} onChange={vi.fn()} />)
    await plain.getByRole('combobox', { name: '提取类型' }).click()
    expect(plain.getByText('页面看不出结构？改用 AI 提取步骤 →').elements()).toHaveLength(0)
  })
})
