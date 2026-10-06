import { describe, expect, it } from 'vitest'
import { canonicalJson } from '../canonical.js'
import { describeLocatorCandidates, sanitizeLocatorLabel, crossCheckMatches, isCrossCheckContainerTag } from '../resolution-policy.js'
import { snapshotDigestPayload } from '../digest-payload.js'
import { locatorPlanPreset } from '../locator-plan.js'
import { locatorPlansNeedAiExecute, stepsNeedLocatorAiExecute } from '../locator-resolution.js'
import { FACTORY_PLATFORM_CONFIG } from '../platform-config.js'
import type { RunSnapshot } from '../run.js'
import { targetDescriptorSchema } from '../target-descriptor.js'
import { waitInputSchema, type Step } from '../step.js'

const click = (id: string, extra: Partial<Step> & { input: Step extends { type: 'click' } ? never : object } | { input: { target: object } }): Step =>
  ({
    id,
    name: '点击',
    type: 'click',
    effectType: 'SIDE_EFFECT',
    ...extra,
  }) as Step

describe('统一目标解析契约', () => {
  it('候选与语义任填其一，都缺则拒绝，css 仍只能最后一档', () => {
    expect(
      targetDescriptorSchema.parse({ semantic: '查询按钮' }).candidates,
    ).toEqual([])
    expect(
      targetDescriptorSchema.parse({ candidates: [{ by: 'text', value: '查询' }] }).semantic,
    ).toBeUndefined()
    expect(() => targetDescriptorSchema.parse({ candidates: [] })).toThrow(/至少提供一项/)
    expect(() =>
      targetDescriptorSchema.parse({
        candidates: [
          { by: 'css', value: '#a' },
          { by: 'text', value: '查询' },
        ],
      }),
    ).toThrow(/最后一档/)
  })

  it('无 semantic 的目标 canonicalJson 不含该键', () => {
    const parsed = targetDescriptorSchema.parse({
      candidates: [{ by: 'role', value: 'button', name: '查询' }],
    })
    expect(canonicalJson(parsed)).toBe(
      canonicalJson({
        framePath: [],
        candidates: [{ by: 'role', value: 'button', name: '查询' }],
      }),
    )
  })

  it('实际会走模型路线的运行才需要 AI 执行权限', () => {
    const step = click('00000000-0000-4000-8000-000000000001', {
      input: { target: { candidates: [{ by: 'text', value: '查询' }] } },
    })
    const open = {
      ...FACTORY_PLATFORM_CONFIG,
      browserAi: { ...FACTORY_PLATFORM_CONFIG.browserAi, enabled: true },
    }
    expect(stepsNeedLocatorAiExecute({ steps: [step], document: open })).toBe(false)
    expect(stepsNeedLocatorAiExecute({
      steps: [step],
      document: open,
      scenarioPlan: locatorPlanPreset('rule_text'),
    })).toBe(true)
    expect(stepsNeedLocatorAiExecute({ steps: [step], document: FACTORY_PLATFORM_CONFIG })).toBe(false)
    expect(locatorPlansNeedAiExecute({
      [step.id]: { requested: ['rule'], actual: ['rule'], skipped: [], allowed: ['rule'], source: 'platform' },
    })).toBe(false)
  })

  it('等待 semantic 需要描述文本', () => {
    expect(waitInputSchema.parse({ kind: 'semantic', text: '列表已刷出' }).kind).toBe('semantic')
    expect(() => waitInputSchema.parse({ kind: 'semantic' })).toThrow()
  })

  it('交叉确认做文本归一化包含匹配', () => {
    expect(crossCheckMatches(['提交 订单'], [{ by: 'text', value: '提交订单' }])).toBe(true)
    expect(crossCheckMatches(['取消'], [{ by: 'text', value: '提交' }])).toBe(false)
    expect(crossCheckMatches(['确定'], [{ by: 'text', value: '确定按钮' }])).toBe(false)
    expect(crossCheckMatches(['#submit'], [{ by: 'css', value: '#submit' }])).toBe(false)
    expect(isCrossCheckContainerTag('td')).toBe(true)
    expect(isCrossCheckContainerTag('button')).toBe(false)
    expect(describeLocatorCandidates([{ by: 'role', value: 'button', name: '提交' }])).toBe(
      '名为「提交」的按钮',
    )
    expect(sanitizeLocatorLabel(' 配置管理 ')).toBe('配置管理')
    expect(sanitizeLocatorLabel('名为「 配置管理 」的菜单项')).toBe('名为「配置管理」的菜单项')
    expect(describeLocatorCandidates([{ by: 'role', value: 'menuitem', name: ' 配置管理 ' }])).toBe(
      '名为「配置管理」的菜单项',
    )
  })

  it('缺 resolution 的快照摘要载荷不含该键', () => {
    const snapshot = {
      schemaVersion: 1,
      targetId: '00000000-0000-4000-8000-000000000001',
      scenarioId: '00000000-0000-4000-8000-000000000002',
      scenarioVersionId: '00000000-0000-4000-8000-000000000003',
      steps: [],
      input: {},
      policy: {},
      sessionPolicy: {},
      evidencePolicy: {},
      executorVersions: {},
      allowedOrigins: [],
    } as unknown as RunSnapshot
    expect(snapshotDigestPayload(snapshot)).not.toHaveProperty('resolution')
    expect(canonicalJson(snapshotDigestPayload(snapshot))).toBe(
      canonicalJson(snapshotDigestPayload({ ...snapshot, resolution: undefined })),
    )
  })

})
