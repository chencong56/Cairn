import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SECRET_KEYS,
  keysOf,
  alignText,
  alignPublicAndSecrets,
  secretKeysIn,
  inspectSecretsFile,
  mergeProfile,
  readActiveProfileName,
  hitsPublishGuard,
  forbiddenSecretLinesInTarget,
  applyTestDbPin,
} from './env-profile.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const exampleText = readFileSync(join(root, '.env.example'), 'utf8')
const guard = JSON.parse(readFileSync(join(root, 'deploy/dev-env.guard.json'), 'utf8'))

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

test('公开 ∪ 密钥 必须对齐 example，公开文件不得含密钥键', () => {
  const publicText = 'CAIRN_DB_HOST=127.0.0.1\n# CAIRN_LOG_LEVEL=info\n'
  const secretsText = SECRET_KEYS.map((key) => `${key}=x`).join('\n')
  const aligned = alignPublicAndSecrets(
    'CAIRN_DB_HOST=\n# CAIRN_LOG_LEVEL=info\nCAIRN_JWT_SECRET=\nCAIRN_DB_PASSWORD=\nCAIRN_CREDENTIAL_KEY=\nCAIRN_INTERNAL_AUTH_SECRET=\nCAIRN_S3_ACCESS_KEY=\nCAIRN_S3_SECRET_KEY=\n',
    publicText,
    secretsText,
  )
  assert.deepEqual(aligned, { missing: [], extra: [] })
  assert.deepEqual(secretKeysIn(publicText), [])
  assert.deepEqual(inspectSecretsFile(secretsText), { extra: [], missing: [], empty: [] })
})

test('密钥文件缺键、空值或多了公开键会被检出', () => {
  const inspect = inspectSecretsFile('CAIRN_DB_PASSWORD=\nCAIRN_DB_HOST=1\n')
  assert.ok(inspect.empty.includes('CAIRN_DB_PASSWORD'))
  assert.ok(inspect.extra.includes('CAIRN_DB_HOST'))
  assert.ok(inspect.missing.includes('CAIRN_JWT_SECRET'))
})

test('mergeProfile 写出画像头且不含符号链接语义', () => {
  const merged = mergeProfile('local', 'CAIRN_DB_HOST=127.0.0.1\n', 'CAIRN_JWT_SECRET=abc\n')
  assert.match(merged, /^# cairn-env-active: local/m)
  assert.match(merged, /^CAIRN_JWT_SECRET=abc$/m)
  assert.equal(readActiveProfileName(merged, '.env.local'), 'local')
  assert.equal(readActiveProfileName('CAIRN_DB_HOST=1\n', '.env.remote'), 'remote')
})

test('发布端口黑名单命中 Tailscale 与机房网同一发布口', () => {
  assert.equal(
    hitsPublishGuard({ dbHost: '100.64.0.4', dbPort: '15432' }, guard).hit,
    true,
  )
  assert.equal(
    hitsPublishGuard({ dbHost: '192.168.3.203', dbPort: '15432' }, guard).hit,
    true,
  )
  assert.equal(
    hitsPublishGuard({ s3Endpoint: 'http://shsnc-ah3:9031' }, guard).hit,
    true,
  )
  assert.equal(
    hitsPublishGuard({ redisUrl: 'redis://100.64.0.4:16380' }, guard).hit,
    true,
  )
  assert.equal(
    hitsPublishGuard({ dbHost: '100.64.0.4', dbPort: '5432', s3Endpoint: 'http://100.64.0.4:9021' }, guard).hit,
    false,
  )
  assert.equal(
    hitsPublishGuard({ dbHost: '127.0.0.1', dbPort: '5432' }, guard).hit,
    false,
  )
  assert.equal(
    hitsPublishGuard(
      {
        dbHost: '100.64.0.4',
        dbPort: '25432',
        s3Endpoint: 'http://100.64.0.4:19031',
        redisUrl: 'redis://100.64.0.4:26380',
      },
      guard,
    ).hit,
    false,
  )
})

test('目标清单不得出现密钥键名', () => {
  assert.equal(forbiddenSecretLinesInTarget('lan_ip=192.168.3.203\n').length, 0)
  assert.equal(forbiddenSecretLinesInTarget('CAIRN_DB_PASSWORD=x\n').length, 1)
})

test('applyTestDbPin 非 CI 把 host 钉到本机测试库', () => {
  const env = {
    CAIRN_DB_HOST: '100.64.0.4',
    CAIRN_DB_PORT: '5432',
    CAIRN_TEST_DB_HOST: '127.0.0.1',
    CAIRN_TEST_DB_PORT: '5442',
  }
  applyTestDbPin(env, { ci: false })
  assert.equal(env.CAIRN_DB_HOST, '127.0.0.1')
  assert.equal(env.CAIRN_DB_PORT, '5442')
  assert.equal(env.CAIRN_TEST_DB_PINNED, '1')
})

test('applyTestDbPin 非 CI 缺省测试 host 为 127.0.0.1', () => {
  const env = {
    CAIRN_DB_HOST: '100.64.0.4',
    CAIRN_DB_PORT: '5432',
    CAIRN_TEST_DB_PORT: '5442',
  }
  applyTestDbPin(env, { ci: false })
  assert.equal(env.CAIRN_DB_HOST, '127.0.0.1')
})

test('applyTestDbPin 测试库与开发库同一地址则拒绝', () => {
  assert.throws(
    () =>
      applyTestDbPin(
        {
          CAIRN_DB_HOST: '127.0.0.1',
          CAIRN_DB_PORT: '5442',
          CAIRN_TEST_DB_HOST: '127.0.0.1',
          CAIRN_TEST_DB_PORT: '5442',
        },
        { ci: false },
      ),
    /写进开发库/,
  )
})

test('applyTestDbPin 在 CI 且未配测试端口时不改 host', () => {
  const env = { CAIRN_DB_HOST: 'ci-db', CAIRN_DB_PORT: '5432' }
  applyTestDbPin(env, { ci: true })
  assert.equal(env.CAIRN_DB_HOST, 'ci-db')
  assert.equal(env.CAIRN_DB_PORT, '5432')
})

test('入库公开画像不含密钥键，且与 example ∪ secrets.example 对齐', () => {
  for (const profile of ['.env.local', '.env.remote']) {
    const file = join(root, profile)
    if (!existsSync(file)) continue
    const publicText = readFileSync(file, 'utf8')
    assert.deepEqual(secretKeysIn(publicText), [], `${profile} 含密钥键`)
    const secretsExample = readFileSync(join(root, '.env.secrets.example'), 'utf8')
    const { missing, extra } = alignPublicAndSecrets(exampleText, publicText, secretsExample)
    assert.deepEqual({ missing, extra }, { missing: [], extra: [] }, `${profile} 与 example 未对齐`)
  }
})
