import { eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type Step,
} from '@cairn/shared'
import { newId } from '../id.js'
import { schemaFor } from '../native.js'
import {
  claimRun,
  createRunWithSnapshot,
  createScenarioWithVersion,
  registerWorker,
  type NativeHandle as DbHandle,
} from '../test-entry.js'
import { DRIVERS, openContractDb } from './contract-fixture.js'

const tableStep: Step = {
  id: '00000000-0000-4000-8000-0000000000f1',
  name: '读表',
  type: 'extract',
  effectType: 'READ_ONLY',
  outputKey: 'tbl',
  input: {
    target: { framePath: [], candidates: [{ by: 'css', value: '#report' }] },
    as: 'table',
    table: {
      protocol: 'table.read@2',
      target: { framePath: [], candidates: [{ by: 'css', value: '#report' }] },
      scope: 'current_page',
      rows: { excludeHeader: true, header: 'auto' },
      columns: [{ key: 'col_1', name: '区域', valueType: 'text' }],
      limits: { maxRows: 200, maxCols: 32, maxBytes: 196608 },
    },
  },
} as Step

describe.each(DRIVERS)('%s table.read@2 不再有独立的能力门禁', { timeout: 60_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `tbl_${Date.now().toString(36)}`)
    const { consoleAccounts } = schemaFor(handle.db)
    actorId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'tbl',
      email: `tbl-${actorId}@example.com`,
      status: 'active',
    })
  })
  afterAll(async () => {
    await handle?.close()
  })

  it('含表格读取步骤的运行：快照不再带表格能力标记，没有声明任何表格能力的 worker 也能领取', async () => {
    const { targets, targetAccounts, runs } = schemaFor(handle.db)
    await handle.db.update(runs).set({ status: 'CANCELLED', cancelRequestedAt: new Date() }).where(inArray(runs.status, ['QUEUED', 'RECOVERING']))
    const targetId = newId()
    const accountId = newId()
    await handle.db.insert(targets).values({ id: targetId, code: `tbl-${targetId}`, name: 'tbl', entryUrl: 'https://shop.example/home' })
    await handle.db.insert(targetAccounts).values({ id: accountId, targetId, displayName: 'tbl', username: `ops-${accountId}`, status: 'active' })
    const scenario = await createScenarioWithVersion(handle.db, { targetId, name: '读表', steps: [tableStep], actor: { kind: 'console', id: actorId } })
    const created = await createRunWithSnapshot(handle.db, { scenarioId: scenario.id, targetAccountId: accountId, actor: { kind: 'console', id: actorId } })

    const instanceId = newId()
    const workerId = `tbl-w-${newId()}`
    await registerWorker(handle.db, {
      workerId,
      instanceId,
      capacity: 4,
      lostAfterSeconds: 60,
      // 不声明任何表格相关能力：表格读取 / 验收不再有能力门禁
      roles: ['executor'],
    })
    const grant = await claimRun(handle, { workerId, instanceId, leaseTtlSeconds: 30 })
    expect(grant?.runId).toBe(created.detail.id)
    const [row] = await handle.db.select({ snapshot: runs.snapshot }).from(runs).where(eq(runs.id, created.detail.id))
    expect(JSON.stringify(row?.snapshot ?? {})).not.toContain('tableReadProtocol')
    expect(JSON.stringify(row?.snapshot ?? {})).not.toContain('tableAcceptanceProtocol')
  })
})
