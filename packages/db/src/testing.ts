import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Client, Pool } from 'pg'
import { dbEnvSchema, formatEnvIssues, type PostgresDbEnv } from '@cairn/shared'
import { bindTransactions, type DbHandle } from './client.js'
import { eq } from 'drizzle-orm'
import { nativeTables, schemaFor } from './native.js'
import { registerFixture } from './database.js'
export type PgTestHandle = DbHandle & { pool: Pool }
import { migrate } from './migrate.js'
import { FACTORY_PLATFORM_CONFIG, type PlatformConfigDocument } from '@cairn/shared'
import { getOrCreatePlatformConfig, updatePlatformConfig } from './platform-config/store.js'
import type { AuditActor } from './audit/record.js'

/** 仓库根 `.env`。与 api / worker 的读取路径同源：本地读它，CI 由环境变量提供。 */
const ENV_FILE = resolve(import.meta.dirname, '../../../.env')

/** 连不上时要快速失败，不能让「网络黑洞」把整个测试挂住。 */
const CONNECT_TIMEOUT_MS = 10_000

/**
 * 集成测试只连测试专用 PG（容器 cairn-postgres-test，内存盘），不碰开发库。
 *
 * 此前测试与开发库共用一个实例：多个会话并发跑测试时互相干扰，测试还会往开发库里建删库与 schema。
 * 做法：把进程里的 CAIRN_DB_PORT 锁定为 CAIRN_TEST_DB_PORT。必须在 globalSetup 里（主进程、fork worker 之前）
 * 调用，worker 继承环境变量，之后无论 `process.loadEnvFile` 还是各测试自读 env，看到的都是测试端口。
 *
 * - 本地未配 CAIRN_TEST_DB_PORT：明确失败，不回退到开发库；
 * - 测试端口与开发库端口相同：明确失败；
 * - CI（`CI` 环境变量）未配：沿用 CAIRN_DB_PORT，CI 的库本来就是一次性、隔离的。
 */
function pinTestDbPort(): void {
  if (process.env.CAIRN_TEST_DB_PINNED === '1') return
  const testPort = process.env.CAIRN_TEST_DB_PORT?.trim()
  if (!testPort) {
    if (process.env.CI) return
    throw new Error(
      '集成测试必须连测试专用 PostgreSQL，但未配置 CAIRN_TEST_DB_PORT（见 .env.example）。\n' +
        '启动：pnpm infra:up（会同时启动 cairn-postgres-test）。不会回退到开发库。',
    )
  }
  if (testPort === String(process.env.CAIRN_DB_PORT ?? '')) {
    throw new Error(
      `CAIRN_TEST_DB_PORT（${testPort}）与开发库端口 CAIRN_DB_PORT 相同，测试会写进开发库，已拒绝。`,
    )
  }
  process.env.CAIRN_DB_PORT = testPort
  process.env.CAIRN_TEST_DB_PINNED = '1'
}

/**
 * 集成测试的库前置条件：**连不上就失败，不跳过**。
 *
 * 判据必须是「库能不能连上」，而不是「配置看起来有没有」。原先各集成测试用
 * `describe.skipIf(!parsed.success)` 判环境变量在不在，于是干净检出、CI 漏配或
 * 临时离线时整包变绿而一条都没跑——实测 db 包 `3 passed | 4 skipped`、退出码 0，
 * 「测试通过」这句话因此没有含义。
 *
 * 由 vitest 的 `globalSetup` 在跑用例之前调用，库不可用时整个包失败。
 * 失败信息只带 host / port / database 与配置项名，不带口令。
 */
export async function requireReachableDb(): Promise<PostgresDbEnv> {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE)
  pinTestDbPort()

  const parsed = dbEnvSchema.safeParse(process.env)
  if (!parsed.success) {
    const lines = formatEnvIssues(parsed.error)
      .map((line) => `  ✗ ${line}`)
      .join('\n')
    throw new Error(
      `集成测试需要可用的 PostgreSQL，但配置不完整（${ENV_FILE} 或环境变量）：\n${lines}\n` +
        '集成测试不会因为缺配置而跳过。',
    )
  }

  const env = parsed.data
  if (env.CAIRN_DB_DRIVER !== 'postgres') throw new Error('PG-specific tests require postgres')
  const pool = new Pool({
    host: env.CAIRN_DB_HOST,
    port: env.CAIRN_DB_PORT,
    database: env.CAIRN_DB_NAME,
    user: env.CAIRN_DB_USER,
    password: env.CAIRN_DB_PASSWORD,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    options: `-c search_path=${env.CAIRN_DB_SCHEMA},public`,
  })

  try {
    await pool.query('select 1')
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    throw new Error(
      `集成测试需要可用的 PostgreSQL，但连接 ` +
        `${env.CAIRN_DB_HOST}:${env.CAIRN_DB_PORT}/${env.CAIRN_DB_NAME} 失败：${reason}\n` +
        '库不可用时集成测试失败，不跳过。本地请先 pnpm infra:up 启动测试专用库 cairn-postgres-test。',
    )
  } finally {
    await pool.end()
  }

  return env
}

