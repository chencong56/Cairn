import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  suiteDocumentSchema,
  type Step,
} from '@cairn/shared'
import { newId } from '../id.js'
import { schemaFor } from '../native.js'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import {
  commitStoredObject,
  createScenarioWithVersion,
  createSuite,
  createSuiteRun,
  deleteRun,
  deleteSuiteRun,
  getRun,
  getSuiteRunCleanupStatus,
  getSuiteRunObservation,
  listPurgeCandidates,
  listSuiteRuns,
  listSuites,
  previewDeleteRun,
  previewDeleteSuiteRun,
  publishSuite,
  recordObjectEvidence,
  rerunSuiteItem,
  cancelSuiteRun,
  reserveStoredObject,
  type NativeHandle as DbHandle,
} from '../test-entry.js'

const echo: Step = {
  id: '00000000-0000-4000-8000-0000000000e1',
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'ok' },
}

describe.each(DRIVERS)('%s 场景集运行删除与级联清理', { timeout: 60_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `suite_del_${Date.now().toString(36)}`)
    const { consoleAccounts, consoleRoles, consoleAccountRoles } = schemaFor(handle.db)
    actorId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'suite-del-tester',
      email: `suite-del-${actorId}@example.com`,
      status: 'active',
    })
    const [admin] = await handle.db.select().from(consoleRoles).where(eq(consoleRoles.key, 'admin'))
    await handle.db.insert(consoleAccountRoles).values({
      consoleAccountId: actorId,
      consoleRoleId: admin!.id,
      targetScopeMode: 'all',
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  async function seedSuite() {
    const { targets } = schemaFor(handle.db)
    const targetId = newId()
    await handle.db.insert(targets).values({
      id: targetId,
      code: `suite-del-target-${targetId}`,
      name: '场景集删除测试目标',
      entryUrl: 'https://shop.example/home',
    })
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '场景集成员场景',
      steps: [echo],
      actor: { id: actorId },
    })

    const created = await createSuite(
      handle.db,
      {
        targetId,
        name: '删除测试场景集',
        document: suiteDocumentSchema.parse({
          schemaVersion: 1,
          groups: [],
          members: [
            {
              memberId: 'm1',
              ordinal: 0,
              displayName: '成员一',
              scenarioId: scenario.id,
              scenarioVersionId: scenario.published!.versionId,
              input: {},
            },
          ],
          stages: [],
        }),
      },
      { kind: 'console', id: actorId },
    )

    await publishSuite(
      handle.db,
      created.id,
      { expectedRevision: created.draft.revision, idempotencyKey: `pub-${created.id}` },
      { kind: 'console', id: actorId },
    )

    return { targetId, suiteId: created.id, scenarioId: scenario.id }
  }

  it('SD01: 禁止删除活跃状态的场景集运行', async () => {
    const { suiteId } = await seedSuite()
    const { observation } = await createSuiteRun(
      handle.db,
      {
        suiteId,
        idempotencyKey: newId(),
      },
      { kind: 'console', id: actorId },
    )

    expect(observation.status).toBe('RUNNING')

    const preview = await previewDeleteSuiteRun(handle.db, observation.id)
    expect(preview.blockers).toContainEqual(
      expect.objectContaining({
        code: 'RUN_NOT_TERMINAL',
      }),
    )

    await expect(
      deleteSuiteRun(handle.db, observation.id, { kind: 'console', id: actorId }),
    ).rejects.toMatchObject({
      code: 'RUN_NOT_TERMINAL',
    })
  })

  it('SD02: 禁止直接删除属于场景集的子运行', async () => {
    const { suiteId } = await seedSuite()
    const { observation } = await createSuiteRun(
      handle.db,
      {
        suiteId,
        idempotencyKey: newId(),
      },
      { kind: 'console', id: actorId },
    )

    const childRunId = observation.items[0]?.childRunId
    expect(childRunId).toBeTruthy()

    // Settle child run so it's idle
    const { runs } = schemaFor(handle.db)
    await handle.db
      .update(runs)
      .set({ status: 'SUCCEEDED', finishedAt: new Date() })
      .where(eq(runs.id, childRunId!))

    const preview = await previewDeleteRun(handle.db, childRunId!)
    expect(preview.blockers).toEqual([
      expect.objectContaining({
        code: 'RUN_OWNED_BY_SUITE',
      }),
    ])

    await expect(
      deleteRun(handle.db, childRunId!, { id: actorId }),
    ).rejects.toMatchObject({
      code: 'RUN_OWNED_BY_SUITE',
    })
  })

  it('SD03: 场景集运行删除级联清理子运行、证据与对象，且重复删除幂等', async () => {
    const { suiteId } = await seedSuite()
    const idempotencyKey = newId()
    const { observation } = await createSuiteRun(
      handle.db,
      {
        suiteId,
        idempotencyKey,
      },
      { kind: 'console', id: actorId },
    )

    const childRunId = observation.items[0]!.childRunId!

    // Attach stored object to child run
    const reserved = await reserveStoredObject(handle.db, {
      runId: childRunId,
      retainUntil: new Date(Date.now() + 86_400_000),
    })
    await commitStoredObject(handle.db, {
      id: reserved.id,
      contentType: 'text/plain',
      byteSize: 4,
      digest: `sha256:${'ab'.repeat(32)}`,
    })
    await recordObjectEvidence(handle.db, {
      runId: childRunId,
      type: 'log',
      objectKey: reserved.objectKey,
    })

    // Settle child run and suite run to completed
    const { runs, suiteRuns } = schemaFor(handle.db)
    await handle.db
      .update(runs)
      .set({ status: 'SUCCEEDED', finishedAt: new Date() })
      .where(eq(runs.id, childRunId))
    await handle.db
      .update(suiteRuns)
      .set({ status: 'COMPLETED', finishedAt: new Date() })
      .where(eq(suiteRuns.id, observation.id))

    // Preview deletion
    const preview = await previewDeleteSuiteRun(handle.db, observation.id)
    expect(preview.counts.suiteRuns).toBe(1)
    expect(preview.counts.runs).toBe(1)
    expect(preview.counts.storedObjects).toBe(1)
    expect(preview.blockers).toHaveLength(0)

    // Expected counts mismatch should fail
    await expect(
      deleteSuiteRun(
        handle.db,
        observation.id,
        { kind: 'console', id: actorId },
        { expectedCounts: { runs: 0 } },
      ),
    ).rejects.toMatchObject({
      code: 'DELETE_SCOPE_EXPANDED',
    })

    // Delete with expected counts
    const result = await deleteSuiteRun(
      handle.db,
      observation.id,
      { kind: 'console', id: actorId },
      { expectedCounts: preview.counts },
    )

    expect(result.resourceId).toBe(observation.id)
    expect(result.totalObjects).toBe(1)

    const { suiteRuns: suiteRunsTable } = schemaFor(handle.db)
    const [suiteRunRow] = await handle.db.select().from(suiteRunsTable).where(eq(suiteRunsTable.id, observation.id))
    expect(suiteRunRow?.deletedAt).toBeTruthy()
    expect(suiteRunRow?.deletedBy).toMatchObject({ id: actorId })

    // Excluded from listSuiteRuns
    const list = await listSuiteRuns(handle.db, { suiteId })
    expect(list.items.some((item) => item.id === observation.id)).toBe(false)

    // 场景集列表的「最近运行」不再指向已删除的运行
    const suites = await listSuites(handle.db, {}, actorId)
    expect(suites.items.find((item) => item.id === suiteId)?.latestRun ?? null).toBeNull()

    // Child run is also soft deleted
    await expect(getRun(handle.db, childRunId)).rejects.toMatchObject({
      code: 'RUN_NOT_FOUND',
    })

    // Observation cannot be loaded
    await expect(getSuiteRunObservation(handle.db, observation.id)).rejects.toMatchObject({
      code: 'SUITE_RUN_NOT_FOUND',
    })

    // Objects are marked for purge
    const candidates = await listPurgeCandidates(handle.db, {
      now: new Date(),
      pendingTtlSeconds: 3600,
      limit: 100,
    })
    expect(candidates.some((row) => row.id === reserved.id && row.deleteRequestedAt)).toBe(true)

    // Cleanup status check
    const cleanupStatus = await getSuiteRunCleanupStatus(handle.db, observation.id)
    expect(cleanupStatus.resourceId).toBe(observation.id)
    expect(cleanupStatus.resourceType).toBe('suite_run')
    expect(cleanupStatus.totalObjects).toBe(1)

    // Repeat deletion is idempotent
    const repeat = await deleteSuiteRun(
      handle.db,
      observation.id,
      { kind: 'console', id: actorId },
    )
    expect(repeat.resourceId).toBe(result.resourceId)
    expect(repeat.status).toBe(result.status)

    // Re-creating with same idempotency key fails with IDEMPOTENCY_KEY_CONSUMED
    await expect(
      createSuiteRun(
        handle.db,
        {
          suiteId,
          idempotencyKey,
        },
        { kind: 'console', id: actorId },
      ),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_CONSUMED',
    })
  })

  async function settle(suiteRunId: string, runId: string) {
    const { runs, suiteRuns } = schemaFor(handle.db)
    await handle.db.update(runs).set({ status: 'SUCCEEDED', finishedAt: new Date() }).where(eq(runs.id, runId))
    await handle.db
      .update(suiteRuns)
      .set({ status: 'COMPLETED', finishedAt: new Date() })
      .where(eq(suiteRuns.id, suiteRunId))
  }

  it('SD04: 重跑过的成员，原 Run 与新 Run 一并级联删除，已删集的取消与重跑返回 404', async () => {
    const { suiteId } = await seedSuite()
    const actor = { kind: 'console' as const, id: actorId }
    const { observation } = await createSuiteRun(handle.db, { suiteId, idempotencyKey: newId() }, actor)
    const firstChild = observation.items[0]!.childRunId!
    await settle(observation.id, firstChild)

    const rerun = await rerunSuiteItem(handle.db, { suiteRunId: observation.id, memberId: 'm1' }, actor)
    const secondChild = rerun.runId
    expect(secondChild).not.toBe(firstChild)
    await settle(observation.id, secondChild)

    const preview = await previewDeleteSuiteRun(handle.db, observation.id)
    expect(preview.blockers).toHaveLength(0)
    expect(preview.counts.runs).toBe(2)

    await deleteSuiteRun(handle.db, observation.id, actor, { expectedCounts: preview.counts })

    const { runs } = schemaFor(handle.db)
    const rows = await handle.db.select().from(runs).where(eq(runs.suiteRunId, observation.id))
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.deletedAt)).toBe(true)

    await expect(cancelSuiteRun(handle.db, observation.id, actor)).rejects.toMatchObject({ code: 'SUITE_RUN_NOT_FOUND' })
    await expect(
      rerunSuiteItem(handle.db, { suiteRunId: observation.id, memberId: 'm1' }, actor),
    ).rejects.toMatchObject({ code: 'SUITE_RUN_NOT_FOUND' })
  })

  it('SD05: 子运行未结束或仍有活跃租约时阻塞删除', async () => {
    const { suiteId } = await seedSuite()
    const actor = { kind: 'console' as const, id: actorId }
    const { observation } = await createSuiteRun(handle.db, { suiteId, idempotencyKey: newId() }, actor)
    const childRunId = observation.items[0]!.childRunId!

    // 集已终态，但子 Run 仍未结束
    const { suiteRuns } = schemaFor(handle.db)
    await handle.db
      .update(suiteRuns)
      .set({ status: 'COMPLETED', finishedAt: new Date() })
      .where(eq(suiteRuns.id, observation.id))

    const preview = await previewDeleteSuiteRun(handle.db, observation.id)
    expect(preview.blockers).toContainEqual(expect.objectContaining({ code: 'RESOURCE_BUSY' }))
    await expect(deleteSuiteRun(handle.db, observation.id, actor)).rejects.toMatchObject({ code: 'RESOURCE_BUSY' })

    const { runs } = schemaFor(handle.db)
    const [row] = await handle.db.select().from(runs).where(eq(runs.id, childRunId))
    expect(row?.deletedAt).toBeNull()
    const [suiteRow] = await handle.db.select().from(suiteRuns).where(eq(suiteRuns.id, observation.id))
    expect(suiteRow?.deletedAt).toBeNull()
  })
})
