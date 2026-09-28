import { canonicalJson, pageLooksLikeLogin, type DemonstrationFact } from '@cairn/shared'

function factHaystack(fact: DemonstrationFact): string {
  const parts = [fact.data.targetDescription, fact.data.instruction]
  for (const candidate of fact.data.target?.candidates ?? []) {
    parts.push(candidate.value, candidate.name)
  }
  return parts.filter(Boolean).join(' ')
}

function isTapFact(fact: DemonstrationFact): boolean {
  return fact.action === 'click' || fact.action === 'aiTap'
}

export interface TargetAuthCleansingContext {
  /** 目标存在当前认证配置（currentAuthProfileRevision 能加载到对应的认证配置行） */
  hasActiveAuthProfile: boolean
  loginUrl?: string | null
}

/**
 * 方案 4.1: 何时提示剔除登录
 * 仅当目标存在当前认证配置时计算。从动作事实头部取连续前缀。
 * 前缀至少含一条口令填充，遇非前缀动作即停止。
 */
export function detectLoginCleansingCandidates(
  facts: DemonstrationFact[],
  authCtx?: TargetAuthCleansingContext | null,
): string[] {
  if (!authCtx?.hasActiveAuthProfile) {
    return []
  }

  const loginUrl = authCtx.loginUrl ?? undefined
  const candidateIds: string[] = []
  let hasPasswordFill = false

  for (const fact of facts) {
    if (fact.kind === 'observation') {
      continue
    }

    let matchesPrefix = false
    let isTerminatingSubmit = false

    // 1. 目标配置了 loginUrl，且该步的 data.url 或 before.url 与 loginUrl 经 pageLooksLikeLogin 判定为同一登录页
    if (loginUrl) {
      const stepUrl = fact.data.url ?? fact.before?.url
      if (stepUrl && pageLooksLikeLogin({ pageUrl: stepUrl, loginUrl })) {
        matchesPrefix = true
      }
    }

    // 2. 动作为 fill，data.value.state === 'redacted'，且目标描述或定位文本匹配 password|passwd|密码|口令
    if (fact.action === 'fill' && fact.data.value?.state === 'redacted') {
      if (/password|passwd|密码|口令/i.test(factHaystack(fact))) {
        matchesPrefix = true
        hasPasswordFill = true
      }
    }

    // 3. 动作为 click 或 keyboard，且步骤名或目标文本匹配 登录|登入|signin|submit。此步纳入后结束前缀。
    if (fact.action === 'click' || fact.action === 'keyboard' || fact.action === 'aiTap') {
      if (/登录|登入|signin|submit/i.test(factHaystack(fact))) {
        matchesPrefix = true
        isTerminatingSubmit = true
      }
    }

    if (matchesPrefix) {
      candidateIds.push(fact.id)
      if (isTerminatingSubmit) {
        break
      }
    } else {
      break
    }
  }

  if (!hasPasswordFill) {
    return []
  }

  return candidateIds
}

/**
 * 方案 4.2: 何时提示清理误触
 * 只考察相邻的点击事实。
 * 满足：同为点击、目标相同、毫秒精度时间差 (0, 500ms)、页面未变 (before.url == after.url, epoch 相等)。
 */
export function detectMisfireCleansingCandidates(facts: DemonstrationFact[]): string[] {
  const misfireIds: string[] = []
  let prevActionFact: DemonstrationFact | null = null

  for (const fact of facts) {
    if (fact.kind === 'observation') {
      continue
    }

    if (!prevActionFact) {
      prevActionFact = fact
      continue
    }

    const first = prevActionFact
    const second = fact
    prevActionFact = fact

    // 1. 两次都是 click (或 ai_action 且操作为 tap)
    const isFirstClick = isTapFact(first)
    const isSecondClick = isTapFact(second)
    if (!isFirstClick || !isSecondClick) {
      continue
    }

    // 2. 目标相同
    let targetsMatch = false
    if (first.data.target && second.data.target) {
      targetsMatch = canonicalJson(first.data.target) === canonicalJson(second.data.target)
    } else if (first.data.targetDescription && second.data.targetDescription) {
      targetsMatch = first.data.targetDescription.trim() === second.data.targetDescription.trim()
    }
    if (!targetsMatch) {
      continue
    }

    // 3. 毫秒精度，时间差大于 0 且小于 500ms
    if (first.timestampPrecision !== 'millisecond' || second.timestampPrecision !== 'millisecond') {
      continue
    }
    if (!first.observedAt || !second.observedAt) {
      continue
    }
    const tFirst = new Date(first.observedAt).getTime()
    const tSecond = new Date(second.observedAt).getTime()
    const deltaMs = tSecond - tFirst
    if (deltaMs <= 0 || deltaMs >= 500) {
      continue
    }

    // 4. 页面未变
    const prevAfterUrl = first.after?.url
    const currBeforeUrl = second.before?.url
    if (!prevAfterUrl || !currBeforeUrl || prevAfterUrl !== currBeforeUrl) {
      continue
    }
    if (first.documentEpoch && second.documentEpoch && first.documentEpoch !== second.documentEpoch) {
      continue
    }

    misfireIds.push(second.id)
  }

  return misfireIds
}