function templateDatabase(): string | undefined {
  const name = process.env.CAIRN_TEST_TEMPLATE_DB
  return name && /^cairn_test_template_[a-f0-9]{32}$/.test(name) ? name : undefined
}

/**
 * 模板库持有者连接的 application_name 前缀。建模板的进程在整个运行期间保持一条这样的连接，
 * 回收程序据此判断模板是否仍有人在用：模板库本身不能挂连接（会让 CREATE DATABASE ... TEMPLATE 失败），
 * 两次克隆之间它是「无连接」的，只看 pg_stat_activity 会把并发运行中的模板当孤儿删掉。
 */
export const TEMPLATE_OWNER_APP_PREFIX = 'cairn-test-owner:'

const TEMPLATE_DB_PREFIX = 'cairn_test_template_'

/**
 * 持有者连接的 application_name。PG 把它截断在 63 字符，完整库名（52）加前缀（17）会超长，
 * 被截断后回收程序认不出持有者而误删，所以只放库名里的 32 位 id，回收时再补回 TEMPLATE_DB_PREFIX。
 */
export function templateOwnerAppName(templateDb: string): string {
  return `${TEMPLATE_OWNER_APP_PREFIX}${templateDb.slice(TEMPLATE_DB_PREFIX.length)}`
}

/**
 * 清理上次被异常中断（如 Ctrl+C、崩溃或进程强杀）遗留的孤儿测试数据库。
 * 保护活跃连接，防止并发套件误删；只清理无连接且符合测试命名前缀的孤儿库。
 * 模板库另有持有者连接保护（见 TEMPLATE_OWNER_APP_PREFIX）；已标 is_template 的库 PG 拒绝直接删除，
 * 须先取消标记。删除失败不静默：汇总数量与首个原因告警。
 */
export async function cleanupOrphanTestDatabases(env?: PostgresDbEnv): Promise<number> {
  const dbEnv = env ?? (await requireReachableDb())
  const admin = new Pool({
    host: dbEnv.CAIRN_DB_HOST,
    port: dbEnv.CAIRN_DB_PORT,
    database: dbEnv.CAIRN_DB_NAME,
    user: dbEnv.CAIRN_DB_USER,
    password: dbEnv.CAIRN_DB_PASSWORD,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  })

  try {
    const res = await admin.query<{ datname: string; datistemplate: boolean }>(
      `
      SELECT datname, datistemplate FROM pg_database 
      WHERE (
        datname LIKE 'cairn_test_%' OR 
        datname LIKE 'cairn_port_%' OR 
        datname LIKE 'cairn_assist_%' OR 
        datname LIKE 'cairn_session_%' OR 
        datname LIKE 'cairn_harness_%' OR 
        datname LIKE 'service_http_%' OR 
        datname LIKE 'cairn_am%' OR 
        datname LIKE 'cairn_cfg%'
      )
      AND datname NOT IN ('cairn', 'postgres', 'template0', 'template1')
      AND datname NOT IN (
        SELECT DISTINCT datname FROM pg_stat_activity 
        WHERE datname IS NOT NULL AND pid <> pg_backend_pid()
      )
      AND datname NOT IN (
        SELECT CAST($3 AS text) || substr(application_name, $1) FROM pg_stat_activity
        WHERE application_name LIKE $2
      )
    `,
      [TEMPLATE_OWNER_APP_PREFIX.length + 1, `${TEMPLATE_OWNER_APP_PREFIX}%`, TEMPLATE_DB_PREFIX],
    )

    let cleaned = 0
    const failures: string[] = []
    for (const row of res.rows) {
      try {
        if (row.datistemplate) {
          await admin.query(`ALTER DATABASE "${row.datname}" WITH is_template = false`)
        }
        await admin.query(`DROP DATABASE IF EXISTS "${row.datname}" WITH (FORCE)`)
        cleaned++
      } catch (error) {
        failures.push(`${row.datname}: ${(error as Error).message}`)
      }
    }
    if (cleaned > 0) {
      console.log(`[testing] 自动垃圾回收：已清理 ${cleaned} 个历史残留孤儿测试库`)
    }
    if (failures.length > 0) {
      console.warn(`[testing] 自动垃圾回收：${failures.length} 个孤儿测试库清理失败，首个：${failures[0]}`)
    }
    return cleaned
  } catch (error) {
    console.warn(`[testing] 自动清理孤儿测试库警告: ${(error as Error).message}`)
    return 0
  } finally {
    await admin.end()
  }
}

