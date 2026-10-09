import { and, eq, isNull } from 'drizzle-orm'
import {
  accountAllowsBusiness,
  accountSourceSubject,
  resolveRunAccount,
  type AccountSource,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { schemaFor } from '../native.js'
import { badRequest, conflict } from './errors.js'

export type RunAccountChoice = { accountId?: string; source?: AccountSource }

/**
 * 按「本次指定 → 场景指定 → 场景集默认 → 目标默认 → 唯一可用」取运行账号。
 * 本次指定的账号由调用方按原有规则校验（不属于目标、停用、仅知识采集各有错误码）；
 * 其余各层取到的账号不可用时按来源报 RUN_ACCOUNT_DISABLED，不偷偷落到下一层。
 */
export async function resolveRunAccountChoice(
  db: Db,
  input: {
    targetId: string
    requestedAccountId?: string | null
    scenarioId?: string
    /** 调用方已读到场景行时直接给出，免得再查一次；undefined 表示按 scenarioId 读取。 */
    scenarioRunAccountId?: string | null
    suiteDefaultAccountId?: string | null
    /**
     * 场景是否含浏览器步骤。为 false 时只认本次指定，各层默认一律不套：不开浏览器就不建会话，
     * 自动绑账号只会给领取与占用添约束。缺省按需要处理。
     */
    needsBrowser?: boolean
  },
): Promise<RunAccountChoice> {
  if (input.requestedAccountId) return { accountId: input.requestedAccountId, source: 'explicit' }
  if (input.needsBrowser === false) return {}
  const { targets, targetAccounts, scenarios } = schemaFor(db)
  let scenarioRunAccountId = input.scenarioRunAccountId
  if (scenarioRunAccountId === undefined && input.scenarioId) {
    const [scenario] = await db
      .select({ runAccountId: scenarios.runAccountId })
      .from(scenarios)
      .where(eq(scenarios.id, input.scenarioId))
      .limit(1)
    scenarioRunAccountId = scenario?.runAccountId ?? null
  }
  const [target] = await db
    .select({ defaultAccountId: targets.defaultAccountId })
    .from(targets)
    .where(eq(targets.id, input.targetId))
    .limit(1)
  const accounts = await db
    .select({
      id: targetAccounts.id,
      displayName: targetAccounts.displayName,
      identityKind: targetAccounts.identityKind,
      status: targetAccounts.status,
      usage: targetAccounts.usage,
      deletedAt: targetAccounts.deletedAt,
    })
    .from(targetAccounts)
    .where(and(eq(targetAccounts.targetId, input.targetId), isNull(targetAccounts.deletedAt)))
  const resolved = resolveRunAccount({
    scenario: scenarioRunAccountId,
    suite: input.suiteDefaultAccountId,
    targetDefault: target?.defaultAccountId ?? null,
    accounts,
  })
  if (!resolved.ok) {
    throw badRequest('RUN_ACCOUNT_REQUIRED', '目标系统有多个可用账号且未设置默认账号，请指定本次使用的目标账号')
  }
  if (!resolved.accountId) return {}
  if (resolved.source === 'only') return { accountId: resolved.accountId, source: 'only' }
  const subject = accountSourceSubject(resolved.source)
  const account = accounts.find((row) => row.id === resolved.accountId)
  if (!account) throw conflict('RUN_ACCOUNT_DISABLED', `${subject}已删除，请改选运行账号`)
  if (account.status !== 'active') {
    throw conflict('RUN_ACCOUNT_DISABLED', `${subject}「${account.displayName}」已停用`)
  }
  if (!accountAllowsBusiness(account.usage)) {
    throw conflict('RUN_ACCOUNT_DISABLED', `${subject}「${account.displayName}」仅用于知识采集，不能跑场景`)
  }
  return { accountId: account.id, source: resolved.source }
}
