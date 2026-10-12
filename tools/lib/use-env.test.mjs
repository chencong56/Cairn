import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { alignPublicAndSecrets, alignText, keysOf, secretKeysIn } from './env-profile.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

test('keysOf 同时统计未注释与注释形态的键', () => {
  const keys = keysOf([
    'CAIRN_DB_HOST=127.0.0.1',
    '# CAIRN_LOG_LEVEL=info',
    '#   CAIRN_JWT_SECRET=$(openssl rand -base64 48 | tr -d \'\\n\')',
    'CAIRN_SESSION_LEASE_TTL_SECONDS=30       # 须 ≥ 3 × 心跳',
    '# 日志级别说明这行没有键',
    '# ════ 分节线 ════',
    '普通中文注释',
  ].join('\n'))
  assert.deepEqual([...keys].sort(), [
    'CAIRN_DB_HOST',
    'CAIRN_JWT_SECRET',
    'CAIRN_LOG_LEVEL',
    'CAIRN_SESSION_LEASE_TTL_SECONDS',
  ])
})

test('alignText 报告缺键与多键', () => {
  const { missing, extra } = alignText('A=1\n# B=2\n', 'A=1\n# C=3\n')
  assert.deepEqual(missing, ['B'])
  assert.deepEqual(extra, ['C'])
})

test('公开画像 ∪ 密钥 与 .env.example 键集完全一致，且公开文件无密钥键', () => {
  const exampleText = readFileSync(join(root, '.env.example'), 'utf8')
  const secretsExample = readFileSync(join(root, '.env.secrets.example'), 'utf8')
  for (const profile of ['.env.local', '.env.remote']) {
    const file = join(root, profile)
    if (!existsSync(file)) continue
    const publicText = readFileSync(file, 'utf8')
    assert.deepEqual(secretKeysIn(publicText), [], `${profile} 含密钥键`)
    const { missing, extra } = alignPublicAndSecrets(exampleText, publicText, secretsExample)
    assert.deepEqual(
      { missing, extra },
      { missing: [], extra: [] },
      `${profile} 与 .env.example 键集不一致`,
    )
  }
})
