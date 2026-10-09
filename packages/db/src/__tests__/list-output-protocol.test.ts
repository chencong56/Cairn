import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SESSION_OCCUPANCY_PROTOCOL, type Step } from '@cairn/shared'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import type { DbHandle } from '../client.js'
import { newId } from '../id.js'
import { schemaFor } from '../native.js'
import { createRunWithSnapshot } from '../runs/runs.js'
import { claimRun, markWorkerStopped, registerWorker } from '../leases/leases.js'
import { createScenarioWithVersion } from '../runs/scenarios.js'

describe.each(DRIVERS)('CFA-14: 列表输出不设 Worker 领取门控 (%s)', (driverName) => {
  let handle: DbHandle
  let targetId: string
  const actorId = newId()
  const actor = { id: actorId, email: 'test@example.com' }

  beforeAll(async () => {
    handle = await openContractDb(driverName)
    targetId = newId()
    const { consoleAccounts, targets } = schemaFor(handle.db)
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'test_author',
      email: `test-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      name: 'test_target',
      code: `test_${targetId.slice(0, 8)}`,
      entryUrl: 'https://example.com',
      status: 'active',
    })
  })

  afterAll(async () => {
    await handle.close?.()
  })

  it('锁步部署：使用列表提取的快照不写 listOutputProtocol，只声明会话占用的 Worker 就能领取', async () => {
    const extractStep: Step = {
      id: newId(),
      name: '批量提取',
      type: 'extract',
      effectType: 'READ_ONLY',
      outputKey: 'items',
      input: {
        target: { framePath: [], candidates: [{ by: 'css', value: '.item' }] },
        as: 'text',
        many: { maxItems: 10 },
      },
    }

    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `list-out-${newId().slice(0, 8)}`,
      actor,
      steps: [extractStep],
    })

    const run = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      scenarioVersionId: scenario.latestVersionId,
      actor: { kind: 'console', id: actorId },
    })

    expect(run.detail.snapshot.listOutputProtocol).toBeUndefined()

    const worker = {
      workerId: `w-${newId()}`,
      instanceId: newId(),
      capacity: 1,
      lostAfterSeconds: 60,
      protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL],
    }
    await registerWorker(handle.db, worker)
    const grant = await claimRun(handle, { ...worker, leaseTtlSeconds: 60 })
    expect(grant?.runId).toBe(run.detail.id)
    await markWorkerStopped(handle.db, worker.workerId, worker.instanceId)
  })
})
