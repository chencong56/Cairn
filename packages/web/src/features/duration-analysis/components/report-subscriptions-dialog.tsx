import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { CalendarClock } from 'lucide-react'
import { toast } from 'sonner'
import {
  DURATION_REPORT_ISSUE_REASONS,
  type DurationPeriodKind,
  type DurationReportIssueStatus,
  type DurationReportSubscriptionDto,
  type DurationTriggerFilter,
} from '@cairn/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SelectField, SelectFieldOption } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useCan } from '@/hooks/use-permissions'
import { ApiRequestError } from '@/lib/api-client'
import {
  createDurationReportSubscription,
  deleteDurationReportSubscription,
  fetchDurationReportSubscriptions,
  previewDurationReportSubscription,
  updateDurationReportSubscription,
} from '@/lib/duration-api'
import { fetchOutboundChannels } from '@/lib/outbound-api'
import { TRIGGER_LABELS } from '../format'

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const ISSUE_STATUS: Record<DurationReportIssueStatus, { label: string; tone: string }> = {
  pending: { label: '待生成', tone: 'text-status-info' },
  generated: { label: '已生成，待推送', tone: 'text-status-info' },
  delivered: { label: '已推送', tone: 'text-status-success' },
  skipped: { label: '已跳过', tone: 'text-muted-foreground' },
  failed: { label: '失败', tone: 'text-status-error' },
}

function scheduleText(value: { period: DurationPeriodKind; sendWeekday: number; sendDay: number; sendTime: string }): string {
  return value.period === 'week' ? `周报 · 每${WEEKDAYS[value.sendWeekday - 1]} ${value.sendTime}` : `月报 · 每月 ${value.sendDay} 日 ${value.sendTime}`
}

function reasonText(reason: string | null): string | null {
  if (!reason) return null
  if (reason.startsWith('generate_failed:')) return `生成报告失败：${reason.slice('generate_failed:'.length).trim()}`
  return DURATION_REPORT_ISSUE_REASONS[reason] ?? reason
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiRequestError ? error.message : fallback
}

type Suite = { id: string; name: string }

/** 「定期发送」入口：需要导出报告与查看消息推送的权限。 */
export function ReportSubscriptionsButton({ targetId, suiteId, suites }: { targetId: string; suiteId?: string; suites: Suite[] }) {
  const canExport = useCan('report:export')
  const canReadOutbound = useCan('outbound:read')
  const [open, setOpen] = React.useState(false)
  if (!canExport || !canReadOutbound) return null
  return (
    <>
      <Button size='sm' variant='outline' onClick={() => setOpen(true)}>
        <CalendarClock className='size-4' />
        定期发送
      </Button>
      {open ? <SubscriptionsDialog targetId={targetId} defaultSuiteId={suiteId} suites={suites} onClose={() => setOpen(false)} /> : null}
    </>
  )
}

