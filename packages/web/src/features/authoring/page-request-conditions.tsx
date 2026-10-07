import { useState } from 'react'
import { ChevronDown, Trash2 } from 'lucide-react'
import { describePageRequestRule, type OutcomeContract, type OutcomePageRequestRule } from '@cairn/shared'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { FieldHelp } from '@/components/ui/field-help'
import { newUuid } from '@/lib/uuid'
import { isPageRequestContract, pageRequestRuleOf } from './page-request-conditions-utils'

const METHODS = ['ANY', 'GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const

function meaningOf(rule: OutcomePageRequestRule): string {
  return `这一步之后应出现请求：${describePageRequestRule(rule)}`
}

function blankPageRequest(): OutcomeContract {
  const rule: OutcomePageRequestRule = { kind: 'page_request', match: '/api/**', status: '2xx' }
  return {
    id: newUuid(),
    scope: 'step',
    meaning: meaningOf(rule),
    severity: 'MUST',
    onViolation: 'halt',
    provenance: 'manual',
    rule,
  }
}

/**
 * 页面请求条件：检查这一步是否真的触发了某个接口。属于高级能力，默认折叠；
 * 用一句话表单表达，不要求用户懂接口细节。有已配置的条件时仍保持折叠，只在标题上显示数量。
 */
export function PageRequestConditions({
  outcomes,
  disabled,
  onChange,
}: {
  outcomes: OutcomeContract[]
  disabled?: boolean
  /** 只回传页面请求条件的新清单，调用方负责与其他成功条件合并。 */
  onChange: (next: OutcomeContract[]) => void
}) {
  const [open, setOpen] = useState(false)
  const items = outcomes.filter(isPageRequestContract)
  const update = (next: OutcomeContract) => onChange(items.map((item) => (item.id === next.id ? next : item)))
  return (
    <Collapsible open={open} onOpenChange={setOpen} className='rounded-md border border-border-card'>
      <div className='flex w-full items-center justify-between gap-1.5 px-3 py-2'>
        <div className='flex items-center gap-1.5'>
          <CollapsibleTrigger
            className='flex items-center gap-1.5 text-left select-none focus-visible:outline-none'
            aria-label='页面请求检查'
          >
            <span className='text-small font-semibold'>页面请求检查</span>
            <span className='text-caption text-muted-foreground'>高级</span>
            {items.length > 0 ? (
              <span className='rounded bg-muted px-1.5 py-0.5 text-caption font-medium text-muted-foreground'>
                {items.length} 条
              </span>
            ) : (
              <span className='text-caption text-muted-foreground'>· 一般不用配</span>
            )}
          </CollapsibleTrigger>
          <FieldHelp label='页面请求检查'>
            适合「页面看着没变化，但不确定接口有没有真的发出去」的情况，例如点了「提交」之后必须出现下单接口。不确定就留空，不影响正常执行。
          </FieldHelp>
        </div>
        <CollapsibleTrigger
          className='p-1 text-muted-foreground hover:text-foreground transition-colors'
          aria-label={open ? '收起' : '展开'}
        >
          <ChevronDown className={`size-4 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className='space-y-3 border-t border-border-card px-3 py-3'>
        {items.map((item, index) => (
          <PageRequestCard
            key={item.id}
            index={index}
            contract={item}
            disabled={disabled}
            onChange={update}
            onRemove={() => onChange(items.filter((other) => other.id !== item.id))}
          />
        ))}
        <Button
          type='button'
          size='sm'
          variant='outline'
          disabled={disabled}
          onClick={() => onChange([...items, blankPageRequest()])}
        >
          添加请求条件
        </Button>
      </CollapsibleContent>
    </Collapsible>
  )
}

function PageRequestCard({
  contract,
  index = 0,
  disabled,
  onChange,
  onRemove,
}: {
  contract: OutcomeContract
  index?: number
  disabled?: boolean
  onChange: (next: OutcomeContract) => void
  onRemove: () => void
}) {
  const rule = pageRequestRuleOf(contract)
  if (!rule) return null
  const hard = contract.severity === 'MUST'
  const patch = (next: Partial<OutcomePageRequestRule>) => {
    const merged: OutcomePageRequestRule = { ...rule, ...next }
    if (merged.method === undefined) delete merged.method
    if (merged.maxMs === undefined) delete merged.maxMs
    if (merged.minCount === undefined || merged.minCount <= 1) delete merged.minCount
    if (merged.graceMs === undefined) delete merged.graceMs
    onChange({ ...contract, rule: merged, meaning: meaningOf(merged) })
  }
  const id = contract.id
  return (
    <div className='space-y-3 rounded-lg border border-border-card bg-muted/20 p-3'>
      <div className='flex items-center justify-between gap-2'>
        <div className='flex items-center gap-1.5'>
          <Label htmlFor={`pr-${id}-match`} className='text-small font-medium'>
            请求端点 {index > 0 ? `#${index + 1}` : ''}
          </Label>
          <FieldHelp label='路径匹配规则'>
            写路径即可，* 代表任意一段，** 代表任意多段；不用写参数。
          </FieldHelp>
        </div>
        <Button
          type='button'
          size='sm'
          variant='ghost'
          className='h-7 px-2 text-caption text-muted-foreground hover:text-destructive hover:bg-destructive/10'
          disabled={disabled}
          onClick={onRemove}
        >
          <Trash2 className='mr-1 size-3.5' />
          删除
        </Button>
      </div>

      <div className='flex items-center gap-1.5'>
        <div className='w-[88px] shrink-0'>
          <Select
            value={rule.method ?? 'ANY'}
            disabled={disabled}
            onValueChange={(value) => patch({ method: value === 'ANY' ? undefined : value })}
          >
            <SelectTrigger
              id={`pr-${id}-method`}
              aria-label='请求方式'
              className='font-mono text-xs font-semibold'
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {METHODS.map((method) => (
                <SelectItem key={method} value={method} className='font-mono text-xs'>
                  {method === 'ANY' ? 'ANY (不限)' : method}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className='min-w-0 flex-1'>
          <Input
            id={`pr-${id}-match`}
            aria-label='请求地址'
            defaultValue={rule.match}
            disabled={disabled}
            placeholder='/api/order/**'
            className='font-mono text-xs'
            onBlur={(event) => {
              const value = event.target.value.trim()
              if (value && value !== rule.match) patch({ match: value })
            }}
          />
        </div>
      </div>

      <div className='space-y-2.5'>
        <div className='space-y-1'>
          <Label htmlFor={`pr-${id}-status`}>算成功的返回</Label>
          <Select
            value={rule.status}
            disabled={disabled}
            onValueChange={(value) => patch({ status: value as OutcomePageRequestRule['status'] })}
          >
            <SelectTrigger id={`pr-${id}-status`} aria-label='算成功的返回'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='2xx'>成功（2xx）</SelectItem>
              <SelectItem value='2xx_3xx'>成功或跳转（2xx / 3xx）</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className='space-y-1'>
          <Label htmlFor={`pr-${id}-miss`}>没出现或没成功时</Label>
          <Select
            value={hard ? 'fail' : 'warn'}
            disabled={disabled}
            onValueChange={(value) =>
              onChange({
                ...contract,
                severity: value === 'fail' ? 'MUST' : 'SHOULD',
                onViolation: value === 'fail' ? 'halt' : 'continue',
              })
            }
          >
            <SelectTrigger id={`pr-${id}-miss`} aria-label='没出现或没成功时'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='fail'>判为失败并停止后续步骤</SelectItem>
              <SelectItem value='warn'>只记警告，继续往下跑</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <Collapsible>
        <CollapsibleTrigger className='flex items-center gap-1 text-caption text-muted-foreground hover:text-foreground transition-colors'>
          更多选项
          <ChevronDown className='size-3' />
        </CollapsibleTrigger>
        <CollapsibleContent className='mt-2.5 grid grid-cols-3 gap-2'>
          <div className='space-y-1'>
            <div className='flex items-center gap-1'>
              <Label htmlFor={`pr-${id}-grace`} className='text-caption'>
                缓冲(秒)
              </Label>
              <FieldHelp label='缓冲等待时间'>
                请求常在点击之后才发出，默认等待 3 秒。
              </FieldHelp>
            </div>
            <Input
              id={`pr-${id}-grace`}
              type='number'
              min={0}
              max={15}
              disabled={disabled}
              className='h-8 text-xs'
              defaultValue={Math.round((rule.graceMs ?? 3000) / 1000)}
              onBlur={(event) => patch({ graceMs: Math.max(0, Math.min(15, Math.trunc(Number(event.target.value) || 0))) * 1000 })}
            />
          </div>
          <div className='space-y-1'>
            <Label htmlFor={`pr-${id}-ms`} className='text-caption'>
              超时(ms)
            </Label>
            <Input
              id={`pr-${id}-ms`}
              type='number'
              min={1}
              disabled={disabled}
              placeholder='不限'
              className='h-8 text-xs'
              defaultValue={rule.maxMs ?? ''}
              onBlur={(event) => {
                const value = Math.trunc(Number(event.target.value))
                patch({ maxMs: value >= 1 ? value : undefined })
              }}
            />
          </div>
          <div className='space-y-1'>
            <Label htmlFor={`pr-${id}-count`} className='text-caption'>
              频次(次)
            </Label>
            <Input
              id={`pr-${id}-count`}
              type='number'
              min={1}
              disabled={disabled}
              className='h-8 text-xs'
              defaultValue={rule.minCount ?? 1}
              onBlur={(event) => patch({ minCount: Math.max(1, Math.trunc(Number(event.target.value) || 1)) })}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
