import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { encodeTableRecordSet, type TableSample } from '@cairn/shared'
import { TableSampleOutput } from './table-sample-view'
import { recordSetToCsv } from './table-recordset-csv'

const fetchEvidenceContent = vi.hoisted(() => vi.fn())
vi.mock('@/lib/runs-api', () => ({ fetchEvidenceContent }))

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

  it('外置记录集：说明全量行数与检查口径，可下载全量 CSV', async () => {
    const full = Array.from({ length: 3 }, (_, i) => ({
      region: { value: `区域${i}`, status: 'ok' as const },
      phone: { value: null, status: 'masked' as const },
      income: { value: i, rawText: String(i), status: 'ok' as const },
    }))
    const text = encodeTableRecordSet({ columns: ['region', 'phone', 'income'], rows: full })
    fetchEvidenceContent.mockResolvedValue({ blob: new Blob([text]), contentType: 'application/x-ndjson' })
    const saved: string[] = []
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      void (blob as Blob).text().then((t) => saved.push(t))
      return 'blob:x'
    })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const external: TableSample = {
      ...sample,
      rows: full.slice(0, 1),
      rowCount: 3,
      summaryRows: undefined,
      coverage: { ...sample.coverage, clues: undefined },
      presentation: { omitted: true, previewCount: 1 },
      storage: { protocol: 'table.recordset@1', objectKey: 'v1/x', digest: 'sha256:x', rowCount: 3, byteSize: text.length, evidenceId: '00000000-0000-4000-8000-0000000000ee' },
    }
    const screen = await render(<TableSampleOutput output={{ value: external }} />)
    await expect.element(screen.getByText('共 3 行，此处显示前 1 行；数据检查按全量计算')).toBeVisible()
    await screen.getByRole('button', { name: '下载全量数据（CSV）' }).click()
    await vi.waitFor(() => expect(saved).toHaveLength(1))
    expect(fetchEvidenceContent).toHaveBeenCalledWith(external.source.runId, external.storage!.evidenceId)
    expect(saved[0]).toContain('地区,电话,收入')
    expect(saved[0]).toContain('区域2,••••,2')
    createUrl.mockRestore()
  })

  it('CSV：逗号、引号、换行按 RFC 4180 转义', () => {
    const text = encodeTableRecordSet({ columns: ['region'], rows: [{ region: { value: '甲,"乙"\n丙', status: 'ok' } }] })
    const csv = recordSetToCsv([{ key: 'region', name: '区域', valueType: 'text' }], text)
    expect(csv).toContain('"甲,""乙""\n丙"')
  })

  it('分页信息：只列出读到的项', async () => {
    const paged: TableSample = { ...sample, pageInfo: { totalRows: 45, currentPage: 1, totalPages: 3, pageSize: 20, rawText: '共 45 条' } }
    const screen = await render(<TableSampleOutput output={{ value: paged }} />)
    await expect.element(screen.getByText('分页显示：共 45 条 · 第 1 / 3 页 · 每页 20 条')).toBeVisible()
    await expect.element(screen.getByText('本页读到 2 行（分页显示共 45 条）', { exact: false })).toBeVisible()
  })

  it('文件来源：显示文件名与工作表', async () => {
    const fromFile: TableSample = { ...sample, source: { ...sample.source, kind: 'file', file: { name: '站点清单.xlsx', format: 'xlsx', sheet: '站点明细' } } }
    const screen = await render(<TableSampleOutput output={{ value: fromFile }} />)
    await expect.element(screen.getByTestId('table-sample-source')).toHaveTextContent('来源：文件「站点清单.xlsx」· 工作表「站点明细」')
  })
})