/**
 * 在运行测试套件前，一次性初始化基准模板库并执行全部迁移。
 * 后续所有 openIsolatedDb 均基于此模板克隆，省去逐用例执行 migration 的高昂耗时。
 *
 * 返回**这一份模板自己的**清理函数：谁建谁删，不读共享环境变量。多 project 配置若每个 project
 * 都声明 globalSetup，会各建一个模板，而共享的 CAIRN_TEST_TEMPLATE_DB 只记得最后一个，其余必漏。
 * 因此 globalSetup 只应在根配置声明一次。
 *
 * 先于建库开持有者连接：模板从创建到标记完成之间，别的进程的回收不能把它当孤儿删掉。
 */
export async function setupTestTemplateDatabase(): Promise<() => Promise<void>> {
  const env = await requireReachableDb()
  await cleanupOrphanTestDatabases(env)
  const name = `${TEMPLATE_DB_PREFIX}${randomUUID().replaceAll('-', '')}`

  const owner = new Client({
    host: env.CAIRN_DB_HOST,
    port: env.CAIRN_DB_PORT,
    database: env.CAIRN_DB_NAME,
    user: env.CAIRN_DB_USER,
    password: env.CAIRN_DB_PASSWORD,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    application_name: templateOwnerAppName(name),
  })
  // 持有者连接被服务端掐断（如开发库重启）时不能变成未处理错误把整个套件打红。
  owner.on('error', () => {})
  await owner.connect()

  const release = async (): Promise<void> => {
    await owner.end().catch(() => {})
    const admin = new Pool({
      host: env.CAIRN_DB_HOST,
      port: env.CAIRN_DB_PORT,
      database: env.CAIRN_DB_NAME,
      user: env.CAIRN_DB_USER,
      password: env.CAIRN_DB_PASSWORD,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    })
    try {
      await admin.query(`ALTER DATABASE "${name}" WITH is_template = false`).catch(() => {
        // 库不存在或缺少特权：下面的 DROP 会给出真实结果
      })
    } finally {
      await admin.end()
    }
    await dropIsolatedDatabase(env, name)
    if (process.env.CAIRN_TEST_TEMPLATE_DB === name) delete process.env.CAIRN_TEST_TEMPLATE_DB
  }

  try {
    const admin = new Pool({
      host: env.CAIRN_DB_HOST,
      port: env.CAIRN_DB_PORT,
      database: env.CAIRN_DB_NAME,
      user: env.CAIRN_DB_USER,
      password: env.CAIRN_DB_PASSWORD,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    })
    try {
      await admin.query(`CREATE DATABASE "${name}"`)
    } finally {
      await admin.end()
    }

    const pool = new Pool({
      host: env.CAIRN_DB_HOST,
      port: env.CAIRN_DB_PORT,
      database: name,
      user: env.CAIRN_DB_USER,
      password: env.CAIRN_DB_PASSWORD,
      options: `-c search_path=cairn,public`,
    })
    try {
      await migrate(pool, 'cairn')
    } finally {
      await pool.end()
    }

    const adminPost = new Pool({
      host: env.CAIRN_DB_HOST,
      port: env.CAIRN_DB_PORT,
      database: env.CAIRN_DB_NAME,
      user: env.CAIRN_DB_USER,
      password: env.CAIRN_DB_PASSWORD,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    })
    try {
      await adminPost.query(`ALTER DATABASE "${name}" WITH is_template = true`)
    } catch {
      // 忽略缺少特权等特定环境告警
    } finally {
      await adminPost.end()
    }
  } catch (error) {
    await release()
    throw error
  }

  // 子进程继承名称；并行套件各有各的模板，不得删除彼此的库。
  process.env.CAIRN_TEST_TEMPLATE_DB = name
  return release
}

