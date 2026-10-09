import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ACTIVE_RUN_STATUSES, type ScenarioDto, type TargetAccountListResponse } from '@cairn/shared'
import { AlertTriangle, Loader2, Play } from 'lucide-react'
import { fetchTargetAccounts } from '@/lib/targets-api'
import { useCan } from '@/hooks/use-permissions'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AccountSessionHint } from '@/features/runs/account-session-hint'
import { RunInputFields, missingRunInput, runInputValues } from '@/features/runs/run-input-fields'
import {
  accountOptionLabel,
  passwordAccounts,
  preferredPasswordAccountId,
  unusableAccountCopy,
  unusableAccountReason,
} from '@/features/runs/target-account'
import { useQuickRunStore } from './quick-run-store'
import type { QuickRunResult } from './use-quick-run'

const ACTIVE = new Set<string>(ACTIVE_RUN_STATUSES)

type AccountChoice = { accountId: string } | { choose: true; preferred: string } | { blocked: string }

/**
 * 账号只在确实需要选择时才问，顺序与服务端开跑一致：场景指定 → 目标默认 → 唯一可用。
 * 都定不下来（多个可用账号且没有默认）才弹气泡，并预选目标默认或首选账号。
 */
function resolveAccount(
  scenario: ScenarioDto,
  targetDefaultAccountId: string | null,
  accounts: TargetAccountListResponse['items'],
): AccountChoice {
  const usable = passwordAccounts(accounts)
  const reason = unusableAccountReason(accounts)
  if (usable.length === 0) return { blocked: reason ? unusableAccountCopy(reason) : '没有可用的目标账号。' }
  const usableId = (id: string | null | undefined) => (id && usable.some((account) => account.id === id) ? id : null)
  const fixed = usableId(scenario.runAccountId) ?? usableId(targetDefaultAccountId)
  if (fixed) return { accountId: fixed }
  if (usable.length === 1) return { accountId: usable[0]!.id }
  return { choose: true, preferred: preferredPasswordAccountId(accounts) }
}

function disabledReason(scenario: ScenarioDto): string | null {
  if (!scenario.latestVersionId) return '还没有发布版本，进入场景发布后再运行'
  if (scenario.status === 'disabled') return '场景已停用'
  return null
}

/**
 * 卡片与列表行上的「运行」：正式运行最新已发布版本。不需要输入、账号也能自动确定时直接发起；
 * 否则在按钮旁弹出轻量气泡补齐。本人发起且仍在进行时变成「查看运行」。
 */
