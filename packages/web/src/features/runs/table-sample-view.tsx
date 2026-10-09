import { useState } from 'react'
import { toast } from 'sonner'
import type { TableSample } from '@cairn/shared'
import { columnLabel, coverageSummary, pageInfoSummary, tableSampleOf } from '@/features/authoring/fields/table-plan-edit'
import { fetchEvidenceContent } from '@/lib/runs-api'
import { recordSetToCsv, saveTextFile } from './table-recordset-csv'

const PAGE = 20

function cell(sample: TableSample, rowIndex: number, key: string): string {
  const field = sample.rows[rowIndex]?.[key]
  if (!field) return ''
  if (field.status === 'masked') return '••••'
  if (field.status === 'missing') return '—'
  if (field.status === 'error') return `${field.rawText ?? ''}（读不出）`
  return String(field.rawText ?? field.value ?? '')
}

/** 表格读取结果：列名、行、页脚（合计）行，顶部一行范围说明与覆盖度。 */
export function TableSampleOutput({ output }: { output: unknown }) {
  const sample = tableSampleOf(output)
  const [shown, setShown] = useState(PAGE)
  if (!sample) return null
  const summary = coverageSummary(sample)
  const rows = Math.min(shown, sample.rows.length)
  return (
    <div className='mt-2 space-y-1.5 rounded border border-border/50 bg-background/80 p-2' data-testid='table-sample-output'>
      <p className='text-label font-medium text-muted-foreground'>读取到的表格数据（{sample.rowCount} 行）</p>
      {summary ? (
        <p className={summary.tone === 'ok' ? 'text-label text-emerald-700' : summary.tone === 'warn' ? 'text-label text-amber-700' : 'text-label text-destructive'}>
          {summary.text}
        </p>
      ) : null}
      {sample.source.kind === 'file' && sample.source.file ? (
        <p className='text-label text-muted-foreground' data-testid='table-sample-source'>
          来源：文件「{sample.source.file.name}」{sample.source.file.sheet ? `· 工作表「${sample.source.file.sheet}」` : ''}
        </p>
      ) : null}
      {pageInfoSummary(sample) ? <p className='text-label text-muted-foreground'>{pageInfoSummary(sample)}</p> : null}
      {sample.storage ? <FullRecordSetNote sample={sample} /> : null}
      <div className='overflow-x-auto'>
        <table className='w-full text-label'>
          <thead className='bg-muted/50'>
            <tr>
              {sample.columns.map((c) => (
                <th key={c.key} className='border-b px-2 py-1 text-left font-medium'>{columnLabel(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }).map((_, i) => (
              <tr key={i} className='border-t'>
                {sample.columns.map((c) => (
                  <td key={c.key} className='px-2 py-1'>{cell(sample, i, c.key)}</td>
                ))}
              </tr>
            ))}
          </tbody>
          {sample.summaryRows?.length ? (
            <tfoot className='border-t bg-muted/30'>
              {sample.summaryRows.map((row, i) => (
                <tr key={i}>
                  {sample.columns.map((c) => {
                    const field = row[c.key]
                    return (
                      <td key={c.key} className='px-2 py-1 font-medium'>
                        {field ? (field.status === 'masked' ? '••••' : String(field.rawText ?? field.value ?? '')) : ''}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tfoot>
          ) : null}
        </table>
      </div>
      {sample.rows.length > rows ? (
        <button type='button' className='text-label text-link' onClick={() => setShown((n) => n + PAGE)}>
          再显示 {Math.min(PAGE, sample.rows.length - rows)} 行（还剩 {sample.rows.length - rows} 行）
        </button>
      ) : null}
      {sample.excluded && (sample.excluded.mergedRows || sample.excluded.paginationRows || sample.excluded.footerRows) ? (
        <p className='text-label text-muted-foreground'>
          未计入数据行：{sample.excluded.mergedRows ? `分组或说明行 ${sample.excluded.mergedRows} 行 ` : ''}
          {sample.excluded.paginationRows ? `分页栏 ${sample.excluded.paginationRows} 行 ` : ''}
          {sample.excluded.footerRows ? `页脚 ${sample.excluded.footerRows} 行` : ''}
        </p>
      ) : null}
    </div>
  )
}

/** 外置记录集：上下文里只有预览，说明全量规模与检查口径，并提供全量下载（CSV）。 */
function FullRecordSetNote({ sample }: { sample: TableSample }) {
  const storage = sample.storage!
  const [busy, setBusy] = useState(false)
  const download = async () => {
    if (!storage.evidenceId) return
    setBusy(true)
    try {
      const { blob } = await fetchEvidenceContent(sample.source.runId, storage.evidenceId)
      const csv = recordSetToCsv(sample.columns, await blob.text())
      saveTextFile(`表格数据-${storage.rowCount}行.csv`, csv, 'text/csv;charset=utf-8')
    } catch (error) {
      toast.error(`下载失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <p className='flex flex-wrap items-center gap-x-2 text-label text-muted-foreground' data-testid='table-sample-fullset'>
      <span>
        共 {storage.rowCount} 行，此处显示前 {sample.rows.length} 行；数据检查按全量计算
      </span>
      {storage.evidenceId ? (
        <button type='button' className='text-link disabled:opacity-60' disabled={busy} onClick={() => void download()}>
          {busy ? '正在准备…' : '下载全量数据（CSV）'}
        </button>
      ) : null}
    </p>
  )
}
