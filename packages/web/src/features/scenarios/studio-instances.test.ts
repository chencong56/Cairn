import { describe, expect, it } from 'vitest'
import type { AccountSessionDetail } from '@cairn/shared'
import {
  canCancelOperation,
  describeOccupancyBy,
  describeQueuedTrialWait,
  findFollowableOperation,
  findLiveManualHold,
  instanceOccupancyText,
  isInstanceIdle,
  pickViewInstance,
  projectDetailToInstance,
  type StudioInstance,
} from './studio-instances'

function instance(id: string, patch: Partial<StudioInstance> = {}): StudioInstance {
  return {
    id,
    status: 'OPEN',
    generation: 1,
    ownerWorkerId: 'w1',
    ownerWorkerOnline: true,
    authState: 'AUTHENTICATED',
    identityState: null,
    observedTier: null,
    lastAuthCheckedAt: null,
    lastAuthSuccessAt: null,
    authValidUntil: null,
    lastExpectedIdentity: null,
    retainUntil: null,
    accountSlot: 1,
    occupancy: null,
    manualControl: null,
    pendingDestructive: null,
    ...patch,
  } as StudioInstance
}

function detail(instances: StudioInstance[], activeOperations: AccountSessionDetail['activeOperations'] = []): AccountSessionDetail {
  return {
    instances,
    activeOperations,
    session: null,
    occupancy: null,
    currentOperation: null,
  } as unknown as AccountSessionDetail
}

describe('pickViewInstance', () => {
  const a = instance('a', { accountSlot: 1, occupancy: { purpose: 'EXECUTION', occupyingRunId: 'r1', occupyingOperationId: null, by: null } })
  const b = instance('b', { accountSlot: 2 })
  const c = instance('c', { accountSlot: 3, manualControl: { actorId: 'me', actorName: 'Me', expiresAt: '2026-01-01T00:00:00.000Z' } })

  it('优先上次看的实例', () => {
    expect(pickViewInstance(detail([a, b, c]), { preferredId: 'a', myId: 'me' })?.id).toBe('a')
  })
  it('其次本人手动操作中的实例，再其次本页试跑所在的实例，再其次空闲实例', () => {
    expect(pickViewInstance(detail([a, b, c]), { myId: 'me' })?.id).toBe('c')
    expect(pickViewInstance(detail([a, b]), { myId: 'me', runSessionId: 'a' })?.id).toBe('a')
    expect(pickViewInstance(detail([a, b]), { myId: 'me' })?.id).toBe('b')
  })
  it('都不空闲时取第一个；已关闭的实例不参与；没有实例返回 null', () => {
    expect(pickViewInstance(detail([a, instance('x', { status: 'CLOSED' })]), {})?.id).toBe('a')
    expect(pickViewInstance(detail([]), {})).toBeNull()
  })
  it('上次看的实例已关闭时回退', () => {
    expect(pickViewInstance(detail([instance('x', { status: 'CLOSED' }), b]), { preferredId: 'x' })?.id).toBe('b')
  })
})

describe('projectDetailToInstance', () => {
  it('单实例原样返回', () => {
    const d = detail([instance('a')])
    expect(projectDetailToInstance(d, d.instances[0]!)).toBe(d)
  })
  it('多实例时把会话、占用和当前操作投影到选中的实例', () => {
    const occupied = instance('a', { occupancy: { purpose: 'EXECUTION', occupyingRunId: 'r1', occupyingOperationId: null, by: null } })
    const idle = instance('b', { accountSlot: 2 })
    const op = {
      id: 'op1',
      kind: 'PREPARE',
      status: 'RUNNING',
      origin: 'USER',
      sessionId: 'b',
      newInstance: false,
      requestedBy: { id: 'u2', name: 'Bob' },
      queueDeadlineAt: '2026-01-01T00:00:00.000Z',
      waitReason: null,
    }
    const d = detail([occupied, idle], [op])
    const forB = projectDetailToInstance(d, idle)!
    expect(forB.session?.id).toBe('b')
    expect(forB.occupancy).toBeNull()
    expect(forB.currentOperation?.id).toBe('op1')
    expect(forB.currentOperation?.requestedBy?.name).toBe('Bob')
    const forA = projectDetailToInstance(d, occupied)!
    expect(forA.session?.id).toBe('a')
    expect(forA.occupancy?.occupyingRunId).toBe('r1')
    expect(forA.currentOperation).toBeNull()
  })
})

