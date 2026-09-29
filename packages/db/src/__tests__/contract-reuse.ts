import type { DbEnv } from '@cairn/shared'
import type { Pool, PoolClient } from 'pg'
import type { DbHandle } from '../client.js'
import { registerFixture } from '../database.js'
import { newId } from '../id.js'
import { openIsolatedDb, requireReachableDb } from '../testing.js'

/**
 * 一个测试文件复用同一对隔离库（普通 / 纯净），用例之间把数据清回刚打开时的种子。
 * 同一用例里再开第二个库时仍新建，避免导入目标这类「两个库同时活着」的用例串数据。
 * 文件结束时关掉。`CAIRN_DB_CONTRACT_REUSE=0` 回到每条用例建库删库。
 *
 * 状态放在进程上：vitest 会为每个文件换一套模块实例，setup 和用例要看到同一个句柄。
 */

type Column = { name: string; type: string }
type SnapshotTable = { name: string; columns: Column[]; rows: Record<string, unknown>[] }
type FkEdge = { child: string; parent: string }
type Snapshot = { schemas: string[]; tables: string[]; filled: SnapshotTable[]; edges: FkEdge[] }
type SlotHandle = DbHandle & { env: DbEnv; pool: Pool }
type Slot = {
  handle: SlotHandle
  snapshot: Snapshot
  checkedOut: number
  generation: number
}
type Registry = { slots: Map<string, Slot>; fastReset: boolean }

const REGISTRY_KEY = '__cairnContractDbReuse'
const SAFE_TYPE = /^[A-Za-z0-9_ ."(),]+$/

function registry(): Registry {
  const bag = process as NodeJS.Process & { [REGISTRY_KEY]?: Registry }
  if (!bag[REGISTRY_KEY]) bag[REGISTRY_KEY] = { slots: new Map(), fastReset: true }
  return bag[REGISTRY_KEY]
}

/** 上一个文件若没归还连接，下一个文件的第一次打开仍会先清再交出。 */
export function beginContractFile(): void {
  for (const slot of registry().slots.values()) {
    slot.checkedOut = 0
    slot.generation += 1
  }
}

/** 文件结束时关掉复用库。连接留着的话，进程退出前这些库会一直占着，下一轮才会被当成孤儿清掉。 */
export async function releaseReusedContractDatabases(): Promise<void> {
  const slots = [...registry().slots.values()]
  registry().slots.clear()
  for (const slot of slots) {
    slot.generation += 1
    slot.checkedOut = 0
    await slot.handle.close().catch(() => {})
  }
}

function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`隔离库标识符不合法：${name}`)
  return `"${name}"`
}

function orderTables(tables: string[], edges: Array<{ child: string; parent: string }>): string[] {
  const names = new Set(tables)
  const incoming = new Map<string, number>(tables.map((table) => [table, 0]))
  const dependents = new Map<string, string[]>(tables.map((table) => [table, []]))
  for (const { child, parent } of edges) {
    if (child === parent || !names.has(child) || !names.has(parent)) continue
    incoming.set(child, (incoming.get(child) ?? 0) + 1)
    dependents.get(parent)!.push(child)
  }
  const queue = tables.filter((table) => incoming.get(table) === 0)
  const ordered: string[] = []
  for (let index = 0; index < queue.length; index += 1) {
    const table = queue[index]!
    ordered.push(table)
    for (const child of dependents.get(table) ?? []) {
      const left = (incoming.get(child) ?? 0) - 1
      incoming.set(child, left)
      if (left === 0) queue.push(child)
    }
  }
  if (ordered.length !== tables.length) throw new Error('种子表外键成环，无法按依赖回填')
  return ordered
}

async function openFresh(pristine: boolean): Promise<SlotHandle> {
  const name = `cairn_port_${newId().replaceAll('-', '')}`
  const handle = await openIsolatedDb(name, { pristine })
  const env = { ...(await requireReachableDb()), CAIRN_DB_NAME: name }
  return Object.assign(handle, { env })
}

