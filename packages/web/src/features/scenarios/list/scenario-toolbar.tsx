import type { ReactNode, RefObject } from 'react'
import type { ScenarioHealthFilter, ScenarioListSort, ScenarioSummaryDto, TargetDto } from '@cairn/shared'
import { ArrowUpDown, LayoutGrid, List, ListFilter, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DateRangePicker } from '@/components/date-range-picker'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import {
  HEALTH_FILTER_HINTS,
  HEALTH_FILTER_LABELS,
  SCHEDULE_FILTER_LABELS,
  dateFromKey,
  dateKey,
  recentDaysRange,
  type CreatedRange,
  type ScheduleFilter,
} from './filter-labels'
import { SegmentedControl } from './segmented-control'

export type ScenarioView = 'grid' | 'list'
export type StatusFilter = 'all' | 'active' | 'disabled'

const STATUS_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'active', label: '已启用' },
  { value: 'disabled', label: '已停用' },
] as const

const VIEW_OPTIONS = [
  { value: 'grid', label: '卡片视图', icon: <LayoutGrid aria-hidden='true' /> },
  { value: 'list', label: '列表视图', icon: <List aria-hidden='true' /> },
] as const

const SORT_LABELS: Record<ScenarioListSort, string> = {
  created: '最近创建',
  updated: '最近更新',
}

/** 「异常 N」：有异常时是警示药丸，为 0 时退成灰色，静默低噪。 */
function AlertPill({ count, pressed, onToggle }: { count: number | undefined; pressed: boolean; onToggle: () => void }) {
  const quiet = !count
  return (
    <button
      type='button'
      aria-pressed={pressed}
      onClick={onToggle}
      className={cn(
        'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-small font-medium outline-none transition-[box-shadow,border-color,scale] duration-150 ease-[var(--ease-standard)] active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none motion-reduce:active:scale-100',
        quiet
          ? 'border-border-default bg-card text-muted-foreground hover:border-border-control'
          : 'border-status-error-accent/30 bg-status-error-background text-status-error-foreground hover:border-status-error-foreground/50',
        pressed && !quiet && 'border-status-error-foreground shadow-[0_0_0_3px_var(--error-halo)]',
        pressed && quiet && 'border-border-control',
      )}
    >
      <span aria-hidden='true' className={cn('size-1.5 rounded-full', quiet ? 'bg-text-disabled' : 'bg-status-error')} />
      异常
      <span className='tabular-nums'>{count ?? '–'}</span>
    </button>
  )
}

