import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { isUsableIdentity, resolveRunAccount, type ScheduleDto } from '@cairn/shared'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { updateScenario } from '@/lib/scenarios-api'
import { fetchSchedules, updateSchedule } from '@/lib/schedules-api'
import { fetchTargetAccounts } from '@/lib/targets-api'
import { newUuid } from '@/lib/uuid'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { accountOptionLabel } from '@/features/runs/target-account'

/**
 * 场景运行账号：存在场景上、不随版本，改了立即生效。
 * 调度在保存时就冻结了账号，不会自动跟着改；这里列出冻结旧账号的调度，由用户勾选后一并更新。
 */
export function ScenarioRunAccountSettings({
  scenarioId,
  targetId,
  runAccountId,
  disabled,
  showLabel = true,
}: {
  scenarioId: string
  targetId: string
  runAccountId: string | null
  disabled?: boolean
  /** 外层已有「运行账号」小节标题时不再重复显示标签。 */
  showLabel?: boolean
}) {
  const queryClient = useQueryClient()
  const [saving, setSaving] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [rebinding, setRebinding] = useState(false)
  const accountsQuery = useQuery({
    queryKey: ['target-accounts', targetId, { limit: 100 }],
    queryFn: () => fetchTargetAccounts(targetId, { limit: 100 }),
  })
  const schedulesQuery = useQuery({
    queryKey: ['schedules', { scenarioId, consumerKey: 'scenario_run' }],
    queryFn: () => fetchSchedules({ scenarioId, consumerKey: 'scenario_run', limit: 100 }),
  })
  const accounts = useMemo(() => accountsQuery.data?.items ?? [], [accountsQuery.data])
  const usable = accounts.filter(isUsableIdentity)
  const targetDefault = accounts.find((item) => item.isDefault)
  const effectiveId = useMemo(() => {
    const resolved = resolveRunAccount({ scenario: runAccountId, targetDefault: targetDefault?.id ?? null, accounts })
    return resolved.ok ? resolved.accountId : undefined
  }, [accounts, runAccountId, targetDefault])
  const stale: ScheduleDto[] = (schedulesQuery.data?.items ?? []).filter(
    (schedule) => effectiveId !== undefined && schedule.targetAccountId !== effectiveId,
  )
  const nameOf = (accountId: string | null) =>
    accountId ? (accounts.find((item) => item.id === accountId)?.displayName ?? '已删除的账号') : '不指定'

  const change = async (next: string | null) => {
    setSaving(true)
    try {
      await updateScenario(scenarioId, { runAccountId: next })
      toast.success('运行账号已更新，立即生效')
      setSelected(new Set())
      await queryClient.invalidateQueries({ queryKey: ['scenarios', scenarioId] })
      await queryClient.invalidateQueries({ queryKey: ['scenario', scenarioId] })
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '修改运行账号失败')
    } finally {
      setSaving(false)
    }
  }

  // 重新按「场景指定 → 目标默认」冻结：不带账号提交，由服务端按同一顺序取。
  const rebind = async () => {
    setRebinding(true)
    let done = 0
    try {
      for (const schedule of stale.filter((item) => selected.has(item.scheduleId))) {
        if (schedule.definition.consumer.type !== 'scenario_run') continue
        await updateSchedule(schedule.scheduleId, {
          expectedRevision: schedule.revision,
          idempotencyKey: `rebind-${newUuid()}`,
          definition: { ...schedule.definition, consumer: { ...schedule.definition.consumer, accountBinding: {} } },
        })
        done += 1
      }
      toast.success(`已更新 ${done} 个调度的运行账号`)
      setSelected(new Set())
      await queryClient.invalidateQueries({ queryKey: ['schedules'] })
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '更新调度失败')
    } finally {
      setRebinding(false)
    }
  }

  return (
    <div className='space-y-4'>
      <div className='space-y-1.5'>
        {showLabel ? <Label htmlFor='scenario-run-account'>运行账号</Label> : null}
        <Select
          value={accountsQuery.isSuccess ? (runAccountId ?? '__default__') : undefined}
          disabled={disabled || saving || !accountsQuery.isSuccess}
          onValueChange={(value) => void change(value === '__default__' ? null : value)}
        >
          <SelectTrigger id='scenario-run-account' aria-label='运行账号' className='w-full'>
            <SelectValue placeholder='正在读取账号…' />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='__default__'>
              {targetDefault ? `跟随目标默认（当前：${accountOptionLabel(targetDefault)}）` : '跟随目标默认（目标未设置默认账号）'}
            </SelectItem>
            {usable.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {accountOptionLabel(item)}
              </SelectItem>
            ))}
            {/* 只有账号列表读成功时才能判断「已停用 / 已删除」，读取失败不做推断。 */}
            {accountsQuery.isSuccess && runAccountId && !usable.some((item) => item.id === runAccountId) ? (
              <SelectItem value={runAccountId} disabled>
                {nameOf(runAccountId)}（已停用）
              </SelectItem>
            ) : null}
          </SelectContent>
        </Select>
        {accountsQuery.isError ? (
          <p className='text-label text-destructive'>无法读取目标账号，请稍后刷新重试。</p>
        ) : null}
        <p className='text-label text-muted-foreground'>
          本场景所有步骤都用这个账号运行；运行和试跑时可以临时改选。选「访客」就不登录。运行账号存在场景上，修改后立即生效，不需要发布。
        </p>
      </div>

      {stale.length > 0 ? (
        <div className='space-y-2 rounded-md border border-border bg-surface-subtle p-3'>
          <p className='text-label font-medium text-text-primary'>
            有 {stale.length} 个调度保存时冻结的是其他账号，不会自动跟着改
          </p>
          <ul className='space-y-1.5'>
            {stale.map((schedule) => (
              <li key={schedule.scheduleId} className='flex items-center gap-2 text-label'>
                <Checkbox
                  id={`rebind-${schedule.scheduleId}`}
                  checked={selected.has(schedule.scheduleId)}
                  disabled={disabled || rebinding}
                  onCheckedChange={(checked) =>
                    setSelected((current) => {
                      const next = new Set(current)
                      if (checked === true) next.add(schedule.scheduleId)
                      else next.delete(schedule.scheduleId)
                      return next
                    })
                  }
                />
                <label htmlFor={`rebind-${schedule.scheduleId}`} className='min-w-0 truncate text-text-secondary'>
                  {schedule.name ?? schedule.objectLabel ?? schedule.scheduleId.slice(0, 8)}
                  <span className='text-muted-foreground'>（当前：{nameOf(schedule.targetAccountId)}）</span>
                </label>
              </li>
            ))}
          </ul>
          <Button
            size='sm'
            variant='outline'
            disabled={disabled || selected.size === 0}
            loading={rebinding}
            onClick={() => void rebind()}
          >
            一并更新这些调度
          </Button>
        </div>
      ) : null}
    </div>
  )
}