export function ScenarioRunButton({
  scenario,
  targetDefaultAccountId = null,
  start,
  pending,
  onOpenRun,
  onMoreOptions,
}: {
  scenario: ScenarioDto
  /** 目标系统的默认账号（访客身份方案）；没有时为 null。 */
  targetDefaultAccountId?: string | null
  start: (scenario: ScenarioDto, options?: { targetAccountId?: string; input?: Record<string, string> }) => Promise<QuickRunResult>
  pending: boolean
  onOpenRun: (runId: string) => void
  onMoreOptions: (scenario: ScenarioDto) => void
}) {
  const canExecute = useCan('run:execute')
  const canReadTargets = useCan('target:read')
  const queryClient = useQueryClient()
  const ownActive = useQuickRunStore((state) =>
    state.runs.find((run) => run.scenarioId === scenario.id && (!run.status || ACTIVE.has(run.status))),
  )
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)

  if (!canExecute || !canReadTargets) return null

  if (ownActive) {
    return (
      <Button
        variant='outline'
        size='sm'
        onClick={() => onOpenRun(ownActive.runId)}
        className='border-status-info-accent/40 bg-status-info-background text-status-info-foreground hover:bg-status-info-background'
      >
        <span className='relative inline-flex size-1.5'>
          <span className='absolute inset-0 animate-ping rounded-full bg-status-info [animation-duration:1.6s] motion-reduce:animate-none' />
          <span className='relative size-1.5 rounded-full bg-status-info' />
        </span>
        查看运行
      </Button>
    )
  }

  const blocked = disabledReason(scenario)
  const tip = blocked ?? (scenario.draftDirty ? `运行已发布 v${scenario.latestVersionNo}，不含未发布的修改` : `运行已发布 v${scenario.latestVersionNo}`)
  const requirements = scenario.runRequirements

  const loadAccounts = () =>
    queryClient.fetchQuery({
      queryKey: ['target-accounts', scenario.targetId],
      queryFn: () => fetchTargetAccounts(scenario.targetId),
      staleTime: 30_000,
    })

  const onClick = async () => {
    setError(null)
    // 拿不到运行前提（旧接口）时一律弹气泡，由用户确认。
    if (!requirements || requirements.inputs.length > 0) {
      setOpen(true)
      return
    }
    if (requirements.needsAccount) {
      setChecking(true)
      try {
        const choice = resolveAccount(scenario, targetDefaultAccountId, (await loadAccounts()).items)
        if (!('accountId' in choice)) {
          setOpen(true)
          return
        }
        const result = await start(scenario, { targetAccountId: choice.accountId })
        if (!result.ok) {
          setError(result.message)
          setOpen(true)
        }
      } catch {
        setOpen(true)
      } finally {
        setChecking(false)
      }
      return
    }
    const result = await start(scenario)
    if (!result.ok) {
      setError(result.message)
      setOpen(true)
    }
  }

  const busy = pending || checking
  const button = (
    <Button
      variant='outline'
      size='sm'
      disabled={Boolean(blocked) || busy}
      aria-busy={busy || undefined}
      aria-label={`运行：${scenario.name}`}
      onMouseEnter={() => {
        if (requirements?.needsAccount) void loadAccounts().catch(() => undefined)
      }}
      onClick={() => void onClick()}
      className={cn(
        'transition-[background-color,border-color,color,scale] active:scale-[0.97] motion-reduce:active:scale-100',
        '[&_svg]:text-primary disabled:[&_svg]:text-muted-foreground',
        'group-hover/card:border-transparent group-hover/card:bg-secondary group-hover/card:text-secondary-foreground group-hover/row:border-transparent group-hover/row:bg-secondary group-hover/row:text-secondary-foreground',
      )}
    >
      {busy ? <Loader2 className='animate-spin motion-reduce:animate-none' /> : <Play />}
      运行
    </Button>
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <span className='inline-flex'>
          <Tooltip>
            <TooltipTrigger asChild>
              {/* 禁用的按钮收不到指针事件，提示挂在外层。 */}
              <span className='inline-flex'>{button}</span>
            </TooltipTrigger>
            <TooltipContent side='top'>{tip}</TooltipContent>
          </Tooltip>
        </span>
      </PopoverAnchor>
      <PopoverContent align='end' className='w-[340px] p-4'>
        {open ? (
          <QuickRunForm
            scenario={scenario}
            targetDefaultAccountId={targetDefaultAccountId}
            initialError={error}
            loadAccounts={loadAccounts}
            onSubmit={async (options) => {
              const result = await start(scenario, options)
              if (result.ok) setOpen(false)
              return result
            }}
            onMoreOptions={() => {
              setOpen(false)
              onMoreOptions(scenario)
            }}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

function QuickRunForm({
  scenario,
  targetDefaultAccountId,
  initialError,
  loadAccounts,
  onSubmit,
  onMoreOptions,
}: {
  scenario: ScenarioDto
  targetDefaultAccountId: string | null
  initialError: string | null
  loadAccounts: () => Promise<TargetAccountListResponse>
  onSubmit: (options: { targetAccountId?: string; input?: Record<string, string> }) => Promise<QuickRunResult>
  onMoreOptions: () => void
}) {
  const requirements = scenario.runRequirements
  const needsAccount = requirements?.needsAccount ?? true
  const inputs = requirements?.inputs ?? []
  const accounts = useQuery({
    queryKey: ['target-accounts', scenario.targetId],
    queryFn: loadAccounts,
    enabled: needsAccount,
    staleTime: 30_000,
  })
  const items = accounts.data?.items ?? []
  const usable = passwordAccounts(items)
  const choice = accounts.data ? resolveAccount(scenario, targetDefaultAccountId, items) : null
  const [accountId, setAccountId] = useState<string>('')
  const selectedAccountId =
    accountId || (choice && 'accountId' in choice ? choice.accountId : choice && 'preferred' in choice ? choice.preferred : '')
  const [values, setValues] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(initialError)
  const [saving, setSaving] = useState(false)
  const blocked = choice && 'blocked' in choice ? choice.blocked : null

  const submit = async () => {
    const missing = missingRunInput(inputs, values)
    if (missing) {
      setError(`请填写「${missing.label}」`)
      return
    }
    if (needsAccount && !selectedAccountId) {
      setError(blocked ?? '请选择目标账号')
      return
    }
    setSaving(true)
    setError(null)
    const result = await onSubmit({
      targetAccountId: needsAccount ? selectedAccountId : undefined,
      input: inputs.length > 0 ? runInputValues(inputs, values) : undefined,
    })
    setSaving(false)
    if (!result.ok) setError(result.message)
  }

  return (
    <form
      className='space-y-3'
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <div>
        <p className='text-body font-semibold text-text-primary'>
          运行已发布 v{scenario.latestVersionNo}
        </p>
        <p className='mt-0.5 truncate text-label text-muted-foreground' title={scenario.name}>
          {scenario.name}
        </p>
      </div>
      {scenario.draftDirty ? (
        <p className='flex items-start gap-1.5 rounded-md bg-status-warning-background px-2.5 py-2 text-label text-status-warning-foreground'>
          <AlertTriangle aria-hidden='true' className='mt-0.5 size-3.5 shrink-0' />
          场景里还有未发布的修改，这次不会带上。
        </p>
      ) : null}
      {needsAccount ? (
        <div className='space-y-1.5'>
          <Label htmlFor={`quick-run-account-${scenario.id}`}>
            目标账号<span className='ml-0.5 text-status-error-foreground'>*</span>
          </Label>
          {accounts.isPending ? (
            <p className='flex items-center gap-1.5 text-label text-muted-foreground'>
              <Loader2 className='size-3.5 animate-spin motion-reduce:animate-none' />
              正在读取账号
            </p>
          ) : blocked ? (
            <p className='text-label text-status-warning-foreground'>{blocked}</p>
          ) : (
            <>
              <Select value={selectedAccountId} onValueChange={setAccountId}>
                <SelectTrigger id={`quick-run-account-${scenario.id}`} className='h-9 w-full'>
                  <SelectValue placeholder='选择目标账号' />
                </SelectTrigger>
                <SelectContent>
                  {usable.map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                      {accountOptionLabel(account)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <AccountSessionHint
                targetId={scenario.targetId}
                account={items.find((account) => account.id === selectedAccountId)}
              />
            </>
          )}
        </div>
      ) : null}
      <RunInputFields
        idPrefix={`quick-run-${scenario.id}`}
        decls={inputs}
        values={values}
        onChange={(key, value) => {
          setValues((current) => ({ ...current, [key]: value }))
          setError(null)
        }}
      />
      {error ? (
        <p role='alert' className='rounded-md bg-status-error-background px-2.5 py-2 text-label text-status-error-foreground'>
          {error}
        </p>
      ) : null}
      <div className='flex items-center justify-between gap-2 pt-1'>
        <Button type='button' variant='link' size='sm' className='h-8 px-0' onClick={onMoreOptions}>
          更多选项…
        </Button>
        <Button type='submit' size='sm' loading={saving} disabled={Boolean(blocked) || (needsAccount && accounts.isPending)}>
          <Play />
          开始运行
        </Button>
      </div>
    </form>
  )
}
