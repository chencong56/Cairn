import { describe, it, expect } from 'vitest'
import {
  detectLoginCleansingCandidates,
  detectMisfireCleansingCandidates,
} from '../cleansing-predicates.js'
import type { DemonstrationFact, DemonstrationObservation } from '@cairn/shared'

const defaultObservation: DemonstrationObservation = {
  status: 'omitted',
  reason: 'test',
}

function makeFact(
  partial: Partial<DemonstrationFact> & Pick<DemonstrationFact, 'id' | 'sequence' | 'action' | 'kind'>,
): DemonstrationFact {
  return {
    sourceIds: [partial.id],
    pageId: null,
    documentEpoch: null,
    framePath: null,
    timestampPrecision: 'millisecond',
    data: {},
    before: defaultObservation,
    after: defaultObservation,
    diagnostics: [],
    ...partial,
  }
}

describe('cleansing-predicates', () => {
  describe('detectLoginCleansingCandidates (方案 4.1)', () => {
    it('无活跃认证配置时，不计算也不返回任何项', () => {
      const facts: DemonstrationFact[] = [
        makeFact({
          id: 'step-1',
          sequence: 0,
          kind: 'action',
          action: 'fill',
          data: {
            url: 'https://example.com/login',
            targetDescription: '输入口令',
            value: { state: 'redacted', reason: 'password' },
          },
        }),
      ]
      expect(detectLoginCleansingCandidates(facts, null)).toEqual([])
      expect(detectLoginCleansingCandidates(facts, { hasActiveAuthProfile: false, loginUrl: 'https://example.com/login' })).toEqual([])
    })

    it('有活跃认证配置且命中连续登录前缀时，返回建议 id 列表', () => {
      const facts: DemonstrationFact[] = [
        // 观察事实跳过，不打断
        makeFact({
          id: 'obs-0',
          sequence: 0,
          kind: 'observation',
          action: 'observe',
        }),
        // 步骤 1：访问登录页
        makeFact({
          id: 'step-1',
          sequence: 1,
          kind: 'action',
          action: 'navigate',
          data: { url: 'https://snc.example.com/login' },
        }),
        // 步骤 2：密码填充（redacted）
        makeFact({
          id: 'step-2',
          sequence: 2,
          kind: 'action',
          action: 'fill',
          data: {
            targetDescription: '请输入密码',
            value: { state: 'redacted', reason: 'password' },
          },
        }),
        // 步骤 3：点击登录按钮（结束前缀）
        makeFact({
          id: 'step-3',
          sequence: 3,
          kind: 'action',
          action: 'click',
          data: { targetDescription: '点击登录按钮' },
        }),
        // 步骤 4：业务点击（不属于前缀）
        makeFact({
          id: 'step-4',
          sequence: 4,
          kind: 'action',
          action: 'click',
          data: { targetDescription: '点击工单查询' },
        }),
      ]

      const candidates = detectLoginCleansingCandidates(facts, {
        hasActiveAuthProfile: true,
        loginUrl: 'https://snc.example.com/login',
      })
      expect(candidates).toEqual(['step-1', 'step-2', 'step-3'])
    })

    it('前缀若不含口令填充，则不触发提示（防误杀普通业务操作）', () => {
      const facts: DemonstrationFact[] = [
        makeFact({
          id: 'step-1',
          sequence: 0,
          kind: 'action',
          action: 'click',
          data: { targetDescription: '查看登录日志' },
        }),
      ]

      const candidates = detectLoginCleansingCandidates(facts, {
        hasActiveAuthProfile: true,
        loginUrl: 'https://snc.example.com/login',
      })
      expect(candidates).toEqual([])
    })

    it('定位候选里的口令文本也算登录前缀', () => {
      const facts: DemonstrationFact[] = [
        makeFact({
          id: 'step-1',
          sequence: 0,
          kind: 'action',
          action: 'fill',
          data: {
            value: { state: 'redacted', reason: 'password' },
            target: { framePath: [], candidates: [{ by: 'label', value: '密码' }] },
          },
        }),
      ]
      expect(
        detectLoginCleansingCandidates(facts, { hasActiveAuthProfile: true, loginUrl: null }),
      ).toEqual(['step-1'])
    })

    it('禁止用 auth 子串匹配业务地址', () => {
      const facts: DemonstrationFact[] = [
        makeFact({
          id: 'step-1',
          sequence: 0,
          kind: 'action',
          action: 'navigate',
          data: { url: 'https://snc.example.com/authorizations' },
        }),
      ]
      const candidates = detectLoginCleansingCandidates(facts, {
        hasActiveAuthProfile: true,
        loginUrl: 'https://snc.example.com/login',
      })
      expect(candidates).toEqual([])
    })
  })

  describe('detectMisfireCleansingCandidates (方案 4.2)', () => {
    it('相邻两次点击同目标、<500ms、且页面未变时，剔除后一次', () => {
      const now = Date.now()
      const facts: DemonstrationFact[] = [
        makeFact({
          id: 'click-1',
          sequence: 0,
          kind: 'action',
          action: 'click',
          documentEpoch: 'epoch-1',
          observedAt: new Date(now).toISOString(),
          data: { targetDescription: '提交按钮' },
          after: { status: 'captured', url: 'https://snc.example.com/form', observedAt: new Date(now).toISOString() },
        }),
        // 观察事实不拆开前后动作对
        makeFact({
          id: 'obs-1',
          sequence: 1,
          kind: 'observation',
          action: 'observe',
          documentEpoch: 'epoch-1',
        }),
        makeFact({
          id: 'click-2',
          sequence: 2,
          kind: 'action',
          action: 'click',
          documentEpoch: 'epoch-1',
          observedAt: new Date(now + 200).toISOString(),
          data: { targetDescription: '提交按钮' },
          before: { status: 'captured', url: 'https://snc.example.com/form', observedAt: new Date(now + 200).toISOString() },
          after: { status: 'captured', url: 'https://snc.example.com/form', observedAt: new Date(now + 200).toISOString() },
        }),
      ]

      const misfires = detectMisfireCleansingCandidates(facts)
      expect(misfires).toEqual(['click-2'])
    })

    it('间隔 >= 500ms 时不建议剔除', () => {
      const now = Date.now()
      const facts: DemonstrationFact[] = [
        makeFact({
          id: 'click-1',
          sequence: 0,
          kind: 'action',
          action: 'click',
          documentEpoch: 'epoch-1',
          observedAt: new Date(now).toISOString(),
          data: { targetDescription: '提交按钮' },
          after: { status: 'captured', url: 'https://snc.example.com/form', observedAt: new Date(now).toISOString() },
        }),
        makeFact({
          id: 'click-2',
          sequence: 1,
          kind: 'action',
          action: 'click',
          documentEpoch: 'epoch-1',
          observedAt: new Date(now + 600).toISOString(),
          data: { targetDescription: '提交按钮' },
          before: { status: 'captured', url: 'https://snc.example.com/form', observedAt: new Date(now + 600).toISOString() },
        }),
      ]

      const misfires = detectMisfireCleansingCandidates(facts)
      expect(misfires).toEqual([])
    })

    it('aiTap 连点与键序不同的同一目标也建议剔除', () => {
      const now = Date.now()
      const facts: DemonstrationFact[] = [
        makeFact({
          id: 'tap-1',
          sequence: 0,
          kind: 'action',
          action: 'aiTap',
          observedAt: new Date(now).toISOString(),
          data: { target: { framePath: [], candidates: [{ by: 'text', value: '提交' }] } },
          after: { status: 'captured', url: 'https://snc.example.com/form', observedAt: new Date(now).toISOString() },
        }),
        makeFact({
          id: 'tap-2',
          sequence: 1,
          kind: 'action',
          action: 'aiTap',
          observedAt: new Date(now + 120).toISOString(),
          data: { target: { candidates: [{ value: '提交', by: 'text' }], framePath: [] } },
          before: { status: 'captured', url: 'https://snc.example.com/form', observedAt: new Date(now + 120).toISOString() },
        }),
      ]
      expect(detectMisfireCleansingCandidates(facts)).toEqual(['tap-2'])
    })

    it('页面 URL 已变化时不建议剔除', () => {
      const now = Date.now()
      const facts: DemonstrationFact[] = [
        makeFact({
          id: 'click-1',
          sequence: 0,
          kind: 'action',
          action: 'click',
          documentEpoch: 'epoch-1',
          observedAt: new Date(now).toISOString(),
          data: { targetDescription: '下一页' },
          after: { status: 'captured', url: 'https://snc.example.com/page/1', observedAt: new Date(now).toISOString() },
        }),
        makeFact({
          id: 'click-2',
          sequence: 1,
          kind: 'action',
          action: 'click',
          documentEpoch: 'epoch-1',
          observedAt: new Date(now + 200).toISOString(),
          data: { targetDescription: '下一页' },
          before: { status: 'captured', url: 'https://snc.example.com/page/2', observedAt: new Date(now + 200).toISOString() },
        }),
      ]

      const misfires = detectMisfireCleansingCandidates(facts)
      expect(misfires).toEqual([])
    })
  })
})
