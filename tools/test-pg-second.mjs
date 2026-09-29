#!/usr/bin/env node
/**
 * 第二测试 PostgreSQL 实例启动器。
 *
 * 背景：全仓 `pnpm test` 时 db 包、worker 集成组、worker 浏览器组、api 四个
 * PG 重度套件挤同一个实例，互相拖慢实测 2-4 倍（机器 CPU 仅 ~20%）。本脚本
 * 给最重的 @cairn/db 套件一个独立实例，消除跨套件争用。
 *
 * 行为（按序尝试，逐级回退，绝不因基础设施缺失而失败）：
 * 1. CAIRN_TEST_PG_PORT（默认 5433）可达（pg_isready 认可）→ 直接用；
 * 2. 本机有 initdb/pg_ctl（Homebrew postgresql）→ 在系统临时目录初始化并启动
 *    独立实例（trust 本地认证），确保 cairn 库存在；
 * 3. 都不行 → 警告并以原环境回退运行（与主实例同跑，只失去提速）。
 *
 * 用法：node tools/test-pg-second.mjs -- <command...>
 * 成功路径会以 CAIRN_DB_PORT=<第二实例> 启动命令；.env 的其余连接信息不变
 * （process.loadEnvFile 不覆盖已有进程环境变量）。
 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import { execFileSync } from 'node:child_process'

const PORT = Number(process.env.CAIRN_TEST_PG_PORT ?? 5433)
const DATA_DIR = process.env.CAIRN_TEST_PG_DATA ?? join(tmpdir(), `cairn-test-pg-${PORT}`)
const USER = 'cairn'
const DB = 'cairn'
const READY_TIMEOUT_MS = 15_000

const sep = process.argv.indexOf('--')
const command = sep >= 0 ? process.argv.slice(sep + 1) : null
if (!command || command.length === 0) {
  console.error('[test-pg-second] 用法: test-pg-second.mjs -- <command...>')
  process.exit(2)
}

function pgBinary(name) {
  // PATH 上的 initdb 可能来自 libpq（纯客户端、缺 postgres 服务端），
  // 因此优先探测带服务端的 Homebrew 安装目录，最后才回退 which。
  const candidates = [
    '/opt/homebrew/opt/postgresql/bin',
    '/opt/homebrew/opt/postgresql@16/bin',
    '/opt/homebrew/opt/postgresql@17/bin',
    '/usr/local/opt/postgresql/bin',
    '/usr/local/opt/postgresql@16/bin',
  ]
  for (const dir of candidates) {
    const full = join(dir, name)
    if (existsSync(full)) return full
  }
  try {
    const onPath = execFileSync('which', [name], { encoding: 'utf8' }).trim()
    if (!onPath) return null
    // initdb 必须与 postgres 服务端同目录才可用
    if (name === 'initdb' && !existsSync(join(onPath, '..', 'postgres'))) return null
    return onPath
  } catch {
    return null
  }
}

function portReachable(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = (ok) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

function pgReady(port) {
  const isready = pgBinary('pg_isready')
  if (!isready) return portReachable(port)
  try {
    execFileSync(isready, ['-h', '127.0.0.1', '-p', String(port), '-U', USER], {
      stdio: 'ignore',
      timeout: 5_000,
    })
    return true
  } catch {
    return false
  }
}

async function waitReady(port) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (pgReady(port)) return true
    await new Promise((r) => setTimeout(r, 400))
  }
  return false
}

function run(binary, args, options = {}) {
  return execFileSync(binary, args, { encoding: 'utf8', stdio: 'pipe', ...options })
}

function repoEnvValue(name) {
  // 从仓库根 .env 读连接口令（第二实例必须用同一密码：client.test 会用
  // 错误密码断言「连接必须失败」，trust 认证会让该用例失真）。
  // 注意相对脚本自身定位：pnpm --filter 的 cwd 在包目录，不在仓库根。
  const envFile = join(import.meta.dirname, '..', '.env')
  try {
    const line = execFileSync('grep', ['-E', `^${name}=`, envFile], { encoding: 'utf8' }).split('\n')[0]
    return line.slice(name.length + 1).trim()
  } catch {
    return undefined
  }
}

async function ensureSecondInstance() {
  if (await waitReady(PORT)) {
    console.log(`[test-pg-second] 复用已在运行的第二实例 :${PORT}`)
    return true
  }

  const initdb = pgBinary('initdb')
  const pgCtl = pgBinary('pg_ctl')
  if (!initdb || !pgCtl) {
    console.warn('[test-pg-second] 未找到 initdb/pg_ctl（可 brew install postgresql@16），回退主实例运行')
    return false
  }

  if (!existsSync(join(DATA_DIR, 'PG_VERSION'))) {
    console.log(`[test-pg-second] 初始化独立实例数据目录 ${DATA_DIR}`)
    const password = repoEnvValue('CAIRN_DB_PASSWORD') ?? 'cairn'
    const pwfile = join(tmpdir(), `cairn-test-pg-${PORT}.pw`)
    writeFileSync(pwfile, `${password}\n`)
    try {
      // host 用 scram 密码认证（与主实例行为一致）；local 保留 trust 便于运维
      run(initdb, ['-D', DATA_DIR, '-U', USER, '--auth-local=trust', '--auth-host=scram-sha-256', `--pwfile=${pwfile}`, '-E', 'UTF8'])
    } finally {
      rmSync(pwfile, { force: true })
    }
  }
  run(pgCtl, ['-D', DATA_DIR, '-o', `-p ${PORT} -k ${tmpdir()}`, '-l', join(DATA_DIR, 'server.log'), 'start'])
  if (!(await waitReady(PORT))) {
    console.warn('[test-pg-second] 第二实例启动超时，回退主实例运行')
    return false
  }
  try {
    const password = repoEnvValue('CAIRN_DB_PASSWORD') ?? 'cairn'
    run('createdb', ['-h', '127.0.0.1', '-p', String(PORT), '-U', USER, DB], {
      env: { ...process.env, PGPASSWORD: password },
    })
  } catch (error) {
    // 数据库已存在是最常见的"失败"；其余错误也不回退——连接失败会在测试里明确暴露
    console.warn(`[test-pg-second] createdb 提示：${error.message}`)
  }
  console.log(`[test-pg-second] 独立实例已就绪 :${PORT}`)
  return true
}

const second = process.env.CAIRN_TEST_PG_DISABLE === '1' ? false : await ensureSecondInstance().catch((error) => {
  console.warn(`[test-pg-second] 初始化第二实例失败（${error.message}），回退主实例运行`)
  return false
})
const env = second ? { ...process.env, CAIRN_DB_PORT: String(PORT) } : { ...process.env }
if (second) console.log(`[test-pg-second] ${command.join(' ')}（CAIRN_DB_PORT=${PORT}）`)

const child = spawn(command[0], command.slice(1), { env, stdio: 'inherit' })
child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0))
})
