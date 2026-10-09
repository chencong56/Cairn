import {
  DURATION_FACTS_CALC_VERSION,
  type NodeDurationFacts,
  type Step,
} from '@cairn/shared'
import { createScenarioWithVersion, eq, newId, schemaFor, writeRunWithSnapshot, type Db } from '../test-entry.js'

/** 耗时分析 / 周期报告测试共用的造数：直接写入运行与耗时事实，读模型只依赖事实表，不必走完整执行链路。 */

export const HOUR = 60 * 60 * 1000
export const DAY = 24 * HOUR
export const STEP_A = '00000000-0000-4000-8000-0000000000b1'
export const STEP_B = '00000000-0000-4000-8000-0000000000b2'
const steps: Step[] = [
  { id: STEP_A, name: '打开查询页', type: 'echo', effectType: 'READ_ONLY', outputKey: 'a', input: { value: 'a' } },
  { id: STEP_B, name: '查询订单', type: 'echo', effectType: 'READ_ONLY', outputKey: 'b', input: { value: 'b' } },
]

export type DurationScenario = { id: string; name: string; latestVersionId: string }

export interface SeedRun {
  scenario: DurationScenario
  targetId: string
  finishedAt: Date
  activeMs: number
  status?: 'SUCCEEDED' | 'FAILED'
  /** [节点键, 执行耗时, 额外字段] */
  nodes?: Array<[string, number, Partial<NodeDurationFacts>?]>
  comparable?: boolean
  trigger?: 'manual' | 'schedule'
  versionId?: string
  authWaitMs?: number
  queueMs?: number
  suite?: { suiteRunId: string; memberId: string }
  deleted?: boolean
  /** 子运行创建时刻；缺省为开跑前 queueMs。 */
  createdAt?: Date
}

export function nodesOf(a: number, b: number, extra: Partial<NodeDurationFacts> = {}): SeedRun['nodes'] {
  return [
    [`step:${STEP_A}`, a],
    [`step:${STEP_B}`, b, extra],
  ]
}

export function durationSeeder(db: Db, actorId: string) {
  async function newTarget(name: string) {
    const id = newId()
    const { targets } = schemaFor(db)
    await db.insert(targets).values({ id, code: `da-${id.slice(-12)}`, name, entryUrl: 'https://example.com' })
    return id
  }

  async function newScenario(targetId: string, name: string): Promise<DurationScenario> {
    const created = await createScenarioWithVersion(db, { targetId, name: `${name}-${newId().slice(0, 4)}`, steps, actor: { id: actorId } })
    return { id: created.id, name: created.name, latestVersionId: created.latestVersionId }
  }

  /** 直接写入运行与耗时事实：分析读模型只依赖事实表，不必走完整执行链路。 */
  async function seedRun(o: SeedRun): Promise<string> {
    const { runs, runDurationFacts, runNodeDurationFacts } = schemaFor(db)
    const trigger = o.trigger ?? 'schedule'
    const versionId = o.versionId ?? o.scenario.latestVersionId
    const { runId } = await writeRunWithSnapshot(db, {
      scenarioId: o.scenario.id,
      scenarioVersionId: versionId,
      actor: { kind: 'console', id: actorId },
      triggerSource: trigger,
      allowTrialVersion: o.comparable === false ? true : undefined,
    })
    const status = o.status ?? 'SUCCEEDED'
    const authWaitMs = o.authWaitMs ?? 0
    const queueMs = o.queueMs ?? 1_000
    const totalMs = o.activeMs + authWaitMs
    const startedAt = new Date(o.finishedAt.getTime() - totalMs)
    const createdAt = o.createdAt ?? new Date(startedAt.getTime() - queueMs)
    await db
      .update(runs)
      .set({
        status,
        createdAt,
        startedAt,
        finishedAt: o.finishedAt,
        suiteRunId: o.suite?.suiteRunId ?? null,
        suiteMemberId: o.suite?.memberId ?? null,
        deletedAt: o.deleted ? new Date() : null,
        deletedBy: o.deleted ? { id: actorId, displayName: '耗时分析', kind: 'console' as const } : null,
      })
      .where(eq(runs.id, runId))
    const nodes = o.nodes ?? []
    await db.insert(runDurationFacts).values({
      runId,
      targetId: o.targetId,
      scenarioId: o.scenario.id,
      scenarioVersionId: versionId,
      suiteRunId: o.suite?.suiteRunId ?? null,
      triggerSource: trigger,
      comparable: o.comparable ?? true,
      status,
      finishedAt: o.finishedAt,
      totalMs,
      activeMs: o.activeMs,
      authWaitMs,
      requeueMs: 0,
      reviewMs: 0,
      holdMs: 0,
      unclassifiedMs: 0,
      queueMs: startedAt.getTime() - createdAt.getTime(),
      overheadMs: Math.max(0, o.activeMs - nodes.reduce((sum, [, ms]) => sum + ms, 0)),
      workerLost: false,
      complete: true,
      incompleteReason: null,
      calcVersion: DURATION_FACTS_CALC_VERSION,
      computedAt: new Date(),
    })
    if (nodes.length) {
      await db.insert(runNodeDurationFacts).values(
        nodes.map(([nodeKey, activeMs, extra], ordinal) => ({
          runId,
          nodeKey,
          scenarioId: o.scenario.id,
          finishedAt: o.finishedAt,
          parentKey: null,
          kind: 'step' as const,
          name: nodeKey === `step:${STEP_A}` ? '打开查询页' : nodeKey === `step:${STEP_B}` ? '查询订单' : nodeKey,
          ordinal,
          status,
          activeMs,
          windowMs: activeMs,
          attemptCount: 1,
          iterationCount: 1,
          maxResolution: null,
          ...extra,
        })),
      )
    }
    return runId
  }

  async function copyVersion(scenario: DurationScenario, kind: 'published' | 'trial', versionNo: number | null) {
    const { scenarioVersions } = schemaFor(db)
    const [row] = await db.select().from(scenarioVersions).where(eq(scenarioVersions.id, scenario.latestVersionId))
    const id = newId()
    await db.insert(scenarioVersions).values({ ...row!, id, kind, versionNo, sourceDigest: `${kind}-${id}`, createdAt: new Date() })
    return id
  }

  return { newTarget, newScenario, seedRun, copyVersion }
}
