import { useQuery } from '@tanstack/react-query'
import {
  ACCOUNT_SOURCE_LABELS,
  accountSourceSubject,
  isUsableIdentity,
  resolveRunAccount,
  type AccountSource,
  type TargetAccountDto,
} from '@cairn/shared'
import { fetchTargetAccounts } from '@/lib/targets-api'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { accountOptionLabel } from './target-account'

export type RunAccountDefault =
  | { kind: 'resolved'; account: TargetAccountDto; source: AccountSource }
  /** 取到的账号已停用、仅知识采集或已删除：按来源报错，不偷偷落到下一层。 */
  | { kind: 'unavailable'; source: AccountSource; message: string }
  /** 有多个可用身份、目标没设默认、场景也没指定。 */
  | { kind: 'required' }
  /** 目标没有任何可用身份。 */
  | { kind: 'none' }

/**
 * 运行账号的取值顺序与服务端一致：本次指定 → 场景指定 → 目标默认 → 唯一可用。
 * 用户不改选时请求里不带账号，由服务端按同一顺序取，运行快照里的来源才准确。
 */
export function useRunAccountChoice(input: {
  targetId: string | undefined
  scenarioRunAccountId?: string | null
  enabled: boolean
}) {
  const accountsQuery = useQuery({
    queryKey: ['target-accounts', input.targetId, { limit: 100 }],
    queryFn: () => fetchTargetAccounts(input.targetId!, { limit: 100 }),
    enabled: input.enabled && Boolean(input.targetId),
  })
  const accounts = accountsQuery.data?.items ?? []
  const usable = accounts.filter(isUsableIdentity)
  let defaultChoice: RunAccountDefault = { kind: 'none' }
  if (accountsQuery.data) {
    const resolved = resolveRunAccount({
      scenario: input.scenarioRunAccountId ?? null,
      targetDefault: accounts.find((item) => item.isDefault)?.id ?? null,
      accounts,
    })
    if (!resolved.ok) defaultChoice = { kind: 'required' }
    else if (resolved.accountId) {
      const account = accounts.find((item) => item.id === resolved.accountId)
      const subject = accountSourceSubject(resolved.source)
      if (!account) {
        defaultChoice = { kind: 'unavailable', source: resolved.source, message: `${subject}已删除，请改选运行账号。` }
      } else if (!isUsableIdentity(account)) {
        defaultChoice = {
          kind: 'unavailable',
          source: resolved.source,
          message: `${subject}「${account.displayName}」已停用或仅用于知识采集，请改选运行账号。`,
        }
      } else {
        defaultChoice = { kind: 'resolved', account, source: resolved.source }
      }
    }
  }
  return { accountsQuery, accounts, usable, defaultChoice }
}

/** 本次实际会用的账号：用户改选的优先，否则用默认值。 */
export function effectiveRunAccount(
  choice: ReturnType<typeof useRunAccountChoice>,
  selectedId: string,
): TargetAccountDto | undefined {
  if (selectedId) return choice.accounts.find((item) => item.id === selectedId)
  return choice.defaultChoice.kind === 'resolved' ? choice.defaultChoice.account : undefined
}

export function RunAccountField({
  choice,
  value,
  onChange,
  needsAccount,
}: {
  choice: ReturnType<typeof useRunAccountChoice>
  /** '' 表示按默认顺序取。 */
  value: string
  onChange: (value: string) => void
  needsAccount: boolean
}) {
  const { usable, defaultChoice, accountsQuery } = choice
  if (accountsQuery.isPending) {
    return <p className='text-label text-muted-foreground'>正在读取运行账号…</p>
  }
  const effective = effectiveRunAccount(choice, value)
  const defaultAccount = defaultChoice.kind === 'resolved' ? defaultChoice.account : undefined
  const defaultSource = defaultChoice.kind === 'resolved' ? ACCOUNT_SOURCE_LABELS[defaultChoice.source] : ''
  const kindChanged =
    Boolean(value) &&
    defaultAccount !== undefined &&
    effective !== undefined &&
    (effective.identityKind === 'visitor') !== (defaultAccount.identityKind === 'visitor')

  // 只有一个可用身份：不让人选，但必须看得到这次用哪个账号跑。
  if (usable.length <= 1) {
    return (
      <div className='space-y-1'>
        <Label>运行账号</Label>
        <p className='text-body text-text-primary'>
          {usable[0] ? accountOptionLabel(usable[0]) : needsAccount ? '没有可用的目标账号' : '不需要账号'}
        </p>
      </div>
    )
  }

  return (
    <div className='space-y-1.5'>
      <Label>运行账号</Label>
      <Select value={value || '__default__'} onValueChange={(next) => onChange(next === '__default__' ? '' : next)}>
        <SelectTrigger className='w-full' aria-label='运行账号'>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value='__default__'>
            {defaultAccount ? `${accountOptionLabel(defaultAccount)} · ${defaultSource}` : '请选择运行账号'}
          </SelectItem>
          {usable
            .filter((item) => item.id !== defaultAccount?.id)
            .map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {accountOptionLabel(item)}
                {item.identityKind !== 'visitor' && !item.hasPassword ? ' · 未保存口令' : ''}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
      {defaultChoice.kind === 'required' && !value ? (
        <p className='text-label text-muted-foreground'>目标有多个账号且没有设置默认账号，请为这次运行选一个；也可以到目标详情设置默认账号。</p>
      ) : null}
      {defaultChoice.kind === 'unavailable' && !value ? (
        <p className='text-label text-destructive'>{defaultChoice.message}</p>
      ) : null}
      {kindChanged && defaultAccount && effective ? (
        <p className='text-label text-status-warning-foreground'>
          本场景默认以{defaultAccount.identityKind === 'visitor' ? '访客' : '登录账号'}运行，这次将以
          {effective.identityKind === 'visitor' ? '访客' : '登录账号'}运行。
        </p>
      ) : null}
    </div>
  )
}
