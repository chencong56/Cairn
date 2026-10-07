import { Trash2 } from 'lucide-react'
import type { OutcomeContract, Step, TableExpectRule } from '@cairn/shared'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  COMPARE_LABEL,
  ROW_PREDICATE_OPS,
  STAT_LABEL,
  everyPrefix,
  anyPrefix,
  countNoun,
  templatesFor,
  type CheckKind,
  buildTableCheck,
  defaultRule,
  sentenceOf,
  withRule,
  withSeverity,
  type CheckColumn,
  type CheckTemplate,
  type CompareOp,
  type TableCheckContract,
} from './table-checks-model'

type ExtractTableStep = Extract<Step, { type: 'extract' }>

const PREDICATE_LABEL: Record<(typeof ROW_PREDICATE_OPS)[number], string> = {
  ...COMPARE_LABEL,
  contains: '包含',
  is_empty: '为空',
  is_not_empty: '不为空',
}

export function checkKindOf(step: ExtractTableStep): CheckKind {
  return step.input.as === 'table' && 'kind' in step.input.table && step.input.table.kind ? step.input.table.kind : 'table'
}

export function checkColumnsOf(step: ExtractTableStep): CheckColumn[] {
  if (step.input.as !== 'table') return []
  return step.input.table.columns.map((c) => ({
    key: c.key,
    label: ('label' in c && c.label ? c.label : c.name) as string,
    numeric: c.valueType === 'number',
  }))
}

