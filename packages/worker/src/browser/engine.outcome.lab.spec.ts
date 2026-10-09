/**
 * Engine × 真浏览器 Outcome 结果轴联调验证。
 * 强制要求真实 Chromium（Playwright）运行，CI 与本地一视同仁。
 *
 * 验证目标：
 * 1. 真实浏览器确定性断言成功（PASS）：执行轴与结果轴均为 PASS；
 * 2. 真实浏览器目标定位失败（TARGET_NOT_FOUND）：结果轴记 UNKNOWN（OCA-08），不被判为业务断言失败。
 *
 * 断言不成立 × continue / halt（OCA-05 / OCA-06）的引擎语义已于 2026-09-29
 * 降层至 L1（src/engine/engine.outcome.spec.ts），真浏览器层只保留上述
 * 「非真浏览器不可」的差异切片。
 */
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  claimRun,
  consoleAccounts,
  createRunWithSnapshot,
  createScenarioWithVersion,
  getRun,
  newId,
  openIsolatedDb,
  registerWorker,
  secrets,
  targetAccounts,
  targets,
  type DbHandle,
} from '@cairn/db/testing'
import {
  DEV_CREDENTIAL_KEY,
  LOCAL_SECRET_PROVIDER,
  stepRunFor,
  type Step,
} from '@cairn/shared'
import { credentialKeyFromEnv, LocalSecretProvider } from '@cairn/secret'
import { createBrowserPort } from './port.js'
import { BrowserSessionManager } from './session-manager.js'
import { LocalObjectStore } from '@cairn/storage'
import { ObjectService } from '../objects/object.service.js'
import { ExecutionEngine } from '../engine/engine.js'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_oclab`

const HTML_CONTENT = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Outcome Lab</title></head>
<body>
  <div id="status-badge">ONLINE</div>
  <button id="action-btn">执行动作</button>
  <div id="action-result">INITIAL</div>
  <script>
    document.getElementById('action-btn').addEventListener('click', () => {
      document.getElementById('action-result').textContent = 'DONE';
    });
  </script>
</body>
</html>`

const LOGIN_HTML = `<!doctype html><html><body>
<form method="POST" action="/login">
  <input name="username" id="user" />
  <input name="password" id="pass" type="password" />
  <button type="submit" id="go">登录</button>
</form>
</body></html>`

