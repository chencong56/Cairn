import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const cairn = join(root, 'deploy/cairn')
const libDir = join(root, 'deploy/lib')
const clusterDir = join(root, 'deploy/cluster')
const targetSh = join(root, 'deploy/lib/target.sh')

function runCairn(args, opts = {}) {
  return spawnSync(cairn, args, {
    encoding: 'utf8',
    cwd: root,
    env: { ...process.env, ...opts.env },
  })
}

test('package.json 没有 deploy/release 脚本', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  for (const name of Object.keys(pkg.scripts ?? {})) {
    assert.equal(/^(deploy|release|ship)$/.test(name), false, name)
  }
})

test('deploy/cluster 没有脚本、gateway 模板、baseline 快照', () => {
  const names = readdirSync(clusterDir)
  assert.deepEqual(names.filter((name) => name.endsWith('.sh')), [])
  assert.equal(existsSync(join(clusterDir, 'nginx/worker-gateway.conf.template')), false)
  const dist = existsSync(join(clusterDir, 'dist')) ? readdirSync(join(clusterDir, 'dist')) : []
  assert.deepEqual(dist.filter((name) => name.startsWith('baseline-')), [])
  assert.equal(existsSync(join(root, 'deploy/singe')), false)
})

test('内部脚本不写主机字面量，一律读清单', () => {
  const forbidden = /shsnc-ah[0-9]|192\.168\.3\.20[0-9]|100\.64\.0\.[0-9]/
  for (const name of readdirSync(libDir)) {
    if (!name.endsWith('.sh')) continue
    const text = readFileSync(join(libDir, name), 'utf8')
    assert.equal(forbidden.test(text), false, name)
  }
})

test('cluster restart 与 accessories 不相交；相交则拒绝', () => {
  const cluster = readFileSync(join(root, 'deploy/targets/cluster.conf'), 'utf8')
  const accessories = new Set(
    (cluster.match(/^accessories=(.*)$/m)?.[1] ?? '').trim().split(/\s+/).filter(Boolean),
  )
  const restart = new Set()
  for (const match of cluster.matchAll(/^restart=(.*)$/gm)) {
    for (const name of match[1].trim().split(/\s+/).filter(Boolean)) restart.add(name)
  }
  assert.deepEqual([...restart].filter((name) => accessories.has(name)), [])
  assert.ok(accessories.has('cairn-pg'))
  assert.ok(restart.has('cairn-api'))

  const dir = mkdtempSync(join(tmpdir(), 'cairn-target-'))
  const bad = join(dir, 'bad.conf')
  writeFileSync(
    bad,
    [
      'name=bad',
      'accessories=cairn-pg cairn-redis',
      '[host.ah3]',
      'restart=cairn-api cairn-pg',
      '',
    ].join('\n'),
  )
  const out = spawnSync(
    'bash',
    ['-c', `set -euo pipefail; . "${targetSh}"; target_assert_restart_safe "${bad}"`],
    { encoding: 'utf8' },
  )
  assert.notEqual(out.status, 0)
  assert.match(out.stderr, /cairn-pg/)
})

test('push-src 增量不打包已删文件', () => {
  const text = readFileSync(join(root, 'deploy/lib/push-src.sh'), 'utf8')
  assert.match(text, /--diff-filter=ACMRT/)
  assert.match(text, /COPYFILE_DISABLE=1/)
})

test('health_worker 按空白拆成多条 url=workerId', () => {
  const script = [
    `set -euo pipefail`,
    `. "${join(root, 'deploy/lib/release.sh')}"`,
    `health_worker_pairs 'http://127.0.0.1:8092=prod-executor-ah3 http://127.0.0.1:8093=prod-scheduler-ah3'`,
  ].join('\n')
  const out = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
  assert.equal(out.status, 0, out.stderr)
  assert.deepEqual(out.stdout.trim().split('\n'), [
    'http://127.0.0.1:8092=prod-executor-ah3',
    'http://127.0.0.1:8093=prod-scheduler-ah3',
  ])
})

test('executor 分发走 lan_ip 而不是 Tailscale 主机名', () => {
  const text = readFileSync(join(root, 'deploy/lib/release.sh'), 'utf8')
  assert.match(text, /机房网 lan_ip/)
  assert.match(text, /root@\$lan/)
})

test('release 先迁移再切 current，切流量用 force-recreate', () => {
  const text = readFileSync(join(root, 'deploy/lib/release.sh'), 'utf8')
  const fn = text.slice(text.indexOf('do_release()'))
  const migrateAt = fn.indexOf('run_migrate "$rev"')
  const switchAt = fn.indexOf('switch_current "$rev"')
  const bounceAt = fn.indexOf('bounce_apps')
  assert.ok(migrateAt > 0)
  assert.ok(switchAt > migrateAt)
  assert.ok(bounceAt > switchAt)
  assert.match(text, /up -d --no-deps --force-recreate/)
  assert.equal(/docker compose -f .* restart \$restart/.test(text), false)
})

test('缺清单或 single / dev-infra 作发布目标时不 SSH', () => {
  const missing = runCairn(['release', '--target', 'no-such-target'])
  assert.notEqual(missing.status, 0)
  assert.match(`${missing.stdout}${missing.stderr}`, /找不到目标清单/)

  const single = runCairn(['release', '--target', 'single'])
  assert.notEqual(single.status, 0)
  assert.match(`${single.stdout}${single.stderr}`, /还没有单机全套编排/)

  const dev = runCairn(['release', '--target', 'dev-infra'])
  assert.notEqual(dev.status, 0)
  assert.match(`${dev.stdout}${dev.stderr}`, /不是发布目标/)
})

test('release --dry-run 打印清单与 rev，不改远端', () => {
  const result = runCairn(['release', '--dry-run'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /目标\s+cluster/)
  assert.match(result.stdout, /build\s+ah3/)
  assert.match(result.stdout, /\[ah3\] role=core/)
  assert.match(result.stdout, /\[ah2\] role=executor/)
  assert.match(result.stdout, /\[ah4\] role=executor/)
  assert.match(result.stdout, /restart cairn-api cairn-nginx/)
  assert.match(result.stdout, /health_http http:\/\/100\.64\.0\.4\/health/)
  assert.match(result.stdout, /health_worker http:\/\/127\.0\.0\.1:8092=prod-executor-ah2/)
  assert.match(result.stdout, /禁区\s+cairn-pg/)
  assert.match(result.stdout, /rev\s+[0-9a-f]{7,12}/)
  assert.match(result.stdout, /dry-run：不推源码、不构建、不迁库、不重启、不改远端/)
})
