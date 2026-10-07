import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  LOCATOR_RESOLUTION_PROTOCOL,
  SESSION_OCCUPANCY_PROTOCOL,
  createRuntimeInvariant,
  FACTORY_ALERT_RULES,
  type AlertRule,
  type AuthoringNode,
  type PlatformConfigDocument,
  type PageHealthFact,
  type RuntimeInvariant,
  type Step,
} from '@cairn/shared'
import {
  createRunWithSnapshot,
  createScenarioWithVersion,
  deleteRun,
  finishAttempt,
  openIsolatedDb,
  publishScenarioDraft,
  saveScenarioDraft,
  schemaFor,
  startAttempt,
  type NativeHandle as DbHandle,
} from '../test-entry.js'
import { newId } from '../id.js'
import { clockNow } from '../native.js'
import { consoleAccounts as pg_consoleAccounts } from '../schema/console.js'
import { targets as pg_targets } from '../schema/targets.js'
import { forceGrantForRun } from './lease-harness.js'
import { summarizeTargetPageHealth, pageHealthRunRate } from '../monitoring/page-health.js'
import { summarizeTargetSla } from '../monitoring/sla.js'
import { collectPlatformSamples } from '../monitoring/tick.js'
import { insertMonitorSamples, readMonitorSeries } from '../monitoring/samples.js'
import { collectAlertReadings, evaluateAlerts, listMonitorAlertRules, listMonitorAlerts } from '../monitoring/alerts.js'
import { getOrCreatePlatformConfig, updatePlatformConfig } from '../platform-config/store.js'

void LOCATOR_RESOLUTION_PROTOCOL
void SESSION_OCCUPANCY_PROTOCOL

const SCHEMA = `cairn_test_${Date.now().toString(36)}_monph`

const echoStep: Step = { id: newId(), name: '回显', type: 'echo', effectType: 'READ_ONLY', input: { value: 'x' } }

