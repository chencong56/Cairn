#!/usr/bin/env node
/**
 * 开发连接画像：对齐公开文件与密钥文件，合并写出仓库根 `.env`。
 *
 * 日常请用 `pnpm dev:env use local|remote`（还会启停进程）。
 * 本命令只做合并，不启停。
 *
 *   pnpm env:use local
 *   pnpm env:use remote
 *   pnpm env:status
 */
import { existsSync, lstatSync, readFileSync, readlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  alignPublicAndSecrets,
  alignText,
  inspectSecretsFile,
  keysOf,
  mergeProfile,
  readActiveProfileName,
  secretKeysIn,
  summarizeEnv,
} from './lib/env-profile.mjs'

export { alignText, keysOf } from './lib/env-profile.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EXAMPLE = join(root, '.env.example')
const ACTIVE = join(root, '.env')
const RESERVED = new Set(['example', 'secrets'])

function die(message) {
  console.error(message)
  process.exit(1)
}

function profilePath(name) {
  if (!/^[a-z][a-z0-9-]*$/.test(name) || RESERVED.has(name)) {
    die(`画像名不合法：${name}`)
  }
  return join(root, `.env.${name}`)
}

function secretsPath(name) {
  return join(root, `.env.${name}.secrets`)
}

function reportAlign(label, missing, extra) {
  if (missing.length) console.error(`  缺键：${missing.join(', ')}`)
  if (extra.length) console.error(`  多键：${extra.join(', ')}`)
  die(`${label}，拒绝切换`)
}

export function prepareProfile(name) {
  const source = profilePath(name)
  const secrets = secretsPath(name)
  if (!existsSync(source)) {
    die(`找不到 ${relative(root, source)}。从已入库的 .env.local / .env.remote 对齐公开项。`)
  }
  if (!existsSync(secrets)) {
    die(`找不到 ${relative(root, secrets)}。从 .env.secrets.example 复制一份并填写密钥。`)
  }

  const exampleText = readFileSync(EXAMPLE, 'utf8')
  const publicText = readFileSync(source, 'utf8')
  const secretsText = readFileSync(secrets, 'utf8')

  const secretHits = secretKeysIn(publicText)
  if (secretHits.length) {
    die(`画像 .env.${name} 含密钥键（${secretHits.join(', ')}），公开文件禁止出现这些键`)
  }

  const secretsInspect = inspectSecretsFile(secretsText)
  if (secretsInspect.missing.length || secretsInspect.extra.length || secretsInspect.empty.length) {
    if (secretsInspect.missing.length) console.error(`  密钥缺键：${secretsInspect.missing.join(', ')}`)
    if (secretsInspect.extra.length) console.error(`  密钥多键：${secretsInspect.extra.join(', ')}`)
    if (secretsInspect.empty.length) console.error(`  密钥空值：${secretsInspect.empty.join(', ')}`)
    die(`画像 .env.${name}.secrets 不完整，拒绝切换`)
  }

  const { missing, extra } = alignPublicAndSecrets(exampleText, publicText, secretsText)
  if (missing.length || extra.length) {
    reportAlign(`画像 .env.${name} 与 .env.example 未对齐`, missing, extra)
  }

  const merged = mergeProfile(name, publicText, secretsText)
  return { name, summary: summarizeEnv(merged), text: merged }
}

export function writeActiveEnv(merged) {
  if (existsSync(ACTIVE)) unlinkSync(ACTIVE)
  writeFileSync(ACTIVE, merged)
}

export function materializeProfile(name) {
  const prepared = prepareProfile(name)
  writeActiveEnv(prepared.text)
  return prepared
}

function printSummary(summary) {
  console.log(`  数据库    ${summary.database}`)
  console.log(`  对象存储  ${summary.object}`)
  console.log(`  变化提示  ${summary.changeHint}`)
}

function useProfile(name) {
  const result = materializeProfile(name)
  console.log(`已切换到 ${result.name}`)
  printSummary(result.summary)
}

function currentProfile() {
  if (!existsSync(ACTIVE)) return null
  const stat = lstatSync(ACTIVE)
  const target = stat.isSymbolicLink() ? readlinkSync(ACTIVE) : ''
  const text = readFileSync(ACTIVE, 'utf8')
  return readActiveProfileName(text, target || undefined)
}

function status() {
  const active = currentProfile()
  if (!active) die('没有 .env。先 pnpm dev:env use local 或 pnpm env:use local。')
  console.log(`当前画像  ${active}`)
  printSummary(summarizeEnv(readFileSync(ACTIVE, 'utf8')))
  if (active !== '(regular file)' && existsSync(profilePath(active))) {
    const publicText = readFileSync(profilePath(active), 'utf8')
    const secretsFile = secretsPath(active)
    if (!existsSync(secretsFile)) {
      console.error('当前画像缺少密钥文件（status 仍显示公开项；use 不会启动）')
      process.exit(1)
    }
    const { missing, extra } = alignPublicAndSecrets(
      readFileSync(EXAMPLE, 'utf8'),
      publicText,
      readFileSync(secretsFile, 'utf8'),
    )
    if (missing.length || extra.length) {
      console.error('当前画像与 .env.example 未对齐：')
      if (missing.length) console.error(`  缺键：${missing.join(', ')}`)
      if (extra.length) console.error(`  多键：${extra.join(', ')}`)
      process.exit(1)
    }
  }
}

const invokedAsCli =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedAsCli) {
  const [command, name] = process.argv.slice(2)
  if (command === 'status' || command === undefined) {
    status()
  } else if (command === 'use' && name) {
    useProfile(name)
  } else if (command && !name && /^[a-z][a-z0-9-]*$/.test(command)) {
    useProfile(command)
  } else {
    die('用法: pnpm env:use local|remote   或   pnpm env:status')
  }
}
