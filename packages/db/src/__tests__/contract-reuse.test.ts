import { afterEach, describe, expect, it } from 'vitest'
import { newId } from '../id.js'
import { openContractDb } from './contract-fixture.js'

describe('隔离库在文件内复用', { timeout: 60_000 }, () => {
  const handles: Array<{ close(): Promise<void> }> = []
  afterEach(async () => {
    for (const handle of handles.splice(0).reverse()) await handle.close()
  })

  async function open(...args: Parameters<typeof openContractDb>) {
    const handle = await openContractDb(...args)
    handles.push(handle)
    return handle
  }

  it('连续打开是同一个库，但看不见上一条写入，系统权限回到种子', async () => {
    const first = await open('postgres')
    const id = newId()
    await first.raw(
      `INSERT INTO cairn.targets (id, code, name, entry_url) VALUES ($1, $2, '复用探针', 'https://example.com')`,
      [id, `reuse-${id.slice(0, 8)}`],
    )
    await first.raw(`DELETE FROM cairn.console_role_permissions WHERE permission = 'session:view'`)
    const name = first.env.CAIRN_DB_NAME
    await first.close()

    const second = await open('postgres')
    expect(second.env.CAIRN_DB_NAME).toBe(name)
    expect(await second.raw(`SELECT id FROM cairn.targets WHERE id = $1`, [id])).toHaveLength(0)
    const permissions = await second.raw(
      `SELECT count(*)::int AS n FROM cairn.console_role_permissions WHERE permission = 'session:view'`,
    )
    expect(Number(permissions[0]!.n)).toBeGreaterThan(0)
    const config = await second.raw(`SELECT count(*)::int AS n FROM cairn.platform_config`)
    expect(Number(config[0]!.n)).toBe(1)
  })

  it('同时打开的两个库互不可见', async () => {
    const first = await open('postgres')
    const second = await open('postgres')
    expect(second.env.CAIRN_DB_NAME).not.toBe(first.env.CAIRN_DB_NAME)
    const id = newId()
    await first.raw(
      `INSERT INTO cairn.targets (id, code, name, entry_url) VALUES ($1, $2, '甲', 'https://example.com')`,
      [id, `reuse-a-${id.slice(0, 8)}`],
    )
    expect(await second.raw(`SELECT id FROM cairn.targets WHERE id = $1`, [id])).toHaveLength(0)
  })

  it('纯净库重置后仍然没有平台配置，种子管理员还在', async () => {
    const seeded = await open('postgres')
    await seeded.close()
    const pristine = await open('postgres', undefined, { pristine: true })
    const before = await pristine.raw(`SELECT count(*)::int AS n FROM cairn.platform_config`)
    expect(Number(before[0]!.n)).toBe(0)
    const id = newId()
    await pristine.raw(
      `INSERT INTO cairn.targets (id, code, name, entry_url) VALUES ($1, $2, '纯净', 'https://example.com')`,
      [id, `reuse-p-${id.slice(0, 8)}`],
    )
    const name = pristine.env.CAIRN_DB_NAME
    await pristine.close()

    const again = await open('postgres', undefined, { pristine: true })
    expect(again.env.CAIRN_DB_NAME).toBe(name)
    expect(await again.raw(`SELECT id FROM cairn.targets WHERE id = $1`, [id])).toHaveLength(0)
    const config = await again.raw(`SELECT count(*)::int AS n FROM cairn.platform_config`)
    expect(Number(config[0]!.n)).toBe(0)
    expect(await again.raw(`SELECT email FROM cairn.console_accounts WHERE email = 'admin'`)).toHaveLength(1)
  })
})
