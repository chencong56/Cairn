import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import type { TableSample } from '@cairn/shared'
import { TableSampleOutput } from './table-sample-view'

const sample: TableSample = {
  protocol: 'table.sample@1',
  source: { runId: '00000000-0000-4000-8000-000000000001', sampledAt: '2026-10-07T00:00:00.000Z', planDigest: 'x' },
  columns: [
    { key: 'region', name: '区域', label: '地区', valueType: 'text' },
    { key: 'phone', name: '电话', valueType: 'text', sensitive: true },
    { key: 'income', name: '收入', valueType: 'number', numericKind: 'decimal' },
  ],
  rows: [
    { region: { value: '辽宁', status: 'ok' }, phone: { value: null, status: 'masked' }, income: { value: 24145.16, rawText: '24,145.16万元', status: 'ok' } },
    { region: { value: '贵州', status: 'ok' }, phone: { value: null, status: 'masked' }, income: { value: null, status: 'missing' } },
  ],
  rowCount: 2,
  coverage: { requestedScope: 'current_page', observedScope: 'current_page', status: 'complete', clues: ['pagination_present'] },
  excluded: { mergedRows: 1, paginationRows: 1, footerRows: 1 },
  summaryRows: [{ region: { value: '合计', status: 'ok' }, phone: { value: null, status: 'masked' }, income: { value: 1, rawText: '46,596.65', status: 'ok' } }],
  presentation: { omitted: false, previewCount: 2 },
}

describe('TableSampleOutput', () => {
  it('按表格展示：显示名、原文、缺失、敏感打码、合计行与范围说明', async () => {
    const screen = await render(<TableSampleOutput output={{ value: sample }} />)
    await expect.element(screen.getByText('读取到的表格数据（2 行）')).toBeVisible()
    await expect.element(screen.getByText('本页读到 2 行；这张表还有分页，检查只针对本页')).toBeVisible()
    await expect.element(screen.getByText('地区', { exact: true })).toBeVisible()
    await expect.element(screen.getByText('24,145.16万元')).toBeVisible()
    await expect.element(screen.getByText('—').first()).toBeVisible()
    expect(screen.getByText('••••').elements().length).toBeGreaterThanOrEqual(2)
    await expect.element(screen.getByText('46,596.65')).toBeVisible()
    await expect.element(screen.getByText('未计入数据行', { exact: false })).toBeVisible()
  })

  it('不是表格读取结果时什么都不渲染', async () => {
    const screen = await render(<TableSampleOutput output={{ value: '普通文本' }} />)
    expect(screen.getByTestId('table-sample-output').elements()).toHaveLength(0)
  })
})
