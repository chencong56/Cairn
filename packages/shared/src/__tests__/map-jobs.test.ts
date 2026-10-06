import { describe, expect, it } from 'vitest'
import {
  FACTORY_MAP_JOB_POLICY,
  isMapJobRun,
  MAP_JOB_EVIDENCE_POLICY,
  mapJobCommandKey,
  mapJobIdempotencyKey,
  runListQuerySchema,
  targetAccessPolicyUpdateBodySchema,
  targetAccessPolicySchema,
} from '../index.js'

describe('地图作业契约', () => {
  it('工厂作业政策默认关闭', () => {
    expect(FACTORY_MAP_JOB_POLICY.manualJobsEnabled).toBe(false)
    expect(FACTORY_MAP_JOB_POLICY.sliceWorkSeconds).toBe(20)
  })

  it('只读规则更新体不再接受访问范围 rules', () => {
    const base = { expectedRevision: 0, idempotencyKey: 'policy-path-1', reason: '调整只读规则' }
    expect(() => targetAccessPolicyUpdateBodySchema.parse({ ...base, rules: [] })).toThrow()
    expect(targetAccessPolicyUpdateBodySchema.parse({
      ...base,
      readOnlyRequests: [{ method: 'POST', origin: 'https://shop.example', pathPattern: '/api/list' }],
    }).readOnlyRequests).toHaveLength(1)
    expect(() => targetAccessPolicyUpdateBodySchema.parse({
      ...base,
      readOnlyRequests: [{ method: 'POST', origin: 'https://shop.example', pathPattern: 'api/list' }],
    })).toThrow()
  })

  it('策略 rules 已废弃：缺省为空，旧冻结快照带 rules 仍可解析', () => {
    const base = { schemaVersion: 1, policyVersion: 1 }
    expect(targetAccessPolicySchema.parse(base).rules).toEqual([])
    const legacy = targetAccessPolicySchema.parse({
      ...base,
      rules: [{ origin: 'https://shop.example', purpose: 'business_surface', effect: 'allow', pathPrefix: '/orders' }],
    })
    expect(legacy.rules).toHaveLength(1)
  })

  it('非页面数据例外必须有精确请求身份和核实依据，空规则保持旧策略形状', () => {
    const base = { schemaVersion: 1, policyVersion: 1 }
    expect(targetAccessPolicySchema.parse(base).verifiedNonContentRequests).toBeUndefined()
    const rule = { method: 'POST', resourceType: 'xhr', origin: 'https://metrics.example',
      pathPattern: '/collect', evidence: '已核对前端调用，仅上报访问统计，不驱动页面内容' }
    expect(targetAccessPolicySchema.parse({ ...base, verifiedNonContentRequests: [rule] })
      .verifiedNonContentRequests).toEqual([rule])
    for (const invalid of [
      { ...rule, origin: 'https://metrics.example/other' },
      { ...rule, pathPattern: '/collect?kind=page' },
      { ...rule, pathPattern: '/collect/*' },
      { ...rule, resourceType: 'document' },
      { ...rule, evidence: '猜测' },
    ]) expect(targetAccessPolicySchema.safeParse({ ...base, verifiedNonContentRequests: [invalid] }).success).toBe(false)
  })

  it('地图作业证据策略关闭截图与录像', () => {
    expect(MAP_JOB_EVIDENCE_POLICY).toEqual({
      screenshot: 'off',
      video: 'off',
      trace: 'off',
    })
  })

  it('运行列表缺省不含 isMapJob，显式 true 才只看作业', () => {
    expect(runListQuerySchema.parse({}).isMapJob).toBeUndefined()
    expect(runListQuerySchema.parse({ isMapJob: true }).isMapJob).toBe(true)
  })

  it('缺 mapJob 视为用户 Run', () => {
    expect(isMapJobRun({})).toBe(false)
    expect(mapJobIdempotencyKey({
      targetId: '00000000-0000-4000-8000-000000000001',
      targetAccountId: '00000000-0000-4000-8000-000000000002',
      manualId: 'manual-1',
    })).toMatch(/^map:manual:/)
    expect(
      mapJobCommandKey({
        source: 'scheduled',
        targetId: '00000000-0000-4000-8000-000000000001',
        targetAccountId: '00000000-0000-4000-8000-000000000002',
        occurrenceId: '00000000-0000-4000-8000-000000000003',
      }),
    ).toBe('map:scheduled:00000000-0000-4000-8000-000000000003')
  })

  it('授权更新必须带修订和理由', () => {
    expect(() =>
      targetAccessPolicyUpdateBodySchema.parse({
        expectedRevision: 0,
        idempotencyKey: 'policy-1',
      }),
    ).toThrow()
  })
})