describe('ExecutionEngine × 真浏览器 Outcome 结果轴联调', { timeout: 180_000 }, () => {
  let handle: DbHandle
  let manager: BrowserSessionManager
  let server: ReturnType<typeof createServer> | undefined
  let baseUrl = ''
  let actorId: string
  let targetId: string
  let accountId: string
  let secretId: string
  let workerId: string
  let workerInstanceId: string
  let objectDir: string
  let objects: ObjectService
  let secretsProvider: LocalSecretProvider

  beforeAll(async () => {
    // 强制验证 Chromium 可用
    const { chromium } = await import('playwright')
    const browser = await chromium.launch({ headless: true })
    await browser.close()

    handle = await openIsolatedDb(SCHEMA)
    actorId = newId()
    targetId = newId()
    accountId = newId()
    secretId = newId()
    secretsProvider = new LocalSecretProvider(credentialKeyFromEnv(DEV_CREDENTIAL_KEY))

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/login') {
        if (req.method === 'POST') {
          res.writeHead(302, {
            Location: '/',
            'Set-Cookie': 'lab=ok; Path=/; HttpOnly',
          })
          res.end()
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(LOGIN_HTML)
        return
      }
      const cookie = req.headers.cookie ?? ''
      if (!cookie.includes('lab=ok')) {
        res.writeHead(302, { Location: '/login' })
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(HTML_CONTENT)
    })
    await new Promise<void>((ready) => server!.listen(0, '127.0.0.1', ready))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('invalid server address')
    baseUrl = `http://127.0.0.1:${address.port}`

    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'outcome-lab',
      email: `oclab-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `oclab-${SCHEMA.slice(-8)}`,
      name: 'Outcome Lab Target',
      entryUrl: `${baseUrl}/`,
      loginUrl: `${baseUrl}/login`,
      authMethod: 'password',
      captchaMode: 'none',
      loginFields: {
        username: { by: 'name', value: 'username' },
        password: { by: 'name', value: 'password' },
        submit: { by: 'css', value: 'button[type=submit]' },
      },
    })
    await handle.db.insert(secrets).values({
      id: secretId,
      provider: LOCAL_SECRET_PROVIDER,
      ciphertext: secretsProvider.encrypt(secretId, 'lab'),
    })
    await handle.db.insert(targetAccounts).values({
      id: accountId,
      targetId,
      displayName: 'lab-user',
      username: 'lab',
      secretProvider: LOCAL_SECRET_PROVIDER,
      secretId,
      status: 'active',
    })

    objectDir = mkdtempSync(join(tmpdir(), 'cairn-oclab-obj-'))
    objects = new ObjectService(
      handle,
      new LocalObjectStore(objectDir, 32 * 1024 * 1024),
      {
        retainDays: 30,
        pendingTtlSeconds: 3600,
        maxBytes: 32 * 1024 * 1024,
        traceMaxBytes: 128 * 1024 * 1024,
        videoMaxBytes: 128 * 1024 * 1024,
        uploadMaxAttempts: 3,
      },
    )
    workerId = `oclab-${SCHEMA.slice(-8)}`
    workerInstanceId = newId()
    await registerWorker(handle.db, {
      workerId,
      instanceId: workerInstanceId,
      capacity: 8,
      lostAfterSeconds: 60,
      roles: ['executor'],
    })
    manager = new BrowserSessionManager(
      handle,
      {
        workerId,
        workerInstanceId,
        profileRoot: mkdtempSync(join(tmpdir(), 'cairn-oclab-prof-')),
        headless: true,
        maxSessions: 2,
        defaultLeaseTtlSeconds: 60,
        defaultAuthWaitSeconds: 60,
        heartbeatMs: 60_000,
      },
      secretsProvider,
      objects,
    )
    await manager.reconcileOwn()
  })

  afterAll(async () => {
    await manager?.shutdown()
    await handle?.close()
    if (objectDir) rmSync(objectDir, { recursive: true, force: true })
    if (server) {
      await new Promise<void>((done) => server!.close(() => done()))
    }
  }, 30_000)

  async function claimThis(runId: string) {
    await handle.pool.query(
      `UPDATE runs
          SET status = 'CANCELLED',
              finished_at = COALESCE(finished_at, now()),
              updated_at = now()
        WHERE status IN ('QUEUED', 'RECOVERING')
          AND id <> $1`,
      [runId],
    )
    const grant = await claimRun(handle, {
      workerId,
      instanceId: workerInstanceId,
      leaseTtlSeconds: 60,
    })
    expect(grant?.runId).toBe(runId)
    return grant!
  }

  it('真浏览器下确定性断言成功（PASS）：执行轴 SUCCEEDED、结果轴 PASS、写入 Expected/Actual', async () => {
    const stepNavId = newId()
    const stepAssertId = newId()
    const steps: Step[] = [
      {
        id: stepNavId,
        name: '导航到测试页',
        type: 'navigate',
        effectType: 'IDEMPOTENT',
        input: { url: `${baseUrl}/` },
      },
      {
        id: stepAssertId,
        name: '断言状态徽标为 ONLINE',
        type: 'assert',
        effectType: 'READ_ONLY',
        input: {
          target: {
            framePath: [],
            candidates: [{ by: 'css', value: '#status-badge' }],
          },
          expect: { kind: 'text_equals', value: 'ONLINE' },
        },
      },
    ]

    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `pass-lab-${newId()}`,
      steps,
      actor: { id: actorId },
    })

    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: accountId,
      actor: { id: actorId },
    })

    const grant = await claimThis(created.detail.id)
    const engine = new ExecutionEngine(handle, createBrowserPort(manager))
    await engine.execute(created.detail.id, { grant })

    const detail = await getRun(handle.db, created.detail.id)

    // 执行轴与结果轴双轴验证
    expect(detail.status).toBe('SUCCEEDED')
    expect(detail.outcomeStatus).toBe('PASS')

    // 步骤级验证
    expect(detail.stepRuns).toHaveLength(2)
    const assertStepRun = stepRunFor(detail.stepRuns, stepAssertId)!
    expect(assertStepRun.status).toBe('SUCCEEDED')
    expect(assertStepRun.outcomeStatus).toBe('PASS')

    // 事实表 outcome_results 验证
    expect(detail.outcomeResults).toHaveLength(1)
    const result = detail.outcomeResults[0]!
    expect(result.verdict).toBe('PASS')
    expect(result.actual).toBe('ONLINE')
    expect(result.meaning).toBe('断言状态徽标为 ONLINE')
    expect(result.provenance).toBe('legacy_assert')
    expect(result.onViolation).toBe('halt')
  })

  it('真浏览器下元素不存在（TARGET_NOT_FOUND）：判定为 UNKNOWN（OCA-08），不判定为业务断言失败', async () => {
    const stepNavId = newId()
    const stepAssertId = newId()

    const steps: Step[] = [
      {
        id: stepNavId,
        name: '打开页面',
        type: 'navigate',
        effectType: 'IDEMPOTENT',
        input: { url: `${baseUrl}/` },
      },
      {
        id: stepAssertId,
        name: '寻找不存在的元素',
        type: 'assert',
        effectType: 'READ_ONLY',
        input: {
          target: {
            framePath: [],
            candidates: [{ by: 'css', value: '#non-existent-element-404' }],
          },
          expect: { kind: 'exists' },
        },
      },
    ]

    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `unknown-lab-${newId()}`,
      steps,
      actor: { id: actorId },
    })

    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: accountId,
      actor: { id: actorId },
    })

    const grant = await claimThis(created.detail.id)
    const engine = new ExecutionEngine(handle, createBrowserPort(manager))
    await engine.execute(created.detail.id, { grant })

    const detail = await getRun(handle.db, created.detail.id)

    // 基础设施执行失败
    expect(detail.status).toBe('FAILED')
    // 核心规范约束：元素定位失败绝不判定为 FAIL 或 PASS，必须判定为 UNKNOWN！
    expect(detail.outcomeStatus).toBe('UNKNOWN')

    const assertStepRun = stepRunFor(detail.stepRuns, stepAssertId)!
    expect(assertStepRun.status).toBe('FAILED')
    expect(assertStepRun.outcomeStatus).toBe('UNKNOWN')
    expect(assertStepRun.attempts[0]?.error?.code).toBe('TARGET_NOT_FOUND')

    expect(detail.outcomeResults).toHaveLength(1)
    const res = detail.outcomeResults[0]!
    expect(res.verdict).toBe('UNKNOWN')
    expect(res.details?.code).toBe('TARGET_NOT_FOUND')
  })
})
