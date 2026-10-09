import { describe, expect, it } from 'vitest'
import {
  createTargetBodySchema,
  isUsableIdentity,
  isVisitorRun,
  resolveRunAccount,
  runAsForIdentity,
  updateScenarioBodySchema,
  updateTargetBodySchema,
  type RunAccountCandidate,
} from '../index.js'

const visitor: RunAccountCandidate = { id: 'v', identityKind: 'visitor', status: 'active', usage: 'business' }
const alice: RunAccountCandidate = { id: 'a', identityKind: 'credential', status: 'active', usage: 'business' }
const bob: RunAccountCandidate = { id: 'b', identityKind: 'credential', status: 'active', usage: 'both' }
const mapOnly: RunAccountCandidate = { id: 'm', identityKind: 'credential', status: 'active', usage: 'map' }
const disabled: RunAccountCandidate = { id: 'd', identityKind: 'credential', status: 'disabled', usage: 'business' }

describe('运行账号取值顺序：本次指定 → 场景指定 → 场景集默认 → 目标默认 → 唯一可用', () => {
  const accounts = [visitor, alice, bob]

  it('本次指定优先于其他各层', () => {
    expect(
      resolveRunAccount({ explicit: 'a', scenario: 'v', suite: 'b', targetDefault: 'b', accounts }),
    ).toEqual({ ok: true, accountId: 'a', source: 'explicit' })
  })

  it('场景指定排在场景集默认之前', () => {
    expect(resolveRunAccount({ scenario: 'v', suite: 'a', targetDefault: 'b', accounts })).toEqual({
      ok: true,
      accountId: 'v',
      source: 'scenario',
    })
  })

  it('场景跟随目标默认时才用场景集默认', () => {
    expect(resolveRunAccount({ scenario: null, suite: 'a', targetDefault: 'b', accounts })).toEqual({
      ok: true,
      accountId: 'a',
      source: 'suite',
    })
  })

  it('其余都没给时用目标默认', () => {
    expect(resolveRunAccount({ targetDefault: 'b', accounts })).toEqual({
      ok: true,
      accountId: 'b',
      source: 'target_default',
    })
  })

  it('只有一个可用身份时自动用它（无需登录目标只有访客）', () => {
    expect(resolveRunAccount({ accounts: [visitor, mapOnly, disabled] })).toEqual({
      ok: true,
      accountId: 'v',
      source: 'only',
    })
  })

  it('多个可用身份且没有默认：要求指定', () => {
    expect(resolveRunAccount({ accounts })).toEqual({ ok: false, code: 'RUN_ACCOUNT_REQUIRED' })
  })

  it('没有任何可用身份：不带账号', () => {
    expect(resolveRunAccount({ accounts: [mapOnly, disabled] })).toEqual({
      ok: true,
      accountId: undefined,
      source: undefined,
    })
  })

  it('只选层、不校验：场景指定了已停用账号也原样返回，由调用方按来源报错', () => {
    expect(resolveRunAccount({ scenario: 'd', accounts: [...accounts, disabled] })).toEqual({
      ok: true,
      accountId: 'd',
      source: 'scenario',
    })
  })
})

describe('身份与可用性', () => {
  it('可用身份：启用、可用于业务；访客也算', () => {
    expect([visitor, alice, bob, mapOnly, disabled].filter(isUsableIdentity).map((row) => row.id)).toEqual([
      'v',
      'a',
      'b',
    ])
  })

  it('运行身份由账号身份类型推出，缺省按登录', () => {
    expect(runAsForIdentity('visitor')).toBe('visitor')
    expect(runAsForIdentity('credential')).toBe('login')
    expect(runAsForIdentity(undefined)).toBe('login')
    expect(isVisitorRun({ runAs: 'visitor' })).toBe(true)
    expect(isVisitorRun({})).toBe(false)
  })
})

describe('契约', () => {
  it('无需登录的目标不能随创建登记登录账号', () => {
    expect(() =>
      createTargetBodySchema.parse({
        code: 'shop-public',
        name: '公开商城',
        entryUrl: 'https://shop.example/',
        authMethod: 'none',
        account: { displayName: 'x', username: 'x' },
      }),
    ).toThrow(/无需登录/)
    expect(
      createTargetBodySchema.parse({
        code: 'shop-public',
        name: '公开商城',
        entryUrl: 'https://shop.example/',
        authMethod: 'none',
      }).authMethod,
    ).toBe('none')
  })

  it('更新目标可以只改访客开关或默认账号；更新场景可以只改运行账号', () => {
    expect(updateTargetBodySchema.parse({ visitorEnabled: true })).toMatchObject({ visitorEnabled: true })
    expect(updateTargetBodySchema.parse({ defaultAccountId: null })).toMatchObject({ defaultAccountId: null })
    expect(updateScenarioBodySchema.parse({ runAccountId: null })).toEqual({ runAccountId: null })
  })
})
