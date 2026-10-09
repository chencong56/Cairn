import { useState } from 'react'
import { newUuid } from '@/lib/uuid'
import { useFormContext } from 'react-hook-form'
import {
  ALERTABLE_METRIC_KEYS,
  ALERT_COMPARATORS,
  ALERT_SEVERITIES,
  FACTORY_ALERT_RULES,
  describeAlertRule,
  metricLabel,
  metricOptionGroups,
  metricUnitLabel,
  requiredAlertMetricScope,
  type AlertRule,
  type MonitorMetricKey,
  type PlatformConfigCurrent,
  type PlatformConfigDocument,
} from '@cairn/shared'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { registerMonitorAlertChannel } from '@/lib/monitoring-api'
import { Button } from '@/components/ui/button'
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { AlertTriangle, ChevronDown } from 'lucide-react'

const COMPARATOR_LABELS: Record<(typeof ALERT_COMPARATORS)[number], string> = {
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  eq: '=',
}

const SEVERITY_LABELS: Record<(typeof ALERT_SEVERITIES)[number], string> = {
  warning: '警告',
  critical: '严重',
}

export function AlertingFields({
  canWrite,
  revision,
  reason,
  busy,
  onRegistered,
  hideChannels = false,
  onGoChannels,
}: {
  canWrite: boolean
  revision?: number
  reason: string
  busy: boolean
  onRegistered: (saved: PlatformConfigCurrent) => Promise<void>
  hideChannels?: boolean
  /** 跳到推送渠道配置（规则没有可用渠道时给用户一个去处）。 */
  onGoChannels?: () => void
}) {
  const form = useFormContext<PlatformConfigDocument>()
  const rules = form.watch('alerting.rules') ?? FACTORY_ALERT_RULES
  const channels = (form.watch('outbound.channels') ?? []).filter(c => c.allowAlerts)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [registering, setRegistering] = useState(false)

  async function registerChannel() {
    if (!revision || !canWrite) return
    const persistReason = reason.trim()
    if (!persistReason) {
      toast.error('请填写变更原因')
      return
    }
    if (!name.trim() || !url.trim()) {
      toast.error('请填写渠道名称和 Webhook 地址')
      return
    }
    setRegistering(true)
    try {
      const saved = await registerMonitorAlertChannel({
        expectedRevision: revision,
        reason: persistReason,
        name: name.trim(),
        url: url.trim(),
        ...(token.trim() ? { token: token.trim() } : {}),
        enabled: true,
      })
      setName('')
      setUrl('')
      setToken('')
      await onRegistered(saved)
      toast.success(`Webhook 已登记，修订 ${saved.revision}`)
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '登记失败')
    } finally {
      setRegistering(false)
    }
  }

  const indexed = rules.map((rule, index) => ({ rule, index }))
  const suggested = indexed.filter(({ rule }) => rule.id.startsWith('factory.'))
  const custom = indexed.filter(({ rule }) => !rule.id.startsWith('factory.'))
  const [customOpen, setCustomOpen] = useState(false)
  const usableChannelIds = (rule: AlertRule) =>
    rule.channelIds.filter((id) => channels.some((channel) => channel.id === id && channel.enabled))

  const renderRule = (rule: AlertRule, index: number) => (
    <article key={rule.id} className='space-y-3 rounded-md border border-border px-3 py-3'>
            <FormField
              name={`alerting.rules.${index}.enabled`}
              render={({ field }) => (
                <FormItem className='flex items-center justify-between gap-4'>
                  <div className='space-y-0.5'>
                    <FormLabel>{rule.name}</FormLabel>
                    <p className='text-caption font-normal text-muted-foreground'>{describeAlertRule(rule)}</p>
                  </div>
                  <FormControl>
                    <Switch
                      checked={field.value}
                      disabled={!canWrite}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                </FormItem>
              )}
            />
            <div className='grid gap-3 md:grid-cols-2'>
              <FormField
                name={`alerting.rules.${index}.forSeconds`}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>持续多久才告警（秒）</FormLabel>
                    <FormControl>
                      <Input
                        type='number'
                        min={0}
                        max={86_400}
                        disabled={!canWrite}
                        value={field.value}
                        onChange={(event) => field.onChange(Number(event.target.value))}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
              {rule.kind === 'threshold' ? (
                <FormField
                  name={`alerting.rules.${index}.threshold`}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        触发阈值{metricUnitLabel(rule.metricKey) ? `（${metricUnitLabel(rule.metricKey)}）` : ''}
                      </FormLabel>
                      <FormControl>
                        <Input
                          type='number'
                          disabled={!canWrite}
                          value={field.value}
                          onChange={(event) => field.onChange(Number(event.target.value))}
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />
              ) : null}
            </div>
            {rule.id.startsWith('factory.') ? null : (
              <div className='grid gap-3 md:grid-cols-2'>
                <FormField
                  name={`alerting.rules.${index}.name`}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>规则名称</FormLabel>
                      <FormControl>
                        <Input disabled={!canWrite} value={field.value} onChange={field.onChange} />
                      </FormControl>
                    </FormItem>
                  )}
                />
                {rule.kind === 'threshold' ? (
                  <>
                    <FormField
                      name={`alerting.rules.${index}.metricKey`}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>指标</FormLabel>
                          <Select
                            disabled={!canWrite}
                            value={field.value}
                            onValueChange={(value) => {
                              const metricKey = value as MonitorMetricKey
                              field.onChange(metricKey)
                              form.setValue(
                                `alerting.rules.${index}.scope`,
                                requiredAlertMetricScope(metricKey),
                                { shouldDirty: true },
                              )
                            }}
                          >
                            <FormControl>
                              <SelectTrigger className='w-full'>
                                <SelectValue />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {metricOptionGroups().map((group) => (
                                <SelectGroup key={group.group}>
                                  <SelectLabel>{group.group}</SelectLabel>
                                  {group.keys.map((key) => (
                                    <SelectItem key={key} value={key}>
                                      {metricLabel(key)}
                                    </SelectItem>
                                  ))}
                                </SelectGroup>
                              ))}
                            </SelectContent>
                          </Select>
                        </FormItem>
                      )}
                    />
                    <FormField
                      name={`alerting.rules.${index}.comparator`}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>比较符</FormLabel>
                          <Select
                            disabled={!canWrite}
                            value={field.value}
                            onValueChange={field.onChange}
                          >
                            <FormControl>
                              <SelectTrigger className='w-full'>
                                <SelectValue />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {ALERT_COMPARATORS.map((comparator) => (
                                <SelectItem key={comparator} value={comparator}>
                                  {COMPARATOR_LABELS[comparator]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </FormItem>
                      )}
                    />
                  </>
                ) : null}
                <FormField
                  name={`alerting.rules.${index}.severity`}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>严重度</FormLabel>
                      <Select
                        disabled={!canWrite}
                        value={field.value}
                        onValueChange={field.onChange}
                      >
                        <FormControl>
                          <SelectTrigger className='w-full'>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {ALERT_SEVERITIES.map((severity) => (
                            <SelectItem key={severity} value={severity}>
                              {SEVERITY_LABELS[severity]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormItem>
                  )}
                />
                {canWrite ? (
                  <div className='flex items-end'>
                    <Button
                      type='button'
                      variant='outline'
                      disabled={busy}
                      onClick={() => {
                        form.setValue(
                          'alerting.rules',
                          rules.filter((_, ruleIndex) => ruleIndex !== index),
                          { shouldDirty: true },
                        )
                      }}
                    >
                      删除自定义规则
                    </Button>
                  </div>
                ) : null}
              </div>
            )}
            {channels.length > 0 ? (
              <fieldset className='space-y-2'>
                <legend className='text-label text-muted-foreground'>通知发到哪里</legend>
                {channels.map((channel) => (
                  <label key={channel.id} className='flex items-center gap-2 text-body'>
                    <input
                      type='checkbox'
                      disabled={!canWrite}
                      checked={rule.channelIds.includes(channel.id)}
                      onChange={(event) => {
                        const next = event.target.checked
                          ? [...rule.channelIds, channel.id]
                          : rule.channelIds.filter((id) => id !== channel.id)
                        form.setValue(`alerting.rules.${index}.channelIds`, next, {
                          shouldDirty: true,
                        })
                      }}
                    />
                    <span>
                      {channel.name} · {channel.kind === 'email' ? '邮件' : channel.host}
                      {channel.enabled ? '' : '（已关闭）'}
                    </span>
                  </label>
                ))}
              </fieldset>
            ) : null}
            {rule.enabled && usableChannelIds(rule).length === 0 ? (
              <div
                role='alert'
                className='flex flex-wrap items-center gap-2 rounded-md bg-status-warning-background px-3 py-2 text-label text-status-warning-foreground'
              >
                <AlertTriangle className='size-3.5 shrink-0' />
                <span>
                  {channels.length === 0
                    ? '已开启，但还没有可用于告警的推送渠道，触发了也不会通知任何人。'
                    : '已开启，但还没选择通知发到哪里，触发了也不会通知任何人。请勾选上面的渠道。'}
                </span>
                {channels.length === 0 && onGoChannels ? (
                  <button type='button' className='underline underline-offset-2' onClick={onGoChannels}>
                    去添加推送渠道
                  </button>
                ) : null}
              </div>
            ) : null}
    </article>
  )

  const addButton = canWrite ? (
    <Button
      type='button'
      variant='outline'
      disabled={busy}
      onClick={() => {
        const custom: AlertRule = {
          kind: 'threshold',
          id: `custom.${newUuid().replace(/-/g, '')}`,
          name: '自定义阈值',
          metricKey: ALERTABLE_METRIC_KEYS[0]!,
          scope: requiredAlertMetricScope(ALERTABLE_METRIC_KEYS[0]!),
          comparator: 'gte',
          threshold: 1,
          forSeconds: 60,
          severity: 'warning',
          channelIds: [],
          enabled: false,
        }
        form.setValue('alerting.rules', [...rules, custom], { shouldDirty: true })
        setCustomOpen(true)
      }}
    >
      添加自定义规则
    </Button>
  ) : null

  return (
    <div className='space-y-6'>
      <p className='text-label text-muted-foreground'>
        {hideChannels
          ? '下面是系统建议的告警情况，默认都关闭。打开某一条，并选好「通知发到哪里」，出问题时才会收到通知。'
          : '出厂建议规则全部关闭。Webhook 地址只在登记时提交，不会写入配置文档或变更记录。'}
      </p>
      <div className='space-y-3'>
        {suggested.map(({ rule, index }) => renderRule(rule, index))}
      </div>
      <Collapsible open={customOpen} onOpenChange={setCustomOpen} className='rounded-md border border-border'>
        <CollapsibleTrigger
          className='flex w-full items-center justify-between gap-2 px-3 py-2 text-left'
          aria-label='自定义告警规则'
        >
          <span className='flex items-center gap-1.5'>
            <span className='text-small font-semibold'>自定义规则</span>
            <span className='text-caption text-muted-foreground'>
              高级
              {custom.length > 0
                ? ` · ${custom.length} 条，已开启 ${custom.filter(({ rule }) => rule.enabled).length} 条`
                : ' · 一般不用配'}
            </span>
          </span>
          <ChevronDown className={`size-4 text-muted-foreground transition-transform ${customOpen ? 'rotate-180' : ''}`} />
        </CollapsibleTrigger>
        <CollapsibleContent className='space-y-3 border-t border-border px-3 py-3'>
          <p className='text-caption text-muted-foreground'>
            建议规则覆盖不到的情况，可以自己选一个监控指标并设阈值。不确定就不用配。
          </p>
          {custom.map(({ rule, index }) => renderRule(rule, index))}
          {addButton}
        </CollapsibleContent>
      </Collapsible>
      {!hideChannels && <section className='space-y-3 rounded-md border border-border px-3 py-3'>
        <h3 className='text-small font-semibold'>Webhook 渠道</h3>
        {channels.length === 0 ? (
          <p className='text-label text-muted-foreground'>还没有渠道。登记后只保存主机名。</p>
        ) : (
          <ul className='space-y-1'>
            {channels.map((channel) => (
              <li key={channel.id} className='text-body'>
                {channel.name} · {channel.host} · {channel.enabled ? '启用' : '关闭'}
              </li>
            ))}
          </ul>
        )}
        {canWrite ? (
          <div className='grid gap-3 md:grid-cols-2'>
            <div className='space-y-2'>
              <label className='text-label' htmlFor='alert-channel-name'>
                渠道名称
              </label>
              <Input
                id='alert-channel-name'
                value={name}
                disabled={registering || busy}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className='space-y-2'>
              <label className='text-label' htmlFor='alert-channel-url'>
                Webhook 地址
              </label>
              <Input
                id='alert-channel-url'
                type='url'
                autoComplete='off'
                value={url}
                disabled={registering || busy}
                onChange={(event) => setUrl(event.target.value)}
              />
            </div>
            <div className='space-y-2 md:col-span-2'>
              <label className='text-label' htmlFor='alert-channel-token'>
                Bearer 令牌（可选）
              </label>
              <Input
                id='alert-channel-token'
                type='password'
                autoComplete='new-password'
                value={token}
                disabled={registering || busy}
                onChange={(event) => setToken(event.target.value)}
              />
            </div>
            <Button
              type='button'
              variant='outline'
              disabled={registering || busy}
              onClick={() => void registerChannel()}
            >
              登记 Webhook
            </Button>
          </div>
        ) : null}
      </section>}
    </div>
  )
}
