import { describe, expect, it } from 'vitest'
import { runHealthBucket } from '../run-health.js'

describe('runHealthBucket', () => {
  it('没有正式运行算从未运行', () => {
    expect(runHealthBucket(null)).toBe('never')
    expect(runHealthBucket(undefined)).toBe('never')
  })

  it('未结束的运行一律算运行中，包括等待登录、挂起与待核查', () => {
    for (const status of ['QUEUED', 'RUNNING', 'RECOVERING', 'WAITING_FOR_AUTH', 'HOLDING', 'NEEDS_REVIEW']) {
      expect(runHealthBucket({ status, outcomeStatus: 'FAIL' })).toBe('running')
    }
  })

  it('执行失败或业务结论不通过都算异常', () => {
    expect(runHealthBucket({ status: 'FAILED', outcomeStatus: 'NOT_EVALUATED' })).toBe('failing')
    expect(runHealthBucket({ status: 'SUCCEEDED', outcomeStatus: 'FAIL' })).toBe('failing')
    expect(runHealthBucket({ status: 'CANCELLED', outcomeStatus: 'FAIL' })).toBe('failing')
  })

  it('用户取消不算失败', () => {
    expect(runHealthBucket({ status: 'CANCELLED', outcomeStatus: 'NOT_EVALUATED' })).toBe('cancelled')
  })

  it('执行完成后按业务结论区分需关注与正常', () => {
    expect(runHealthBucket({ status: 'SUCCEEDED', outcomeStatus: 'WARN' })).toBe('warning')
    expect(runHealthBucket({ status: 'SUCCEEDED', outcomeStatus: 'UNKNOWN' })).toBe('warning')
    expect(runHealthBucket({ status: 'SUCCEEDED', outcomeStatus: 'PASS' })).toBe('passing')
    expect(runHealthBucket({ status: 'SUCCEEDED', outcomeStatus: 'NOT_EVALUATED' })).toBe('passing')
    expect(runHealthBucket({ status: 'SUCCEEDED', outcomeStatus: null })).toBe('passing')
  })
})
