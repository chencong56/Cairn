import type { OutcomeContract, Step } from '@cairn/shared'
import { Link2 } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { fieldElementId } from '@/features/authoring/document'
import { OutcomeListEditor } from '@/features/authoring/outcome-editor'
import { TableChecksEditor } from '@/features/authoring/fields/table-checks'
import { splitTableChecks } from '@/features/authoring/fields/table-checks-model'

export interface SectionDataOutcomesProps {
  step: Step
  disabled?: boolean
  outcomes?: OutcomeContract[]
  consumers?: { id: string; name: string }[]
  onChange: (step: Step) => void
  onOutcomesChange?: (outcomes: OutcomeContract[]) => void
}

export function SectionDataOutcomes({
  step,
  disabled,
  outcomes = [],
  consumers = [],
  onChange,
  onOutcomesChange,
}: SectionDataOutcomesProps) {
  const supportsOutput =
    step.type === 'extract' ||
    step.type === 'echo' ||
    step.type === 'ai_extract' ||
    step.type === 'ai_assert' ||
    step.type === 'download'

  const tableStep = step.type === 'extract' && step.input.as === 'table' ? step : null
  const tableSplit = splitTableChecks(outcomes)

  return (
    <div data-testid='section-data-outcomes' className='space-y-4'>
      {/* 变量输出声明 */}
      {supportsOutput ? (
        <div className='space-y-1.5'>
          <Label htmlFor={fieldElementId(step.id, ['outputKey'])} className='text-label'>
            {step.type === 'extract' || step.type === 'ai_extract' || step.type === 'download'
              ? '保存本步结果为（建议填写 outputKey）'
              : '保存本步结果为（可选 outputKey）'}
          </Label>
          <Input
            id={fieldElementId(step.id, ['outputKey'])}
            value={step.outputKey ?? ''}
            disabled={disabled}
            placeholder='例如: orderId, ticketStatus'
            className='border-control focus:border-primary shadow-control-focus font-mono text-small'
            onChange={(event) =>
              onChange({
                ...step,
                outputKey: event.target.value.trim() || undefined,
              })
            }
          />
          {consumers.length > 0 ? (
            <div className='flex items-center gap-1.5 text-label text-primary bg-primary/5 px-2.5 py-1.5 rounded border border-primary/15 mt-1.5'>
              <Link2 className='size-3 shrink-0' />
              <span className='truncate'>
                已在后续 {consumers.length} 个步骤中引用：{consumers.map((c) => c.name).join('、')}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* 步骤级成功条件与断言清单 */}
      {onOutcomesChange && tableStep && (
        <div className='pt-1'>
          <TableChecksEditor
            step={tableStep}
            checks={tableSplit.checks}
            disabled={disabled}
            onChange={(next) => onOutcomesChange([...next, ...tableSplit.others])}
          />
        </div>
      )}
      {onOutcomesChange && (
        <div className='pt-1'>
          <OutcomeListEditor
            outcomes={tableStep ? tableSplit.others : outcomes}
            scope='step'
            disabled={disabled}
            onChange={(next) => onOutcomesChange(tableStep ? [...tableSplit.checks, ...next] : next)}
          />
        </div>
      )}
    </div>
  )
}
