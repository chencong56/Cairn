import {
  LOCATOR_PRESETS,
  LOCATOR_PRESET_LABELS,
  locatorPresetFor,
  locatorReadiness,
  resolveLocatorPlan,
  type PlatformConfigDocument,
  type ScenarioAuthoringDocumentV2,
  type TargetResolutionPolicy,
} from '@cairn/shared'
import { FieldHelp } from '@/components/ui/field-help'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { locatorRouteListLabel, locatorSkippedLabel } from '@/lib/locator-labels'

export function ScenarioLocatorSettings({ document, platform, target, disabled, onChange }: {
  document: ScenarioAuthoringDocumentV2
  platform?: PlatformConfigDocument
  target?: TargetResolutionPolicy | null
  disabled?: boolean
  onChange: (document: ScenarioAuthoringDocumentV2) => void
}) {
  const presetKeys = Object.keys(LOCATOR_PRESETS) as Array<keyof typeof LOCATOR_PRESETS>
  let preview = '正在读取平台定位配置…'
  if (platform) {
    try {
      const result = resolveLocatorPlan({
        platform: { plan: platform.locator.defaultPlan, limits: platform.locator.limits },
        target: target ? { plan: target.plan, limits: target.limits } : undefined,
        scenario: { plan: document.locatorPlan },
        ...locatorReadiness(platform),
      })
      preview = `请求：${locatorRouteListLabel(result.requested)}；预计实际：${locatorRouteListLabel(result.actual)}${result.skipped.length ? `；跳过：${locatorSkippedLabel(result.skipped)}` : ''}`
    } catch (error) { preview = error instanceof Error ? error.message : '定位路线不可用' }
  }
  return (
    <section className='space-y-3 rounded-lg border border-border-default p-3'>
      <div className='flex items-center gap-1.5'>
        <Label>场景默认定位顺序</Label>
        <FieldHelp label='场景默认定位顺序'>
          步骤未单独设置时使用；选择只影响普通步骤找页面元素。
        </FieldHelp>
      </div>
      <Select
        disabled={disabled || !platform}
        value={document.locatorPlan ? locatorPresetFor(document.locatorPlan) ?? 'custom' : 'inherit'}
        onValueChange={(value) => {
          if (value === 'custom') return
          const { locatorPlan: _plan, ...rest } = document
          onChange(value === 'inherit' ? rest
            : { ...rest, locatorPlan: { v: 2, order: [...LOCATOR_PRESETS[value as keyof typeof LOCATOR_PRESETS].order] } })
        }}
      >
        <SelectTrigger aria-label='场景默认定位顺序'><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value='inherit'>继承目标／平台</SelectItem>
          {document.locatorPlan && !locatorPresetFor(document.locatorPlan) ? <SelectItem value='custom'>当前顺序：{locatorRouteListLabel(document.locatorPlan.order)}</SelectItem> : null}
          {presetKeys.map((key) => <SelectItem key={key} value={key}>{LOCATOR_PRESET_LABELS[key]}</SelectItem>)}
        </SelectContent>
      </Select>
      <p className='text-label text-muted-foreground'>{preview}</p>
    </section>
  )
}