describe('目标页面健康聚合、采样、SLA 与告警读数（P2-B，集成）', () => {
  let handle: DbHandle
  let actorId: string
  let targetId: string
  let otherTargetId: string
  let consoleAccounts: typeof pg_consoleAccounts
  let targets: typeof pg_targets
  let net: RuntimeInvariant
  let script: RuntimeInvariant
  let scenarioId: string

  beforeAll(async () => {
    handle = await openIsolatedDb(SCHEMA)
    ;({ consoleAccounts, targets } = schemaFor(handle.db))
    actorId = newId()
    targetId = newId()
    otherTargetId = newId()
    await handle.db.insert(consoleAccounts).values({ id: actorId, displayName: 'mon-ph', email: `monph-${actorId}@example.com`, status: 'active' })
    await handle.db.insert(targets).values([
      { id: targetId, code: `monph-${SCHEMA.slice(-6)}`, name: '监控页面健康目标', entryUrl: 'https://example.com' },
      { id: otherTargetId, code: `monph2-${SCHEMA.slice(-6)}`, name: '无运行目标', entryUrl: 'https://example.org' },
    ])
    net = createRuntimeInvariant('network_health', newId())
    script = createRuntimeInvariant('script_errors', newId())
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '页面健康监控',
      steps: [{ ...echoStep, id: newId() }],
      actor: { id: actorId },
    })
    scenarioId = scenario.id
    const nodes: AuthoringNode[] = [{ kind: 'step', step: echoStep }]
    await saveScenarioDraft(handle.db, scenario.id, {
      revision: 1,
      document: { authoringSchemaVersion: 2 as const, nodes, runtimeInvariants: [net, script] },
      actor: { id: actorId },
    })
    await publishScenarioDraft(handle.db, scenario.id, { revision: 2, actor: { id: actorId } })
  })

  afterAll(async () => {
    await handle?.close()
  })

  const fact = (kind: PageHealthFact['kind'], total: number, byClass: Record<string, number>): PageHealthFact => ({ kind, total, byClass, samples: [] })

  /** 跑一次已结束的运行，按给定事实写页面健康违规行。 */
  async function finishedRun(facts: PageHealthFact[]): Promise<string> {
    const run = await createRunWithSnapshot(handle.db, { scenarioId, actor: { id: actorId } })
    const runId = run.detail.id
    const grant = await forceGrantForRun(handle, runId, `w-${newId()}`)
    const start = await startAttempt(handle.db, { runId, stepRunId: run.detail.stepRuns[0]!.id, grant, inputPayload: {} })
    await finishAttempt(handle.db, {
      runId,
      attemptId: start!.attemptId,
      attemptStatus: 'SUCCEEDED',
      output: { ok: true },
      stepRunStatus: 'SUCCEEDED',
      runStatus: 'SUCCEEDED',
      grant,
      outcomeResults: facts.map((item) => {
        const invariant = item.kind === 'network_health' ? net : script
        return {
          contractId: invariant.id,
          scope: 'scenario' as const,
          meaning: invariant.meaning,
          severity: 'SHOULD' as const,
          onViolation: 'continue' as const,
          provenance: 'runtime_invariant' as const,
          verdict: 'FAIL' as const,
          expected: { kind: item.kind, violations: 0 },
          actual: item as never,
          evaluatedAt: new Date(),
        }
      }),
    })
    return runId
  }

  it('聚合：慢请求 / 接口错误 / 违规运行数 / 分母；没有带约束的运行的目标不出现；软删除运行不计入', async () => {
    await finishedRun([fact('network_health', 5, { '5xx': 2, slow: 3 }), fact('script_errors', 1, { script: 1 })])
    await finishedRun([])
    await finishedRun([fact('network_health', 1, { '4xx': 1 })])
    const deleted = await finishedRun([fact('network_health', 99, { slow: 99 })])
    await deleteRun(handle.db, deleted, { id: actorId })

    const summary = await summarizeTargetPageHealth(handle.db, await clockNow(handle.db))
    expect(summary.get(targetId)).toEqual({ slowCount: 3, errorCount: 3, violatingRuns: 2, runsWithGuards: 3, truncated: false })
    expect(summary.has(otherTargetId)).toBe(false)
    expect(pageHealthRunRate(summary.get(targetId)!)).toBe(67)
    expect(pageHealthRunRate({ violatingRuns: 0, runsWithGuards: 0 })).toBeNull()
  })

  it('窗口之外的运行不计入', async () => {
    const asOf = await clockNow(handle.db)
    const later = new Date(asOf.getTime() + 2 * 60 * 60_000)
    const summary = await summarizeTargetPageHealth(handle.db, later)
    expect(summary.has(targetId)).toBe(false)
  })

  it('采样写出目标范围的三条样本；没有数据的目标不写', async () => {
    const writes = await collectPlatformSamples(handle.db)
    const mine = writes.filter((item) => item.scope === 'target')
    expect(mine.every((item) => item.scopeId === targetId)).toBe(true)
    const byKey = Object.fromEntries(mine.map((item) => [item.key, item.value]))
    expect(byKey).toEqual({ 'target.apiSlowCount': 3, 'target.apiErrorCount': 3, 'target.pageHealthRunRate': 67 })
    // 目标范围样本能真正落库并按目标读回序列（库里的范围约束要放行 target）
    expect(await insertMonitorSamples(handle.db, mine)).toBe(3)
    const series = await readMonitorSeries(handle.db, { keys: ['target.apiSlowCount'], scope: 'target', scopeId: targetId })
    expect(series.items[0]?.points.map((point) => point.value)).toEqual([3])
  })

  it('SLA 卡片带 pageHealth，没有数据的目标不带该字段', async () => {
    const items = await summarizeTargetSla(handle.db, await clockNow(handle.db))
    expect(items.find((item) => item.targetId === targetId)?.pageHealth).toEqual({
      slowCount: 3, errorCount: 3, violatingRuns: 2, runsWithGuards: 3, truncated: false,
    })
    expect(items.find((item) => item.targetId === otherTargetId)).not.toHaveProperty('pageHealth')
  })

  it('告警读数：目标范围的三个键，没有数据的目标没有读数', async () => {
    const readings = await collectAlertReadings(handle.db, await clockNow(handle.db))
    expect(readings.get(`metric:target.apiSlowCount:target:${targetId}`)).toEqual({ availability: 'known', value: 3 })
    expect(readings.get(`metric:target.apiErrorCount:target:${targetId}`)).toEqual({ availability: 'known', value: 3 })
    expect(readings.get(`metric:target.pageHealthRunRate:target:${targetId}`)).toEqual({ availability: 'known', value: 67 })
    expect([...readings.keys()].some((key) => key.endsWith(`:target:${otherTargetId}`))).toBe(false)
  })

  it('启用目标告警规则：超阈时按目标触发一次，降到阈值以下恢复；出厂规则默认关闭', async () => {
    expect(FACTORY_ALERT_RULES.filter((rule) => rule.id.startsWith('factory.target.')).every((rule) => !rule.enabled)).toBe(true)
    const setRules = async (rules: AlertRule[]) => {
      const current = await getOrCreatePlatformConfig(handle.db)
      await updatePlatformConfig(handle.db, {
        expectedRevision: current.revision,
        reason: '测试目标页面健康告警',
        document: { ...current.document, alerting: { ...current.document.alerting, rules } } satisfies PlatformConfigDocument,
        actor: { id: actorId },
      })
    }
    const rulesWith = (threshold: number) =>
      FACTORY_ALERT_RULES.map((rule) =>
        rule.id === 'factory.target.api_slow' ? ({ ...rule, enabled: true, forSeconds: 0, threshold } as AlertRule) : rule,
      )
    await setRules(rulesWith(2))
    expect((await evaluateAlerts(handle.db)).fired).toBe(1)
    const { monitoringAlerts } = schemaFor(handle.db)
    const open = await handle.db.select().from(monitoringAlerts)
    expect(open.filter((row) => row.scope === 'target' && row.scopeId === targetId && row.ruleId === 'factory.target.api_slow')).toHaveLength(1)
    const listed = await listMonitorAlerts(handle.db, { view: 'active', limit: 20 })
    expect(listed.items.find((item) => item.ruleId === 'factory.target.api_slow')).toMatchObject({ scope: 'target', scopeId: targetId, scopeName: '监控页面健康目标' })
    await setRules(rulesWith(1000))
    expect((await evaluateAlerts(handle.db)).resolved).toBe(1)
  })

  it('存量配置缺少新增的出厂规则时，列表按 id 补上（默认关闭、不带渠道），已有规则原样保留', async () => {
    const current = await getOrCreatePlatformConfig(handle.db)
    const legacy = FACTORY_ALERT_RULES.filter((rule) => !rule.id.startsWith('factory.target.')).map((rule) =>
      rule.id === 'factory.worker.ready_zero' ? ({ ...rule, enabled: true, channelIds: [] } as AlertRule) : rule,
    )
    await updatePlatformConfig(handle.db, {
      expectedRevision: current.revision,
      reason: '模拟存量配置',
      document: { ...current.document, alerting: { ...current.document.alerting, rules: legacy } } satisfies PlatformConfigDocument,
      actor: { id: actorId },
    })
    const listed = await listMonitorAlertRules(handle.db)
    const ids = listed.rules.map((rule) => rule.id)
    expect(ids).toEqual(expect.arrayContaining(['factory.target.api_slow', 'factory.target.page_health_rate']))
    expect(new Set(ids).size).toBe(ids.length)
    const added = listed.rules.filter((rule) => rule.id.startsWith('factory.target.'))
    expect(added.every((rule) => rule.enabled === false && rule.channelIds.length === 0)).toBe(true)
    expect(listed.rules.find((rule) => rule.id === 'factory.worker.ready_zero')?.enabled).toBe(true)
  })
})
