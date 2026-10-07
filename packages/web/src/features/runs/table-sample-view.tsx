import { useState } from 'react'
import type { TableSample } from '@cairn/shared'
import { columnLabel, coverageSummary, tableSampleOf } from '@/features/authoring/fields/table-plan-edit'

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