function SubscriptionsDialog({ targetId, defaultSuiteId, suites, onClose }: { targetId: string; defaultSuiteId?: string; suites: Suite[]; onClose: () => void }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [editing, setEditing] = React.useState<DurationReportSubscriptionDto | 'new' | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const subscriptions = useQuery({ queryKey: ['duration-report-subscriptions', targetId], queryFn: () => fetchDurationReportSubscriptions(targetId) })
  const channels = useQuery({ queryKey: ['outbound-channels', targetId], queryFn: () => fetchOutboundChannels(targetId) })
  const channelName = (id: string) => channels.data?.channels.find((c) => c.id === id)?.name ?? '已移除的渠道'
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['duration-report-subscriptions', targetId] })

  async function act(key: string, work: () => Promise<unknown>, failure: string) {
    setBusy(key)
    try {
      await work()
      await refresh()
    } catch (error) {
      toast.error(errorText(error, failure))
    } finally {
      setBusy(null)
    }
  }

  const items = subscriptions.data?.items ?? []
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>定期发送周期报告</DialogTitle>
          <DialogDescription>到点为最近一期生成周报 / 月报并推送到所选渠道（邮件附 HTML 报告，IM 与 webhook 带控制台链接）。新建的订阅默认不启用。</DialogDescription>
        </DialogHeader>
        {channels.data && !channels.data.enabled ? (
          <p className='rounded-md bg-surface-subtle px-3 py-2 text-label text-muted-foreground'>消息推送当前未启用：订阅启用后到点仍会生成报告，但不会发出。</p>
        ) : null}

        {editing ? (
          <SubscriptionForm
            key={editing === 'new' ? 'new' : editing.id}
            initial={editing === 'new' ? null : editing}
            targetId={targetId}
            defaultSuiteId={defaultSuiteId}
            suites={suites}
            channels={channels.data?.channels ?? []}
            onCancel={() => setEditing(null)}
            onSaved={async () => {
              setEditing(null)
              await refresh()
            }}
          />
        ) : (
          <div className='flex flex-col gap-3'>
            {subscriptions.isPending ? <p className='text-label text-muted-foreground'>加载中…</p> : null}
            {subscriptions.isSuccess && items.length === 0 ? <p className='text-label text-muted-foreground'>该目标系统还没有订阅。</p> : null}
            {items.map((sub) => {
              const issue = sub.lastIssue
              return (
                <div key={sub.id} className='flex flex-col gap-2 rounded-lg border border-border-card p-3'>
                  <div className='flex flex-wrap items-start justify-between gap-2'>
                    <div className='min-w-0'>
                      <p className='text-body font-medium text-text-primary'>
                        {scheduleText(sub)}
                        <span className='ml-2 text-label font-normal text-muted-foreground'>{sub.timeZone}</span>
                      </p>
                      <p className='text-label text-muted-foreground'>
                        {sub.suiteName ? `场景集「${sub.suiteName}」` : '全部场景'} · {TRIGGER_LABELS[sub.trigger]} · 渠道：{sub.channelIds.length ? sub.channelIds.map(channelName).join('、') : '未选择'}
                      </p>
                    </div>
                    <div className='flex items-center gap-2'>
                      <Label htmlFor={`sub-${sub.id}`} className='text-label'>{sub.enabled ? '已启用' : '未启用'}</Label>
                      <Switch
                        id={`sub-${sub.id}`}
                        checked={sub.enabled}
                        disabled={busy !== null}
                        onCheckedChange={(enabled) =>
                          void act(`toggle-${sub.id}`, () => updateDurationReportSubscription(sub.id, { expectedRevision: sub.revision, enabled }), enabled ? '启用失败' : '停用失败')
                        }
                      />
                    </div>
                  </div>
                  <div className='flex flex-wrap items-center gap-x-3 gap-y-1 text-label text-muted-foreground'>
                    {sub.nextSendAt ? <span>下次发送：{new Date(sub.nextSendAt).toLocaleString()}</span> : null}
                    {issue ? (
                      <span className='flex flex-wrap items-center gap-1.5'>
                        最近一期：{issue.periodLabel}
                        <Badge variant='outline' className={ISSUE_STATUS[issue.status].tone}>{ISSUE_STATUS[issue.status].label}</Badge>
                        {reasonText(issue.reason) ? <span>{reasonText(issue.reason)}</span> : null}
                        {issue.reportId ? (
                          <Link to='/reports/$reportId' params={{ reportId: issue.reportId }} className='text-link'>
                            查看报告
                          </Link>
                        ) : null}
                      </span>
                    ) : (
                      <span>还没有发送过</span>
                    )}
                  </div>
                  <div className='flex flex-wrap gap-2'>
                    <Button size='sm' variant='outline' disabled={busy !== null} onClick={() => setEditing(sub)}>
                      编辑
                    </Button>
                    <Button
                      size='sm'
                      variant='outline'
                      disabled={busy !== null}
                      onClick={() =>
                        void act(
                          `preview-${sub.id}`,
                          async () => {
                            const report = await previewDurationReportSubscription(sub.id)
                            onClose()
                            void navigate({ to: '/reports/$reportId', params: { reportId: report.id } })
                          },
                          '生成预览失败',
                        )
                      }
                    >
                      {busy === `preview-${sub.id}` ? '生成中…' : '立即生成本期预览（不推送）'}
                    </Button>
                    <Button
                      size='sm'
                      variant='outline'
                      className='text-status-error'
                      disabled={busy !== null}
                      onClick={() => {
                        if (window.confirm('删除这条订阅？已生成的报告会保留。')) void act(`delete-${sub.id}`, () => deleteDurationReportSubscription(sub.id), '删除失败')
                      }}
                    >
                      删除
                    </Button>
                  </div>
                </div>
              )
            })}
            <DialogFooter>
              <Button onClick={() => setEditing('new')}>新建订阅</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

type Channel = { id: string; name: string; kind: string; enabled: boolean; revoked: boolean }

function SubscriptionForm({
  initial,
  targetId,
  defaultSuiteId,
  suites,
  channels,
  onCancel,
  onSaved,
}: {
  initial: DurationReportSubscriptionDto | null
  targetId: string
  defaultSuiteId?: string
  suites: Suite[]
  channels: Channel[]
  onCancel: () => void
  onSaved: () => Promise<void>
}) {
  const [period, setPeriod] = React.useState<DurationPeriodKind>(initial?.period ?? 'week')
  const [sendWeekday, setSendWeekday] = React.useState(initial?.sendWeekday ?? 1)
  const [sendDay, setSendDay] = React.useState(initial?.sendDay ?? 1)
  const [sendTime, setSendTime] = React.useState(initial?.sendTime ?? '09:00')
  const [trigger, setTrigger] = React.useState<DurationTriggerFilter>(initial?.trigger ?? 'schedule')
  const [suiteId, setSuiteId] = React.useState<string | undefined>(initial ? (initial.suiteId ?? undefined) : defaultSuiteId)
  const [channelIds, setChannelIds] = React.useState<string[]>(initial?.channelIds ?? [])
  const [enabled, setEnabled] = React.useState(initial?.enabled ?? false)
  const [saving, setSaving] = React.useState(false)
  // 新建时不传时区：服务端按平台统计时区（与耗时分析按天汇总同一切法）
  const timeZoneText = initial?.timeZone ?? '平台统计时区'

  async function save() {
    setSaving(true)
    try {
      const fields = { period, sendWeekday, sendDay, sendTime, trigger, channelIds, enabled }
      if (initial) await updateDurationReportSubscription(initial.id, { expectedRevision: initial.revision, ...fields, suiteId: suiteId ?? null })
      else await createDurationReportSubscription({ targetId, ...(suiteId ? { suiteId } : {}), ...fields })
      toast.success(initial ? '订阅已保存' : enabled ? '订阅已创建并启用' : '订阅已创建（未启用）')
      await onSaved()
    } catch (error) {
      toast.error(errorText(error, '保存失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className='flex flex-col gap-4'>
      <div className='grid gap-3 sm:grid-cols-2'>
        <div className='flex flex-col gap-1.5'>
          <Label className='text-label'>周期</Label>
          <SelectField aria-label='周期' value={period} onValueChange={(next) => setPeriod(next as DurationPeriodKind)}>
            <SelectFieldOption value='week'>周报（上一自然周）</SelectFieldOption>
            <SelectFieldOption value='month'>月报（上一自然月）</SelectFieldOption>
          </SelectField>
        </div>
        <div className='flex flex-col gap-1.5'>
          <Label className='text-label'>发送时间（{timeZoneText}）</Label>
          <div className='flex gap-2'>
            {period === 'week' ? (
              <SelectField className='w-28' aria-label='星期' value={sendWeekday} onValueChange={(next) => setSendWeekday(Number(next))}>
                {WEEKDAYS.map((label, index) => (
                  <SelectFieldOption key={label} value={index + 1}>
                    每{label}
                  </SelectFieldOption>
                ))}
              </SelectField>
            ) : (
              <Input aria-label='每月几号' type='number' min={1} max={28} className='w-28' value={sendDay} onChange={(event) => setSendDay(Math.min(28, Math.max(1, Number(event.target.value) || 1)))} />
            )}
            <Input aria-label='时刻' type='time' className='w-32' value={sendTime} onChange={(event) => setSendTime(event.target.value)} />
          </div>
        </div>
        <div className='flex flex-col gap-1.5'>
          <Label className='text-label'>范围</Label>
          <SelectField aria-label='范围' value={suiteId ?? 'all'} onValueChange={(next) => setSuiteId(next === 'all' ? undefined : next)}>
            <SelectFieldOption value='all'>全部场景</SelectFieldOption>
            {suites.map((suite) => (
              <SelectFieldOption key={suite.id} value={suite.id}>
                场景集：{suite.name}
              </SelectFieldOption>
            ))}
          </SelectField>
        </div>
        <div className='flex flex-col gap-1.5'>
          <Label className='text-label'>统计口径</Label>
          <SelectField aria-label='统计口径' value={trigger} onValueChange={(next) => setTrigger(next as DurationTriggerFilter)}>
            {(Object.keys(TRIGGER_LABELS) as DurationTriggerFilter[]).map((key) => (
              <SelectFieldOption key={key} value={key}>
                {TRIGGER_LABELS[key]}
              </SelectFieldOption>
            ))}
          </SelectField>
        </div>
      </div>
      <div className='flex flex-col gap-1.5'>
        <Label className='text-label'>推送渠道（只列授权给该目标系统的渠道）</Label>
        {channels.length === 0 ? (
          <p className='text-label text-muted-foreground'>没有授权给该目标系统的渠道，请先在「消息推送」里配置。</p>
        ) : (
          <div className='flex flex-col gap-1.5'>
            {channels.map((channel) => {
              const usable = channel.enabled && !channel.revoked
              const checked = channelIds.includes(channel.id)
              return (
                <label key={channel.id} className='flex items-center gap-2 text-body'>
                  <Checkbox
                    checked={checked}
                    disabled={!usable && !checked}
                    onCheckedChange={(next) => setChannelIds((prev) => (next ? [...prev, channel.id] : prev.filter((id) => id !== channel.id)))}
                  />
                  <span className={usable ? 'text-text-primary' : 'text-muted-foreground'}>
                    {channel.name}
                    <span className='ml-1 text-label text-muted-foreground'>（{channel.kind === 'email' ? '邮件' : 'Webhook'}{usable ? '' : '，已停用'}）</span>
                  </span>
                </label>
              )
            })}
          </div>
        )}
      </div>
      <div className='flex items-center gap-2'>
        <Switch id='sub-enabled' checked={enabled} onCheckedChange={setEnabled} />
        <Label htmlFor='sub-enabled' className='text-label'>启用（到点自动生成并推送）</Label>
      </div>
      <DialogFooter>
        <Button variant='outline' disabled={saving} onClick={onCancel}>
          返回
        </Button>
        <Button disabled={saving || !/^\d{2}:\d{2}$/.test(sendTime)} onClick={() => void save()}>
          {saving ? '保存中…' : '保存'}
        </Button>
      </DialogFooter>
    </div>
  )
}