async function capture(handle: SlotHandle): Promise<Snapshot> {
  const pool = handle.pool
  const [schemas, columns, edges] = await Promise.all([
    pool.query<{ nspname: string }>('SELECT nspname FROM pg_namespace'),
    pool.query<{ table: string; name: string; type: string }>(`
      SELECT c.relname AS table, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
      WHERE n.nspname = 'cairn' AND c.relkind = 'r' AND c.relname <> '_migrations'
        AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
      ORDER BY c.relname, a.attnum
    `),
    pool.query<{ child: string; parent: string }>(`
      SELECT child.relname AS child, parent.relname AS parent
      FROM pg_constraint c
      JOIN pg_class child ON child.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = child.relnamespace
      JOIN pg_class parent ON parent.oid = c.confrelid
      WHERE c.contype = 'f' AND n.nspname = 'cairn'
    `),
  ])
  const byTable = new Map<string, Column[]>()
  for (const row of columns.rows) {
    if (!SAFE_TYPE.test(row.type)) throw new Error(`无法回填的列类型：${row.table}.${row.name} ${row.type}`)
    const list = byTable.get(row.table) ?? []
    list.push({ name: row.name, type: row.type })
    byTable.set(row.table, list)
  }
  const tables = [...byTable.keys()]
  const filled: SnapshotTable[] = []
  for (const table of await listNonempty(pool)) {
    const columns = byTable.get(table)
    if (!columns) continue
    const result = await pool.query<Record<string, unknown>>(`SELECT * FROM cairn.${quoteIdent(table)}`)
    if (result.rows.length === 0) continue
    filled.push({ name: table, columns, rows: result.rows })
  }
  return {
    schemas: schemas.rows.map((row) => row.nspname),
    tables,
    filled,
    edges: edges.rows,
  }
}

function bindValue(value: unknown, type: string): unknown {
  if (value == null) return null
  const array = type.endsWith('[]')
  const base = (array ? type.slice(0, -2) : type).trim()
  if (base !== 'json' && base !== 'jsonb') return value
  if (array && Array.isArray(value)) {
    return value.map((item) => (item == null ? null : JSON.stringify(item)))
  }
  return typeof value === 'string' ? value : JSON.stringify(value)
}

