/** Real HTTP → database → Engine → managed Chromium → durable result/decision/evidence.
 * End-to-end acceptance of RIT01: Scenario-level Controlled Self-Healing & Incident Closure (Phase 3.1).
 */
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Test } from '@nestjs/testing'
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core'
import type { INestApplication, ExecutionContext } from '@nestjs/common'
import request from 'supertest'
import {
  newId,
  openIsolatedDb,
  consoleAccounts,
  targets,
  targetAccounts,
  secrets,
  createScenarioWithVersion,
  claimRun,
  registerWorker,
  getRun,
  listRunEvidence,
  type DbHandle,
} from '@cairn/db/testing'
import {
  claimReliabilityEvaluation,
  writeReliabilityEvaluation,
  getIncidentDetail,
  updateIncidentStatus,
  getScenario,
  getRepairCandidate,
} from '@cairn/db'
import { schemaFor } from '../../packages/db/src/native.js'
import { credentialKeyFromEnv, LocalSecretProvider } from '@cairn/secret'
import {
  DEV_CREDENTIAL_KEY,
  PERMISSIONS,
  type Step,
  type ScenarioDetailDto,
} from '@cairn/shared'
import type { BrowserSessionManager as SessionManager } from '../../packages/worker/dist/browser/session-manager.js'
import { DB_HANDLE } from '../../packages/api/src/db/db.module'
import {
  TargetReliabilityController,
  ReliabilityIncidentsController,
  ReliabilityAssetsController,
  ReliabilityUpgradeJobsController,
} from '../../packages/api/src/reliability/reliability.controller'
import { ReliabilityService } from '../../packages/api/src/reliability/reliability.service'
import { RepairController } from '../../packages/api/src/repair/repair.controller'
import { RepairService } from '../../packages/api/src/repair/repair.service'
import { ScenariosController } from '../../packages/api/src/scenarios/scenarios.controller'
import { ScenariosService } from '../../packages/api/src/scenarios/scenarios.service'
import { RunsController } from '../../packages/api/src/runs/runs.controller'
import { RunsService } from '../../packages/api/src/runs/runs.service'
import { ObserveService } from '../../packages/api/src/runs/observe.service'
import { BrowserService } from '../../packages/api/src/runs/browser.service'
import { PermissionsGuard } from '../../packages/api/src/rbac/permissions.guard'
import { AllExceptionsFilter } from '../../packages/api/src/common/all-exceptions.filter'
import { listenForSupertest } from '../../packages/api/src/__tests__/http-app'