export function ScenarioToolbar({
  status,
  onStatusChange,
  failingCount,
  onlyFailing,
  onToggleFailing,
  targets,
  targetId,
  onTargetChange,
  health,
  onHealthChange,
  hasDraft,
  onHasDraftChange,
  schedule,
  onScheduleChange,
  creators,
  currentUserId,
  createdBy,
  onCreatedByChange,
  createdRange,
  onCreatedRangeChange,
  sort,
  onSortChange,
  search,
  onSearchChange,
  searchRef,
  view,
  onViewChange,
}: {
  status: StatusFilter
  onStatusChange: (status: StatusFilter) => void
  failingCount: number | undefined
  onlyFailing: boolean
  onToggleFailing: () => void
  targets: TargetDto[] | undefined
  targetId: string | undefined
  onTargetChange: (targetId: string | undefined) => void
  health: readonly ScenarioHealthFilter[]
  onHealthChange: (health: ScenarioHealthFilter[]) => void
  hasDraft: boolean
  onHasDraftChange: (hasDraft: boolean) => void
  schedule: ScheduleFilter | undefined
  onScheduleChange: (schedule: ScheduleFilter | undefined) => void
  creators: ScenarioSummaryDto['creators']
  currentUserId: string | undefined
  createdBy: string | undefined
  onCreatedByChange: (createdBy: string | undefined) => void
  createdRange: CreatedRange
  onCreatedRangeChange: (range: CreatedRange) => void
  sort: ScenarioListSort
  onSortChange: (sort: ScenarioListSort) => void
  search: string
  onSearchChange: (search: string) => void
  searchRef: RefObject<HTMLInputElement | null>
  view: ScenarioView
  onViewChange: (view: ScenarioView) => void
}) {
  const advancedCount =
    health.length + (hasDraft ? 1 : 0) + (schedule ? 1 : 0) + (createdBy ? 1 : 0) + (createdRange.from || createdRange.to ? 1 : 0)
  const creatorOptions = creators ?? []
  // 选中的人不在当前可选项里（比如筛选后他名下已没有场景）时仍列出来，避免下拉框显示空白。
  const selectedMissing = createdBy && !creatorOptions.some((creator) => creator.id === createdBy)
  return (
    <div
      role='toolbar'
      aria-label='场景筛选'
      className='flex flex-wrap items-center justify-between gap-x-2 gap-y-3 border-b border-border-divider px-4 py-3'
    >
      <div className='flex min-w-0 flex-wrap items-center gap-2'>
        <SegmentedControl ariaLabel='启用状态' value={status} options={STATUS_OPTIONS} onChange={onStatusChange} />
        <AlertPill count={failingCount} pressed={onlyFailing} onToggle={onToggleFailing} />
        {targets && targets.length > 0 ? (
          <Select value={targetId ?? 'all'} onValueChange={(value) => onTargetChange(value === 'all' ? undefined : value)}>
            <SelectTrigger className='h-8 w-44' aria-label='目标系统筛选'>
              <SelectValue placeholder='全部目标系统' />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='all'>全部目标系统</SelectItem>
              {targets.map((target) => (
                <SelectItem key={target.id} value={target.id}>
                  {target.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <Popover>
          <PopoverTrigger asChild>
            <Button variant='outline' size='sm' aria-label={advancedCount ? `筛选，已选 ${advancedCount} 项` : '筛选'}>
              <ListFilter />
              筛选
              {advancedCount ? (
                <span className='inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1 text-2xs font-semibold text-primary-foreground tabular-nums'>
                  {advancedCount}
                </span>
              ) : null}
            </Button>
          </PopoverTrigger>
          {/* 条件多，矮屏（如 1366×768）上在浮层内部滚动，不超出视口。 */}
          <PopoverContent
            align='start'
            collisionPadding={12}
            className='max-h-[var(--radix-popover-content-available-height)] w-80 space-y-4 overflow-y-auto p-4'
          >
            <div>
              <p className='text-body font-semibold text-text-primary'>筛选</p>
              <p className='mt-0.5 text-label text-muted-foreground'>按最近一次正式运行与场景属性缩小范围。</p>
            </div>
            <fieldset className='space-y-2'>
              <legend className='mb-2 text-small font-medium text-text-secondary'>健康度</legend>
              {(Object.keys(HEALTH_FILTER_LABELS) as ScenarioHealthFilter[]).map((key) => (
                <div key={key} className='flex items-start gap-2'>
                  <Checkbox
                    id={`filter-health-${key}`}
                    className='mt-0.5'
                    checked={health.includes(key)}
                    onCheckedChange={(checked) =>
                      onHealthChange(checked === true ? [...health, key] : health.filter((item) => item !== key))
                    }
                  />
                  <Label htmlFor={`filter-health-${key}`} className='flex-col items-start gap-0 font-normal'>
                    <span>{HEALTH_FILTER_LABELS[key]}</span>
                    <span className='text-label text-muted-foreground'>{HEALTH_FILTER_HINTS[key]}</span>
                  </Label>
                </div>
              ))}
            </fieldset>
            <div className='space-y-2'>
              <p className='text-small font-medium text-text-secondary'>草稿</p>
              <div className='flex items-center gap-2'>
                <Checkbox
                  id='filter-has-draft'
                  checked={hasDraft}
                  onCheckedChange={(checked) => onHasDraftChange(checked === true)}
                />
                <Label htmlFor='filter-has-draft' className='font-normal'>
                  只看有未发布修改的场景
                </Label>
              </div>
            </div>
            <div className='space-y-2'>
              <Label htmlFor='filter-created-by' className='text-small text-text-secondary'>
                创建人
              </Label>
              <Select
                value={createdBy ?? 'any'}
                onValueChange={(value) => onCreatedByChange(value === 'any' ? undefined : value)}
              >
                <SelectTrigger id='filter-created-by' className='h-8 w-full'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='any'>不限</SelectItem>
                  {currentUserId ? <SelectItem value={currentUserId}>我创建的</SelectItem> : null}
                  {selectedMissing && createdBy !== currentUserId ? (
                    <SelectItem value={createdBy}>当前筛选的创建人</SelectItem>
                  ) : null}
                  {creatorOptions
                    .filter((creator) => creator.id !== currentUserId)
                    .map((creator) => (
                      <SelectItem key={creator.id} value={creator.id}>
                        {creator.displayName}
                        <span className='ml-1 text-muted-foreground tabular-nums'>{creator.count}</span>
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className='space-y-2'>
              <p className='text-small font-medium text-text-secondary'>创建时间</p>
              <DateRangePicker
                value={{ from: dateFromKey(createdRange.from), to: dateFromKey(createdRange.to) }}
                onChange={(range) => onCreatedRangeChange({ from: dateKey(range?.from), to: dateKey(range?.to ?? range?.from) })}
                placeholder='选择日期范围'
                className='w-full justify-start'
              />
              <div className='flex flex-wrap gap-1.5'>
                {([
                  [1, '今天'],
                  [7, '近 7 天'],
                  [30, '近 30 天'],
                ] as const).map(([days, label]) => (
                  <Button
                    key={days}
                    type='button'
                    variant='outline'
                    size='sm'
                    className='h-7 px-2 text-label'
                    onClick={() => onCreatedRangeChange(recentDaysRange(days))}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            </div>
            <div className='space-y-2'>
              <Label htmlFor='filter-schedule' className='text-small text-text-secondary'>
                定时调度（不含场景集）
              </Label>
              <Select
                value={schedule ?? 'any'}
                onValueChange={(value) => onScheduleChange(value === 'any' ? undefined : (value as ScheduleFilter))}
              >
                <SelectTrigger id='filter-schedule' className='h-8 w-full'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='any'>不限</SelectItem>
                  <SelectItem value='scheduled'>{SCHEDULE_FILTER_LABELS.scheduled}</SelectItem>
                  <SelectItem value='unscheduled'>{SCHEDULE_FILTER_LABELS.unscheduled}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </PopoverContent>
        </Popover>
      </div>
      <div className='flex min-w-0 flex-wrap items-center gap-2'>
        <Select value={sort} onValueChange={(value) => onSortChange(value as ScenarioListSort)}>
          <SelectTrigger className='h-8 w-auto gap-1.5' aria-label={`排序：${SORT_LABELS[sort]}`}>
            <ArrowUpDown aria-hidden='true' className='size-3.5 text-muted-foreground' />
            <SelectValue />
          </SelectTrigger>
          <SelectContent align='end'>
            <SelectItem value='created'>{SORT_LABELS.created}</SelectItem>
            <SelectItem value='updated'>{SORT_LABELS.updated}</SelectItem>
          </SelectContent>
        </Select>
        <div className='relative w-56'>
          <Search
            aria-hidden='true'
            className='pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground'
          />
          <Input
            ref={searchRef}
            aria-label='搜索场景'
            placeholder='搜索场景名称'
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && search) {
                event.preventDefault()
                onSearchChange('')
              }
            }}
            className='peer h-8 pr-8 pl-8'
          />
          {search ? (
            <button
              type='button'
              aria-label='清空搜索'
              onClick={() => {
                onSearchChange('')
                searchRef.current?.focus()
              }}
              className='absolute top-1/2 right-1.5 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:bg-surface-subtle hover:text-text-primary'
            >
              <X className='size-3.5' />
            </button>
          ) : (
            <Kbd size='sm' className='absolute top-1/2 right-2 -translate-y-1/2 peer-focus:opacity-0' aria-hidden='true'>
              /
            </Kbd>
          )}
        </div>
        <SegmentedControl ariaLabel='视图' value={view} options={VIEW_OPTIONS} onChange={onViewChange} iconOnly />
      </div>
    </div>
  )
}

export type FilterChip = { key: string; label: string; onRemove: () => void }

export function FilterChips({
  chips,
  onClearAll,
  summary,
}: {
  chips: FilterChip[]
  onClearAll: () => void
  summary?: ReactNode
}) {
  if (chips.length === 0) return null
  return (
    <div className='flex flex-wrap items-center gap-2 border-b border-border-divider bg-surface-header px-4 py-2'>
      {chips.map((chip) => (
        <span
          key={chip.key}
          className='inline-flex h-6 max-w-72 items-center gap-0.5 rounded-sm bg-selection-background pl-2 text-label font-medium text-selection-foreground'
        >
          <span className='truncate'>{chip.label}</span>
          <button
            type='button'
            aria-label={`移除条件：${chip.label}`}
            onClick={chip.onRemove}
            className='inline-flex size-5 shrink-0 items-center justify-center rounded-sm outline-none hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-ring'
          >
            <X className='size-3' />
          </button>
        </span>
      ))}
      <Button variant='link' size='sm' className='h-6 px-1' onClick={onClearAll}>
        清除全部
      </Button>
      {summary ? <span className='ml-auto text-label text-muted-foreground tabular-nums'>{summary}</span> : null}
    </div>
  )
}
