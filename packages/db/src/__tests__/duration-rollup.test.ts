import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { durationAnalysisQuerySchema, lastCompleteDurationPeriodStart, targetDurationAnalysisQuerySchema, type DurationPeriodReportSubject } from '@cairn/shared'
import { buildDurationPeriodReport } from '../runs/duration-report.js'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import { DAY, durationSeeder, nodesOf, type DurationScenario, type SeedRun } from './duration-fixture.js'
import {
  adjustPlatformConfig,
  deleteRun,
  newId,
  processDurationRollups,
  readDurationRollupState,
  readScenarioDurationAnalysis,
  readScenarioNodeChildren,
  readTargetDurationAnalysis,
  schemaFor,
  sql,
} from '../test-entry.js'

/**
 * 耗时分析按天汇总（方案 2026-10-08-duration-daily-rollups）：
 * 汇总就绪前读明细、就绪后读汇总，两条路径给出同样的统计；运行删除登记脏键，作业重算后汇总随之更新；
 * 统计时区变更整体重建，重建完成前退回明细。
 */

const day = (offsetDays: number, hourUtc = 4) => {
  const date = new Date(Date.now() - offsetDays * DAY)
  date.setUTCHours(hourUtc, 0, 0, 0)
  return date
}

describe.each(DRIVERS)('%s 耗时分析按天汇总', { timeout: 120_000 }, (driver) => {
  let handle: Awaited<ReturnType<typeof openContractDb>>
  let actorId: string
  let seeder: ReturnType<typeof durationSeeder>
  let targetId: string
  let scenario: DurationScenario
  let deletable: string

  async function dirtyCount(): Promise<number> {
    const { durationRollupDirty } = schemaFor(handle.db)
    const [row] = await handle.db.select({ n: sql<number | string>`count(*)` }).from(durationRollupDirty)
    return Number(row?.n ?? 0)
  }

  /** 跑作业直到汇总就绪且没有待重算的天。 */
  async function settle() {
    for (let i = 0; i < 40; i += 1) {
      const result = await processDurationRollups(handle.db, { limit: 500, backfillPageSize: 500 })
      if (result.ready && (await dirtyCount()) === 0) return result
    }
    throw new Error('耗时汇总没有就绪')
  }

  const targetQuery = () => targetDurationAnalysisQuerySchema.parse({ days: 30 })
  const scenarioQuery = () => durationAnalysisQuerySchema.parse({ days: 30 })
  const withoutVolatile = <T extends { window: unknown; aggregation: unknown }>(dto: T) => ({ ...dto, window: undefined, aggregation: undefined })

  beforeAll(async () => {
    handle = await openContractDb(driver, `duration_rollup_${driver}`)
    actorId = newId()
    const { consoleAccounts } = schemaFor(handle.db)
    await handle.db.insert(consoleAccounts).values({ id: actorId, displayName: '耗时汇总', email: `duration-rollup-${actorId}@example.com`, status: 'active' })
    seeder = durationSeeder(handle.db, actorId)
    targetId = await seeder.newTarget('汇总目标')
    scenario = await seeder.newScenario(targetId, '订单巡检')
    const v2 = await seeder.copyVersion(scenario, 'published', 2)
    const moduleNodes = (outer: number, inner: number): NonNullable<SeedRun['nodes']> => [
      ['module:login', outer, { kind: 'module', name: '登录模块' }],
      ['module:login/step:user', inner, { kind: 'module_step', name: '输入账号', parentKey: 'module:login' }],
    ]
    // 上一周期：执行 10s
    for (let i = 0; i < 12; i += 1) {
      await seeder.seedRun({ scenario, targetId, finishedAt: day(40 + i), activeMs: 10_000, nodes: [...nodesOf(4_000, 6_000)!, ...moduleNodes(2_000, 1_000)] })
    }
    // 本周期：执行 13s，后 6 次换了新版本；夹一次失败与一次人工运行
    for (let i = 0; i < 12; i += 1) {
      await seeder.seedRun({
        scenario,
        targetId,
        finishedAt: day(12 - i, i % 2 === 0 ? 4 : 17),
        activeMs: 13_000 + i * 10,
        versionId: i >= 6 ? v2 : undefined,
        nodes: [...nodesOf(4_000, 9_000)!, ...moduleNodes(3_000, 2_000)],
      })
    }
    await seeder.seedRun({ scenario, targetId, finishedAt: day(3), activeMs: 30_000, status: 'FAILED', nodes: nodesOf(4_000, 26_000) })
    deletable = await seeder.seedRun({ scenario, targetId, finishedAt: day(2), activeMs: 12_000, trigger: 'manual', nodes: nodesOf(4_000, 8_000) })
  })

  afterAll(async () => {
    await handle?.close()
  })

  it('就绪前读明细；作业回扫、重算后读汇总，目标系统与场景页的统计与明细完全一致', async () => {
    expect(await readDurationRollupState(handle.db)).toBeNull()
    const rawTarget = await readTargetDurationAnalysis(handle.db, targetId, targetQuery())
    const rawScenario = await readScenarioDurationAnalysis(handle.db, scenario.id, scenarioQuery())
    expect(rawTarget.aggregation).toEqual({ source: 'raw', settling: false })
    expect(rawScenario.kpis.runs).toBe(14)

    const first = await processDurationRollups(handle.db, { limit: 500, backfillPageSize: 500 })
    expect(first.reset).toBe(true)
    await settle()
    expect(await readDurationRollupState(handle.db)).toEqual({ timeZone: 'Asia/Shanghai', ready: true })

    const rolledTarget = await readTargetDurationAnalysis(handle.db, targetId, targetQuery())
    const rolledScenario = await readScenarioDurationAnalysis(handle.db, scenario.id, scenarioQuery())
    expect(rolledTarget.aggregation).toEqual({ source: 'rollup', settling: false })
    expect(rolledScenario.aggregation).toEqual({ source: 'rollup', settling: false })
    expect(withoutVolatile(rolledTarget)).toEqual(withoutVolatile(rawTarget))
    expect(withoutVolatile(rolledScenario)).toEqual(withoutVolatile(rawScenario))
    expect(rolledScenario.versionBoundaries).toHaveLength(1)
    expect(rolledScenario.kpis.activeP50.deltaPct).toBeGreaterThan(20)
  })

  it('节点表只给顶层节点；有子节点的可展开，展开时按单场景读明细', async () => {
    const analysis = await readScenarioDurationAnalysis(handle.db, scenario.id, scenarioQuery())
    expect(analysis.nodes.every((node) => node.parentKey === null)).toBe(true)
    const login = analysis.nodes.find((node) => node.nodeKey === 'module:login')
    expect(login).toMatchObject({ hasChildren: true, samples: 12, activeP50: 3_000 })
    expect(analysis.nodes.find((node) => node.nodeKey !== 'module:login')?.hasChildren).toBe(false)

    const children = await readScenarioNodeChildren(handle.db, scenario.id, { ...scenarioQuery(), parentKey: 'module:login' })
    expect(children.nodes).toEqual([
      expect.objectContaining({ nodeKey: 'module:login/step:user', parentKey: 'module:login', name: '输入账号', samples: 12, activeP50: 2_000, baseP50: 1_000, hasChildren: false }),
    ])
  })

  it('删除运行同事务登记脏键：重算前标注「整理中」，重算后汇总少了这次运行', async () => {
    const before = await readScenarioDurationAnalysis(handle.db, scenario.id, scenarioQuery())
    await deleteRun(handle.db, deletable, { id: actorId })
    expect(await dirtyCount()).toBeGreaterThan(0)
    const settling = await readScenarioDurationAnalysis(handle.db, scenario.id, scenarioQuery())
    expect(settling.aggregation).toEqual({ source: 'rollup', settling: true })
    expect(settling.kpis.runs).toBe(before.kpis.runs)

    await settle()
    const after = await readScenarioDurationAnalysis(handle.db, scenario.id, scenarioQuery())
    expect(after.aggregation.settling).toBe(false)
    expect(after.kpis.runs).toBe(before.kpis.runs - 1)
  })

  it('指定非统计时区时读明细；改统计时区后整体重建，重建完成前退回明细', async () => {
    const utc = await readScenarioDurationAnalysis(handle.db, scenario.id, durationAnalysisQuerySchema.parse({ days: 30, tz: 'UTC' }))
    expect(utc.aggregation.source).toBe('raw')
    expect(utc.window.tz).toBe('UTC')

    await adjustPlatformConfig(handle, { id: actorId }, (document) => ({ ...document, statistics: { timeZone: 'UTC' } }), '改统计时区')
    const reset = await processDurationRollups(handle.db, { limit: 0, backfillPageSize: 1 })
    expect(reset.reset).toBe(true)
    expect(await readDurationRollupState(handle.db)).toEqual({ timeZone: 'UTC', ready: false })
    const rebuilding = await readScenarioDurationAnalysis(handle.db, scenario.id, scenarioQuery())
    expect(rebuilding.window.tz).toBe('UTC')
    expect(rebuilding.aggregation.source).toBe('raw')
    // 周报：重建期间读明细，就绪后读汇总，报告内容一致
    const subject: DurationPeriodReportSubject = {
      kind: 'DURATION_PERIOD',
      targetId,
      period: 'week',
      periodStart: lastCompleteDurationPeriodStart('week', new Date(), 'UTC'),
      timeZone: 'UTC',
      trigger: 'all',
    }
    const rawReport = await buildDurationPeriodReport(handle.db, subject)
    expect(rawReport.block.kpis.runs).toBeGreaterThan(0)

    await settle()
    const rebuilt = await readScenarioDurationAnalysis(handle.db, scenario.id, scenarioQuery())
    expect(rebuilt.aggregation).toEqual({ source: 'rollup', settling: false })
    expect(withoutVolatile(rebuilt)).toEqual(withoutVolatile(rebuilding))
    const rolledReport = await buildDurationPeriodReport(handle.db, subject)
    expect(rolledReport.block).toEqual(rawReport.block)
  })
})