describe('findFollowableOperation', () => {
  const op = (patch: Record<string, unknown>) => ({
    id: 'op',
    kind: 'PREPARE',
    status: 'QUEUED',
    origin: 'USER',
    sessionId: null,
    newInstance: false,
    requestedBy: null,
    queueDeadlineAt: '2026-01-01T00:00:00.000Z',
    waitReason: null,
    ...patch,
  })
  it('没有实例时跟随正在新建实例的建立类操作', () => {
    expect(findFollowableOperation(detail([], [op({ id: 'n' })] as never), null)?.id).toBe('n')
  })
  it('按实例匹配；破坏性操作和「新开实例」不跟随', () => {
    const a = instance('a')
    const d = detail([a], [op({ id: 'x', sessionId: 'a' }), op({ id: 'close', kind: 'CLOSE', sessionId: 'a' }), op({ id: 'new', newInstance: true })] as never)
    expect(findFollowableOperation(d, a)?.id).toBe('x')
    expect(findFollowableOperation(detail([], [op({ id: 'new', newInstance: true })] as never), null)).toBeNull()
  })
})

describe('canCancelOperation', () => {
  it('发起人可以；其他人需要 session:dispose；后台操作只有管理员', () => {
    expect(canCancelOperation({ requestedBy: { id: 'me' } }, { myId: 'me', canDispose: false })).toBe(true)
    expect(canCancelOperation({ requestedBy: { id: 'other' } }, { myId: 'me', canDispose: false })).toBe(false)
    expect(canCancelOperation({ requestedBy: { id: 'other' } }, { myId: 'me', canDispose: true })).toBe(true)
    expect(canCancelOperation({ requestedBy: null }, { myId: 'me', canDispose: false })).toBe(false)
    expect(canCancelOperation({ requestedBy: null }, { myId: 'me', canDispose: true })).toBe(true)
  })
})

describe('占用说明', () => {
  it('describeOccupancyBy 区分用户、调度等归属', () => {
    expect(describeOccupancyBy({ kind: 'user', id: 'u', name: 'Alice' })).toBe('Alice 的运行')
    expect(describeOccupancyBy({ kind: 'schedule', id: 's', name: '日报' })).toBe('调度《日报》')
    expect(describeOccupancyBy({ kind: 'service', id: 's', name: null })).toBe('服务调用')
    expect(describeOccupancyBy(null)).toBe('运行')
  })
  it('instanceOccupancyText 说明谁在操作、谁占用、是否空闲', () => {
    const held = instance('a', { manualControl: { actorId: 'u2', actorName: 'Bob', expiresAt: '2026-01-01T00:00:00.000Z' } })
    expect(instanceOccupancyText(held, 'me')).toBe('Bob 正在手动操作')
    expect(instanceOccupancyText(held, 'u2')).toBe('你正在手动操作')
    expect(instanceOccupancyText(instance('b'), 'me')).toBe('空闲')
    expect(isInstanceIdle(held)).toBe(false)
    expect(
      instanceOccupancyText(instance('c', { pendingDestructive: { operationId: 'o', kind: 'CLOSE', requestedByName: 'Bob' } }), 'me'),
    ).toBe('Bob 已请求重建')
  })
  it('findLiveManualHold 区分本人、他人和过期操作权', () => {
    const live = instance('a', {
      manualControl: { actorId: 'me', actorName: '我', expiresAt: new Date(Date.now() + 30_000).toISOString() },
    })
    const other = instance('b', {
      manualControl: { actorId: 'u2', actorName: 'Bob', expiresAt: new Date(Date.now() + 30_000).toISOString() },
    })
    const expired = instance('c', {
      manualControl: { actorId: 'me', actorName: '我', expiresAt: new Date(Date.now() - 1000).toISOString() },
    })
    expect(findLiveManualHold(detail([live]), 'me')).toEqual({ mine: true, actorName: '我' })
    expect(findLiveManualHold(detail([other]), 'me')).toEqual({ mine: false, actorName: 'Bob' })
    expect(findLiveManualHold(detail([expired]), 'me')).toBeNull()
  })
  it('describeQueuedTrialWait 本人持有时指向退出操作', () => {
    expect(describeQueuedTrialWait({ hold: { mine: true, actorName: '我' } })).toContain('退出操作')
    expect(describeQueuedTrialWait({ hold: { mine: false, actorName: 'Bob' } })).toContain('Bob')
    expect(describeQueuedTrialWait({ hold: null, waitReasonCopy: '会话已达上限。' })).toContain('会话已达上限')
  })
})