function ColumnSelect({
  value,
  columns,
  disabled,
  onChange,
}: {
  value: string
  columns: readonly CheckColumn[]
  disabled?: boolean
  onChange: (key: string) => void
}) {
  return (
    <Select value={value} disabled={disabled} onValueChange={onChange}>
      <SelectTrigger className='h-8 w-auto min-w-24'>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {columns.map((c) => (
          <SelectItem key={c.key} value={c.key}>
            {c.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function CompareSelect({
  value,
  disabled,
  onChange,
}: {
  value: CompareOp
  disabled?: boolean
  onChange: (op: CompareOp) => void
}) {
  return (
    <Select value={value} disabled={disabled} onValueChange={(v) => onChange(v as CompareOp)}>
      <SelectTrigger className='h-8 w-auto min-w-24'>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {(Object.keys(COMPARE_LABEL) as CompareOp[]).map((op) => (
          <SelectItem key={op} value={op}>
            {COMPARE_LABEL[op]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function NumberInput({
  value,
  disabled,
  label,
  onChange,
}: {
  value: number
  disabled?: boolean
  label: string
  onChange: (n: number) => void
}) {
  return (
    <Input
      aria-label={label}
      className='h-8 w-28'
      inputMode='decimal'
      defaultValue={String(value)}
      disabled={disabled}
      onBlur={(e) => {
        const n = Number(e.target.value.trim())
        if (e.target.value.trim() !== '' && Number.isFinite(n)) onChange(n)
        else e.target.value = String(value)
      }}
    />
  )
}

function RuleFields({
  rule,
  columns,
  kind,
  disabled,
  onChange,
}: {
  rule: TableExpectRule
  columns: readonly CheckColumn[]
  kind: CheckKind
  disabled?: boolean
  onChange: (next: TableExpectRule) => void
}) {
  const numberColumns = columns.filter((c) => c.numeric)
  switch (rule.rule) {
    case 'row_count':
      return (
        <>
          <span>{countNoun(kind).subject}</span>
          <CompareSelect value={rule.op as CompareOp} disabled={disabled} onChange={(op) => onChange({ ...rule, op })} />
          <NumberInput label='行数' value={rule.value} disabled={disabled} onChange={(value) => onChange({ ...rule, value: Math.max(0, Math.floor(value)) })} />
          <span>{countNoun(kind).unit}</span>
        </>
      )
    case 'all_rows':
    case 'any_row': {
      const p = rule.predicate
      const needsValue = p.op !== 'is_empty' && p.op !== 'is_not_empty'
      const numeric = columns.find((c) => c.key === rule.column)?.numeric === true
      const setOp = (op: (typeof ROW_PREDICATE_OPS)[number]) => {
        if (op === 'is_empty' || op === 'is_not_empty') return onChange({ ...rule, predicate: { op } })
        if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
          return onChange({ ...rule, predicate: { op, value: typeof (p as { value?: unknown }).value === 'number' ? ((p as { value: number }).value) : 0 } })
        }
        if (op === 'contains') return onChange({ ...rule, predicate: { op, value: typeof (p as { value?: unknown }).value === 'string' ? ((p as { value: string }).value || ' ') : ' ' } })
        const prev = (p as { value?: unknown }).value
        return onChange({ ...rule, predicate: { op, value: typeof prev === 'string' || typeof prev === 'number' ? prev : '' } })
      }
      return (
        <>
          <span>{rule.rule === 'all_rows' ? everyPrefix(kind) : anyPrefix(kind)}</span>
          <ColumnSelect value={rule.column} columns={columns} disabled={disabled} onChange={(column) => onChange({ ...rule, column })} />
          <Select value={p.op} disabled={disabled} onValueChange={(v) => setOp(v as (typeof ROW_PREDICATE_OPS)[number])}>
            <SelectTrigger className='h-8 w-auto min-w-24'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROW_PREDICATE_OPS.map((op) => (
                <SelectItem key={op} value={op}>
                  {PREDICATE_LABEL[op]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {needsValue ? (
            <Input
              aria-label='比较的值'
              className='h-8 w-36'
              defaultValue={String((p as { value: unknown }).value ?? '')}
              disabled={disabled}
              onBlur={(e) => {
                const text = e.target.value
                if (p.op === 'gt' || p.op === 'gte' || p.op === 'lt' || p.op === 'lte') {
                  const n = Number(text.trim())
                  if (text.trim() !== '' && Number.isFinite(n)) onChange({ ...rule, predicate: { op: p.op, value: n } })
                  else e.target.value = String((p as { value: unknown }).value)
                  return
                }
                if (p.op === 'contains') {
                  if (text !== '') onChange({ ...rule, predicate: { op: 'contains', value: text } })
                  return
                }
                const n = Number(text.trim())
                const value = numeric && text.trim() !== '' && Number.isFinite(n) ? n : text
                onChange({ ...rule, predicate: { op: p.op as 'eq' | 'neq', value } })
              }}
            />
          ) : null}
        </>
      )
    }
    case 'column_stat':
      return (
        <>
          <ColumnSelect value={rule.column} columns={numberColumns} disabled={disabled} onChange={(column) => onChange({ ...rule, column })} />
          <span>的</span>
          <Select value={rule.stat} disabled={disabled} onValueChange={(v) => onChange({ ...rule, stat: v as typeof rule.stat })}>
            <SelectTrigger className='h-8 w-auto min-w-20'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(STAT_LABEL) as (keyof typeof STAT_LABEL)[]).map((s) => (
                <SelectItem key={s} value={s}>
                  {STAT_LABEL[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <CompareSelect value={rule.op} disabled={disabled} onChange={(op) => onChange({ ...rule, op })} />
          <NumberInput label='数值' value={rule.value} disabled={disabled} onChange={(value) => onChange({ ...rule, value })} />
          <Label className='flex items-center gap-1.5 text-caption font-normal'>
            <Checkbox checked={rule.ignoreEmpty} disabled={disabled} onCheckedChange={(v) => onChange({ ...rule, ignoreEmpty: v === true })} />
            忽略空值
          </Label>
        </>
      )
    case 'total_row_match':
      return (
        <>
          <ColumnSelect value={rule.column} columns={numberColumns} disabled={disabled} onChange={(column) => onChange({ ...rule, column })} />
          <span>各行相加，等于合计行里的值</span>
          <Label className='flex items-center gap-1.5 text-caption font-normal'>
            <Checkbox checked={rule.precision === 'exact'} disabled={disabled} onCheckedChange={(v) => onChange({ ...rule, precision: v === true ? 'exact' : 'display' })} />
            精确比较（默认按合计行显示的小数位）
          </Label>
        </>
      )
    case 'column_unique':
      return (
        <>
          <ColumnSelect value={rule.column} columns={columns} disabled={disabled} onChange={(column) => onChange({ ...rule, column })} />
          <span>没有重复值</span>
        </>
      )
    case 'row_expression':
      return <span className='text-muted-foreground'>自定义条件（高级），请到高级编辑中修改</span>
  }
}

/** 表格数据检查：句子模板，写成步骤级业务结果条件（不通过记业务异常，不算执行失败）。 */
export function TableChecksEditor({
  step,
  checks,
  disabled,
  onChange,
}: {
  step: ExtractTableStep
  checks: TableCheckContract[]
  disabled?: boolean
  onChange: (next: OutcomeContract[]) => void
}) {
  const columns = checkColumnsOf(step)
  const kind = checkKindOf(step)
  const labelOf = (key: string) => columns.find((c) => c.key === key)?.label ?? key
  const outputKey = step.outputKey
  const replace = (next: TableCheckContract) => onChange(checks.map((c) => (c.id === next.id ? next : c)))

  const add = (template: CheckTemplate) => {
    if (!outputKey) return
    const rule = defaultRule(template, columns)
    if (!rule) return
    onChange([...checks, buildTableCheck(outputKey, rule, labelOf, 'MUST', undefined, kind)])
  }

  return (
    <div className='space-y-3' data-testid='table-checks'>
      <div className='flex items-center justify-between gap-2'>
        <div className='flex items-center gap-1.5'>
          <h3 className='text-small font-semibold'>数据检查</h3>
          <span className='rounded bg-muted px-1.5 py-0.5 text-caption font-medium text-muted-foreground'>选填</span>
        </div>
        <Select value='' disabled={disabled || !outputKey} onValueChange={(v) => add(v as CheckTemplate)}>
          <SelectTrigger className='h-8 w-auto min-w-28' aria-label='添加数据检查'>
            <SelectValue placeholder='添加检查' />
          </SelectTrigger>
          <SelectContent>
            {templatesFor(kind).map((t) => (
              <SelectItem key={t.value} value={t.value}>
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <p className='text-caption text-muted-foreground'>
        对读取到的数据做检查。不满足时记为“业务结果异常”，不是执行失败；读不全或读不出时显示“无法确认”。
      </p>
      {!outputKey ? (
        <p className='rounded-md border border-dashed border-border-divider bg-muted/20 p-3 text-caption text-muted-foreground'>
          先在上面填写“输出名称”，数据检查才知道检查哪一步读到的表格。
        </p>
      ) : null}
      {checks.length === 0 && outputKey ? (
        <p className='rounded-md border border-dashed border-border-divider bg-muted/20 p-3 text-caption text-muted-foreground'>
          还没有数据检查。例如“金额的合计大于 0”“各行相加等于合计行”，不加也不影响读取。
        </p>
      ) : null}
      <ul className='space-y-2'>
        {checks.map((check) => {
          const rule = check.rule.expect.rule
          return (
            <li key={check.id} className='space-y-1.5 rounded-md border border-border-divider p-3' data-testid='table-check'>
              <div className='flex flex-wrap items-center gap-2 text-small'>
                <RuleFields
                  rule={rule}
                  columns={columns}
                  kind={kind}
                  disabled={disabled}
                  onChange={(next) => replace(withRule(check, next, labelOf, kind))}
                />
                <div className='ml-auto flex items-center gap-2'>
                  <Label className='flex items-center gap-1.5 text-caption font-normal'>
                    <Checkbox
                      checked={check.severity === 'SHOULD'}
                      disabled={disabled}
                      onCheckedChange={(v) => replace(withSeverity(check, v === true ? 'SHOULD' : 'MUST', labelOf, kind))}
                    />
                    只提醒
                  </Label>
                  <Button
                    type='button'
                    size='icon'
                    variant='ghost'
                    aria-label='删除这条检查'
                    disabled={disabled}
                    onClick={() => onChange(checks.filter((c) => c.id !== check.id))}
                  >
                    <Trash2 className='size-4' />
                  </Button>
                </div>
              </div>
              <p className='text-caption text-muted-foreground'>检查内容：{sentenceOf(rule, labelOf, kind)}</p>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
