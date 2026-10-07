import { DEFAULT_TABLE_TIMEZONE, type TablePredicate, type TableSample } from '@cairn/shared'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { DATE_MODE_OPTIONS, dateModeOf, predicateFromDateMode, type DateMode } from './table-checks-model'

const TIMEZONES: Array<{ value: string; label: string }> = [
  { value: DEFAULT_TABLE_TIMEZONE, label: '北京时间（Asia/Shanghai）' },
  { value: 'UTC', label: '世界标准时间（UTC）' },
  { value: 'Asia/Tokyo', label: '东京（Asia/Tokyo）' },
  { value: 'America/New_York', label: '纽约（America/New_York）' },
]

/** 预览里某日期列出现过的日期（规整成 YYYY-MM-DD，去重）。 */
function dateCandidates(sample: TableSample | null, column: string): string[] {
  if (!sample) return []
  const seen = new Set<string>()
  for (const row of sample.rows) {
    const f = row[column]
    if (!f || f.status !== 'ok' || typeof f.value !== 'string') continue
    const day = /^\d{4}-\d{2}-\d{2}/.exec(f.value)?.[0]
    if (day) seen.add(day)
  }
  return Array.from(seen).sort().reverse().slice(0, 6)
}

/**
 * 日期列的条件：一个“怎么比”的下拉 + 按需出现的值（天数 / 日期选择框）。
 * 返回一个片段：第一个子元素是下拉，值区域在网格里独占一行。
 */
export function DatePredicateFields({
  predicate,
  column,
  side,
  sample,
  disabled,
  onChange,
}: {
  predicate: TablePredicate
  column: string
  side: 'where' | 'expect'
  sample: TableSample | null
  disabled?: boolean
  onChange: (next: TablePredicate) => void
}) {
  const mode = dateModeOf(predicate)
  const options = DATE_MODE_OPTIONS.filter((o) => side === 'expect' || (o.mode !== 'is_empty' && o.mode !== 'is_not_empty'))
  const fixedValue = 'value' in predicate && typeof predicate.value === 'string' ? predicate.value : ''
  const fixedMode = mode.startsWith('date_')
  const relative = predicate.op === 'date_within_days' ? predicate : null
  const chips = fixedMode ? dateCandidates(sample, column) : []

  return (
    <>
      <Select value={mode} disabled={disabled} onValueChange={(v) => onChange(predicateFromDateMode(v as DateMode, predicate))}>
        <SelectTrigger className='h-8 w-full min-w-0' aria-label='条件'>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.mode} value={o.mode}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {mode === 'days_n' && relative ? (
        <div className='flex items-center gap-1.5' style={{ gridColumn: '1 / -1' }}>
          <span className='text-caption text-muted-foreground'>不早于</span>
          <Input
            key={relative.days}
            aria-label='往前几天'
            className='h-8 w-20'
            inputMode='numeric'
            disabled={disabled}
            defaultValue={String(relative.days)}
            onBlur={(e) => {
              const n = Number(e.target.value.trim())
              if (e.target.value.trim() !== '' && Number.isInteger(n) && n >= 0 && n <= 3650) onChange({ ...relative, days: n })
              else e.target.value = String(relative.days)
            }}
          />
          <span className='text-caption text-muted-foreground'>天前</span>
        </div>
      ) : null}
      {fixedMode ? (
        <div className='space-y-1' style={{ gridColumn: '1 / -1' }}>
          <Input
            key={fixedValue}
            type='date'
            aria-label='日期'
            className='h-8 w-full'
            disabled={disabled}
            defaultValue={fixedValue}
            onChange={(e) => {
              if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) onChange({ op: mode as 'date_on', value: e.target.value })
            }}
          />
          {chips.length > 0 ? (
            <div className='flex flex-wrap gap-1' aria-label='预览里出现过的日期'>
              {chips.map((c) => (
                <button
                  key={c}
                  type='button'
                  disabled={disabled}
                  className={`rounded-full border px-2 text-caption ${fixedValue === c ? 'border-primary bg-primary/10 text-primary' : 'border-border-divider bg-background text-foreground'}`}
                  onClick={() => onChange({ op: mode as 'date_on', value: c })}
                >
                  {c}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {relative ? (
        <Collapsible style={{ gridColumn: '1 / -1' }}>
          <CollapsibleTrigger asChild>
            <button type='button' className='text-caption text-muted-foreground hover:text-foreground'>▸ 一般不用动</button>
          </CollapsibleTrigger>
          <CollapsibleContent className='space-y-1.5 pt-1.5'>
            <p className='text-caption text-muted-foreground'>“今天”按运行时刻、在这个时区下取日期</p>
            <Select value={relative.timezone} disabled={disabled} onValueChange={(v) => onChange({ ...relative, timezone: v })}>
              <SelectTrigger className='h-8 w-full' aria-label='时区'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIMEZONES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Label className='flex items-center gap-1.5 text-caption font-normal'>
              <Checkbox checked={relative.allowFuture} disabled={disabled} onCheckedChange={(v) => onChange({ ...relative, allowFuture: v === true })} />
              允许日期晚于今天
            </Label>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </>
  )
}
