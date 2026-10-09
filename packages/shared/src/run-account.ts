import { z } from 'zod'
import { accountAllowsBusiness, type AccountUsage } from './account-usage.js'

/**
 * 访客也是一个账号（每个目标至多一个、不带凭据），因此「用访客还是登录」等于「用哪个账号」。
 * 运行身份不单独设置，由所选账号的身份类型推出。
 */
export const IDENTITY_KINDS = ['credential', 'visitor'] as const
export type IdentityKind = (typeof IDENTITY_KINDS)[number]
export const identityKindSchema = z.enum(IDENTITY_KINDS)
export const IDENTITY_KIND_LABELS: Record<IdentityKind, string> = { credential: '登录账号', visitor: '访客' }
export const DEFAULT_VISITOR_DISPLAY_NAME = '访客'

export const RUN_AS_VALUES = ['login', 'visitor'] as const
export type RunAs = (typeof RUN_AS_VALUES)[number]
export const runAsSchema = z.enum(RUN_AS_VALUES)

export function runAsForIdentity(kind: IdentityKind | string | null | undefined): RunAs {
  return kind === 'visitor' ? 'visitor' : 'login'
}

/** 快照缺少 runAs 的历史运行一律按登录解释。 */
export function isVisitorRun(snapshot: { runAs?: RunAs | null } | null | undefined): boolean {
  return snapshot?.runAs === 'visitor'
}

/** 运行账号是从取值顺序的哪一层取到的，用于复盘与展示。 */
export const ACCOUNT_SOURCES = ['explicit', 'scenario', 'suite', 'target_default', 'only'] as const
export type AccountSource = (typeof ACCOUNT_SOURCES)[number]
export const accountSourceSchema = z.enum(ACCOUNT_SOURCES)
export const ACCOUNT_SOURCE_LABELS: Record<AccountSource, string> = {
  explicit: '本次指定',
  scenario: '场景指定',
  suite: '场景集默认',
  target_default: '目标默认',
  only: '唯一可用',
}

export type RunAccountCandidate = {
  id: string
  identityKind?: IdentityKind | null
  status: string
  usage?: AccountUsage | string | null
  deletedAt?: Date | string | null
}

/** 可用身份：启用、未删除、可用于业务的登录账号，加上启用的访客。 */
export function isUsableIdentity(account: RunAccountCandidate): boolean {
  return !account.deletedAt && account.status === 'active' && accountAllowsBusiness(account.usage)
}

export type RunAccountResolution =
  | { ok: true; accountId: string; source: AccountSource }
  /** 目标没有任何可用身份，也没有任何一层指定：沿用现状，不带账号建 Run。 */
  | { ok: true; accountId: undefined; source: undefined }
  | { ok: false; code: 'RUN_ACCOUNT_REQUIRED' }

/**
 * 按「本次指定 → 场景指定 → 场景集默认 → 目标默认 → 唯一可用」取运行账号。
 * 只选层，不校验所选账号是否可用：已停用、已删除或不属于该目标由调用方按来源报错，
 * 不偷偷落到下一层。
 */
export function resolveRunAccount(input: {
  explicit?: string | null
  scenario?: string | null
  suite?: string | null
  targetDefault?: string | null
  accounts: readonly RunAccountCandidate[]
}): RunAccountResolution {
  const layers: Array<[AccountSource, string | null | undefined]> = [
    ['explicit', input.explicit],
    ['scenario', input.scenario],
    ['suite', input.suite],
    ['target_default', input.targetDefault],
  ]
  for (const [source, accountId] of layers) {
    if (accountId) return { ok: true, accountId, source }
  }
  const usable = input.accounts.filter(isUsableIdentity)
  if (usable.length === 1) return { ok: true, accountId: usable[0]!.id, source: 'only' }
  if (usable.length === 0) return { ok: true, accountId: undefined, source: undefined }
  return { ok: false, code: 'RUN_ACCOUNT_REQUIRED' }
}

export function accountSourceSubject(source: AccountSource | undefined): string {
  switch (source) {
    case 'scenario':
      return '场景指定的运行账号'
    case 'suite':
      return '场景集默认账号'
    case 'target_default':
      return '目标默认账号'
    case 'only':
      return '目标唯一可用账号'
    default:
      return '指定的目标账号'
  }
}
