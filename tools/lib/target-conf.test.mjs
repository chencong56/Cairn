import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { forbiddenSecretLinesInTarget, hitsPublishGuard } from './env-profile.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const targetsDir = join(root, 'deploy/targets')
const guard = JSON.parse(readFileSync(join(root, 'deploy/dev-env.guard.json'), 'utf8'))

function containerNames(text) {
  const names = new Set()
  for (const line of text.split('\n')) {
    const match = line.match(/^(restart|accessories)=(.*)$/)
    if (!match) continue
    for (const name of match[2].trim().split(/\s+/).filter(Boolean)) names.add(name)
  }
  return names
}

function hostIds(text) {
  return [...text.matchAll(/^\[host\.([^\]]+)\]/gm)].map((match) => match[1])
}

test('入库目标清单不含密钥键名', () => {
  for (const name of ['cluster.conf', 'dev-infra.conf', 'single.conf']) {
    const file = join(targetsDir, name)
    assert.equal(existsSync(file), true, name)
    assert.deepEqual(forbiddenSecretLinesInTarget(readFileSync(file, 'utf8')), [], name)
  }
})

test('dev-infra 与 cluster 容器名不相交，single 没有主机', () => {
  const cluster = containerNames(readFileSync(join(targetsDir, 'cluster.conf'), 'utf8'))
  const dev = containerNames(readFileSync(join(targetsDir, 'dev-infra.conf'), 'utf8'))
  const overlap = [...dev].filter((name) => cluster.has(name))
  assert.deepEqual(overlap, [])
  assert.ok(dev.has('cairn-dev-pg'))
  assert.ok(cluster.has('cairn-pg'))
  assert.deepEqual(hostIds(readFileSync(join(targetsDir, 'single.conf'), 'utf8')), [])
})

test('dev-infra 端口只写在清单，compose 跟变量走', () => {
  const conf = readFileSync(join(targetsDir, 'dev-infra.conf'), 'utf8')
  assert.match(conf, /^remote_root=\/home\/cairn$/m)
  assert.match(conf, /^\[host\.gs1\]$/m)
  assert.match(conf, /^bind=0\.0\.0\.0$/m)
  assert.match(conf, /^pg_port=25432$/m)
  assert.match(conf, /^redis_port=26380$/m)
  assert.match(conf, /^s3_port=19031$/m)
  assert.match(conf, /^bucket=cairn-dev-evidence$/m)
  const compose = readFileSync(join(root, 'deploy/dev-infra/compose.yml'), 'utf8')
  assert.match(compose, /\$\{BIND_ADDR\}:\$\{DEV_PG_PORT\}:5432/)
  assert.match(compose, /\$\{BIND_ADDR\}:\$\{DEV_REDIS_PORT\}:6379/)
  assert.match(compose, /\$\{BIND_ADDR\}:\$\{DEV_S3_PORT\}:9000/)
  assert.equal(/0\.0\.0\.0:15432:/.test(compose), false)
  assert.equal(/0\.0\.0\.0:16380:/.test(compose), false)
  assert.equal(/0\.0\.0\.0:9031:/.test(compose), false)
  assert.equal(/^\s+-\s+cairn-net\s*$/m.test(compose), false)
})

test('remote 开发口不命中发布黑名单', () => {
  assert.equal(
    hitsPublishGuard(
      {
        dbHost: '100.64.0.4',
        dbPort: '25432',
        redisUrl: 'redis://100.64.0.4:26380',
        s3Endpoint: 'http://100.64.0.4:19031',
      },
      guard,
    ).hit,
    false,
  )
})
