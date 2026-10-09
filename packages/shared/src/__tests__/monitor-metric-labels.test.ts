import { describe, expect, it } from 'vitest'
import { ALERTABLE_METRIC_KEYS, FACTORY_ALERT_RULES, type AlertRule } from '../alerting.js'
import { describeAlertRule, describeAlertReading, describeAlertScope, METRIC_GROUP_ORDER, METRIC_LABELS, metricLabel, metricOptionGroups, metricUnitLabel } from '../monitor-metric-labels.js'

describe('监控指标中文名', () => {
  it('每个可告警指标都有中文名与分组（新增指标必须补，不能只显示英文键）', () => {
    const missing = ALERTABLE_METRIC_KEYS.filter((key) => !METRIC_LABELS[key])
    expect(missing).toEqual([])
    for (const key of ALERTABLE_METRIC_KEYS) {
      const entry = METRIC_LABELS[key]!
      expect(entry.label).toMatch(/[一-龥]/)
      expect(METRIC_GROUP_ORDER).toContain(entry.group)
    }
  })

  it('没登记的键退回原样，单位给阈值用', () => {
    expect(metricLabel('worker.status.ready')).toBe('就绪的执行节点数')
    expect(metricLabel('unknown.metric')).toBe('unknown.metric')
    expect(metricLabel(null)).toBe('')
    expect(metricUnitLabel('queue.oldestWaitMs')).toBe('毫秒')
    expect(metricUnitLabel('target.pageHealthRunRate')).toBe('%')
    expect(metricUnitLabel('worker.status.ready')).toBe('数量')
  })
})

describe('告警规则的人话描述与指标分组', () => {
  it('每条出厂规则都能读成一句中文，不出现英文指标键', () => {
    for (const rule of FACTORY_ALERT_RULES) {
      const text = describeAlertRule(rule)
      expect(text).toMatch(/[\u4e00-\u9fa5]/)
      if (rule.kind === 'threshold') expect(text).not.toContain(rule.metricKey)
    }
  })

  it('阈值规则带比较词、单位、持续时间与级别；持续为 0 说一出现就告警', () => {
    const rule = FACTORY_ALERT_RULES.find((item) => item.id === 'factory.target.api_slow') as AlertRule
    expect(describeAlertRule(rule)).toBe('目标系统接口耗时超阈次数（近 1 小时） 大于等于 10，持续 5 分钟后告警（警告）')
    const ms = { ...rule, metricKey: 'queue.oldestWaitMs', threshold: 30000, forSeconds: 0, severity: 'critical' } as AlertRule
    expect(describeAlertRule(ms)).toBe('最久的排队等待时长 大于等于 30000 毫秒，一出现就告警（严重）')
  })

  it('指标下拉按业务分组，每个可告警指标恰好出现一次', () => {
    const groups = metricOptionGroups()
    expect(groups.map((group) => group.group)).not.toContain('其他')
    const flat = groups.flatMap((group) => group.keys)
    expect(new Set(flat).size).toBe(flat.length)
    expect(groups.find((group) => group.group === '目标系统')?.keys).toEqual(['target.apiSlowCount', 'target.apiErrorCount', 'target.pageHealthRunRate'])
  })
})

describe('告警推送的读数与作用对象', () => {
  it('阈值类给指标中文名、当前值与规则；带单位、小数收两位', () => {
    expect(
      describeAlertReading({ metricKey: 'queue.oldestWaitMs', source: null, value: 45000, threshold: 30000, comparator: 'gte' }),
    ).toBe('最久的排队等待时长，当前 45000 毫秒，规则 大于等于 30000 毫秒')
    expect(
      describeAlertReading({ metricKey: 'target.pageHealthRunRate', source: null, value: 33.33333, threshold: 20, comparator: 'gt' }),
    ).toBe('目标系统页面健康违规运行占比（近 1 小时），当前 33.33 %，规则 大于 20 %')
    expect(describeAlertReading({ metricKey: 'worker.status.lost', source: null, value: null, threshold: null, comparator: null })).toBe(
      '失联的执行节点数',
    )
  })

  it('陈旧类说明哪个判断依据没更新；认不出的不硬译', () => {
    expect(describeAlertReading({ metricKey: null, source: 'object_store_probe', value: null, threshold: null, comparator: null })).toBe(
      '「对象存储探测」长时间没有更新',
    )
    expect(describeAlertReading({ metricKey: null, source: 'unknown', value: null, threshold: null, comparator: null })).toBeNull()
  })

  it('作用对象：目标系统用名称，没有名称退回编号，平台级没有对象', () => {
    expect(describeAlertScope({ scope: 'target', scopeId: 't1', scopeName: '订单中心' })).toBe('目标系统：订单中心')
    expect(describeAlertScope({ scope: 'target', scopeId: 't1', scopeName: null })).toBe('目标系统：t1')
    expect(describeAlertScope({ scope: 'worker', scopeId: 'worker-a' })).toBe('执行节点：worker-a')
    expect(describeAlertScope({ scope: 'platform', scopeId: 'platform' })).toBeNull()
  })
})
