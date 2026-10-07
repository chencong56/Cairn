import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { evaluateTableExpectation, type TableCondition, type TableExpectRule, type TablePredicate, type TableSample } from '@cairn/shared'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { DatePredicateFields } from './date-predicate-fields'
import {
  columnTypeOf,
  defaultPredicate,
  emptyCondition,
  lookupIncomplete,
  normalizePredicate,
  predicateOptionsFor,
  type CheckColumn,
  type CheckKind,
} from './table-checks-model'

type LookupRule = Extract<TableExpectRule, { rule: 'row_lookup' }>
type Side = 'where' | 'expect'

const MAX_CONDITIONS = 3
const CHIPS_PER_PAGE = 6

/** 预览里某列出现过的值（去重、非空），给“点一下就填入”的候选。 */
function candidatesOf(sample: TableSample | null, column: string): string[] {
  if (!sample) return []
  const seen = new Set<string>()
  for (const row of sample.rows) {
    const f = row[column]
    if (!f || f.status !== 'ok' || f.value === null || f.value === undefined) continue
    const text = String(f.rawText ?? f.value).trim()
    if (text) seen.add(text)
  }
  return Array.from(seen).slice(0, 60)
}

function ConditionBlock({
  cond,
  side,
  columns,
  sample,
  disabled,
  canRemove,
  onChange,
  onRemove,
}: {
  cond: TableCondition
  side: Side
  columns: readonly CheckColumn[]
  sample: TableSample | null
  disabled?: boolean
  canRemove: boolean
  onChange: (next: TableCondition) => void
  onRemove: () => void
}) {
  const col = columns.find((c) => c.key === cond.column)
  const type = columnTypeOf(col)
  const options = predicateOptionsFor(type, side)
  const pred = cond.predicate
  const [pendingOp, setPendingOp] = useState<TablePredicate['op'] | null>(null)
  const [page, setPage] = useState(0)
  const shownOp = pendingOp ?? pred.op
  const needsValue = shownOp !== 'is_empty' && shownOp !== 'is_not_empty'
  const currentValue = 'value' in pred ? pred.value : undefined
  const candidates = type === 'boolean' ? [] : candidatesOf(sample, cond.column)
  const pages = Math.max(1, Math.ceil(candidates.length / CHIPS_PER_PAGE))
  const chips = candidates.slice((page % pages) * CHIPS_PER_PAGE, (page % pages) * CHIPS_PER_PAGE + CHIPS_PER_PAGE)

  const commit = (next: TablePredicate): void => {
    setPendingOp(null)
    onChange({ column: cond.column, predicate: normalizePredicate(next, col) })
  }
  const commitText = (op: TablePredicate['op'], text: string): void => {
    if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') return
    if ((op === 'contains' || op === 'starts_with' || op === 'ends_with') && text === '') {
      setPendingOp(op) // 包含 / 开头 不能是空内容：等用户填了再生效，不写出不合法的规则
      return
    }
    if (type === 'number' || (op !== 'eq' && op !== 'neq' && op !== 'contains' && op !== 'starts_with' && op !== 'ends_with')) return
    commit({ op, value: text } as TablePredicate)
  }
  const commitNumber = (op: TablePredicate['op'], raw: string): boolean => {
    const n = Number(raw.trim())
    if (raw.trim() === '' || !Number.isFinite(n)) return false
    commit({ op, value: n } as TablePredicate)
    return true
  }
  const changeOp = (op: TablePredicate['op']): void => {
    if (op === 'is_empty' || op === 'is_not_empty') return commit({ op })
    if (type === 'number') return commit({ op, value: typeof currentValue === 'number' ? currentValue : 0 } as TablePredicate)
    if (type === 'boolean') return commit({ op: op as 'eq' | 'neq', value: typeof currentValue === 'boolean' ? currentValue : true })
    const text = typeof currentValue === 'string' ? currentValue : ''
    if ((op === 'contains' || op === 'starts_with') && text === '') {
      setPendingOp(op)
      return
    }
    commit({ op, value: text } as TablePredicate)
  }
  const valueKey = `${cond.column}:${shownOp}:${String(currentValue)}`

  return (
    <div className='relative grid grid-cols-2 gap-1.5 rounded-md border border-border-divider/70 bg-muted/30 p-2' data-testid='lookup-condition'>
      <Select
        value={cond.column}
        disabled={disabled}
        onValueChange={(key) => {
          const next = columns.find((c) => c.key === key)
          setPendingOp(null)
          setPage(0)
          onChange({ column: key, predicate: normalizePredicate(defaultPredicate(next, side), next) })
        }}
      >
        <SelectTrigger className='h-8 w-full min-w-0' aria-label={side === 'where' ? '按哪一列找行' : '检查哪一列'}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {columns.map((c) => (
            <SelectItem key={c.key} value={c.key} disabled={c.sensitive}>
              {c.label}
              {c.sensitive ? '（敏感列，不能用于条件）' : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {type === 'date' ? (
        <DatePredicateFields predicate={pred} column={cond.column} side={side} sample={sample} disabled={disabled} onChange={commit} />
      ) : (
      <Select value={shownOp} disabled={disabled} onValueChange={(v) => changeOp(v as TablePredicate['op'])}>
        <SelectTrigger className='h-8 w-full min-w-0' aria-label='条件'>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.op} value={o.op}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      )}
      {needsValue && type !== 'date' ? (
        <div className='space-y-1' style={{ gridColumn: '1 / -1' }}>
          {type === 'boolean' ? (
            <Select value={currentValue === false ? 'false' : 'true'} disabled={disabled} onValueChange={(v) => commit({ op: shownOp as 'eq' | 'neq', value: v === 'true' })}>
              <SelectTrigger className='h-8 w-full' aria-label='值'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='true'>是</SelectItem>
                <SelectItem value='false'>否</SelectItem>
              </SelectContent>
            </Select>
          ) : (
            <Input
              key={valueKey}
              aria-label={side === 'where' ? '要找的内容' : '比较的值'}
              className='h-8 w-full'
              inputMode={type === 'number' ? 'decimal' : undefined}
              placeholder={side === 'where' ? '填要找的内容，或点下面的候选' : '填比较的值'}
              disabled={disabled}
              defaultValue={pendingOp ? '' : currentValue === undefined ? '' : String(currentValue)}
              onBlur={(e) => {
                if (type === 'number') {
                  if (!commitNumber(shownOp, e.target.value)) e.target.value = currentValue === undefined ? '' : String(currentValue)
                } else commitText(shownOp, e.target.value)
              }}
            />
          )}
          {chips.length > 0 ? (
            <div className='flex flex-wrap gap-1' aria-label='预览里出现过的值'>
              {chips.map((c) => (
                <button
                  key={c}
                  type='button'
                  disabled={disabled}
                  className={`max-w-full truncate rounded-full border px-2 text-caption ${currentValue === c ? 'border-primary bg-primary/10 text-primary' : 'border-border-divider bg-background text-foreground'}`}
                  onClick={() => (type === 'number' ? commitNumber(shownOp, c) : commitText(shownOp === 'eq' || shownOp === 'neq' ? shownOp : 'eq', c))}
                >
                  {c}
                </button>
              ))}
              {pages > 1 ? (
                <button type='button' className='rounded-full px-2 text-caption text-muted-foreground' onClick={() => setPage((p) => p + 1)}>
                  …换一批
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {canRemove ? (
        <button
          type='button'
          aria-label='删除这个条件'
          disabled={disabled}
          className='absolute right-1 top-1 rounded p-0.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors'
          onClick={onRemove}
        >
          <X className='size-3.5' />
        </button>
      ) : null}
    </div>
  )
}

function StepTitle({ n, children }: { n: number; children: string }) {
  return (
    <div className='mb-1 mt-3 flex items-center gap-1.5 text-caption font-semibold'>
      <span className='inline-grid size-[18px] place-items-center rounded-full bg-primary text-2xs text-primary-foreground'>{n}</span>
      {children}
    </div>
  )
}

/** 「找到某一行，再检查它」：三步（找哪一行 / 找到后要满足 / 找不到时），窄栏下不折断。 */
export function RowLookupFields({
  rule,
  columns,
  kind,
  sample,
  disabled,
  onChange,
}: {
  rule: LookupRule
  columns: readonly CheckColumn[]
  kind: CheckKind
  sample: TableSample | null
  disabled?: boolean
  onChange: (next: LookupRule) => void
}) {
  const unit = kind === 'cards' ? '卡片' : '行'
  const setList = (side: Side, list: TableCondition[]) => onChange({ ...rule, [side]: list } as LookupRule)
  const addCondition = (side: Side) => {
    const used = new Set(rule[side].map((c) => c.column))
    const col = columns.find((c) => !c.sensitive && !used.has(c.key)) ?? columns.find((c) => !c.sensitive) ?? columns[0]
    setList(side, [...rule[side], emptyCondition(col, side)])
  }
  const incomplete = lookupIncomplete(rule)
  const preview = useMemo(() => {
    if (!sample || incomplete) return null
    try {
      return evaluateTableExpectation(sample, rule)
    } catch {
      return null
    }
  }, [sample, rule, incomplete])

  const block = (side: Side) =>
    rule[side].map((cond, i) => (
      <div key={`${side}-${i}`}>
        {i > 0 ? <div className='py-0.5 text-caption text-muted-foreground'>并且</div> : null}
        <ConditionBlock
          cond={cond}
          side={side}
          columns={columns}
          sample={sample}
          disabled={disabled}
          canRemove={rule[side].length > 1}
          onChange={(next) => setList(side, rule[side].map((c, k) => (k === i ? next : c)))}
          onRemove={() => setList(side, rule[side].filter((_, k) => k !== i))}
        />
      </div>
    ))

  return (
    <div className='w-full' data-testid='row-lookup'>
      <StepTitle n={1}>{`找哪一${kind === 'cards' ? '张' : '行'}`}</StepTitle>
      {block('where')}
      {rule.where.length < MAX_CONDITIONS ? (
        <Button type='button' variant='link' size='sm' className='h-6 px-0 text-caption' disabled={disabled} onClick={() => addCondition('where')}>
          ＋ 再加一个条件（并且）
        </Button>
      ) : null}

      <StepTitle n={2}>{`找到后，这一${kind === 'cards' ? '张' : '行'}要满足`}</StepTitle>
      {block('expect')}
      {rule.expect.length < MAX_CONDITIONS ? (
        <Button type='button' variant='link' size='sm' className='h-6 px-0 text-caption' disabled={disabled} onClick={() => addCondition('expect')}>
          ＋ 再加一个要求（并且）
        </Button>
      ) : null}

      <StepTitle n={3}>{`找不到这一${kind === 'cards' ? '张' : '行'}时`}</StepTitle>
      <Select value={rule.onMissing} disabled={disabled} onValueChange={(v) => onChange({ ...rule, onMissing: v as LookupRule['onMissing'] })}>
        <SelectTrigger className='h-8 w-full' aria-label='找不到时怎么办'>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value='fail'>记为不通过（推荐）</SelectItem>
          <SelectItem value='unknown'>记为无法确认</SelectItem>
          <SelectItem value='pass'>当作通过</SelectItem>
        </SelectContent>
      </Select>

      <Collapsible className='mt-2'>
        <CollapsibleTrigger asChild>
          <button type='button' className='text-caption text-muted-foreground hover:text-foreground'>▸ 一般不用动</button>
        </CollapsibleTrigger>
        <CollapsibleContent className='space-y-1 pt-1.5'>
          <p className='text-caption text-muted-foreground'>{`找到多${kind === 'cards' ? '张' : '行'}时`}</p>
          <Select value={rule.onMultiple} disabled={disabled} onValueChange={(v) => onChange({ ...rule, onMultiple: v as LookupRule['onMultiple'] })}>
            <SelectTrigger className='h-8 w-full' aria-label='找到多行时怎么办'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='all'>{`每一${kind === 'cards' ? '张' : '行'}都要满足`}</SelectItem>
              <SelectItem value='any'>{`只要有一${kind === 'cards' ? '张' : '行'}满足`}</SelectItem>
            </SelectContent>
          </Select>
        </CollapsibleContent>
      </Collapsible>

      {incomplete ? <p className='mt-2 text-caption text-status-warning-foreground'>{incomplete}</p> : null}
      {preview ? (
        <p className={`mt-2 text-caption ${preview.passed ? 'text-status-success-foreground' : 'text-status-warning-foreground'}`} data-testid='lookup-preview'>
          {preview.reasonCode === 'ROW_NOT_FOUND'
            ? `⚠ 当前预览里没有找到符合的${unit}（共 ${sample?.rows.length ?? 0} ${kind === 'cards' ? '张' : '行'}）。运行时以页面实时数据为准。${preview.details.lookup?.closest.length ? `最接近的：${preview.details.lookup.closest.join('、')}` : ''}`
            : preview.passed
              ? `按当前预览：这条检查会通过。${preview.details.lookup?.summary ?? ''}`
              : `按当前预览：${preview.factsUnavailable ? '无法确认' : '不会通过'}。${preview.reasonMessage ?? ''}`}
        </p>
      ) : null}
    </div>
  )
}
