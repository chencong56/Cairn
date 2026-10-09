import { Lock, LockOpen } from 'lucide-react'
import type { TableColumnSpec, TableDetectedColumn, TableSample } from '@cairn/shared'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { columnLabel, excludedReasonText, renameColumn, setColumnSensitive, toggleColumn } from './table-plan-edit'

const PREVIEW_ROWS = 5

function cellText(sample: TableSample | null, rowIndex: number, key: string): string {
  const field = sample?.rows[rowIndex]?.[key]
  if (!field) return ''
  if (field.status === 'masked') return '••••'
  if (field.status === 'missing') return '—'
  if (field.status === 'error') return `${field.rawText ?? ''}（读不出）`
  return String(field.rawText ?? field.value ?? '')
}

/**
 * 预览表 + 列勾选 / 显示名 / 敏感打码：页面来源与文件来源共用。
 * 识别过就列出全部列（含被自动排除的），否则只列计划里的列。
 */
export function TablePreviewGrid<P extends { columns: TableColumnSpec[] }>({
  plan,
  columns,
  sample,
  unit,
  disabled,
  onChange,
}: {
  plan: P
  /** 识别出的全部列；null 表示没有识别结果，只列计划里的列。 */
  columns: readonly TableDetectedColumn[] | null
  sample: TableSample | null
  /** 叫法：表格是“列”，卡片 / 详情是“项”。 */
  unit: '列' | '项'
  disabled?: boolean
  onChange: (plan: P) => void
}) {
  const sampleColumns = sample?.columns ?? plan.columns
  const columnRows = columns
    ? columns.map((c) => ({ key: c.key, name: c.name, info: c as TableDetectedColumn | null, checked: plan.columns.some((p) => p.key === c.key) }))
    : plan.columns.map((c) => ({ key: c.key, name: c.name, info: null as TableDetectedColumn | null, checked: true }))
  return (
    <>
      <div className='overflow-x-auto rounded-md border'>
        <table className='w-full text-xs'>
          <thead className='bg-muted/50'>
            <tr>
              {columnRows.map((c) => {
                const planColumn = plan.columns.find((p) => p.key === c.key)
                return (
                  <th key={c.key} className='min-w-28 border-b px-2 py-1.5 text-left align-top font-medium'>
                    <div className='flex items-center gap-1'>
                      <Checkbox
                        aria-label={`读取「${c.name}」${unit}`}
                        checked={c.checked}
                        disabled={disabled || (c.checked && plan.columns.length <= 1)}
                        onCheckedChange={(checked) => onChange(toggleColumn(plan, columns ?? [], c.key, checked === true))}
                      />
                      {planColumn ? (
                        <Input
                          key={`${c.key}:${c.name}:${columnLabel(planColumn)}`}
                          aria-label={`「${c.name}」${unit}的显示名`}
                          className='h-6 px-1 text-xs'
                          defaultValue={columnLabel(planColumn)}
                          disabled={disabled}
                          onBlur={(event) => onChange(renameColumn(plan, c.key, event.target.value))}
                        />
                      ) : (
                        <span className='text-muted-foreground'>{c.name}</span>
                      )}
                      {planColumn ? (
                        <button
                          type='button'
                          className='text-muted-foreground hover:text-foreground'
                          title={planColumn.sensitive ? '已标为敏感：输出与报告里会打码' : '标为敏感（打码）'}
                          aria-label={`${planColumn.sensitive ? '取消' : '标为'}「${c.name}」${unit}敏感`}
                          disabled={disabled}
                          onClick={() => onChange(setColumnSensitive(plan, c.key, !planColumn.sensitive))}
                        >
                          {planColumn.sensitive ? <Lock className='size-3.5 text-amber-600' /> : <LockOpen className='size-3.5' />}
                        </button>
                      ) : null}
                    </div>
                    {c.info?.excludedReason ? (
                      <span className='mt-0.5 block font-normal text-muted-foreground'>已排除：{excludedReasonText(c.info.excludedReason)}</span>
                    ) : null}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: Math.min(PREVIEW_ROWS, sample?.rows.length ?? 0) }).map((_, rowIndex) => (
              <tr key={rowIndex} className='border-t'>
                {columnRows.map((c) => (
                  <td key={c.key} className='px-2 py-1 text-muted-foreground'>
                    {c.checked && sampleColumns.some((s) => s.key === c.key) ? cellText(sample, rowIndex, c.key) : ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sample && sample.rowCount > PREVIEW_ROWS ? (
        <p className='text-xs text-muted-foreground'>只显示前 {PREVIEW_ROWS} 行，共 {sample.rowCount} 行。</p>
      ) : null}
    </>
  )
}
