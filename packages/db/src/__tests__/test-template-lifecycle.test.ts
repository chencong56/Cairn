import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { Client, Pool } from 'pg'
import type { PostgresDbEnv } from '@cairn/shared'
import {
  cleanupOrphanTestDatabases,
  requireReachableDb,
  setupTestTemplateDatabase,
  templateOwnerAppName,
} from '../testing.js'

/**
 * 测试模板库的生命周期：不泄漏、不误删。
 *
 * 背景：2026-09-30 起 worker 多 project 配置每个 project 都跑一遍 globalSetup，一次运行建多个模板而
 * 只删最后一个；2026-09-29 起模板被标 is_template 后 PG 拒绝直接 DROP，自动回收对模板一律静默失败。
 * 两者叠加在开发库里积压了 200+ 个模板（4GB+）。
 */

const created: string[] = []
const holders: Client[] = []

function templateName(): string {
  const name = `cairn_test_template_${randomUUID().replaceAll('-', '')}`
  created.push(name)
  return name
}

function adminPool(env: PostgresDbEnv): Pool {
  return new Pool({
    host: env.CAIRN_DB_HOST,
    port: env.CAIRN_DB_PORT,
    database: env.CAIRN_DB_NAME,
    user: env.CAIRN_DB_USER,
    password: env.CAIRN_DB_PASSWORD,
    max: 2,
  })
}

async function exists(admin: Pool, name: string): Promise<boolean> {
  const res = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
  return res.rows.length > 0
}

async function createTemplate(admin: Pool, name: string): Promise<void> {
  await admin.query(`CREATE DATABASE "${name}"`)
  await admin.query(`ALTER DATABASE "${name}" WITH is_template = true`)
}

async function hold(env: PostgresDbEnv, name: string): Promise<Client> {
  const client = new Client({
    host: env.CAIRN_DB_HOST,
    port: env.CAIRN_DB_PORT,
    database: env.CAIRN_DB_NAME,
    user: env.CAIRN_DB_USER,
    password: env.CAIRN_DB_PASSWORD,
    application_name: templateOwnerAppName(name),
  })
  client.on('error', () => {})
  await client.connect()
  holders.push(client)
  return client
}

afterEach(async () => {
  for (const client of holders.splice(0)) await client.end().catch(() => {})
  const env = await requireReachableDb()
  const admin = adminPool(env)
  try {
    for (const name of created.splice(0)) {
      await admin.query(`ALTER DATABASE "${name}" WITH is_template = false`).catch(() => {})
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {})
    }
  } finally {
    await admin.end()
  }
})

describe('测试模板库生命周期', () => {
  it('已标 is_template 且无人持有的孤儿模板能被回收（PG 拒绝直接 DROP 模板）', async () => {
    const env = await requireReachableDb()
    const admin = adminPool(env)
    try {
      const name = templateName()
      await createTemplate(admin, name)
      await expect(admin.query(`DROP DATABASE "${name}"`)).rejects.toThrow(/template/i)

      await cleanupOrphanTestDatabases(env)

      expect(await exists(admin, name)).toBe(false)
    } finally {
      await admin.end()
    }
  })

  it('持有者连接仍在的模板被保留，持有者断开后才可回收', async () => {
    const env = await requireReachableDb()
    const admin = adminPool(env)
    try {
      const name = templateName()
      // PG 把 application_name 截断在 63 字符；超长会让回收程序认不出持有者而误删在用的模板
      expect(templateOwnerAppName(name).length).toBeLessThanOrEqual(63)
      await createTemplate(admin, name)
      const owner = await hold(env, name)

      await cleanupOrphanTestDatabases(env)
      expect(await exists(admin, name)).toBe(true)

      await owner.end()
      // 服务端回收 backend 有极短延迟
      for (let i = 0; i < 20; i += 1) {
        const left = await admin.query('SELECT 1 FROM pg_stat_activity WHERE application_name = $1', [
          templateOwnerAppName(name),
        ])
        if (left.rows.length === 0) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }

      await cleanupOrphanTestDatabases(env)
      expect(await exists(admin, name)).toBe(false)
    } finally {
      await admin.end()
    }
  })

  it('一次 setup 只建一个模板，清理函数删掉自己建的那个，且持有者连接随之释放', async () => {
    const env = await requireReachableDb()
    const admin = adminPool(env)
    const previous = process.env.CAIRN_TEST_TEMPLATE_DB
    try {
      const before = new Set(
        (await admin.query<{ datname: string }>(`SELECT datname FROM pg_database WHERE datname LIKE 'cairn_test_template_%'`)).rows.map(
          (row) => row.datname,
        ),
      )

      const release = await setupTestTemplateDatabase()
      const mine = process.env.CAIRN_TEST_TEMPLATE_DB
      expect(mine).toMatch(/^cairn_test_template_[a-f0-9]{32}$/)
      created.push(mine!)

      const during = (
        await admin.query<{ datname: string; datistemplate: boolean }>(
          `SELECT datname, datistemplate FROM pg_database WHERE datname LIKE 'cairn_test_template_%'`,
        )
      ).rows
      const added = during.filter((row) => !before.has(row.datname))
      // 并发运行的其他套件也可能新增模板；本次至少且只为自己建了 mine
      expect(added.map((row) => row.datname)).toContain(mine)
      expect(added.find((row) => row.datname === mine)?.datistemplate).toBe(true)
      const holder = await admin.query('SELECT 1 FROM pg_stat_activity WHERE application_name = $1', [
        templateOwnerAppName(mine!),
      ])
      expect(holder.rows.length).toBe(1)

      await release()

      expect(await exists(admin, mine!)).toBe(false)
      expect(process.env.CAIRN_TEST_TEMPLATE_DB).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.CAIRN_TEST_TEMPLATE_DB
      else process.env.CAIRN_TEST_TEMPLATE_DB = previous
      await admin.end()
    }
  }, 60_000)
})
