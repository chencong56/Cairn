import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  LOCATOR_PRESETS,
  LOCATOR_PRESET_LABELS,
  locatorPresetFor,
  locatorReadiness,
  resolveLocatorPlan,
  type TargetDto,
  type TargetResolutionPolicyPatch,
} from '@cairn/shared'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { updateTargetResolutionPolicy } from '@/lib/targets-api'
import { fetchPlatformConfig } from '@/lib/platform-config-api'
import { useCan } from '@/hooks/use-permissions'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { locatorRouteListLabel, locatorSkippedLabel } from '@/lib/locator-labels'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const INHERIT = 'inherit'

export function ResolutionPolicyCard({ target }: { target: TargetDto }) {
  const canWrite = useCan('target:write')
  const queryClient = useQueryClient()
  const override = target.resolutionPolicy ?? null
  const platform = useQuery({ queryKey: ['platform-config'], queryFn: fetchPlatformConfig }).data?.document
  const presetKeys = Object.keys(LOCATOR_PRESETS) as Array<keyof typeof LOCATOR_PRESETS>
  const plan = override?.plan
  const limits = override?.limits
  const allowedOptions = [
    { value: 'inherit', label: '继承平台允许集合' },
    { value: 'rule', label: '仅规则' },
    { value: 'rule,text_ai', label: '规则和文本模型' },
    { value: 'rule,vision_ai', label: '规则和视觉模型' },
    { value: 'rule,text_ai,vision_ai', label: '全部定位能力' },
  ]
  let planPreview = ''
  if (platform) {
    try {
      const result = resolveLocatorPlan({
        platform: { plan: platform.locator.defaultPlan, limits: platform.locator.limits },
        target: override ? { plan: override.plan, limits: override.limits } : undefined,
        ...locatorReadiness(platform),
      })
      planPreview = `请求：${locatorRouteListLabel(result.requested)}；实际：${locatorRouteListLabel(result.actual)}${result.skipped.length ? `；跳过 ${locatorSkippedLabel(result.skipped)}` : ''}`
    } catch (error) { planPreview = error instanceof Error ? error.message : '定位路线不可用' }
  }
  const mutation = useMutation({
    mutationFn: (body: TargetResolutionPolicyPatch) => updateTargetResolutionPolicy(target.id, body),
    onSuccess: async () => {
      toast.success('已更新目标解析策略')
      await queryClient.invalidateQueries({ queryKey: ['target', target.id] })
    },
    onError: (error) => {
      toast.error(error instanceof ApiRequestError ? error.message : '更新目标解析策略失败')
    },
  })

  return (
    <Card className='min-w-0'>
      <CardHeader>
        <CardTitle className='text-section font-semibold'>目标定位</CardTitle>
        <p className='mt-1 text-label text-muted-foreground'>
          本目标系统可收紧允许能力，也可覆盖默认尝试顺序。未设置时继承平台，只影响之后新建的运行。
        </p>
      </CardHeader>
      <CardContent className='space-y-4'>
        <div className='grid gap-4 sm:grid-cols-2'>
          <div className='space-y-2'>
            <Label>目标默认定位顺序</Label>
            <Select disabled={!canWrite || mutation.isPending} value={plan ? locatorPresetFor(plan) ?? 'custom' : INHERIT} onValueChange={(value) => {
              if (value === 'custom') return
              mutation.mutate({
                plan: value === INHERIT ? null : { v: 2, order: [...LOCATOR_PRESETS[value as keyof typeof LOCATOR_PRESETS].order] },
              })
            }}>
              <SelectTrigger aria-label='目标默认定位顺序'><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={INHERIT}>继承平台默认</SelectItem>
                {plan && !locatorPresetFor(plan) ? <SelectItem value='custom'>当前顺序：{locatorRouteListLabel(plan.order)}</SelectItem> : null}
                {presetKeys.map((key) => <SelectItem key={key} value={key}>{LOCATOR_PRESET_LABELS[key]}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className='space-y-2'>
            <Label>本目标允许的定位能力</Label>
            <Select disabled={!canWrite || mutation.isPending} value={limits?.allowed.join(',') ?? INHERIT} onValueChange={(value) => mutation.mutate({
              limits: value === INHERIT ? null : { v: 2, allowed: value.split(',') as NonNullable<TargetResolutionPolicyPatch['limits']>['allowed'] },
            })}>
              <SelectTrigger aria-label='本目标允许的定位能力'><SelectValue /></SelectTrigger>
              <SelectContent>{allowedOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
        <p className='text-label text-muted-foreground'>{planPreview || (platform ? `请求：${locatorRouteListLabel(plan?.order ?? platform.locator.defaultPlan.order)}` : '')}</p>
      </CardContent>
    </Card>
  )
}