async function settle(pool: Pool, run: (client: PoolClient) => Promise<void>): Promise<void> {
  if (pool.waitingCount !== 0 || pool.idleCount !== pool.totalCount) {
    throw new Error('隔离库连接尚未归还')
  }
  const clients: PoolClient[] = []
  const count = Math.max(pool.totalCount, 1)
  for (let index = 0; index < count; index += 1) clients.push(await pool.connect())
  try {
    for (const client of clients) {
      await client.query('ROLLBACK')
      await client.query('SELECT pg_advisory_unlock_all()')
      await client.query('DISCARD ALL')
      await client.query('SET search_path TO cairn, public')
    }
    const client = clients[0]!
    await client.query('BEGIN')
    try {
      await client.query("SET LOCAL lock_timeout = '5s'")
      await run(client)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
  } finally {
    for (const client of clients) client.release()
  }
}

type Queryable = Pick<Pool, 'query'>

async function listNonempty(db: Queryable): Promise<string[]> {
  await db.query(`
    CREATE OR REPLACE FUNCTION pg_temp.cairn_nonempty_tables()
    RETURNS SETOF name
    LANGUAGE plpgsql AS $fn$
    DECLARE
      rel name;
      marker int;
    BEGIN
      FOR rel IN
        SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'cairn' AND c.relkind = 'r' AND c.relname <> '_migrations'
      LOOP
        EXECUTE format('SELECT 1 FROM cairn.%I LIMIT 1', rel) INTO marker;
        IF marker IS NOT NULL THEN
          RETURN NEXT rel;
        END IF;
      END LOOP;
    END
    $fn$
  `)
  const result = await db.query<{ cairn_nonempty_tables: string }>('SELECT * FROM pg_temp.cairn_nonempty_tables()')
  return result.rows.map((row) => row.cairn_nonempty_tables)
}

async function restore(slot: Slot): Promise<void> {
  const { snapshot } = slot
  await settle(slot.handle.pool, async (client) => {
    const current = await client.query<{ nspname: string }>('SELECT nspname FROM pg_namespace')
    for (const row of current.rows) {
      if (row.nspname.startsWith('pg_') || snapshot.schemas.includes(row.nspname)) continue
      await client.query(`DROP SCHEMA ${quoteIdent(row.nspname)} CASCADE`)
    }
    const known = new Set(snapshot.tables)
    const truncate = new Set(snapshot.filled.map((table) => table.name))
    for (const name of await listNonempty(client)) {
      if (known.has(name)) truncate.add(name)
    }
    const clearing = [...truncate]
    for (const name of clearing) quoteIdent(name)
    // TRUNCATE 只要有外键指向就会拒绝或 CASCADE 到整张图，196 张表要将近 1 秒。
    // 只删有行的表；复制角色关掉外键触发器，清完再打开，种子按依赖插回。
    let ordered = clearing
    try {
      ordered = orderTables(clearing, snapshot.edges).reverse()
    } catch {
      ordered = clearing
    }
    await client.query(`
      CREATE OR REPLACE FUNCTION pg_temp.cairn_clear(rels name[])
      RETURNS void LANGUAGE plpgsql AS $fn$
      DECLARE rel name;
      BEGIN
        PERFORM set_config('session_replication_role', 'replica', true);
        FOREACH rel IN ARRAY rels LOOP
          EXECUTE format('DELETE FROM cairn.%I', rel);
        END LOOP;
        PERFORM set_config('session_replication_role', 'origin', true);
      EXCEPTION WHEN insufficient_privilege THEN
        FOREACH rel IN ARRAY rels LOOP
          EXECUTE format('ALTER TABLE cairn.%I DISABLE TRIGGER USER', rel);
          EXECUTE format('DELETE FROM cairn.%I', rel);
          EXECUTE format('ALTER TABLE cairn.%I ENABLE TRIGGER USER', rel);
        END LOOP;
      END
      $fn$
    `)
    if (ordered.length) await client.query('SELECT pg_temp.cairn_clear($1::name[])', [ordered])
    const filled = new Map(snapshot.filled.map((table) => [table.name, table]))
    const insertOrder = orderTables(
      snapshot.filled.map((table) => table.name),
      snapshot.edges,
    )
    for (const name of insertOrder) {
      const table = filled.get(name)
      if (!table) continue
      const colSql = table.columns.map((column) => quoteIdent(column.name)).join(', ')
      for (let offset = 0; offset < table.rows.length; offset += 40) {
        const slice = table.rows.slice(offset, offset + 40)
        const params: unknown[] = []
        const tuples = slice.map((row) => {
          const placeholders = table.columns.map((column) => {
            params.push(bindValue(row[column.name], column.type))
            return `$${params.length}::${column.type}`
          })
          return `(${placeholders.join(', ')})`
        })
        try {
          await client.query(
            `INSERT INTO cairn.${quoteIdent(name)} (${colSql}) VALUES ${tuples.join(', ')}`,
            params,
          )
        } catch (error) {
          throw new Error(`回填 ${name} 失败：${(error as Error).message}`, { cause: error })
        }
      }
    }
  })
}

function wrap(slot: Slot): SlotHandle {
  const generation = (slot.generation += 1)
  slot.checkedOut += 1
  let released = false
  // 业务入口用句柄对象本身做登记。交出去的必须是新对象，否则下一次复用会换掉上一条用例的 close。
  return registerFixture(
    Object.assign({}, slot.handle, {
      close: async () => {
        if (released || slot.generation !== generation) return
        released = true
        slot.checkedOut = Math.max(0, slot.checkedOut - 1)
      },
    }),
  )
}

export async function acquireReusedContractDb(
  options: { pristine?: boolean } = {},
): Promise<SlotHandle> {
  if (!registry().fastReset) return openFresh(options.pristine === true)
  const pristine = options.pristine === true
  const key = pristine ? 'pristine' : 'seeded'
  const slots = registry().slots
  const existing = slots.get(key)
  if (existing && existing.checkedOut > 0) return openFresh(pristine)
  if (existing) {
    try {
      await restore(existing)
    } catch (error) {
      const pgCode = (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code
      if (pgCode === '42501') registry().fastReset = false
      console.warn(`[openContractDb] 复用库重置失败，改为新建：${(error as Error).message}`)
      slots.delete(key)
      existing.generation += 1
      await existing.handle.close().catch(() => {})
      return acquireReusedContractDb(options)
    }
    return wrap(existing)
  }
  const handle = await openFresh(pristine)
  try {
    const slot: Slot = { handle, snapshot: await capture(handle), checkedOut: 0, generation: 0 }
    slots.set(key, slot)
    return wrap(slot)
  } catch (error) {
    console.warn(`[openContractDb] 无法快照隔离库，本库用完即删：${(error as Error).message}`)
    return handle
  }
}
