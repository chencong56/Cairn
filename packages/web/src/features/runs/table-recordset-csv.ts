import { decodeTableRecordSet, type TableColumnSpec, type TableRowField } from '@cairn/shared'
import { columnLabel } from '@/features/authoring/fields/table-plan-edit'

function csvCell(text: string): string {
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function fieldText(field: TableRowField | undefined): string {
  if (!field) return ''
  if (field.status === 'masked') return '••••'
  if (field.status === 'missing') return ''
  return String(field.rawText ?? field.value ?? '')
}

/** 外置记录集（JSON 行）→ CSV：表头用列的显示名，敏感列保持打码；带 BOM 方便 Excel 识别中文。 */
export function recordSetToCsv(columns: readonly TableColumnSpec[], recordSetText: string): string {
  const decoded = decodeTableRecordSet(recordSetText)
  const lines = [columns.map((c) => csvCell(columnLabel(c))).join(',')]
  for (const row of [...decoded.rows, ...decoded.summaryRows]) {
    lines.push(columns.map((c) => csvCell(fieldText(row[c.key]))).join(','))
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`
}

export function saveTextFile(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
