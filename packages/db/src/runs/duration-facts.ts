import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, or, type InferSelectModel, type SQL } from 'drizzle-orm'
import {
  DURATION_FACTS_CALC_VERSION,
  FINISHED_RUN_STATUSES,
  type NodeDurationFacts,
  type RunDurationFacts,
  type RunSnapshot,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { markDurationRollupDirty } from './duration-rollup.js'
import { atomic, clockNow, deleteRows, insertIgnoreRows, schemaFor, updateRows } from '../native.js'
import type { runDurationFacts as runDurationFactsTable } from '../schema/duration-facts.js'
import { computeRunDurationFacts, type DurationCalculatorInput, type DurationCalculatorOutput } from './duration-calculator.js'

const STATUS_EVENT_TYPES = ['run.status_changed', 'run.auth_wait', 'run.auth_resumed'] as const
const ATTEMPT_CHUNK = 500

/** 可比运行：已发布版本且场景用途为 user。试跑（含调试）、模块用例、修复验证、地图作业都不可比。 */
export function isComparableRun(input: { versionKind: string | null; purpose: string | null }): boolean {
  return input.versionKind === 'published' && (input.purpose ?? 'user') === 'user'
}

/** 一批运行的计算输入；缺失的运行不出现在结果里。 */
async function loadCalculatorInputs(db: Db, runIds: readonly string[], asOf?: Date): Promise<Map<string, DurationCalculatorInput>> {
  const result = new Map<string, DurationCalculatorInput>()
  if (runIds.length === 0) return result
  const { runs, scenarioVersions, scenarios, runEvents, stepRuns, attempts, resolutionDecisions } = schemaFor(db)
  const runRows = await db
    .select({
      id: runs.id,
      targetId: runs.targetId,
      scenarioId: runs.scenarioId,
      scenarioVersionId: runs.scenarioVersionId,
      suiteRunId: runs.suiteRunId,
      triggerSource: runs.triggerSource,
      status: runs.status,
      createdAt: runs.createdAt,
      startedAt: runs.startedAt,
      finishedAt: runs.finishedAt,
      snapshot: runs.snapshot,
      versionKind: scenarioVersions.kind,
      purpose: scenarios.purpose,
    })
    .from(runs)
    .leftJoin(scenarioVersions, eq(scenarioVersions.id, runs.scenarioVersionId))
    .leftJoin(scenarios, eq(scenarios.id, runs.scenarioId))
    .where(inArray(runs.id, [...runIds]))
  if (runRows.length === 0) return result
  const ids = runRows.map((row) => row.id)
  const [events, stepRows, decisions] = await Promise.all([
    db
      .select({ runId: runEvents.runId, type: runEvents.type, occurredAt: runEvents.occurredAt, sequence: runEvents.sequence, payload: runEvents.payload })
      .from(runEvents)
      .where(and(inArray(runEvents.runId, ids), inArray(runEvents.type, [...STATUS_EVENT_TYPES])))
      .orderBy(asc(runEvents.runId), asc(runEvents.sequence)),
    db
      .select({
        id: stepRuns.id,
        runId: stepRuns.runId,
        stepId: stepRuns.stepId,
        name: stepRuns.name,
        ordinal: stepRuns.ordinal,
        scopePath: stepRuns.scopePath,
        status: stepRuns.status,
      })
      .from(stepRuns)
      .where(inArray(stepRuns.runId, ids)),
    db
      .select({ runId: resolutionDecisions.runId, attemptId: resolutionDecisions.attemptId, decisionKind: resolutionDecisions.decisionKind })
      .from(resolutionDecisions)
      .where(inArray(resolutionDecisions.runId, ids)),
  ])
  const stepRunIds = stepRows.map((row) => row.id)
  const attemptRows: Array<{ stepRunId: string; id: string; startedAt: Date; finishedAt: Date | null }> = []
  for (let i = 0; i < stepRunIds.length; i += ATTEMPT_CHUNK) {
    const chunk = stepRunIds.slice(i, i + ATTEMPT_CHUNK)
    attemptRows.push(
      ...(await db
        .select({ stepRunId: attempts.stepRunId, id: attempts.id, startedAt: attempts.startedAt, finishedAt: attempts.finishedAt })
        .from(attempts)
        .where(inArray(attempts.stepRunId, chunk))),
    )
  }
  const runOfStepRun = new Map(stepRows.map((row) => [row.id, row.runId]))
  for (const row of runRows) {
    const snapshot = row.snapshot as RunSnapshot | null
    result.set(row.id, {
      run: {
        id: row.id,
        targetId: row.targetId,
        scenarioId: row.scenarioId,
        scenarioVersionId: row.scenarioVersionId,
        suiteRunId: row.suiteRunId ?? null,
        triggerSource: row.triggerSource,
        status: row.status,
        createdAt: row.createdAt,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
      },
      comparable: isComparableRun({ versionKind: row.versionKind, purpose: row.purpose }),
      events: events.filter((event) => event.runId === row.id),
      stepRuns: stepRows.filter((step) => step.runId === row.id),
      attempts: attemptRows.filter((attempt) => runOfStepRun.get(attempt.stepRunId) === row.id),
      decisions: decisions
        .filter((decision) => decision.runId === row.id && decision.attemptId !== null)
        .map((decision) => ({ attemptId: decision.attemptId!, decisionKind: decision.decisionKind })),
      snapshot: snapshot
        ? { steps: snapshot.steps ?? [], moduleManifest: snapshot.moduleManifest, candidateGroups: snapshot.candidateGroups, outcomeManifest: snapshot.outcomeManifest }
        : null,
      ...(asOf ? { asOf } : {}),
    })
  }
  return result
}

function factsRow(output: DurationCalculatorOutput, computedAt: Date) {
  const { facts } = output
  return {
    runId: facts.runId,
    targetId: facts.targetId,
    scenarioId: facts.scenarioId,
    scenarioVersionId: facts.scenarioVersionId,
    suiteRunId: facts.suiteRunId,
    triggerSource: facts.triggerSource,
    comparable: facts.comparable,
    status: facts.status,
    finishedAt: facts.finishedAt ? new Date(facts.finishedAt) : null,
    totalMs: facts.totalMs,
    activeMs: facts.activeMs,
    authWaitMs: facts.authWaitMs,
    requeueMs: facts.requeueMs,
    reviewMs: facts.reviewMs,
    holdMs: facts.holdMs,
    unclassifiedMs: facts.unclassifiedMs,
    queueMs: facts.queueMs,
    overheadMs: facts.overheadMs,
    workerLost: facts.workerLost,
    complete: facts.complete,
    incompleteReason: facts.incompleteReason,
    calcVersion: facts.calcVersion,
    computedAt,
  }
}

function nodeRows(output: DurationCalculatorOutput) {
  const finishedAt = output.facts.finishedAt ? new Date(output.facts.finishedAt) : null
  return output.nodes.map((node) => ({
    runId: output.facts.runId,
    nodeKey: node.nodeKey,
    scenarioId: output.facts.scenarioId,
    finishedAt,
    parentKey: node.parentKey,
    kind: node.kind,
    name: node.name.slice(0, 512),
    ordinal: node.ordinal,
    status: node.status,
    activeMs: node.activeMs,
    windowMs: node.windowMs,
    attemptCount: node.attemptCount,
    iterationCount: node.iterationCount,
    maxResolution: node.maxResolution,
  }))
}

type WriteOutcome = 'written' | 'recomputed' | 'kept' | 'skipped'

/**
 * 幂等写入一条运行的事实。多个 analyst 实例并发时首个写入者生效；
 * 规则版本落后时重算，但事件已被清理（no_events）的运行保留原事实、不覆盖成不完整，
 * 只推进版本号以免反复扫描。
 */
async function writeFacts(db: Db, output: DurationCalculatorOutput): Promise<WriteOutcome> {
  return atomic(db, async (tx) => {
    const { runDurationFacts, runNodeDurationFacts } = schemaFor(tx)
    const now = await clockNow(tx)
    const inserted = await insertIgnoreRows(tx, runDurationFacts, factsRow(output, now))
    // 改变事实的写入都同事务登记耗时汇总的脏键（场景 + 统计日），作业随后重算这一天
    const dirty = [{ scenarioId: output.facts.scenarioId, finishedAt: output.facts.finishedAt ? new Date(output.facts.finishedAt) : null }]
    if (inserted > 0) {
      await insertIgnoreRows(tx, runNodeDurationFacts, nodeRows(output))
      await markDurationRollupDirty(tx, dirty)
      return 'written'
    }
    const [existing] = await tx
      .select({ calcVersion: runDurationFacts.calcVersion, complete: runDurationFacts.complete })
      .from(runDurationFacts)
      .where(eq(runDurationFacts.runId, output.facts.runId))
      .limit(1)
    if (!existing || existing.calcVersion >= DURATION_FACTS_CALC_VERSION) return 'skipped'
    if (output.facts.incompleteReason === 'no_events' && existing.complete) {
      const bumped = await updateRows(
        tx,
        runDurationFacts,
        { calcVersion: DURATION_FACTS_CALC_VERSION },
        and(eq(runDurationFacts.runId, output.facts.runId), lt(runDurationFacts.calcVersion, DURATION_FACTS_CALC_VERSION)),
        { runId: runDurationFacts.runId },
      )
      // 节点事实只取自步骤与 attempt，不依赖运行事件，可以按新规则刷新
      if (bumped.length > 0) {
        await deleteRows(tx, runNodeDurationFacts, eq(runNodeDurationFacts.runId, output.facts.runId), { runId: runNodeDurationFacts.runId })
        await insertIgnoreRows(tx, runNodeDurationFacts, nodeRows(output))
        await markDurationRollupDirty(tx, dirty)
      }
      return 'kept'
    }
    const removed = await deleteRows(
      tx,
      runDurationFacts,
      and(eq(runDurationFacts.runId, output.facts.runId), lt(runDurationFacts.calcVersion, DURATION_FACTS_CALC_VERSION)),
      { runId: runDurationFacts.runId },
    )
    if (removed.length === 0) return 'skipped'
    await deleteRows(tx, runNodeDurationFacts, eq(runNodeDurationFacts.runId, output.facts.runId), { runId: runNodeDurationFacts.runId })
    await insertIgnoreRows(tx, runDurationFacts, factsRow(output, now))
    await insertIgnoreRows(tx, runNodeDurationFacts, nodeRows(output))
    await markDurationRollupDirty(tx, dirty)
    return 'recomputed'
  })
}

export interface DurationFactsCursor {
  finishedAt: string
  runId: string
}

export interface SyncRunDurationFactsInput {
  /** 近期窗口：完成时间在此之内、缺事实或版本落后的运行优先处理。默认 1 小时。 */
  recentWindowMs?: number
  recentBatchSize?: number
  /**
   * 全量回扫：按完成时间从新到旧分页，补上近期窗口之外漏掉的运行（晚提交的长事务、
   * 迁移前的历史运行、规则版本落后）。null 表示本轮不回扫；before 为空表示从最新开始。
   */
  catchUp?: { before: DurationFactsCursor | null; pageSize?: number } | null
}

export interface SyncRunDurationFactsResult {
  written: number
  recomputed: number
  kept: number
  failed: number
  /** 失败时最后一条错误，供作业记日志。 */
  lastError?: string
  /** 回扫的下一页游标；null 表示本轮回扫已走到最早的运行。 */
  catchUpNext: DurationFactsCursor | null
}

/** 后台事实作业的一轮：近期窗口 + 一页全量回扫。正确性靠「已完结且没有（当前版本）事实」的反连接。 */
export async function syncRunDurationFacts(db: Db, input: SyncRunDurationFactsInput = {}): Promise<SyncRunDurationFactsResult> {
  const { runs, runDurationFacts } = schemaFor(db)
  const finished = [...FINISHED_RUN_STATUSES]
  const missing = or(isNull(runDurationFacts.runId), lt(runDurationFacts.calcVersion, DURATION_FACTS_CALC_VERSION))
  const now = await clockNow(db)
  const since = new Date(now.getTime() - (input.recentWindowMs ?? 60 * 60 * 1000))

  const recent = await db
    .select({ id: runs.id })
    .from(runs)
    .leftJoin(runDurationFacts, eq(runDurationFacts.runId, runs.id))
    .where(and(gte(runs.finishedAt, since), inArray(runs.status, finished), missing))
    .orderBy(desc(runs.finishedAt), desc(runs.id))
    .limit(input.recentBatchSize ?? 50)

  const candidates = new Set(recent.map((row) => row.id))
  let catchUpNext: DurationFactsCursor | null = null
  if (input.catchUp) {
    const pageSize = input.catchUp.pageSize ?? 200
    const before = input.catchUp.before
    const cursorPredicate: SQL | undefined = before
      ? or(
          lt(runs.finishedAt, new Date(before.finishedAt)),
          and(eq(runs.finishedAt, new Date(before.finishedAt)), lt(runs.id, before.runId)),
        )
      : undefined
    const page = await db
      .select({ id: runs.id, finishedAt: runs.finishedAt, calcVersion: runDurationFacts.calcVersion })
      .from(runs)
      .leftJoin(runDurationFacts, eq(runDurationFacts.runId, runs.id))
      .where(and(isNotNull(runs.finishedAt), inArray(runs.status, finished), cursorPredicate))
      .orderBy(desc(runs.finishedAt), desc(runs.id))
      .limit(pageSize)
    for (const row of page) {
      if (row.calcVersion === null || row.calcVersion < DURATION_FACTS_CALC_VERSION) candidates.add(row.id)
    }
    const last = page.at(-1)
    catchUpNext = page.length === pageSize && last?.finishedAt ? { finishedAt: last.finishedAt.toISOString(), runId: last.id } : null
  }

  const result: SyncRunDurationFactsResult = { written: 0, recomputed: 0, kept: 0, failed: 0, catchUpNext }
  const ids = [...candidates]
  for (let i = 0; i < ids.length; i += 20) {
    const inputs = await loadCalculatorInputs(db, ids.slice(i, i + 20))
    for (const calculatorInput of inputs.values()) {
      try {
        const outcome = await writeFacts(db, computeRunDurationFacts(calculatorInput))
        if (outcome === 'written') result.written += 1
        else if (outcome === 'recomputed') result.recomputed += 1
        else if (outcome === 'kept') result.kept += 1
      } catch (error) {
        result.failed += 1
        result.lastError = `${calculatorInput.run.id}: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }
  return result
}

function factsFromRow(row: InferSelectModel<typeof runDurationFactsTable>): RunDurationFacts {
  return {
    runId: row.runId,
    targetId: row.targetId,
    scenarioId: row.scenarioId,
    scenarioVersionId: row.scenarioVersionId,
    suiteRunId: row.suiteRunId,
    triggerSource: row.triggerSource,
    comparable: row.comparable,
    status: row.status,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    totalMs: row.totalMs,
    activeMs: row.activeMs,
    authWaitMs: row.authWaitMs,
    requeueMs: row.requeueMs,
    reviewMs: row.reviewMs,
    holdMs: row.holdMs,
    unclassifiedMs: row.unclassifiedMs,
    queueMs: row.queueMs,
    overheadMs: row.overheadMs,
    workerLost: row.workerLost,
    complete: row.complete,
    incompleteReason: row.incompleteReason,
    calcVersion: row.calcVersion,
  }
}

export interface RunDurationFactsReadout {
  facts: RunDurationFacts
  nodes: NodeDurationFacts[]
  /** stored：读自事实表；computed：事实未生成（或运行未完结）时用同一计算器现算，未落库。 */
  source: 'stored' | 'computed'
}

/** 读取一条运行的耗时事实；没有当前版本事实时现算（运行中按当前时刻截止）。 */
export async function readRunDurationFacts(db: Db, runId: string, options: { asOf?: Date } = {}): Promise<RunDurationFactsReadout | null> {
  const { runDurationFacts, runNodeDurationFacts } = schemaFor(db)
  const [stored] = await db.select().from(runDurationFacts).where(eq(runDurationFacts.runId, runId)).limit(1)
  if (stored && stored.calcVersion >= DURATION_FACTS_CALC_VERSION) {
    const nodes = await db
      .select()
      .from(runNodeDurationFacts)
      .where(eq(runNodeDurationFacts.runId, runId))
      .orderBy(asc(runNodeDurationFacts.ordinal), asc(runNodeDurationFacts.nodeKey))
    return {
      facts: factsFromRow(stored),
      nodes: nodes.map((node) => ({
        nodeKey: node.nodeKey,
        parentKey: node.parentKey,
        kind: node.kind,
        name: node.name,
        ordinal: node.ordinal,
        status: node.status,
        activeMs: node.activeMs,
        windowMs: node.windowMs,
        attemptCount: node.attemptCount,
        iterationCount: node.iterationCount,
        maxResolution: node.maxResolution,
      })),
      source: 'stored',
    }
  }
  const asOf = options.asOf ?? (await clockNow(db))
  const input = (await loadCalculatorInputs(db, [runId], asOf)).get(runId)
  if (!input) return null
  const output = computeRunDurationFacts(input)
  return { facts: output.facts, nodes: output.nodes, source: 'computed' }
}
