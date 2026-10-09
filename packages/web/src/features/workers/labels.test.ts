import { describe, expect, it } from 'vitest'
import { classifyWorkerRole, workerLifecycle } from './labels'

describe('workerLifecycle', () => {
  it('把四值状态与心跳新鲜度拆开显示', () => {
    expect(workerLifecycle({ status: 'READY', heartbeatFresh: true })).toEqual({
      tone: 'success',
      label: '就绪',
    })
    expect(workerLifecycle({ status: 'READY', heartbeatFresh: false })).toEqual({
      tone: 'warning',
      label: '就绪登记已过期',
    })
    expect(workerLifecycle({ status: 'DRAINING', heartbeatFresh: true })).toEqual({
      tone: 'warning',
      label: '收尾中',
    })
    expect(workerLifecycle({ status: 'STOPPED', heartbeatFresh: true })).toEqual({
      tone: 'neutral',
      label: '已停止',
    })
    expect(workerLifecycle({ status: 'LOST', heartbeatFresh: false })).toEqual({
      tone: 'error',
      label: '失联',
    })
  })
})

describe('classifyWorkerRole', () => {
  it('按登记的角色归类：四个角色齐全为全功能，带执行角色按执行器，其余取所登记的角色', () => {
    expect(classifyWorkerRole({ workerId: 'node-a', roles: ['executor', 'scheduler', 'maintenance', 'analyst'] })).toBe('monolithic')
    expect(classifyWorkerRole({ workerId: 'node-b', roles: ['executor', 'maintenance'] })).toBe('executor')
    expect(classifyWorkerRole({ workerId: 'cairn-worker-executor-0', roles: ['scheduler'] })).toBe('scheduler')
  })

  it('没有登记角色的旧记录按 workerId 识别 4 角色与单机全能兜底', () => {
    expect(classifyWorkerRole({ workerId: 'local-worker-executor', roles: [] })).toBe('executor')
    expect(classifyWorkerRole({ workerId: 'cairn-worker-executor-0', roles: [] })).toBe('executor')
    expect(classifyWorkerRole({ workerId: 'local-worker-scheduler', roles: [] })).toBe('scheduler')
    expect(classifyWorkerRole({ workerId: 'cairn-worker-scheduler-1', roles: [] })).toBe('scheduler')
    expect(classifyWorkerRole({ workerId: 'local-worker-analyst', roles: [] })).toBe('analyst')
    expect(classifyWorkerRole({ workerId: 'cairn-worker-analyst-2', roles: [] })).toBe('analyst')
    expect(classifyWorkerRole({ workerId: 'local-worker-maintenance', roles: [] })).toBe('maintenance')
    expect(classifyWorkerRole({ workerId: 'cairn-worker-maintenance-0', roles: [] })).toBe('maintenance')
    expect(classifyWorkerRole({ workerId: 'local-worker', roles: [] })).toBe('monolithic')
    expect(classifyWorkerRole({ workerId: 'worker-1', roles: [] })).toBe('monolithic')
  })
})

