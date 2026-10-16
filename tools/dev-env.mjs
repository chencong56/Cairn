#!/usr/bin/env node
/**
 * 日常开发画像入口：切配置、起停本机热重载进程、探活。
 *
 *   pnpm dev:env use local|remote
 *   pnpm dev:env status|check|restart|down
 */
import { spawnSync } from 'node:child_process'
import { createConnection } from 'node:net'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hitsPublishGuard, summarizeEnv } from './lib/env-profile.mjs'
import { prepareProfile, writeActiveEnv } from './use-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ACTIVE = join(root, '.env')
const GUARD = join(root, 'deploy/dev-env.guard.json')

function die(message, code = 1) {
  console.error(message)
  process.exit(code)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    ...options,
  })
  if (result.error) die(result.error.message)
  if (result.status !== 0) die(`${command} ${args.join(' ')} 退出 ${result.status}`, result.status ?? 1)
  return result
}

function runCapture(command, args) {
  return spawnSync(command, args, { cwd: root, encoding: 'utf8' })
}

function probeListen(host, port, timeoutMs = 2000) {
  return new Promise((resolveListen) => {
    const socket = createConnection({ host, port })
    const finish = (ok) => {
      socket.removeAllListeners()
      socket.destroy()
      resolveListen(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

function loadGuard() {
  return JSON.parse(readFileSync(GUARD, 'utf8'))
}

function assertNotPublish(summary) {
  const verdict = hitsPublishGuard(summary, loadGuard())
  if (verdict.hit) die(verdict.reason)
}

async function assertRemoteReachable(summary) {
  const checks = []
  if (summary.dbHost && summary.dbPort) {
    checks.push({ label: `数据库 ${summary.dbHost}:${summary.dbPort}`, host: summary.dbHost, port: Number(summary.dbPort) })
  }
  if (summary.s3Endpoint) {
    try {
      const url = new URL(summary.s3Endpoint)
      checks.push({
        label: `对象存储 ${summary.s3Endpoint}`,
        host: url.hostname,
        port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
      })
    } catch {
      die(`CAIRN_S3_ENDPOINT=${summary.s3Endpoint} 不是合法地址`)
    }
  }
  if (summary.redisUrl) {
    try {
      const url = new URL(summary.redisUrl)
      checks.push({
        label: `Redis ${summary.redisUrl.replace(/:\/\/[^@/]+@/, '://***@')}`,
        host: url.hostname,
        port: Number(url.port) || 6379,
      })
    } catch {
      die(`CAIRN_REDIS_URL 不是合法地址`)
    }
  }
  for (const check of checks) {
    const ok = await probeListen(check.host, check.port)
    if (!ok) die(`远端开发组件不通：${check.label}。不进入半连状态。`)
  }
}

function stopApp() {
  run('./scripts/dev.sh', ['stop'])
}

function startApp() {
  run('./scripts/dev.sh', ['start'])
}

function startInfra(target = 'all') {
  run('./scripts/infra.sh', ['start', target])
}

function printStatus(name, summary) {
  console.log(`当前画像  ${name}`)
  console.log(`  数据库    ${summary.database}`)
  console.log(`  对象存储  ${summary.object}`)
  console.log(`  变化提示  ${summary.changeHint}`)
  console.log(`  Web 地址  ${summary.webUrl}`)
}

function activeSummary() {
  if (!existsSync(ACTIVE)) die('没有 .env。先 pnpm dev:env use local 或 pnpm dev:env use remote。')
  const text = readFileSync(ACTIVE, 'utf8')
  const name = (text.match(/^# cairn-env-active: ([a-z][a-z0-9-]*)/m) ?? [])[1] ?? '(regular file)'
  return { name, summary: summarizeEnv(text) }
}

async function noteUnusedLocalInfra(profile) {
  if (profile !== 'remote') return
  const unused = []
  if (await probeListen('127.0.0.1', 5432)) unused.push('postgres :5432')
  if (await probeListen('127.0.0.1', 6379)) unused.push('redis :6379')
  if (await probeListen('127.0.0.1', 9021)) unused.push('rustfs :9021')
  if (unused.length) {
    console.log(`  本机组件  在跑但当前画像不用：${unused.join('、')}`)
  }
}

async function useProfile(name) {
  if (name !== 'local' && name !== 'remote') {
    die('用法: pnpm dev:env use local|remote')
  }
  const prepared = prepareProfile(name)
  if (name === 'remote') {
    assertNotPublish(prepared.summary)
    await assertRemoteReachable(prepared.summary)
  }
  stopApp()
  writeActiveEnv(prepared.text)
  if (name === 'local') startInfra('all')
  else startInfra('postgres-test')
  console.log('▶ 按当前画像迁库（开发库，不是发布栈）')
  run('pnpm', ['db:migrate'])
  startApp()
  const { summary } = prepared
  console.log(`已切换到 ${name} 并启动本机进程`)
  printStatus(name, summary)
}

async function check() {
  const { name, summary } = activeSummary()
  printStatus(name, summary)
  if (name === 'remote') {
    assertNotPublish(summary)
    await assertRemoteReachable(summary)
    await noteUnusedLocalInfra(name)
    console.log('  底座      远端开发组件 TCP 可达')
  } else if (name === 'local') {
    const dbOk = await probeListen(summary.dbHost || '127.0.0.1', Number(summary.dbPort || 5432))
    console.log(`  底座      本机库 ${dbOk ? '可达' : '不可达'}`)
    if (!dbOk) die('本机开发组件不通')
  }
  const stack = runCapture('pnpm', ['check:stack'])
  if (stack.stdout) process.stdout.write(stack.stdout)
  if (stack.stderr) process.stderr.write(stack.stderr)
  if (stack.status !== 0) process.exit(stack.status ?? 1)
}

function restart() {
  if (!existsSync(ACTIVE)) die('没有 .env。先 pnpm dev:env use local 或 remote。')
  const active = activeSummary()
  let { name, summary } = active
  if (name === 'local' || name === 'remote') {
    const prepared = prepareProfile(name)
    if (name === 'remote') assertNotPublish(prepared.summary)
    writeActiveEnv(prepared.text)
    summary = prepared.summary
  }
  run('./scripts/dev.sh', ['restart'])
  printStatus(name, summary)
}

function down() {
  stopApp()
}

function usage() {
  die(`用法: pnpm dev:env use local|remote
       pnpm dev:env status|check|restart|down`)
}

const [command, name] = process.argv.slice(2)
if (command === 'use' && name) {
  await useProfile(name)
} else if (command === 'status') {
  const { name: active, summary } = activeSummary()
  printStatus(active, summary)
  run('./scripts/dev.sh', ['status'])
} else if (command === 'check') {
  await check()
} else if (command === 'restart') {
  restart()
} else if (command === 'down') {
  down()
} else {
  usage()
}
