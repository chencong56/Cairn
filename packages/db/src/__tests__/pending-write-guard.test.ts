import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Step } from '@cairn/shared'
import { newId } from '../id.js'
import { pendingWriteBlockers } from '../lifecycle.js'
import { schemaFor } from '../native.js'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import {
  createRunWithSnapshot,
  createScenarioWithVersion,
  deleteRun,
  listPurgeCandidates,
  markStoredObjectPurgeFailed,
  previewDeleteRun,
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

describe.each(DRIVERS)('%s 删除守卫只拦新鲜 pending、清理失败有退避', { timeout: 60_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string
  let scenarioId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `pend_guard_${Date.now().toString(36)}`)
    const { consoleAccounts, targets } = schemaFor(handle.db)
    actorId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'pending-guard',
      email: `pend-guard-${actorId}@example.com`,
      status: 'active',
    })
    const targetId = newId()
    await handle.db.insert(targets).values({
      id: targetId,
      code: `pend-guard-${targetId}`,
      name: '守卫测试目标',
      entryUrl: 'https://example.com',
    })
    scenarioId = (
      await createScenarioWithVersion(handle.db, {
        targetId,
        name: '守卫场景',
        steps: [echo],
        actor: { id: actorId },
      })
    ).id
  })

  afterAll(async () => {
    await handle?.close()
  })

  async function newRun(): Promise<string> {
    return (await createRunWithSnapshot(handle.db, { scenarioId, actor: { id: actorId } })).detail.id
  }

  async function pendingObject(runId: string, ageMs: number): Promise<string> {
    const reserved = await reserveStoredObject(handle.db, {
      runId,
      retainUntil: new Date(Date.now() + 86_400_000),
    })
    const { storedObjects } = schemaFor(handle.db)
    await handle.db
      .update(storedObjects)
      .set({ createdAt: new Date(Date.now() - ageMs) })
      .where(eq(storedObjects.id, reserved.id))
    return reserved.id
  }

  it('TTL 内的 pending 阻塞，提示带 Run ID、对象数与自动恢复说明', async () => {
    const runId = await newRun()
    await pendingObject(runId, 5 * 60_000)
    await pendingObject(runId, 60_000)

    const blockers = await pendingWriteBlockers(handle.db, [runId])
    expect(blockers).toHaveLength(1)
    expect(blockers[0]).toMatchObject({ id: runId, code: 'RESOURCE_BUSY' })
    expect(blockers[0]!.message).toContain(runId)
    expect(blockers[0]!.message).toContain('2 个证据对象')
    expect(blockers[0]!.message).toContain('5 分钟前')
    expect(blockers[0]!.message).toContain('自动恢复')
  })

  it('超过 TTL 的 pending 不阻塞，删除放行', async () => {
    const runId = await newRun()
    await pendingObject(runId, 2 * 3600_000)

    expect(await pendingWriteBlockers(handle.db, [runId])).toEqual([])
    const preview = await previewDeleteRun(handle.db, runId)
    expect(preview.blockers.filter((b) => b.code === 'RESOURCE_BUSY')).toEqual([])
  })

  it('超过 pendingTtl 的判据可显式传入', async () => {
    const runId = await newRun()
    await pendingObject(runId, 10 * 60_000)
    expect(await pendingWriteBlockers(handle.db, [runId], { pendingTtlSeconds: 300 })).toEqual([])
    expect(await pendingWriteBlockers(handle.db, [runId], { pendingTtlSeconds: 900 })).toHaveLength(1)
  })

  it('多个运行阻塞时最多逐个列出 3 个，其余折叠', async () => {
    const ids: string[] = []
    for (let i = 0; i < 5; i += 1) {
      const runId = await newRun()
      await pendingObject(runId, 60_000)
      ids.push(runId)
    }
    const blockers = await pendingWriteBlockers(handle.db, ids)
    expect(blockers).toHaveLength(4)
    expect(blockers[3]!.message).toContain('另有 2 个运行')
  })

  it('删除后卡死的 pending 被标记删除并进入清理候选', async () => {
    const runId = await newRun()
    const objectId = await pendingObject(runId, 2 * 3600_000)
    const { runs } = schemaFor(handle.db)
    await handle.db.update(runs).set({ status: 'SUCCEEDED', finishedAt: new Date() }).where(eq(runs.id, runId))
    await deleteRun(handle.db, runId, { id: actorId })
    const candidates = await listPurgeCandidates(handle.db, {
      now: new Date(),
      pendingTtlSeconds: 3600,
      limit: 1000,
    })
    expect(candidates.map((c) => c.id)).toContain(objectId)
  })

  it('清理失败后按退避窗口再选中，封顶 1 小时', async () => {
    const runId = await newRun()
    const objectId = await pendingObject(runId, 2 * 3600_000)
    const t0 = new Date()
    const has = async (at: Date) =>
      (await listPurgeCandidates(handle.db, { now: at, pendingTtlSeconds: 3600, limit: 1000 }))
        .map((c) => c.id)
        .includes(objectId)

    expect(await has(t0)).toBe(true)
    await markStoredObjectPurgeFailed(handle.db, { id: objectId, now: t0 })
    expect(await has(new Date(t0.getTime() + 30_000))).toBe(false)
    expect(await has(new Date(t0.getTime() + 150_000))).toBe(true)

    for (let i = 0; i < 9; i += 1) {
      await markStoredObjectPurgeFailed(handle.db, { id: objectId, now: t0 })
    }
    expect(await has(new Date(t0.getTime() + 3_000_000))).toBe(false)
    expect(await has(new Date(t0.getTime() + 3_700_000))).toBe(true)
  })
})
