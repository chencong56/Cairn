import { useState } from 'react'
import { isTablePlanUnconfigured, type Step } from '@cairn/shared'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select'
import { createPlaceholderFilePlan, createPlaceholderTablePlan } from './table-plan-edit'

type ExtractStep = Extract<Step, { type: 'extract' }>
type ExtractKind = 'text' | 'value' | 'attribute' | 'table' | 'table_file'

type Option = { value: ExtractKind; label: string; hint: string }

/**
 * 提取类型：先回答“取一个值，还是一组数据”，取一组数据时再回答“数据在哪儿”。
 * 页面上的数据不让用户先选表格 / 卡片 / 详情，仍然点一下由系统认。
 */
const EXTRACT_TYPE_GROUPS: Array<{ label: string; options: Option[] }> = [
  {
    label: '取一个值',
    options: [
      { value: 'text', label: '文本', hint: '例：订单号、页面提示语' },
      { value: 'value', label: '输入框的值', hint: '例：表单里已填的金额' },
      { value: 'attribute', label: '元素属性', hint: '例：链接地址 href' },
    ],
  },
  {
    label: '取一组数据（可做数据检查）',
    options: [
      { value: 'table', label: '页面上的表格 / 列表数据', hint: '表格、卡片、详情信息' },
      { value: 'table_file', label: '下载文件里的数据', hint: '导出的 CSV、Excel' },
    ],
  },
]
const OPTIONS = EXTRACT_TYPE_GROUPS.flatMap((g) => g.options)
const AI_EXTRACT = '__ai_extract'

function extractKindOf(input: ExtractStep['input']): ExtractKind {
  if (input.as === 'table') return 'source' in input && input.source === 'file' ? 'table_file' : 'table'
  return input.as
}

/** 换成另一种提取类型后的输入：保留页面目标（取一个值之间切换不丢）；切到“一组数据”给占位计划。 */
function inputForKind(step: ExtractStep, kind: ExtractKind): ExtractStep['input'] {
  const pageTarget = 'target' in step.input && step.input.target ? step.input.target : createPlaceholderTablePlan().target
  if (kind === 'table') {
    const placeholder = createPlaceholderTablePlan()
    return { target: placeholder.target, as: 'table', table: placeholder }
  }
  if (kind === 'table_file') return { as: 'table', source: 'file', table: createPlaceholderFilePlan('downloadFile') }
  if (kind === 'attribute') {
    return { target: pageTarget, as: 'attribute', attribute: 'attribute' in step.input && step.input.attribute ? step.input.attribute : 'value' }
  }
  return { target: pageTarget, as: kind }
}

/** 已经配好的“一组数据”读取计划：切走会丢掉列与检查，要先确认。 */
function hasConfiguredPlan(step: ExtractStep): boolean {
  return step.input.as === 'table' && !isTablePlanUnconfigured(step.input.table)
}

export function ExtractTypeSelect({
  step,
  disabled,
  onChange,
  onRequestAiExtract,
}: {
  step: ExtractStep
  disabled?: boolean
  onChange: (step: Step) => void
  /** 改用 AI 提取步骤（走检查器现有的换类型流程）；不提供时不显示入口。 */
  onRequestAiExtract?: () => void
}) {
  const kind = extractKindOf(step.input)
  const current = OPTIONS.find((o) => o.value === kind)
  const [pending, setPending] = useState<ExtractKind | null>(null)
  const apply = (next: ExtractKind) => {
    setPending(null)
    onChange({ ...step, input: inputForKind(step, next) } as Step)
  }
  return (
    <div className='space-y-2'>
      <Label>提取类型</Label>
      <Select
        value={kind}
        disabled={disabled}
        onValueChange={(value) => {
          if (value === AI_EXTRACT) return onRequestAiExtract?.()
          const next = value as ExtractKind
          if (next === kind) return
          if (hasConfiguredPlan(step)) setPending(next)
          else apply(next)
        }}
      >
        <SelectTrigger className='w-full' aria-label='提取类型'>
          <SelectValue>
            {current ? (
              <span className='truncate'>
                {current.label}
                <span className='ml-1.5 text-muted-foreground'>· {current.hint}</span>
              </span>
            ) : null}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {EXTRACT_TYPE_GROUPS.map((group) => (
            <SelectGroup key={group.label}>
              <SelectLabel>{group.label}</SelectLabel>
              {group.options.map((o) => (
                <SelectItem key={o.value} value={o.value} textValue={o.label}>
                  <span className='flex flex-col items-start'>
                    <span>{o.label}</span>
                    <span className='text-caption text-muted-foreground'>{o.hint}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
          {onRequestAiExtract ? (
            <>
              <SelectSeparator />
              <SelectItem value={AI_EXTRACT} textValue='改用 AI 提取步骤' className='text-ai-foreground'>
                页面看不出结构？改用 AI 提取步骤 →
              </SelectItem>
            </>
          ) : null}
        </SelectContent>
      </Select>
      {pending ? (
        <div className='space-y-2 rounded-md border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-900' role='alertdialog' aria-label='切换提取类型'>
          <p>
            切换为「{OPTIONS.find((o) => o.value === pending)?.label}」后，已配置的读取设置（列、预览）会被清空，挂在这一步上的数据检查也会失效。
            {step.outputKey ? `保存结果为「${step.outputKey}」保留不变。` : ''}
          </p>
          <div className='flex gap-2'>
            <Button type='button' size='sm' onClick={() => apply(pending)}>
              切换
            </Button>
            <Button type='button' size='sm' variant='outline' onClick={() => setPending(null)}>
              保留现在的设置
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
