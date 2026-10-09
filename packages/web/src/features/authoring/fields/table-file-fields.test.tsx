import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render } from 'vitest-browser-react'
import { useState } from 'react'
import { tableFilePlanSchema, TABLE_FILE_PROTOCOL, type Step, type TableFilePreviewResponse } from '@cairn/shared'
import { ApiRequestError } from '@/lib/api-client'
import { ResolutionSourceProvider } from '../resolution-source'
import { FileTableFields } from './table-file-fields'
import { createPlaceholderFilePlan } from './table-plan-edit'

const previewTableFile = vi.hoisted(() => vi.fn())
vi.mock('@/lib/table-file-api', () => ({ previewTableFile, fileToBase64: async () => 'QQ==' }))

const SCENARIO = '00000000-0000-4000-8000-0000000000a1'
const DOWNLOAD: Step = {
  id: '00000000-0000-4000-8000-0000000000d1',
  name: '导出报表',
  type: 'download',
  effectType: 'READ_ONLY',
  outputKey: 'exportFile',
  input: { target: { framePath: [], candidates: [{ by: 'css', value: '#export' }] } },
} as Step
const extract = (table = createPlaceholderFilePlan('downloadFile')): Extract<Step, { type: 'extract' }> =>
  ({ id: '00000000-0000-4000-8000-0000000000e2', name: '读取导出文件', type: 'extract', effectType: 'READ_ONLY', outputKey: 'rows', input: { as: 'table', source: 'file', table } }) as Extract<Step, { type: 'extract' }>

const plan = tableFilePlanSchema.parse({
  protocol: TABLE_FILE_PROTOCOL,
  fromKey: 'exportFile',
  columns: [
    { key: 'col_2', name: '站点名称', valueType: 'text' },
    { key: 'col_4', name: '数量', valueType: 'number', numericKind: 'integer' },
  ],
})
const response: TableFilePreviewResponse = {
  source: { kind: 'latest_run', runId: '00000000-0000-4000-8000-0000000000f1', at: '2026-10-09T06:02:00.000Z' },
  file: { name: '站点清单.xlsx', byteSize: 7150, format: 'xlsx', sheet: '站点明细' },
  sheets: [{ name: '站点明细', rows: 1203 }, { name: '汇总', rows: 4 }],
  headerRow: 4,
  headerRows: 1,
  dataRows: 1203,
  columns: [
    { key: 'col_1', name: '序号', valueType: 'number', numericKind: 'integer', source: 'header', index: 0, excludedReason: 'index' },
    { key: 'col_2', name: '站点名称', valueType: 'text', source: 'header', index: 1 },
    { key: 'col_4', name: '数量', valueType: 'number', numericKind: 'integer', source: 'header', index: 3 },
  ],
  plan,
  sample: {
    protocol: 'table.sample@1',
    source: { kind: 'file', runId: '00000000-0000-4000-8000-0000000000f1', sampledAt: '2026-10-09T06:02:00.000Z', planDigest: 'x' },
    columns: plan.columns,
    rows: [{ col_2: { value: '站点0001', status: 'ok' }, col_4: { value: 1, status: 'ok' } }],
    rowCount: 1203,
    coverage: { requestedScope: 'current_page', observedScope: 'current_page', status: 'complete' },
    presentation: { omitted: true, previewCount: 1 },
  },
}

/** 受控外壳：onChange 写回步骤，便于观察自动选择下载步骤、用识别结果建计划等连锁行为。 */
function Harness({ steps, initial, onChange }: { steps: Step[]; initial: Extract<Step, { type: 'extract' }>; onChange?: (s: Step) => void }) {
  const [step, setStep] = useState(initial)
  return (
    <ResolutionSourceProvider scenarioId={SCENARIO} steps={[...steps, step]}>
      <FileTableFields
        step={step}
        onChange={(next) => {
          onChange?.(next)
          setStep(next as Extract<Step, { type: 'extract' }>)
        }}
      />
    </ResolutionSourceProvider>
  )
}

describe('FileTableFields', () => {
  beforeEach(() => previewTableFile.mockReset())

  it('前面没有下载步骤：说清楚先加下载步骤，不发预览请求', async () => {
    const screen = await render(<Harness steps={[]} initial={extract()} />)
    await expect.element(screen.getByTestId('table-file-no-download')).toBeVisible()
    expect(previewTableFile).not.toHaveBeenCalled()
  })

  it('只有一个下载步骤：自动选上，用最近一次运行的文件预览，并按识别结果建好列', async () => {
    previewTableFile.mockResolvedValue(response)
    const onChange = vi.fn()
    const screen = await render(<Harness steps={[DOWNLOAD]} initial={extract()} onChange={onChange} />)
    await expect.element(screen.getByText('预览用的文件：最近一次运行', { exact: false })).toBeVisible()
    await expect.element(screen.getByTestId('table-file-detected')).toHaveTextContent('识别：Excel（.xlsx） · 明细 1203 行')
    await expect.element(screen.getByText('预览只带回前 1 行；保存后数据检查按全部 1203 行计算。')).toBeVisible()
    await expect.element(screen.getByText('已排除：序号')).toBeVisible()
    const body = previewTableFile.mock.calls[0]![1]
    expect(body).toMatchObject({ fromKey: 'exportFile', downloadStepId: DOWNLOAD.id, source: { kind: 'latest_run' } })
    await new Promise((r) => setTimeout(r, 1000))
    expect(previewTableFile).toHaveBeenCalledTimes(1)
    const last = onChange.mock.calls[onChange.mock.calls.length - 1]![0] as Extract<Step, { type: 'extract' }>
    expect((last.input as { table: { columns: unknown[] } }).table.columns).toHaveLength(2)
  })

  it('最近的运行里没有文件：给出补救办法（运行到前置 / 上传样例）', async () => {
    const noRunFile = new ApiRequestError(404, { code: 'TABLE_FILE_NO_RUN_FILE', message: '最近的运行里没有', requestId: 'r' } as never)
    previewTableFile.mockRejectedValueOnce(noRunFile)
    const step = extract(plan)
    const screen = await render(
      <ResolutionSourceProvider scenarioId={SCENARIO} steps={[DOWNLOAD, step]}>
        <FileTableFields step={step} onChange={vi.fn()} />
      </ResolutionSourceProvider>,
    )
    await expect.element(screen.getByRole('alert')).toHaveTextContent('上传一个样例文件')
    await expect.element(screen.getByRole('button', { name: '上传样例文件' })).toBeVisible()
    await new Promise((r) => setTimeout(r, 1000))
    expect(previewTableFile).toHaveBeenCalledTimes(1)
  })
})
