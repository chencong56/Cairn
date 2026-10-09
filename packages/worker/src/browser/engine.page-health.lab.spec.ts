/**
 * Engine × 真 Chromium：页面健康约束（接口 4xx / 5xx、静态资源 404、未捕获异常）端到端验收。
 * 强制启动 Playwright Chromium，不跳过、不注入 Attempt 错误码。
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
  eq,
  getRun,
  newId,
  openIsolatedDb,
  publishScenarioDraft,
  registerWorker,
  saveScenarioDraft,
  secrets,
  targetAccounts,
  targets,
  type DbHandle,
} from '@cairn/db/testing'
import {
  DEV_CREDENTIAL_KEY,
  LOCAL_SECRET_PROVIDER,
  defaultPageHealthInvariants,
  createRuntimeInvariant,
  type AuthoringNode,
  type OutcomeContract,
  type RuntimeInvariant,
  type Step,
} from '@cairn/shared'
import { credentialKeyFromEnv, LocalSecretProvider } from '@cairn/secret'
import { createBrowserPort } from './port.js'
import { BrowserSessionManager } from './session-manager.js'
import { LocalObjectStore } from '@cairn/storage'
import { ObjectService } from '../objects/object.service.js'
import { ExecutionEngine } from '../engine/engine.js'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_phlab`

const LOGIN_HTML = `<!doctype html><html><body>
<form method="POST" action="/login">
  <input name="username" id="user" />
  <input name="password" id="pass" type="password" />
  <button type="submit" id="go">登录</button>
</form>
</body></html>`

const HOME_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Page Health Lab</title></head>
<body>
  <button id="action-btn">提交</button>
  <button id="fine-btn">正常查询</button>
  <script>
    document.getElementById('action-btn').addEventListener('click', () => {
      fetch('/api/order/123456', { method: 'POST' });
      fetch('/api/slow').catch(() => {});
      setTimeout(() => { throw new Error('点击后脚本异常 token=abc123') }, 30);
    });
    document.getElementById('fine-btn').addEventListener('click', () => { fetch('/api/ok') });
  </script>
</body>
</html>`

describe('ExecutionEngine × 真浏览器 页面健康约束', { timeout: 240_000 }, () => {
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
  let secretsProvider: LocalSecretProvider

  beforeAll(async () => {
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
          req.resume()
          req.on('end', () => {
            res.writeHead(302, { Location: '/', 'Set-Cookie': 'lab=ok; Path=/; HttpOnly' })
            res.end()
          })
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(LOGIN_HTML)
        return
      }
      if (!(req.headers.cookie ?? '').includes('lab=ok')) {
        res.writeHead(302, { Location: '/login' })
        res.end()
        return
      }
      if (url.pathname === '/api/ok') return void res.writeHead(200).end('{}')
      if (url.pathname === '/api/slow') return void setTimeout(() => res.writeHead(503).end('slow'), 600)
      if (url.pathname.startsWith('/api/')) return void res.writeHead(500).end('boom')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(HOME_HTML)
    })
    await new Promise<void>((ready) => server!.listen(0, '127.0.0.1', ready))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('invalid server address')
    baseUrl = `http://127.0.0.1:${address.port}`

    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'ph-lab',
      email: `phlab-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `phlab-${SCHEMA.slice(-8)}`,
      name: 'Page Health Lab Target',
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
    objectDir = mkdtempSync(join(tmpdir(), 'cairn-phlab-obj-'))
    const objects = new ObjectService(
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
    workerId = `phlab-${SCHEMA.slice(-8)}`
    workerInstanceId = newId()
    await registerWorker(handle.db, {
      workerId,
      instanceId: workerInstanceId,
      capacity: 8,
      maxSessions: 4,
      lostAfterSeconds: 60,
      roles: ['executor'],
    })
    manager = new BrowserSessionManager(
      handle,
      {
        workerId,
        workerInstanceId,
        profileRoot: mkdtempSync(join(tmpdir(), 'cairn-phlab-prof-')),
        headless: true,
        maxSessions: 4,
        defaultLeaseTtlSeconds: 90,
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
    if (server) await new Promise<void>((done) => server!.close(() => done()))
  }, 30_000)

  const css = (value: string) => ({ framePath: [], candidates: [{ by: 'css' as const, value }] })
  const navigate = (id: string, path: string): Step => ({
    id,
    name: `打开 ${path}`,
    type: 'navigate',
    effectType: 'IDEMPOTENT',
    input: { url: `${baseUrl}${path}` },
  })
  const click = (id: string, selector: string): Step => ({
    id,
    name: `点击 ${selector}`,
    type: 'click',
    effectType: 'SIDE_EFFECT',
    input: { target: css(selector) },
  })
  // 点击不等网络：加一个等待步骤，让点击触发的请求在后面的步骤里才返回
  const wait = (id: string, ms: number): Step => ({
    id,
    name: `等待 ${ms}ms`,
    type: 'wait',
    effectType: 'READ_ONLY',
    input: { kind: 'time', durationMs: ms },
  })

  async function execute(input: { steps: Step[]; invariants: RuntimeInvariant[]; outcomes?: Record<string, OutcomeContract[]> }) {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `ph-${newId()}`,
      steps: [{ id: newId(), name: 'init', type: 'echo', effectType: 'READ_ONLY', input: { value: 'init' } }],
      actor: { id: actorId },
    })
    const nodes: AuthoringNode[] = input.steps.map((step) => ({
      kind: 'step',
      step,
      ...(input.outcomes?.[step.id] ? { outcomes: input.outcomes[step.id] } : {}),
    }))
    await saveScenarioDraft(handle.db, scenario.id, {
      revision: 1,
      document: {
        authoringSchemaVersion: 2 as const,
        schemaVersion: 1,
        inputs: [],
        nodes,
        runtimeInvariants: input.invariants,
      },
      actor: { id: actorId },
    })
    await publishScenarioDraft(handle.db, scenario.id, { revision: 2, actor: { id: actorId } })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: accountId,
      actor: { id: actorId },
    })
    await handle.pool.query(
      `UPDATE runs SET status = 'CANCELLED', finished_at = COALESCE(finished_at, now()), updated_at = now()
        WHERE status IN ('QUEUED', 'RECOVERING', 'WAITING_FOR_AUTH', 'HOLDING') AND id <> $1`,
      [created.detail.id],
    )
    const grant = await claimRun(handle, { workerId, instanceId: workerInstanceId, leaseTtlSeconds: 90 })
    expect(grant?.runId).toBe(created.detail.id)
    const engine = new ExecutionEngine(handle, createBrowserPort(manager))
    await engine.execute(created.detail.id, { grant: grant! })
    return getRun(handle.db, created.detail.id)
  }

  const healthRows = (detail: Awaited<ReturnType<typeof getRun>>) =>
    detail.outcomeResults.filter((row) => (row.expected as { kind?: string } | null)?.kind === 'network_health' || (row.expected as { kind?: string } | null)?.kind === 'script_errors')

  it('默认约束：点击触发的 500 / 延迟 503 / 脚本异常记警告，归到点击那一步，不停止、不判失败', async () => {
    const invariants = defaultPageHealthInvariants(newId)
    const stepNav = newId()
    const stepClick = newId()
    const stepWait = newId()
    const detail = await execute({
      steps: [navigate(stepNav, '/'), click(stepClick, '#action-btn'), wait(stepWait, 1_200)],
      invariants,
    })
    expect(detail.status).toBe('SUCCEEDED')
    expect(detail.outcomeStatus).toBe('WARN')
    const rows = healthRows(detail)
    expect(rows.map((row) => row.verdict)).toEqual(expect.arrayContaining(['FAIL']))
    const all = rows.flatMap((row) => (row.actual as { samples: { url?: string; status?: number; stepId?: string; type: string }[] }).samples)
    const urls = all.map((sample) => sample.url?.replace(baseUrl, ''))
    expect(urls).toEqual(expect.arrayContaining(['/api/order/*', '/api/slow']))
    // 发起步骤是点击，而不是取数时所在的等待步骤
    expect(all.filter((sample) => sample.url?.endsWith('/api/slow')).every((sample) => sample.stepId === stepClick)).toBe(true)
    expect(all.some((sample) => sample.type === 'script_error' && sample.stepId === stepClick)).toBe(true)
    // 结果行指向 page_health 证据
    const withEvidence = rows.find((row) => row.evidenceId)
    expect(withEvidence).toBeTruthy()
    const evidence = await handle.pool.query(`SELECT type, payload FROM evidences WHERE id = $1`, [withEvidence!.evidenceId])
    expect(evidence.rows[0]).toMatchObject({ type: 'log', payload: { role: 'page_health' } })
    // 发现项合并，且没有 token
    const findings = detail.output?.findings ?? []
    expect(findings.filter((finding) => finding.title.includes('页面'))).toHaveLength(2)
    expect(JSON.stringify(detail.outcomeResults)).not.toContain('abc123')
  })

  it('没有违规：不写任何页面健康结果，结论保持未评价', async () => {
    const detail = await execute({
      steps: [navigate(newId(), '/'), click(newId(), '#fine-btn'), wait(newId(), 300)],
      invariants: defaultPageHealthInvariants(newId),
    })
    expect(detail.status).toBe('SUCCEEDED')
    expect(healthRows(detail)).toEqual([])
    expect(detail.outcomeStatus).toBe('NOT_EVALUATED')
  })

  it('调成 MUST + 停止：违规后停止后续步骤，结论为失败', async () => {
    const [net] = defaultPageHealthInvariants(newId)
    const must = { ...net!, severity: 'MUST' as const, onViolation: 'halt' as const }
    const lastStep = newId()
    const detail = await execute({
      steps: [navigate(newId(), '/'), click(newId(), '#action-btn'), wait(newId(), 1_200), click(lastStep, '#fine-btn')],
      invariants: [must],
    })
    expect(detail.outcomeStatus).toBe('FAIL')
    expect(detail.status).toBe('FAILED')
  })

  const requestRule = (rule: Record<string, unknown>, overrides: Partial<OutcomeContract> = {}): OutcomeContract =>
    ({
      id: newId(),
      scope: 'step',
      meaning: '点击后必须调用接口',
      severity: 'MUST',
      onViolation: 'halt',
      provenance: 'manual',
      rule: { kind: 'page_request', status: '2xx', graceMs: 1_500, ...rule },
      ...overrides,
    }) as OutcomeContract

  it('页面请求条件：点击后出现且 2xx 通过；请求在步骤结束后才发出也在宽限期内等到', async () => {
    const stepNav = newId()
    const stepClick = newId()
    const okRule = requestRule({ match: '/api/ok', method: 'GET' })
    const detail = await execute({
      steps: [navigate(stepNav, '/'), click(stepClick, '#fine-btn')],
      invariants: [],
      outcomes: { [stepClick]: [okRule] },
    })
    expect(detail.status).toBe('SUCCEEDED')
    const row = detail.outcomeResults.find((item) => item.contractId === okRule.id)
    expect(row).toMatchObject({ verdict: 'PASS', provenance: 'manual' })
    expect(detail.outcomeStatus).toBe('PASS')
    const evidence = await handle.pool.query(`SELECT type, payload FROM evidences WHERE id = $1`, [row!.evidenceId])
    expect(evidence.rows[0]).toMatchObject({ type: 'log', payload: { role: 'page_requests' } })
  })

  it('页面请求条件：没有出现该请求 / 返回 500 判不通过，按严重级别决定警告或失败并停止', async () => {
    const stepClick = newId()
    const never = requestRule({ match: '/api/never', graceMs: 300 }, { severity: 'SHOULD', onViolation: 'continue' })
    const soft = await execute({
      steps: [navigate(newId(), '/'), click(stepClick, '#fine-btn')],
      invariants: [],
      outcomes: { [stepClick]: [never] },
    })
    expect(soft.status).toBe('SUCCEEDED')
    expect(soft.outcomeStatus).toBe('WARN')
    expect(soft.outcomeResults.find((item) => item.contractId === never.id)).toMatchObject({
      verdict: 'FAIL',
      actual: { reason: '步骤期间没有出现该请求' },
    })

    const stepOrder = newId()
    const lastStep = newId()
    const status500 = requestRule({ match: '/api/order/*', method: 'POST', graceMs: 1_000 })
    const hard = await execute({
      steps: [navigate(newId(), '/'), click(stepOrder, '#action-btn'), click(lastStep, '#fine-btn')],
      invariants: [],
      outcomes: { [stepOrder]: [status500] },
    })
    expect(hard.status).toBe('FAILED')
    expect(hard.outcomeStatus).toBe('FAIL')
    expect(hard.outcomeResults.find((item) => item.contractId === status500.id)).toMatchObject({
      verdict: 'FAIL',
      actual: { reason: expect.stringContaining('返回 500') },
    })
  })
})
