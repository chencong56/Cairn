import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { useState } from 'react'
import {
  TABLE_NETWORK_PROTOCOL,
  tableNetworkPlanSchema,
  type NetworkInspectObservation,
  type NetworkListObservation,
  type NetworkReadObservation,
  type Step,
  type TableSample,
} from '@cairn/shared'
import { NetworkTableFields } from './table-network-fields'
import { createPlaceholderNetworkPlan } from './table-plan-edit'
import { requestNetworkPicker } from './network-picker-request'

const observeNetwork = vi.hoisted(() => vi.fn())
vi.mock('@/lib/network-observe-api', () => ({ observeNetwork }))
const observe = vi.hoisted(() => ({ value: { networkOwner: { kind: 'session', sessionId: '00000000-0000-4000-8000-0000000000c1' } as unknown, viewedPageId: () => undefined } }))
vi.mock('../observe', () => ({ useAuthoringObserve: () => observe.value }))

type ExtractStep = Extract<Step, { type: 'extract' }>
const STEP_ID = '00000000-0000-4000-8000-0000000000e9'
const stepWith = (table = createPlaceholderNetworkPlan()): ExtractStep =>
  ({ id: STEP_ID, name: '读接口', type: 'extract', effectType: 'READ_ONLY', outputKey: 'apiRows', input: { as: 'table', source: 'network', table } }) as ExtractStep

const ENTRY = { id: '00000000-0000-4000-8000-00000000f001', at: '2026-10-09T06:02:11.000Z', method: 'POST', url: 'http://lab/grids/api/sites', status: 200, byteSize: 32_000, json: true, best: true, rowHint: 45 }
const OTHER = { id: '00000000-0000-4000-8000-00000000f002', at: '2026-10-09T06:02:10.000Z', method: 'GET', url: 'http://lab/api/user/info', status: 200, byteSize: 800, json: true }
const list: NetworkListObservation = { outcome: 'FOUND', page: {}, capturingSince: '2026-10-09T06:02:00.000Z', entries: [ENTRY, OTHER] }
const inspect: NetworkInspectObservation = {
  outcome: 'FOUND',
  entry: ENTRY,
  truncated: false,
  nodes: [
    { path: '', key: '', depth: 0, type: 'object' },
    { path: 'data', key: 'data', depth: 1, type: 'object' },
    { path: 'data.total', key: 'total', depth: 2, type: 'number', preview: '45', numeric: true },
    { path: 'data.list', key: 'list', depth: 2, type: 'array', length: 45, rows: true },
    { path: 'data.list.0', key: '0', depth: 3, type: 'object' },
    { path: 'data.list.0.id', key: 'id', depth: 4, type: 'number', preview: '1000', numeric: true },
    { path: 'data.list.0.name', key: 'name', depth: 4, type: 'string', preview: '站点0001' },
    { path: 'data.list.0.qty', key: 'qty', depth: 4, type: 'number', preview: '1', numeric: true },
  ],
  suggestions: [
    {
      layout: 'rows',
      rowsPath: 'data.list',
      totalPath: 'data.total',
      rowCount: 45,
      score: 99,
      columns: [
        { key: 'id', name: 'id', path: 'id', valueType: 'number', numericKind: 'integer' },
        { key: 'name', name: 'name', path: 'name', valueType: 'text' },
        { key: 'qty', name: 'qty', path: 'qty', valueType: 'number', numericKind: 'integer' },
      ],
    },
  ],
}
const sample = (n: number): TableSample => ({
  protocol: 'table.sample@1',
  source: { kind: 'network', request: { method: 'POST', url: 'http://lab/grids/api/sites', status: 200, at: ENTRY.at, byteSize: 32_000, digest: 'sha256:x' }, runId: '00000000-0000-4000-8000-0000000000a1', sampledAt: ENTRY.at, planDigest: 'x' },
  columns: [{ key: 'id', name: 'id', valueType: 'number', numericKind: 'integer', path: 'id' }],
  rows: Array.from({ length: n }, (_, i) => ({ id: { value: 1000 + i, status: 'ok' } })),
  rowCount: n,
  coverage: { requestedScope: 'current_page', observedScope: 'current_page', status: 'complete' },
  pageInfo: { totalRows: n, rawText: `接口 data.total = ${n}` },
  presentation: { omitted: false, previewCount: Math.min(n, 20) },
})

