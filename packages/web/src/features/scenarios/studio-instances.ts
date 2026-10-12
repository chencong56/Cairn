import type { AccountSessionDetail, ActiveSessionOperation, OccupancyActor } from '@cairn/shared'

export type StudioInstance = AccountSessionDetail['instances'][number]

const BUILD_KINDS = new Set(['PREPARE', 'LOGIN', 'VERIFY_AUTH', 'RENEW_AUTH', 'SETTLE_LANDING'])
const ACTIVE_STATUSES = new Set(['QUEUED', 'RUNNING', 'WAITING_FOR_AUTH'])

export function describeOccupancyBy(by: OccupancyActor | null | undefined): string {
  if (!by) return '运行'
  switch (by.kind) {
    case 'user':
      return by.name ? `${by.name} 的运行` : '其他用户的运行'
    case 'schedule':
      return by.name ? `调度《${by.name}》` : '调度运行'
    case 'suite':
      return '套件运行'
    case 'batch':
      return '批量运行'
    case 'service':
      return '服务调用'
    default:
      return '系统任务'
  }
}

/** 切换器里的占用说明：谁在手动操作、谁的运行占用、是否空闲。 */
export function instanceOccupancyText(instance: StudioInstance, myId?: string | null): string {
  if (instance.pendingDestructive) {
    return `${instance.pendingDestructive.requestedByName ?? '有人'} 已请求重建`
  }
  if (instance.occupancy) {
    const by = instance.occupancy.by
    if (instance.occupancy.occupyingRunId) return `${describeOccupancyBy(by)}占用中`
    if (instance.occupancy.purpose === 'AUTH_WAIT') return '等待人工验证'
    return `${by?.name ?? '系统'} 的会话操作中`
  }
  if (instance.manualControl) {
    return instance.manualControl.actorId === myId
      ? '你正在手动操作'
      : `${instance.manualControl.actorName ?? '其他用户'} 正在手动操作`
  }
  if (instance.status !== 'OPEN') return instance.status === 'LOST' ? '已失联' : instance.status
  if (instance.ownerWorkerOnline === false) return '节点离线'
  return '空闲'
}

export type LiveManualHold = { mine: boolean; actorName: string | null }

/** 账号里正在生效的手动操作：本人还是别人。过期的操作权不算。 */
export function findLiveManualHold(
  detail: Pick<AccountSessionDetail, 'instances'> | undefined,
  myId?: string | null,
  nowMs = Date.now(),
): LiveManualHold | null {
  const held = (detail?.instances ?? []).find((item) => {
    if (!item.manualControl) return false
    const expires = Date.parse(item.manualControl.expiresAt)
    return Number.isFinite(expires) ? expires > nowMs : true
  })
  if (!held?.manualControl) return null
  return {
    mine: Boolean(myId && held.manualControl.actorId === myId),
    actorName: held.manualControl.actorName,
  }
}

export function describeQueuedTrialWait(input: {
  hold: LiveManualHold | null
  waitReasonCopy?: string
}): string {
  if (input.hold?.mine) {
    return '试跑还没开始。你正在这个浏览器里手动操作；点画面上的「退出操作」，或稍等系统接管后会自动开始。'
  }
  if (input.hold) {
    return `试跑还没开始。${input.hold.actorName ?? '其他人'} 正在手动操作，结束后会自动开始。`
  }
  if (input.waitReasonCopy) return `你的试跑在排队，等当前实例空出来后自动开始：${input.waitReasonCopy}`
  return '你的试跑在排队，等当前实例空出来后自动开始。'
}

export function isInstanceIdle(instance: StudioInstance): boolean {
  return (
    instance.status === 'OPEN' &&
    !instance.occupancy &&
    !instance.manualControl &&
    !instance.pendingDestructive &&
    instance.ownerWorkerOnline !== false &&
    instance.authState !== 'UNAUTHENTICATED'
  )
}

/**
 * 编排页当前看哪个实例。顺序：上次看的 > 本人手动操作中的 > 本页试跑所在的 > 空闲就绪的 > 第一个。
 * 只在可用（未关闭、未被排空）的实例里选；账号没有实例时返回 null。
 */
export function pickViewInstance(
  detail: Pick<AccountSessionDetail, 'instances'> | undefined,
  input: { preferredId?: string | null; myId?: string | null; runSessionId?: string | null },
): StudioInstance | null {
  const usable = (detail?.instances ?? []).filter((item) => item.status !== 'CLOSED' && item.status !== 'CLOSING')
  if (usable.length === 0) return null
  const byId = (id?: string | null) => (id ? usable.find((item) => item.id === id) : undefined)
  return (
    byId(input.preferredId) ??
    usable.find((item) => item.manualControl?.actorId === input.myId) ??
    byId(input.runSessionId) ??
    usable.find(isInstanceIdle) ??
    usable[0]!
  )
}

/**
 * 把账号级详情投影到选中的实例，让界面其余部分仍按「一个会话」读取。
 * 单实例（含没有实例）时原样返回，行为与改造前一致。
 */
export function projectDetailToInstance(
  detail: AccountSessionDetail | undefined,
  instance: StudioInstance | null,
): AccountSessionDetail | undefined {
  if (!detail || !instance || (detail.instances ?? []).length <= 1) return detail
  const { occupancy, manualControl: _manual, pendingDestructive: _pending, ...sessionFields } = instance
  const ownOps = (detail.activeOperations ?? []).filter((op) => op.sessionId === instance.id)
  const op = ownOps[0] ?? null
  return {
    ...detail,
    session: sessionFields,
    occupancy,
    currentOperation: op
      ? {
          id: op.id,
          kind: op.kind,
          status: op.status,
          reusedRunId: null,
          queueDeadlineAt: op.queueDeadlineAt,
          waitReason: op.waitReason,
          sessionId: op.sessionId,
          requestedBy: op.requestedBy,
        }
      : null,
  }
}

/** 没有实例（或要新建实例）时，可以跟随的进行中建立类操作。 */
export function findFollowableOperation(
  detail: AccountSessionDetail | undefined,
  instance: StudioInstance | null,
): ActiveSessionOperation | null {
  if (!detail) return null
  const candidates = (detail.activeOperations ?? []).filter(
    (op) => BUILD_KINDS.has(op.kind) && ACTIVE_STATUSES.has(op.status) && !op.newInstance,
  )
  if (instance) return candidates.find((op) => op.sessionId === instance.id) ?? null
  return candidates.find((op) => op.sessionId == null) ?? candidates[0] ?? null
}

/** 取消会话操作：发起人，或有 session:dispose 的人；后台操作只有后者。 */
export function canCancelOperation(
  op: { requestedBy: { id: string } | null } | null | undefined,
  input: { myId?: string | null; canDispose: boolean },
): boolean {
  if (!op) return false
  if (op.requestedBy && op.requestedBy.id === input.myId) return true
  return input.canDispose
}

const VIEW_KEY_PREFIX = 'cairn:studio:view-instance:'

export function readPreferredInstance(targetId?: string, accountId?: string): string | null {
  if (!targetId || !accountId) return null
  try {
    return window.localStorage.getItem(`${VIEW_KEY_PREFIX}${targetId}:${accountId}`)
  } catch {
    return null
  }
}

export function writePreferredInstance(targetId: string | undefined, accountId: string | undefined, id: string) {
  if (!targetId || !accountId) return
  try {
    window.localStorage.setItem(`${VIEW_KEY_PREFIX}${targetId}:${accountId}`, id)
  } catch {
    // 浏览器禁用存储时只是记不住上次选择，不影响功能。
  }
}