/**
 * 集成测试用的独立数据库。
 *
 * Drizzle 表名编译期写死为 `cairn.*`，只建独立 schema 拦不住限定名。
 * 另开数据库再在其中 migrate `cairn`，查询与领取都不会碰到开发库或其它测试。
 * 优先采用 TEMPLATE 克隆已迁移的模板库（耗时从 1.5s 降至 20ms）；若模板库不存在则平滑降级为新建+迁移。
 * `close()` 会 `DROP DATABASE`。
 */
export async function openIsolatedDb(
  name: string,
  options: { pristine?: boolean } = {},
): Promise<PgTestHandle> {
  const env = await requireReachableDb()
  if (!/^[a-z_][a-z0-9_]*$/.test(name) || name.length > 63) {
    throw new Error(`隔离库名不合法：${name}`)
  }

  const admin = new Pool({
    host: env.CAIRN_DB_HOST,
    port: env.CAIRN_DB_PORT,
    database: env.CAIRN_DB_NAME,
    user: env.CAIRN_DB_USER,
    password: env.CAIRN_DB_PASSWORD,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  })

  let createdFromTemplate = false
  try {
    const template = templateDatabase()
    const chk = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [template])
    if (template && chk.rows.length > 0) {
      try {
        await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`)
        createdFromTemplate = true
      } catch (firstErr) {
        // 并发竞态自愈：偶发残留连接占用时，剔除模板库上的残留空闲连接并重试一次
        try {
          await admin.query(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
            [template],
          )
          await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`)
          createdFromTemplate = true
        } catch (secondErr) {
          console.warn(
            `[openIsolatedDb] ⚠️ 模板库克隆失败，降级为全量迁移! 耗时将显著增加: ${(secondErr as Error).message}`,
          )
          await admin.query(`CREATE DATABASE "${name}"`)
        }
      }
    } else {
      await admin.query(`CREATE DATABASE "${name}"`)
    }
  } finally {
    await admin.end()
  }

  const pool = new Pool({
    host: env.CAIRN_DB_HOST,
    port: env.CAIRN_DB_PORT,
    database: name,
    user: env.CAIRN_DB_USER,
    password: env.CAIRN_DB_PASSWORD,
    options: `-c search_path=cairn,public`,
  })

  /**
   * 收尾竞态：`DROP DATABASE ... WITH (FORCE)` 会 `pg_terminate_backend` 掉所有
   * 还连在这个库上的会话。`await pool.end()` 在本地判定连接已结束时就返回，但
   * 套接字可能还没真正关完、服务端 backend 也还在——FORCE 的终止信号正好落进
   * 这个窗口，客户端就读到一条 FATAL 57P01。
   *
   * `Pool` 没有 'error' 监听者时，这条错误是 EventEmitter 的未处理 'error'，
   * vitest 记成 unhandled error 并把整份用例文件判红。
   */
  let closing = false
  pool.on('error', (error) => {
    if (closing) return
    console.error(`[openIsolatedDb:${name}] 空闲连接错误：${error.message}`)
  })

  if (!createdFromTemplate) {
    try {
      await migrate(pool, 'cairn')
    } catch (error) {
      closing = true
      await pool.end()
      await dropIsolatedDatabase(env, name)
      throw error
    }
  }

  const db = bindTransactions(drizzle(pool), 'postgres', nativeTables('postgres', 'cairn'))
  const handle = registerFixture({
    db,
    pool,
    driver: 'postgres',
    raw: async (statement, values) => (await pool.query(statement, values)).rows,
    ping: async () => true,
    close: async () => {
      closing = true
      await pool.end()
      await dropIsolatedDatabase(env, name)
    },
  })
  if (!options.pristine) await seedFixtureStepsEnabled(handle)
  return handle
}

/**
 * 给夹具账号一条「admin 角色 + 全部目标范围」的绑定。
 *
 * 只绑角色不够：`console_account_roles.target_scope_mode` 默认是 'none'（0066），
 * 绑了 admin 但没写范围的账号，目标范围仍是空——创建目标、处置会话这类需要
 * 「全部目标」的操作都会被拒。这是产品有意的语义，夹具要显式给足范围。
 * 放在 @cairn/db/testing，api / worker 的集成测试也要用。
 */
