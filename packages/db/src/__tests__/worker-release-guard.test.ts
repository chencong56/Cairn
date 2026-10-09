import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Step } from '@cairn/shared'
import { newId } from '../id.js'
import { clockNow, schemaFor } from '../native.js'
import {
  claimRun,
  collectAlertReadings,
  createRunWithSnapshot,
  createScenarioWithVersion,
  getWorkerDetail,
  heartbeatApiInstance,
  listMonitorAlertRules,
  listWorkers,
  markApiInstanceStopped,
  registerWorker,
  summarizeFleet,
  type NativeHandle as DbHandle,
} from '../test-entry.js'
import { DRIVERS, openContractDb } from './contract-fixture.js'

const echo: Step = {
  id: '00000000-0000-4000-8000-000000000071',
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'hello' },
}

/** 锁步部署 P1：显式角色决定谁领运行，发布号与在线控制台不一致的 Worker 不领新运行。 */
describe.each(DRIVERS)('%s Worker 角色与发布号守卫', { timeout: 90_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string
  let targetId: string
  let accountId: string
  const apiInstances: Array<{ id: string; instanceId: string }> = []

  beforeAll(async () => {
    handle = await openContractDb(driver, `release_${Date.now().toString(36)}`)
    const { consoleAccounts, targets, targetAccounts } = schemaFor(handle.db)
    actorId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'release',
      email: `release-${actorId}@example.com`,
      status: 'active',
    })
    targetId = newId()
    accountId = newId()
    await handle.db.insert(targets).values({ id: targetId, code: `release-${targetId}`, name: '发布号', entryUrl: 'https://shop.example/home' })
    await handle.db.insert(targetAccounts).values({
      id: accountId,
      targetId,
      displayName: '发布号',
      username: `ops-${accountId}`,
      status: 'active',
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  async function worker(suffix: string, roles: string[], release: string | null) {
    const workerId = `rel-${suffix}-${newId().slice(-12)}`
    const instanceId = newId()
    await registerWorker(handle.db, { workerId, instanceId, capacity: 4, maxSessions: 4, lostAfterSeconds: 60, roles, release })
    return { workerId, instanceId }
  }

  async function queueRun(name: string) {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name,
      steps: [echo],
      actor: { kind: 'console', id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: accountId,
      actor: { kind: 'console', id: actorId },
    })
    return created.detail.id
  }

  async function runStatus(runId: string) {
    const { runs } = schemaFor(handle.db)
    const [row] = await handle.db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId))
    return row?.status
  }

  async function apiOnline(version: string | null) {
    const instance = { id: `api-${newId().slice(-12)}`, instanceId: newId() }
    await heartbeatApiInstance(handle.db, { ...instance, idSource: 'configured', lostAfterSeconds: 60, version, schemaLogicalVersion: null })
    apiInstances.push(instance)
  }

  async function apiAllStopped() {
    for (const instance of apiInstances.splice(0)) await markApiInstanceStopped(handle.db, instance.id, instance.instanceId)
  }

  const claim = (w: { workerId: string; instanceId: string }) => claimRun(handle, { ...w, leaseTtlSeconds: 30 })

  it('只有执行节点领运行', async () => {
    const runId = await queueRun('only-executor')
    const scheduler = await worker('sched', ['scheduler', 'maintenance', 'analyst'], null)
    expect(await claim(scheduler)).toBeNull()
    expect(await runStatus(runId)).toBe('QUEUED')

    const executor = await worker('exec', ['executor'], null)
    expect((await claim(executor))?.runId).toBe(runId)
  })

  it('在线控制台都是发布号 R 时，发布号不同的 Worker 不领新运行；一致或没有发布号的照常领', async () => {
    await apiOnline('r2')
    const runId = await queueRun('release-guard')

    const old = await worker('old', ['executor'], 'r1')
    expect(await claim(old)).toBeNull()
    expect(await runStatus(runId)).toBe('QUEUED')

    const unversioned = await worker('dev', ['executor'], null)
    expect((await claim(unversioned))?.runId).toBe(runId)

    const nextRunId = await queueRun('release-match')
    const current = await worker('cur', ['executor'], 'r2')
    expect((await claim(current))?.runId).toBe(nextRunId)
  })

  it('控制台之间发布号不一致（控制台滚动升级中）或控制台都下线时不拦', async () => {
    await apiOnline('r3')
    const rollingRunId = await queueRun('rolling-api')
    const old = await worker('roll', ['executor'], 'r1')
    expect((await claim(old))?.runId).toBe(rollingRunId)

    await apiAllStopped()
    const offlineRunId = await queueRun('api-offline')
    const stray = await worker('stray', ['executor'], 'r1')
    expect((await claim(stray))?.runId).toBe(offlineRunId)
  })

  it('舰队摘要、容量卡与告警读数标出版本不一致的执行节点；出厂规则默认开启', async () => {
    await apiOnline('r9')
    const behind = await worker('behind', ['executor'], 'r8')
    const analyst = await worker('analyst', ['analyst'], 'r8')
    const current = await worker('match', ['executor', 'scheduler'], 'r9')

    const list = await listWorkers(handle.db, { limit: 100 }, { canSeeEndpoint: false })
    const byId = new Map(list.items.map((item) => [item.workerId, item]))
    expect(byId.get(behind.workerId)).toMatchObject({ roles: ['executor'], release: 'r8', releaseMismatch: true })
    expect(byId.get(current.workerId)).toMatchObject({ roles: ['executor', 'scheduler'], release: 'r9', releaseMismatch: false })
    const detail = await getWorkerDetail(handle.db, behind.workerId, { limit: 20 }, { canSeeEndpoint: false })
    expect(detail.worker.releaseMismatch).toBe(true)

    // 只数执行节点：分析节点版本不同不影响领运行
    const fleet = await summarizeFleet(handle.db)
    const expected = list.items.filter((item) => item.releaseMismatch && item.roles.includes('executor') && item.heartbeatFresh).length
    expect(fleet.data.workers.releaseMismatch).toEqual({ availability: 'known', value: expected })
    expect(expected).toBeGreaterThanOrEqual(1)
    expect(byId.get(analyst.workerId)?.releaseMismatch).toBe(true)

    const readings = await collectAlertReadings(handle.db, await clockNow(handle.db))
    expect(readings.get('metric:worker.release.mismatch:platform:platform')).toEqual({ availability: 'known', value: expected })

    const rules = await listMonitorAlertRules(handle.db)
    expect(rules.rules.find((rule) => rule.id === 'factory.worker.release_mismatch')).toMatchObject({
      metricKey: 'worker.release.mismatch',
      enabled: true,
    })
    await apiAllStopped()
  })
})