function respond(read: NetworkReadObservation = { outcome: 'FOUND', entry: ENTRY, sample: sample(45) }) {
  observeNetwork.mockImplementation(async (_owner: unknown, op: { subOp: string }) => (op.subOp === 'inspect' ? inspect : op.subOp === 'read' ? read : list))
}

function Harness({ initial, onChange }: { initial: ExtractStep; onChange?: (s: Step) => void }) {
  const [step, setStep] = useState(initial)
  return (
    <NetworkTableFields
      step={step}
      onChange={(next) => {
        onChange?.(next)
        setStep(next as ExtractStep)
      }}
    />
  )
}

describe('NetworkTableFields', () => {
  beforeEach(() => {
    observeNetwork.mockReset()
    observe.value.networkOwner = { kind: 'session', sessionId: '00000000-0000-4000-8000-0000000000c1' }
  })

  it('没有受管画面：说清楚先连接会话，不能选接口', async () => {
    observe.value.networkOwner = undefined
    const screen = await render(<Harness initial={stepWith()} />)
    await expect.element(screen.getByTestId('table-network-no-page')).toBeVisible()
    await expect.element(screen.getByRole('button', { name: '选择接口' })).toBeDisabled()
    expect(observeNetwork).not.toHaveBeenCalled()
  })

  it('选择接口：自动选上星标的响应、按建议起草数据行与字段，确定后写回计划', async () => {
    respond()
    const onChange = vi.fn()
    const screen = await render(<Harness initial={stepWith()} onChange={onChange} />)
    await screen.getByRole('button', { name: '选择接口' }).click()
    await expect.element(screen.getByRole('option', { name: /\/grids\/api\/sites/ })).toHaveAttribute('aria-selected', 'true')
    await expect.element(screen.getByTestId('network-draft-summary')).toHaveTextContent('数据行：data.list · 已选 3 个字段 · 总条数：data.total')
    await expect.element(screen.getByTestId('network-preview')).toHaveTextContent('共 45 行 · 接口给的总条数 45')
    // 取消一个字段后确定
    await screen.getByRole('checkbox', { name: '取字段「name」' }).click()
    await expect.element(screen.getByTestId('network-draft-summary')).toHaveTextContent('已选 2 个字段')
    await screen.getByRole('button', { name: '确定' }).click()
    const last = onChange.mock.calls[onChange.mock.calls.length - 1]![0] as ExtractStep
    expect((last.input as { table: unknown }).table).toMatchObject({
      protocol: TABLE_NETWORK_PROTOCOL,
      match: { url: '/grids/api/sites', method: 'POST' },
      layout: 'rows',
      rowsPath: 'data.list',
      totalPath: 'data.total',
      columns: [{ path: 'id' }, { path: 'qty' }],
    })
    await expect.element(screen.getByTestId('table-network-summary')).toHaveTextContent('POST 地址包含 /grids/api/sites')
  })

  it('已配置：按计划预览；读不到时说明原因并给“重新加载并预览”', async () => {
    respond({ outcome: 'NOT_FOUND', reason: { code: 'TABLE_SOURCE_NOT_FOUND', message: '当前页面加载以来没有匹配「POST /grids/api/sites」的接口响应' } })
    const plan = tableNetworkPlanSchema.parse({ protocol: TABLE_NETWORK_PROTOCOL, match: { url: '/grids/api/sites', method: 'POST' }, rowsPath: 'data.list', columns: [{ key: 'id', name: 'id', path: 'id', valueType: 'number', numericKind: 'integer' }] })
    const screen = await render(<Harness initial={stepWith(plan)} />)
    await expect.element(screen.getByRole('alert')).toHaveTextContent('当前页面加载以来没有匹配')
    respond()
    await screen.getByRole('button', { name: '重新加载并预览' }).click()
    await expect.element(screen.getByTestId('table-network-preview-summary')).toHaveTextContent('共 45 行 · 接口给的总条数 45')
    expect(observeNetwork.mock.calls.some(([, op]) => (op as { subOp: string }).subOp === 'reload')).toBe(true)
  })

  it('从图表引导卡切过来：一打开面板就弹出“选择接口”', async () => {
    respond()
    requestNetworkPicker(STEP_ID)
    const screen = await render(<Harness initial={stepWith()} />)
    await expect.element(screen.getByTestId('network-picker')).toBeVisible()
  })
})