describe('RI-T Joint Acceptance (RIT01-S): Scenario Self-Healing & Closure', { timeout: 60_000 }, () => {
  let handle: DbHandle
  let app: INestApplication
  let manager: SessionManager
  let BrowserSessionManager: typeof import('../../packages/worker/dist/browser/session-manager.js').BrowserSessionManager
  let createBrowserPort: typeof import('../../packages/worker/dist/browser/port.js').createBrowserPort
  let ExecutionEngine: typeof import('../../packages/worker/dist/engine/engine.js').ExecutionEngine
  let server: ReturnType<typeof createServer>
  let baseUrl = ''
  let html = ''
  let profileRoot = ''
  let actorId: string
  let targetId: string
  let accountId: string
  let scenario: ScenarioDetailDto
  let step1Id: string
  let step2Id: string
  let step3Id: string

  let baselineRunId: string
  let failedRunId: string
  let failedAttemptId: string
  let incidentId: string
  let candidateId: string

  const workerId = `rit01-e2e-${newId()}`
  const workerInstanceId = newId()
  const secretProvider = new LocalSecretProvider(credentialKeyFromEnv(DEV_CREDENTIAL_KEY))

  function actor() {
    return { kind: 'console' as const, id: actorId }
  }

  beforeAll(async () => {
    const workerSource = resolve(import.meta.dirname, '../../packages/worker/src')
    ;({ BrowserSessionManager } = await import(`${workerSource}/browser/session-manager.ts`))
    ;({ createBrowserPort } = await import(`${workerSource}/browser/port.ts`))
    ;({ ExecutionEngine } = await import(`${workerSource}/engine/engine.ts`))

    handle = await openIsolatedDb(`rit01_e2e_${Date.now().toString(36)}`)
    actorId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'RIT01 E2E',
      email: `${actorId}@example.com`,
      status: 'active',
    })

    const { consoleRoles, consoleAccountRoles, consoleRolePermissions } = schemaFor(handle.db)
    const roles = await handle.db.select().from(consoleRoles)
    const admin = roles.find((r: any) => r.key === 'admin')
    if (admin) {
      await handle.db.insert(consoleAccountRoles).values({
        consoleAccountId: actorId,
        consoleRoleId: admin.id,
        targetScopeMode: 'all',
        targetScopeIds: [],
      })
      const allPerms = await handle.db.select().from(consoleRolePermissions)
      const existingPerms = new Set(
        allPerms.filter((p: any) => p.consoleRoleId === admin.id).map((p: any) => p.permission),
      )
      const missing = PERMISSIONS.filter((p) => !existingPerms.has(p))
      if (missing.length > 0) {
        await handle.db.insert(consoleRolePermissions).values(
          missing.map((permission) => ({ consoleRoleId: admin.id, permission })),
        )
      }
    }

    // Controlled mock server simulating resource query UI
    server = createServer((req, res) => {
      if (req.url?.startsWith('/login') && req.method === 'POST') {
        req.resume()
        res.writeHead(302, { Location: '/orders', 'Set-Cookie': 'rit=ok; Path=/' })
        res.end()
        return
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(
        req.url?.startsWith('/login')
          ? '<form method="POST" action="/login"><input name="username"><input name="password" type="password"><button type="submit">Login</button></form>'
          : html,
      )
    })

    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res))
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('Failed to bind server port')
    baseUrl = `http://127.0.0.1:${addr.port}`

    await registerWorker(handle.db, {
      workerId,
      instanceId: workerInstanceId,
      capacity: 10,
      maxSessions: 16,
      lostAfterSeconds: 3600,
      roles: ['executor'],
    })

    profileRoot = mkdtempSync(join(tmpdir(), 'cairn-rit01-e2e-'))
    manager = new BrowserSessionManager(
      handle,
      {
        workerId,
        workerInstanceId,
        profileRoot,
        headless: true,
        maxSessions: 16,
        defaultLeaseTtlSeconds: 120,
        defaultAuthWaitSeconds: 60,
        heartbeatMs: 5000,
      },
      secretProvider,
    )

    const module = await Test.createTestingModule({
      controllers: [
        TargetReliabilityController,
        ReliabilityIncidentsController,
        ReliabilityAssetsController,
        ReliabilityUpgradeJobsController,
        RepairController,
        ScenariosController,
        RunsController,
      ],
      providers: [
        ReliabilityService,
        RepairService,
        ScenariosService,
        RunsService,
        { provide: DB_HANDLE, useValue: handle },
        { provide: ObserveService, useValue: {} },
        { provide: BrowserService, useValue: {} },
        {
          provide: APP_GUARD,
          useValue: {
            canActivate(context: ExecutionContext) {
              context.switchToHttp().getRequest().account = {
                ...actor(),
                displayName: 'RIT01 E2E',
                status: 'active',
                roles: [],
                permissions: [...PERMISSIONS],
              }
              return true
            },
          },
        },
        {
          provide: APP_GUARD,
          useFactory: (reflector: Reflector) => new PermissionsGuard(reflector),
          inject: [Reflector],
        },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    }).compile()

    app = module.createNestApplication()
    await listenForSupertest(app)

    // Seed target and target account
    targetId = newId()
    accountId = newId()
    await handle.db.insert(targets).values({
      id: targetId,
      code: `rit-${targetId}`,
      name: 'RIT Controlled Target',
      entryUrl: baseUrl,
      loginUrl: `${baseUrl}/login`,
      authMethod: 'password',
      captchaMode: 'none',
      loginFields: {
        username: { by: 'name', value: 'username' },
        password: { by: 'name', value: 'password' },
        submit: { by: 'css', value: 'button[type=submit]' },
      },
    })
    const secretId = newId()
    await handle.db.insert(secrets).values({
      id: secretId,
      provider: 'local',
      ciphertext: secretProvider.encrypt(secretId, 'rit-fixture'),
    })
    await handle.db.insert(targetAccounts).values({
      id: accountId,
      targetId,
      secretId,
      secretProvider: 'local',
      displayName: 'RIT Fixture Account',
      username: 'rit-tester',
      status: 'active',
    })

    const { credentials, credentialVersions, credentialBindings } = schemaFor(handle.db)
    const credId = newId()
    const versionId = newId()
    await handle.db.insert(credentials).values({
      id: credId,
      type: 'target_password',
      source: 'target_account',
      name: 'RIT Credential',
      managementStatus: 'active',
      currentVersionId: versionId,
    })
    await handle.db.insert(credentialVersions).values({
      id: versionId,
      credentialId: credId,
      secretProvider: 'local',
      secretId,
      materialStatus: 'current',
      identityUsername: 'rit-tester',
      registeredAt: new Date(),
    })
    await handle.db.insert(credentialBindings).values({
      id: newId(),
      credentialId: credId,
      kind: 'target_account',
      targetId,
      targetAccountId: accountId,
      identityUsername: 'rit-tester',
      identityConfirmStatus: 'confirmed',
    })

    manager.resolveCredential = async () => ({
      username: 'rit-tester',
      password: 'rit-fixture',
      secretId,
    })

    // Setup 3-step Scenario:
    // 1. Navigate to /resource
    // 2. Extract button text from .query-btn-v1 (READ_ONLY)
    // 3. Assert #resource-status is ACTIVE (READ_ONLY)
    step1Id = newId()
    step2Id = newId()
    step3Id = newId()

    const step1: Step = {
      id: step1Id,
      name: '导航到资源页面',
      type: 'navigate',
      effectType: 'IDEMPOTENT',
      input: { url: `${baseUrl}/resource` },
    }
    const step2: Step = {
      id: step2Id,
      name: '读取查询按钮文本',
      type: 'extract',
      effectType: 'READ_ONLY',
      policy: { timeoutMs: 3000 },
      outputKey: 'queryBtnText',
      input: {
        target: { framePath: [], candidates: [{ by: 'css', value: '.query-btn-v1' }] },
        as: 'text',
      },
    }
    const step3: Step = {
      id: step3Id,
      name: '验证资源状态就绪',
      type: 'assert',
      effectType: 'READ_ONLY',
      policy: { timeoutMs: 3000 },
      input: {
        target: { framePath: [], candidates: [{ by: 'css', value: '#resource-status' }] },
        expect: { kind: 'text_equals', value: 'ACTIVE' },
      },
    }

    scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `RIT01-Scenario-${newId()}`,
      actor: { id: actorId },
      steps: [step1, step2, step3],
    })
  })

  afterAll(async () => {
    await app?.close()
    await manager?.shutdown()
    await handle?.close()
    if (server) await new Promise<void>((res) => server.close(() => res()))
    if (profileRoot) rmSync(profileRoot, { recursive: true, force: true })
  })

  async function executeRun(runId: string) {
    const grant = await claimRun(handle, { workerId, instanceId: workerInstanceId, leaseTtlSeconds: 120 })
    expect(grant?.runId).toBe(runId)
    const port = createBrowserPort(manager)
    const engine = new ExecutionEngine(handle, port, secretProvider)
    await engine.execute(runId, { grant: grant! })
    const detail = await getRun(handle.db, runId)
    return detail
  }

  it('RIT01-A 基线: v1 DOM 运行成功且产出不可变基线 Outcome', async () => {
    html = `
      <div id="app">
        <button class="query-btn-v1">查询资源</button>
        <span id="resource-status">ACTIVE</span>
      </div>
    `
    const res = await request(app.getHttpServer())
      .post('/runs')
      .send({ scenarioId: scenario.id, targetAccountId: accountId })
      .expect(201)

    baselineRunId = res.body.id
    const detail = await executeRun(baselineRunId)
    expect(detail.status).toBe('SUCCEEDED')
    expect(detail.context.queryBtnText).toBe('查询资源')

    // Confirm durable evidence exists
    const evidence = await listRunEvidence(handle.db, baselineRunId)
    expect(evidence.items.length).toBeGreaterThan(0)
  })

  it('RIT01-B 变化: v2 DOM 改变定位表达导致步骤退化失败', async () => {
    // Inject DOM change: .query-btn-v1 is renamed to .query-btn-v2-renamed
    html = `
      <div id="app">
        <button class="query-btn-v2-renamed">查询资源</button>
        <span id="resource-status">ACTIVE</span>
      </div>
    `
    const res = await request(app.getHttpServer())
      .post('/runs')
      .send({ scenarioId: scenario.id, targetAccountId: accountId })
      .expect(201)

    failedRunId = res.body.id
    const detail = await executeRun(failedRunId)
    expect(detail.status).toBe('FAILED')

    // Failed step is step2 (extract button text)
    const failedStepRun = detail.stepRuns.find((s) => s.stepId === step2Id)
    expect(failedStepRun).toBeDefined()
    expect(failedStepRun?.attempts.length).toBeGreaterThanOrEqual(1)
    failedAttemptId = failedStepRun!.attempts[0]!.id
    expect(failedAttemptId).toBeTruthy()
  })

  it('RIT01-C 归并: 信号归入同一 Incident 且重复投递不增计', async () => {
    const claim = await claimReliabilityEvaluation(handle, { workerId, targetId })
    expect(claim).toBeTruthy()

    // Ingest signal and create Incident
    await writeReliabilityEvaluation(handle, {
      targetId,
      fencingToken: claim!.fencingToken,
      scopeDigest: 'scope_rit01_resource_query',
      watermarkVector: { runCompletedSeq: 1, mapCommittedSeq: 0, validationSeq: 0 },
      rulesEvaluated: 1,
      breachesCount: 1,
      result: { status: 'degradation_detected' },
      sparseSignals: [
        {
          kind: 'resolution_fallback',
          severity: 'WARN',
          subjectRef: { type: 'scenario', id: scenario.id },
          sourceRef: { type: 'run', id: failedRunId },
          occurredAt: new Date().toISOString(),
          value: 1,
          scopeDigest: 'scope_rit01_resource_query',
          groupingKey: 'locator_degradation_query_btn',
        },
      ],
      incidents: [
        {
          id: newId(),
          groupingKey: 'locator_degradation_query_btn',
          scopeDigest: 'scope_rit01_resource_query',
          severity: 'HIGH',
          status: 'ACTION_REQUIRED',
          actionRequiredReason: 'awaiting_triage',
          title: '资源查询按钮定位失效',
          summary: '定位器 .query-btn-v1 无法匹配，建议生成场景修复补丁',
          evidenceScores: { locatorScore: 0.1, businessScore: 1.0, overallScore: 0.55 },
          firstSeenAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
          members: [{ memberRef: `run:${failedRunId}:attempt:0`, memberType: 'run_attempt' }],
        },
      ],
    })

    const listRes = await request(app.getHttpServer())
      .get(`/reliability/incidents?targetId=${targetId}`)
      .expect(200)

    expect(listRes.body.items.length).toBe(1)
    incidentId = listRes.body.items[0].id
    expect(listRes.body.items[0].status).toBe('ACTION_REQUIRED')
    expect(listRes.body.items[0].memberCount).toBe(1)

    // Ingest duplicate signal: should update lastSeen without creating duplicate incident
    const claim2 = await claimReliabilityEvaluation(handle, { workerId, targetId })
    expect(claim2).toBeTruthy()

    await writeReliabilityEvaluation(handle, {
      targetId,
      fencingToken: claim2!.fencingToken,
      scopeDigest: 'scope_rit01_resource_query',
      watermarkVector: { runCompletedSeq: 2, mapCommittedSeq: 0, validationSeq: 0 },
      rulesEvaluated: 1,
      breachesCount: 1,
      result: { status: 'duplicate_degradation_received' },
      incidents: [
        {
          groupingKey: 'locator_degradation_query_btn',
          scopeDigest: 'scope_rit01_resource_query',
          severity: 'HIGH',
          status: 'ACTION_REQUIRED',
          title: '资源查询按钮定位失效',
          summary: '定位器 .query-btn-v1 无法匹配，建议生成场景修复补丁',
          evidenceScores: { locatorScore: 0.1, businessScore: 1.0, overallScore: 0.55 },
          firstSeenAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
        },
      ],
    })

    const listRes2 = await request(app.getHttpServer())
      .get(`/reliability/incidents?targetId=${targetId}`)
      .expect(200)

    // Deduplication check: remains 1 incident
    expect(listRes2.body.items.length).toBe(1)
    expect(listRes2.body.items[0].id).toBe(incidentId)
  })

  it('RIT01-D 影响: 沿调用与版本计算受影响资产及历史运行 (Dual-Layer BFS)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/reliability/incidents/${incidentId}/impact`)
      .expect(200)

    const impact = res.body

    // 1. Historical impacted runs layer
    expect(impact.impactedRuns.length).toBeGreaterThanOrEqual(1)
    const impactedRun = impact.impactedRuns.find((r: any) => r.runId === failedRunId)
    expect(impactedRun).toBeDefined()
    expect(impactedRun.executionStatus).toBe('FAILED')

    // 2. Downstream assets layer: scenario is listed with legacy_missing_manifest coverage gap
    expect(impact.affectedAssets.length).toBeGreaterThanOrEqual(1)
    const affectedScenario = impact.affectedAssets.find((a: any) => a.assetId === scenario.id)
    expect(affectedScenario).toBeDefined()
    expect(affectedScenario.assetKind).toBe('scenario')
    expect(affectedScenario.relation).toBe('coverage_gap')
    expect(affectedScenario.gapReason).toBe('legacy_missing_manifest')
  })

  it('RIT01-E 候选: 生成场景步骤补丁且实体解耦 (无 incident_id 外键)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/runs/${failedRunId}/repair-candidates`)
      .send({
        stepId: step2Id,
        sourceAttemptId: failedAttemptId,
        hypothesis: '前端重命名查询按钮样式类为 .query-btn-v2-renamed',
        patch: {
          kind: 'REPLACE_LOCATOR',
          suggestedCandidate: {
            by: 'css',
            value: '.query-btn-v2-renamed',
          },
        },
      })
      .expect(201)

    candidateId = res.body.id
    expect(res.body.status).toBe('proposed')
    expect(res.body.patchTargetRef.kind).toBe('scenario')
    expect(res.body.patchTargetRef.stepId).toBe(step2Id)
    expect(res.body.guardResults.overallPassed).toBe(true)

    // Data model check: repair_candidates table has NO incident_id column
    const { repairCandidates } = schemaFor(handle.db)
    const tableColumns = Object.keys(repairCandidates)
    expect(tableColumns).not.toContain('incidentId')
    expect(tableColumns).not.toContain('incident_id')

    const candInDb = await getRepairCandidate(handle, candidateId)
    expect(candInDb).toBeDefined()
    expect((candInDb as any).incident_id).toBeUndefined()
  })

  it('RIT01-F 验证: READ_ONLY 候选核验且原 MUST Outcome 完好', async () => {
    const res = await request(app.getHttpServer())
      .post(`/repair-candidates/${candidateId}/validate`)
      .send({
        validationRunId: newId(),
        validationScope: {
          locatorValid: true,
          stepPassed: true,
          outcomePassed: true,
          crossSampleStable: true,
        },
      })
      .expect(200)

    expect(res.body.status).toBe('validated')
    expect(res.body.validationScope.outcomePassed).toBe(true)
    expect(res.body.validationScope.stepPassed).toBe(true)
  })

  it('RIT01-G 采纳: 采纳补丁至场景草稿并产出 AdoptionReceipt', async () => {
    const res = await request(app.getHttpServer())
      .post(`/repair-candidates/${candidateId}/adopt`)
      .send({ expectedRevision: 1 })
      .expect(200)

    expect(res.body.candidate.status).toBe('adopted')
    expect(res.body.candidate.adoption).toBeDefined()
    expect(res.body.candidate.adoption.resultingRevision).toBe(2)
    expect(res.body.candidate.adoption.targetId).toBe(scenario.id)
    expect(res.body.candidate.adoption.receiptId).toBeDefined()
    expect(res.body.draftRevision).toBe(2)

    // Verify draft was patched in DB
    const scenarioDetail = await getScenario(handle, scenario.id)
    expect(scenarioDetail.draft?.revision).toBe(2)
    const patchedStep = (scenarioDetail.draft?.document as any).steps.find((s: any) => s.id === step2Id)
    expect(patchedStep.input.target.candidates[0].value).toBe('.query-btn-v2-renamed')
  })

  it('RIT01-H 升级: 发布新版本并触发回归 Run 成功，原失败保持不可变', async () => {
    // 1. Publish scenario draft (revision: 2)
    await request(app.getHttpServer())
      .post(`/scenarios/${scenario.id}/publish`)
      .send({ revision: 2 })
      .expect(200)

    // 2. Trigger regression run on v2 DOM
    const res = await request(app.getHttpServer())
      .post('/runs')
      .send({ scenarioId: scenario.id, targetAccountId: accountId })
      .expect(201)

    const regressionRunId = res.body.id
    const detail = await executeRun(regressionRunId)
    expect(detail.status).toBe('SUCCEEDED')
    expect(detail.context.queryBtnText).toBe('查询资源')

    // 3. Immutability check: historical failed run remains FAILED
    const historicalRun = await getRun(handle.db, failedRunId)
    expect(historicalRun.status).toBe('FAILED')
  })

  it('RIT01-I 观察与归档: 状态流转至 OBSERVING 并经审计合规 RESOLVED', async () => {
    // 1. Move incident to OBSERVING
    await updateIncidentStatus(handle, {
      incidentId,
      status: 'OBSERVING',
    })

    const observingRes = await request(app.getHttpServer())
      .get(`/reliability/incidents/${incidentId}`)
      .expect(200)
    expect(observingRes.body.incident.status).toBe('OBSERVING')

    // 2. Operator triages and resolves incident via API
    const resolutionReason = 'RIT01 场景自愈回归测试通过，零退化，符合准出条件'
    const resolveRes = await request(app.getHttpServer())
      .post(`/reliability/incidents/${incidentId}/resolve`)
      .send({ reason: resolutionReason })
      .expect(200)

    expect(resolveRes.body.status).toBe('RESOLVED')
    expect(resolveRes.body.dismissedReason).toBe(resolutionReason)

    // 3. Confirm durable persistence
    const { incident } = await getIncidentDetail(handle, incidentId)
    expect(incident.status).toBe('RESOLVED')
    expect(incident.dismissedReason).toBe(resolutionReason)
  })
})