export async function grantAdminScope(db: DbHandle['db'], accountId: string): Promise<void> {
  const { consoleRoles, consoleAccountRoles } = schemaFor(db)
  const [admin] = await db.select().from(consoleRoles).where(eq(consoleRoles.key, 'admin'))
  if (!admin) throw new Error('missing admin role fixture')
  await db
    .insert(consoleAccountRoles)
    .values({ consoleAccountId: accountId, consoleRoleId: admin.id, targetScopeMode: 'all' })
}

/**
 * 给夹具账号一个「只含指定权限、范围为全部目标」的自定义角色。
 *
 * grantAdminScope 给的是 admin，权限是全集，包括 ai:execute。要测「缺某项权限被拒」
 * （如含 AI 步骤的试跑须有 ai:execute）就不能用它：账号得有足够权限走到那一步，
 * 又恰好缺被测的那一项。这里直接写库，因为夹具账号本来就是直接 insert 的，
 * 且产品路径 createRole 要求操作者是范围管理员，在夹具里得不偿失。
 */
export async function grantScopedPermissions(
  db: DbHandle['db'],
  accountId: string,
  permissions: readonly string[],
): Promise<string> {
  const { consoleRoles, consoleRolePermissions, consoleAccountRoles } = schemaFor(db)
  const roleId = randomUUID()
  await db.insert(consoleRoles).values({
    id: roleId,
    key: `fixture-${roleId.slice(0, 8)}`,
    name: '测试夹具角色',
    kind: 'custom',
  })
  await db
    .insert(consoleRolePermissions)
    .values(permissions.map((permission) => ({ consoleRoleId: roleId, permission })))
  await db
    .insert(consoleAccountRoles)
    .values({ consoleAccountId: accountId, consoleRoleId: roleId, targetScopeMode: 'all' })
  return roleId
}

/**
 * 夹具步骤（echo / delay / fail）是集成测试构造确定性运行的基座，而平台出厂把它关着。
 * 隔离库在这里统一开放一次，用例走的就是「已开放」这条真实路径；要验闸门本身的
 * 用例自己把它改回 false。放在这一层，是因为直接调 openIsolatedDb 的用例与
 * 经 openContractDb 的用例共用同一个入口，不必各自记得种一遍。
 *
 * 需要「刚迁移完的纯净库」的用例（如数据库迁移的导入目标）传 `{ pristine: true }`：
 * 那里 platform_config 必须为空，预先种进去会让判空失败。
 *
 * 注意：库里已经有配置行，所以用例里 `getOrCreatePlatformConfig(db, { document })` 会是
 * 空操作。要改配置项用 `adjustPlatformConfig`（只改差异，走真实的更新路径）。
 */
export async function seedFixtureStepsEnabled(handle: DbHandle): Promise<void> {
  await getOrCreatePlatformConfig(handle.db, {
    document: { ...FACTORY_PLATFORM_CONFIG, fixtureStepsEnabled: true },
    reason: '测试库：开放调试夹具步骤',
  })
}

/**
 * 在已有配置上改用例需要的那几项，而不是整份替换。
 *
 * 隔离库默认已经种了一行配置（见 seedFixtureStepsEnabled），所以用例里再
 * `getOrCreatePlatformConfig(db, { document })` 是空操作——「已存在就直接返回」，
 * 传进去的文档被静默丢掉。managed-page.lab 因此没能把 autoLoginMaxPerWindow 调到 20，
 * 几次自动登录后账号被暂停。这里改走产品真实的「改配置」路径，并且只改 mutate 返回
 * 的差异：整份替换会把种下的夹具开关一并抹回出厂的 false。
 */
export async function adjustPlatformConfig(
  handle: DbHandle,
  actor: AuditActor,
  mutate: (document: PlatformConfigDocument) => PlatformConfigDocument,
  reason: string,
): Promise<void> {
  const current = await getOrCreatePlatformConfig(handle.db)
  await updatePlatformConfig(handle.db, {
    expectedRevision: current.revision,
    document: mutate(current.document),
    reason,
    actor,
  })
}

async function dropIsolatedDatabase(env: PostgresDbEnv, name: string): Promise<void> {
  const admin = new Pool({
    host: env.CAIRN_DB_HOST,
    port: env.CAIRN_DB_PORT,
    database: env.CAIRN_DB_NAME,
    user: env.CAIRN_DB_USER,
    password: env.CAIRN_DB_PASSWORD,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  })
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  } finally {
    await admin.end()
  }
}
