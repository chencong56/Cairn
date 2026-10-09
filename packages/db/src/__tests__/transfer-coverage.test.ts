import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { is } from 'drizzle-orm'
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core'
import { createAccountBodySchema, createTargetBodySchema, type Step } from '@cairn/shared'
import * as api from '../index.js'
import { expose } from '../database.js'
import type { DbHandle } from '../client.js'
import { schemaFor } from '../native.js'
import * as logical from '../schema/index.js'
import { TRANSFER_TABLE_ORDER, exportDatabase, importDatabase } from '../transfer.js'
import { DRIVERS, openContractDb } from './contract-fixture.js'

const echo: Step = {
  id: '00000000-0000-4000-8000-000000000081',
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'hello' },
}
const passwordAdapter = {
  hash: async (s: string) => createHash('sha256').update(s).digest('hex'),
  verify: async (s: string, h: string) => createHash('sha256').update(s).digest('hex') === h,
}
const transferOptions = { writersStopped: true as const, allowMillisecondPrecisionLoss: true }

const logicalTables = Object.entries(logical).filter(([, value]) => is(value, PgTable)) as Array<[string, PgTable]>

const handles: DbHandle[] = []
afterEach(async () => {
  for (const h of handles.splice(0).reverse()) await h.close()
})

/** 迁移归档必须覆盖全部逻辑表；漏登记的表在导出时会被静默丢掉（曾漏掉运行事件、耗时事实等 45 张表）。 */
describe('迁移归档的表覆盖', () => {
  it('登记的表与 schema 全集一致、不重复', () => {
    expect(new Set(TRANSFER_TABLE_ORDER).size).toBe(TRANSFER_TABLE_ORDER.length)
    expect([...TRANSFER_TABLE_ORDER].sort()).toEqual(logicalTables.map(([key]) => key).sort())
  })

  it.each(DRIVERS.filter((driver) => driver === 'postgres'))('%s 登记顺序满足库内外键：被引用的表先导入', async (driver) => {
    const h = await openContractDb(driver)
    handles.push(h)
    const keyBySqlName = new Map(logicalTables.map(([key, table]) => [getTableConfig(table).name, key]))
    const schema = getTableConfig(schemaFor(h.db).runs).schema ?? 'public'
    const rows = await h.raw(
      `SELECT ch.relname AS child, pa.relname AS parent
         FROM pg_constraint c
         JOIN pg_class ch ON ch.oid = c.conrelid
         JOIN pg_class pa ON pa.oid = c.confrelid
         JOIN pg_namespace n ON n.oid = ch.relnamespace
        WHERE c.contype = 'f' AND n.nspname = $1`,
      [schema],
    )
    expect(rows.length).toBeGreaterThan(100)
    const position = new Map<string, number>(TRANSFER_TABLE_ORDER.map((key, index) => [key, index]))
    const violations: string[] = []
    for (const row of rows) {
      const child = keyBySqlName.get(String(row.child))
      const parent = keyBySqlName.get(String(row.parent))
      expect(child, `外键子表 ${String(row.child)} 不在逻辑 schema 里`).toBeDefined()
      expect(parent, `外键父表 ${String(row.parent)} 不在逻辑 schema 里`).toBeDefined()
      if (child === parent) continue // 自引用由导入时按行排序处理（reportRevisions）
      if (position.get(parent!)! > position.get(child!)!) violations.push(`${child} → ${parent}`)
    }
    expect(violations).toEqual([])
  })

  it.each(DRIVERS.filter((driver) => driver === 'postgres'))('%s 运行事件、耗时事实与按天汇总随归档迁走并原样回读', async (driver) => {
    const source = await openContractDb(driver)
    handles.push(source)
    const db = expose(source)
    const rbac = new api.RbacStore(db, passwordAdapter)
    const adminRole = (await rbac.listRoles()).items.find((role) => role.key === 'admin')!
    const actor = await rbac.createAccount(
      createAccountBodySchema.parse({
        email: 'transfer-admin',
        displayName: '迁移管理员',
        password: 'secret-password',
        roleIds: [adminRole.id],
        targetScopes: [{ roleId: adminRole.id, mode: 'all' }],
      }),
      null,
    )
    const targets = new api.TargetsStore(db, () => Buffer.from([1, 2, 3]))
    const target = await targets.createTarget(
      createTargetBodySchema.parse({
        code: 'transfer-coverage',
        name: '迁移覆盖',
        entryUrl: 'https://example.com',
        account: { username: 'user', displayName: '账号', password: 'hidden-value', validity: { mode: 'permanent' } },
      }),
      actor,
    )
    const scenario = await api.createScenarioWithVersion(db, { targetId: target.id, name: '迁移场景', steps: [echo], actor })
    const created = await api.createRunWithSnapshot(db, { scenarioId: scenario.id, actor })
    const worker = { workerId: api.newId(), instanceId: api.newId() }
    await api.registerWorker(db, { ...worker, capacity: 2, lostAfterSeconds: 60, roles: ['executor'] })
    const grant = (await api.claimRun(db, { ...worker, leaseTtlSeconds: 60 }))!
    const attempt = (await api.startAttempt(db, {
      runId: grant.runId,
      stepRunId: created.detail.stepRuns[0]!.id,
      inputPayload: {},
      grant,
    }))!
    await api.finishAttempt(db, {
      runId: grant.runId,
      attemptId: attempt.attemptId,
      attemptStatus: 'SUCCEEDED',
      output: { text: '迁移 🧪' },
      stepRunStatus: 'SUCCEEDED',
      runStatus: 'SUCCEEDED',
      grant,
    })
    await api.markWorkerStopped(db, worker.workerId, worker.instanceId)
    await api.syncRunDurationFacts(db)
    await api.processDurationRollups(db)

    const archive = await exportDatabase(db, source.env, transferOptions)
    for (const key of ['runEvents', 'runDurationFacts', 'runNodeDurationFacts', 'durationScenarioDaily', 'durationRollupState'] as const) {
      expect(archive.tables[key]!.length, key).toBeGreaterThan(0)
    }

    const target2 = await openContractDb(driver, undefined, { pristine: true })
    handles.push(target2)
    const targetDb = expose(target2)
    const result = await importDatabase(targetDb, target2.env, archive, transferOptions)
    for (const key of TRANSFER_TABLE_ORDER) expect(result.counts[key], key).toBe(archive.tables[key]!.length)
    expect(await api.readRunDurationFacts(targetDb, grant.runId)).toEqual(await api.readRunDurationFacts(db, grant.runId))
  })
})
