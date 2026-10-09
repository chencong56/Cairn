import { describe, expect, it } from 'vitest'
import { parseWorkerRoles, workerHasRole, workerReleaseMismatch, workerRoleNames } from '../worker-roles.js'

describe('Worker 角色', () => {
  it('缺省 all；角色名按固定顺序登记；all 不能与其他角色组合', () => {
    const all = parseWorkerRoles(undefined)
    expect(all).toEqual({ executor: true, scheduler: true, maintenance: true, analyst: true })
    expect(workerRoleNames(all)).toEqual(['executor', 'scheduler', 'maintenance', 'analyst'])
    expect(() => parseWorkerRoles('all,executor')).toThrow(/不能再组合/)
    expect(() => parseWorkerRoles('executor,unknown')).toThrow(/只能是/)
    expect(workerRoleNames(parseWorkerRoles('scheduler'))).toEqual(['scheduler'])
    expect(workerRoleNames(parseWorkerRoles('maintenance,executor'))).toEqual(['executor', 'maintenance'])
  })

  it('按登记的角色判断能力；没有角色的登记什么都不领', () => {
    expect(workerHasRole(['executor', 'analyst'], 'executor')).toBe(true)
    expect(workerHasRole(['maintenance'], 'executor')).toBe(false)
    expect(workerHasRole([], 'executor')).toBe(false)
    expect(workerHasRole(null, 'executor')).toBe(false)
  })

  it('发布号守卫：控制台一致且与 Worker 不同才判不一致；开发环境与控制台滚动升级中不判', () => {
    expect(workerReleaseMismatch('20261008-a', ['20261009-b', '20261009-b'])).toBe(true)
    expect(workerReleaseMismatch('20261009-b', ['20261009-b'])).toBe(false)
    expect(workerReleaseMismatch(null, ['20261009-b'])).toBe(false)
    expect(workerReleaseMismatch('20261008-a', [])).toBe(false)
    expect(workerReleaseMismatch('20261008-a', [null])).toBe(false)
    expect(workerReleaseMismatch('20261008-a', ['20261008-a', '20261009-b'])).toBe(false)
  })
})
