/**
 * Real HTTP → Database → Worker Engine → Managed Chromium → Durable Result / Settlement.
 * End-to-End Simulation Test for Action Module Trusted Reuse and Regression Loop (AMR-01 ~ AMR-10).
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
  registerWorker,
  claimRun,
  getRun,
  computeSampleReview,
  type DbHandle,
} from '@cairn/db/testing'
import { schemaFor } from '../../packages/db/src/native.js'
import { credentialKeyFromEnv, LocalSecretProvider } from '@cairn/secret'
import {
  DEV_CREDENTIAL_KEY,
  PERMISSIONS,
  MAX_SCENARIO_STEPS,
  MAX_COMPILED_SCENARIO_STEPS,
  MAX_TEST_BATCH_CASES,
  type Step,
  type ModuleContent,
  type ScenarioAuthoringDocumentV2,
} from '@cairn/shared'
import type { BrowserSessionManager as SessionManager } from '../../packages/worker/dist/browser/session-manager.js'
import { DB_HANDLE } from '../../packages/api/src/db/db.module.js'
import { ActionModulesController } from '../../packages/api/src/action-modules/action-modules.controller.js'
import { ActionModulesService } from '../../packages/api/src/action-modules/action-modules.service.js'
import { ScenariosController } from '../../packages/api/src/scenarios/scenarios.controller.js'
import { ScenariosService } from '../../packages/api/src/scenarios/scenarios.service.js'
import { RunsController } from '../../packages/api/src/runs/runs.controller.js'
import { RunsService } from '../../packages/api/src/runs/runs.service.js'
import { ObserveService } from '../../packages/api/src/runs/observe.service.js'
import { BrowserService } from '../../packages/api/src/runs/browser.service.js'
import { PermissionsGuard } from '../../packages/api/src/rbac/permissions.guard.js'
import { AllExceptionsFilter } from '../../packages/api/src/common/all-exceptions.filter.js'
import { listenForSupertest } from '../../packages/api/src/__tests__/http-app.js'

describe('Action Modules Trusted Reuse & Regression End-to-End Simulation (AMR-01 ~ AMR-10)', { timeout: 60_000 }, () => {
  let handle: DbHandle
  let app: INestApplication
  let manager: SessionManager
  let BrowserSessionManager: typeof import('../../packages/worker/dist/browser/session-manager.js').BrowserSessionManager
  let createBrowserPort: typeof import('../../packages/worker/dist/browser/port.js').createBrowserPort
  let ExecutionEngine: typeof import('../../packages/worker/dist/engine/engine.js').ExecutionEngine
  let server: ReturnType<typeof createServer>
  let baseUrl = ''
  let profileRoot = ''
  let actorId: string
  let targetId: string
  let accountId: string
  let secretId: string
  const workerId = `amr-e2e-${newId()}`
  const workerInstanceId = newId()
  const secretProvider = new LocalSecretProvider(credentialKeyFromEnv(DEV_CREDENTIAL_KEY))

  // State across tests
  let moduleId: string
  let case1Id: string
  let case2Id: string
  let publishedVersionId: string
  let scenario1Id: string
  let scenario2Id: string

  function actor() {
    return { kind: 'console' as const, id: actorId }
  }

  beforeAll(async () => {
    const workerSource = resolve(import.meta.dirname, '../../packages/worker/src')
    ;({ BrowserSessionManager } = await import(`${workerSource}/browser/session-manager.ts`))
    ;({ createBrowserPort } = await import(`${workerSource}/browser/port.ts`))
    ;({ ExecutionEngine } = await import(`${workerSource}/engine/engine.ts`))

    handle = await openIsolatedDb(`amr_e2e_${Date.now().toString(36)}`)
    actorId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'AMR E2E Admin',
      email: `${actorId}@example.com`,
      status: 'active',
    })

    const { consoleRoles, consoleAccountRoles } = schemaFor(handle.db)
    const roles = await handle.db.select().from(consoleRoles)
    const admin = roles.find((r: any) => r.key === 'admin')
    if (admin) {
      await handle.db.insert(consoleAccountRoles).values({
        consoleAccountId: actorId,
        consoleRoleId: admin.id,
        targetScopeMode: 'all',
        targetScopeIds: [],
      })
    }

    // Local controlled HTTP server simulating an order management target application
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/login' && req.method === 'POST') {
        req.resume()
        res.writeHead(302, { Location: '/orders', 'Set-Cookie': 'amr_auth=ok; Path=/' })
        res.end()
        return
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      if (url.pathname === '/login') {
        res.end('<form method="POST" action="/login"><input name="username"><input name="password" type="password"><button type="submit">Login</button></form>')
        return
      }
      if (url.pathname === '/orders') {
        const orderId = url.searchParams.get('id') || 'ORD-9999'
        let status = 'SHIPPED'
        if (orderId === 'ORD-8888') status = 'PENDING'
        if (orderId === 'ORD-2002') status = 'RETURNED'
        res.end(`
          <!doctype html>
          <html>
            <head><meta charset="utf-8"><title>订单中心</title></head>
            <body>
              <div id="order-container">
                <h1>订单信息</h1>
                <div id="order-id">${orderId}</div>
                <div id="order-status" data-testid="order-status">${status}</div>
              </div>
            </body>
          </html>
        `)
        return
      }
      res.end('<h1>AMR Target Lab</h1>')
    })

    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res))
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('Failed to bind target server port')
    baseUrl = `http://127.0.0.1:${addr.port}`

    // Register Worker with all required protocols
    await registerWorker(handle.db, {
      workerId,
      instanceId: workerInstanceId,
      capacity: 10,
      maxSessions: 16,
      lostAfterSeconds: 3600,
      roles: ['executor'],
    })

    profileRoot = mkdtempSync(join(tmpdir(), 'cairn-amr-e2e-'))
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

    // Assemble real NestJS testing application with HTTP controllers
    const moduleRef = await Test.createTestingModule({
      controllers: [
        ActionModulesController,
        ScenariosController,
        RunsController,
      ],
      providers: [
        ActionModulesService,
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
                displayName: 'AMR E2E Admin',
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

    app = moduleRef.createNestApplication()
    await listenForSupertest(app)

    // Seed Target and TargetAccount
    targetId = newId()
    accountId = newId()
    secretId = newId()

    await handle.db.insert(targets).values({
      id: targetId,
      code: `amr-target-${targetId.slice(0, 8)}`,
      name: 'AMR 订单中心靶场',
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

    await handle.db.insert(secrets).values({
      id: secretId,
      provider: 'local',
      ciphertext: secretProvider.encrypt(secretId, 'amr-secret-pass'),
    })

    await handle.db.insert(targetAccounts).values({
      id: accountId,
      targetId,
      secretId,
      secretProvider: 'local',
      displayName: 'AMR Operator',
      username: 'amr-admin',
      status: 'active',
    })

    const { credentials, credentialVersions, credentialBindings } = schemaFor(handle.db)
    const credId = newId()
    const credVerId = newId()
    await handle.db.insert(credentials).values({
      id: credId,
      type: 'target_password',
      source: 'target_account',
      name: 'AMR Credential',
      managementStatus: 'active',
      currentVersionId: credVerId,
    })
    await handle.db.insert(credentialVersions).values({
      id: credVerId,
      credentialId: credId,
      secretProvider: 'local',
      secretId,
      materialStatus: 'current',
      identityUsername: 'amr-admin',
      registeredAt: new Date(),
    })
    await handle.db.insert(credentialBindings).values({
      id: newId(),
      credentialId: credId,
      kind: 'target_account',
      targetId,
      targetAccountId: accountId,
      identityUsername: 'amr-admin',
      identityConfirmStatus: 'confirmed',
    })

    manager.resolveCredential = async () => ({
      username: 'amr-admin',
      password: 'amr-secret-pass',
      secretId,
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

  // -------------------------------------------------------------------------
  // 1. AMR-01 & AMR-02: Action Module Creation with Parameter Contract & Field Bindings
  // -------------------------------------------------------------------------
  it('AMR-01 & AMR-02: 动作模块定义、参数契约与受限字段绑定', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/action-modules')
      .send({
        idempotencyKey: newId(),
        targetId,
        key: 'order.query',
        name: '订单状态查询',
        description: '根据订单号查询并提取订单状态',
      })
    if (createRes.status !== 201) {
      console.log('CREATE RES FAILED:', createRes.status, createRes.body, createRes.text)
    }
    expect(createRes.status).toBe(201)

    moduleId = createRes.body.id
    expect(moduleId).toBeTruthy()

    const step1Id = newId()
    const step2Id = newId()
    const step3Id = newId()

    const content: ModuleContent = {
      contract: {
        inputs: [
          { key: 'orderUrl', label: '订单页面URL', valueType: 'string', required: true },
          { key: 'orderId', label: '订单号', valueType: 'string', required: true },
          { key: 'expectedStatus', label: '预期状态', valueType: 'string', required: true },
        ],
        outputs: [
          { key: 'queryStatus', label: '查询状态', shape: { kind: 'scalar', type: 'string' } },
        ],
        effectCeiling: 'READ_ONLY',
        preconditions: [],
        postconditions: [
          { meaning: '订单状态有效提取', verification: { kind: 'output_required', outputKey: 'queryStatus' } },
        ],
      },
      implementations: [
        {
          implementationKey: 'default',
          kind: 'structured_steps',
          steps: [
            {
              id: step1Id,
              name: '导航到订单页面',
              type: 'navigate',
              effectType: 'READ_ONLY',
              input: { url: 'PLACEHOLDER_URL' },
            },
            {
              id: step2Id,
              name: '断言状态元素',
              type: 'assert',
              effectType: 'READ_ONLY',
              input: {
                target: {
                  framePath: [],
                  candidates: [
                    { by: 'testId', value: 'order-status' },
                    { by: 'css', value: '#order-status' },
                  ],
                  anchor: {
                    withinText: 'PLACEHOLDER_ORDER_ID',
                    scope: 'nearest',
                  },
                },
                expect: { kind: 'text_equals', value: 'PLACEHOLDER_STATUS' },
              },
            },
            {
              id: step3Id,
              name: '提取订单状态',
              type: 'extract',
              effectType: 'READ_ONLY',
              input: {
                target: {
                  framePath: [],
                  candidates: [
                    { by: 'testId', value: 'order-status' },
                    { by: 'css', value: '#order-status' },
                  ],
                },
                as: 'text',
              },
              outputKey: 'extracted_status',
            },
          ],
          fieldBindings: [
            {
              stepId: step1Id,
              field: 'navigate.url',
              inputKey: 'orderUrl',
            },
            {
              stepId: step2Id,
              field: 'target.anchor.withinText',
              inputKey: 'orderId',
            },
            {
              stepId: step2Id,
              field: 'assert.expect.value',
              inputKey: 'expectedStatus',
            },
          ],
          outputMapping: {
            queryStatus: 'extracted_status',
          },
        },
      ],
    }

    const draftRes = await request(app.getHttpServer())
      .post(`/action-modules/${moduleId}/draft`)
      .send({
        baseRevision: 0,
        content,
      })
    if (draftRes.status !== 200) {
      console.log('DRAFT RES FAILED:', draftRes.status, draftRes.body, draftRes.text)
    }
    expect(draftRes.status).toBe(200)

    expect(draftRes.body.draftRevision).toBe(1)
    expect(draftRes.body.draftContent).toBeTruthy()
    expect(draftRes.body.draftContent.implementations[0].fieldBindings).toHaveLength(3)
  })

  // -------------------------------------------------------------------------
  // 2. AMR-04 & AMR-05: Server-Side Test Cases with Sample Review & Snapshot Freeze
  // -------------------------------------------------------------------------
  it('AMR-04 & AMR-05: 服务端用例创建、样本安全审阅与不可变快照', async () => {
    // Case 1: Positive Release Gate test case (Expect SHIPPED -> Matches actual)
    const inputs1 = {
      orderUrl: `${baseUrl}/orders?id=ORD-9999`,
      orderId: 'ORD-9999',
      expectedStatus: 'SHIPPED',
    }
    const expectedOutputs1 = { queryStatus: 'SHIPPED' }
    const review1 = computeSampleReview(inputs1, expectedOutputs1, true, actorId)

    const case1Res = await request(app.getHttpServer())
      .post(`/action-modules/${moduleId}/test-cases`)
      .send({
        name: '用例1-已发货正常订单',
        inputs: inputs1,
        expectedModuleOutcome: 'VERIFIED',
        expectedOutputs: expectedOutputs1,
        implementationKey: 'default',
        releaseGate: true,
        targetAccountId: accountId,
        sampleReview: review1,
      })
    if (case1Res.status !== 201) {
      console.log('CASE 1 RES FAILED:', case1Res.status, case1Res.body, case1Res.text)
    }
    expect(case1Res.status).toBe(201)

    case1Id = case1Res.body.id
    expect(case1Id).toBeTruthy()
    expect(case1Res.body.releaseGate).toBe(true)
    expect(case1Res.body.status).toBe('ACTIVE')

    // Case 2: Mismatched Expectation test case (Expect CANCELLED -> Actual is SHIPPED)
    const inputs2 = {
      orderUrl: `${baseUrl}/orders?id=ORD-9999`,
      orderId: 'ORD-9999',
      expectedStatus: 'SHIPPED',
    }
    const expectedOutputs2 = { queryStatus: 'CANCELLED' }
    const review2 = computeSampleReview(inputs2, expectedOutputs2, true, actorId)

    const case2Res = await request(app.getHttpServer())
      .post(`/action-modules/${moduleId}/test-cases`)
      .send({
        name: '用例2-状态不符预期回归样本',
        inputs: inputs2,
        expectedModuleOutcome: 'VERIFIED',
        expectedOutputs: expectedOutputs2,
        implementationKey: 'default',
        releaseGate: false,
        targetAccountId: accountId,
        sampleReview: review2,
      })
    if (case2Res.status !== 201) {
      throw new Error(`CASE 2 FAILED [${case2Res.status}]: ${JSON.stringify(case2Res.body)}`)
    }
    expect(case2Res.status).toBe(201)

    case2Id = case2Res.body.id
    expect(case2Id).toBeTruthy()
  })

  // -------------------------------------------------------------------------
  // 3. AMR-10: Release Gate Enforcement Before Testing (409 Conflict)
  // -------------------------------------------------------------------------
  it('AMR-10: 未通过发布门禁前阻断发布 (409 MODULE_TEST_CASES_FAILED)', async () => {
    const pubRes = await request(app.getHttpServer())
      .post(`/action-modules/${moduleId}/publish`)
      .send({
        idempotencyKey: newId(),
        expectedRevision: 1,
      })
    if (pubRes.status !== 409) {
      console.log('PUB RES FAILED (Expected 409):', pubRes.status, JSON.stringify(pubRes.body, null, 2))
    }
    expect(pubRes.status).toBe(409)
    expect(pubRes.body.message).toMatch(/发布门禁未通过/)
  })

  // -------------------------------------------------------------------------
  // 4. AMR-04 & AMR-05: Test Case Trial Runs, Worker Execution, and Outcome Settlement
  // -------------------------------------------------------------------------
  it('AMR-04 & AMR-05: 试跑执行与结算器比较 (Case 1 PASS, Case 2 FAIL)', async () => {
    // 4.1 Execute Case 1 (Positive Gate Case)
    const runCase1Res = await request(app.getHttpServer())
      .post(`/action-modules/${moduleId}/test-cases/${case1Id}/run`)
      .send({
        mode: 'draft',
      })
    if (runCase1Res.status !== 201) {
      console.log('RUN CASE 1 FAILED (Expected 201):', runCase1Res.status, runCase1Res.body)
    }
    expect(runCase1Res.status).toBe(201)

    const { runId: runId1, executionId: execId1 } = runCase1Res.body
    expect(runId1).toBeTruthy()
    expect(execId1).toBeTruthy()

    // Worker Engine claims and executes the trial run
    const detail1 = await executeRun(runId1)
    expect(detail1?.status).toBe('SUCCEEDED')

    // Verify Case 1 settlement settled as PASS
    const getCase1Res = await request(app.getHttpServer())
      .get(`/action-modules/${moduleId}/test-cases/${case1Id}`)
      .expect(200)

    if (getCase1Res.body.latestResult?.status !== 'PASS') {
      console.log('CASE 1 LATEST RESULT NOT PASS:', JSON.stringify(getCase1Res.body.latestResult, null, 2))
    }
    expect(getCase1Res.body.latestResult).toBeDefined()
    expect(getCase1Res.body.latestResult.status).toBe('PASS')
    expect(getCase1Res.body.latestResult.outcomeMatched).toBe(true)
    expect(getCase1Res.body.latestResult.outputsMatched).toBe(true)

    // 4.2 Execute Case 2 (Mismatched Expectation Case)
    const runCase2Res = await request(app.getHttpServer())
      .post(`/action-modules/${moduleId}/test-cases/${case2Id}/run`)
      .send({
        mode: 'draft',
      })
      .expect(201)

    const { runId: runId2 } = runCase2Res.body
    const detail2 = await executeRun(runId2)
    expect(detail2?.status).toBe('SUCCEEDED')

    // Verify Case 2 settlement settled as FAIL with detailed mismatches
    const getCase2Res = await request(app.getHttpServer())
      .get(`/action-modules/${moduleId}/test-cases/${case2Id}`)
      .expect(200)

    expect(getCase2Res.body.latestResult).toBeDefined()
    expect(getCase2Res.body.latestResult.status).toBe('FAIL')
    expect(getCase2Res.body.latestResult.outputsMatched).toBe(false)
    expect(getCase2Res.body.latestResult.failureReason).toContain('输出不匹配：queryStatus')
    expect(getCase2Res.body.latestResult.details?.mismatches).toEqual({
      queryStatus: {
        expected: 'CANCELLED',
        actual: 'SHIPPED',
      },
    })
  })

  // -------------------------------------------------------------------------
  // 5. AMR-10: Successful Module Publication After Release Gate Satisfaction
  // -------------------------------------------------------------------------
  it('AMR-10: 满足发布门禁后成功发布正式版本 (v1)', async () => {
    const pubRes = await request(app.getHttpServer())
      .post(`/action-modules/${moduleId}/publish`)
      .send({
        idempotencyKey: newId(),
        expectedRevision: 1,
      })
      .expect(200)

    expect(pubRes.body.latestVersionNo).toBe(1)

    // Verify version list returns published version
    const versRes = await request(app.getHttpServer())
      .get(`/action-modules/${moduleId}/versions`)
      .expect(200)

    expect(versRes.body.items).toHaveLength(1)
    expect(versRes.body.items[0].versionNo).toBe(1)
    expect(versRes.body.items[0].publicationStatus).toBe('published')
    publishedVersionId = versRes.body.items[0].id
    expect(publishedVersionId).toBeTruthy()
  })

  // -------------------------------------------------------------------------
  // 6. AMR-01 & AMR-03: Scenario Multi-Reuse with Parameter Contracts & Split Step Budget
  // -------------------------------------------------------------------------
  it('AMR-01 & AMR-03: 多场景跨业务对象复用、参数契约展开与拆分步骤预算验证', async () => {
    const dummyStep: Step = {
      id: newId(),
      name: '初始步骤',
      type: 'echo',
      effectType: 'READ_ONLY',
      input: { value: 'initial' },
    }

    // 6.1 Create Scenario 1: Order Delivery Tracking (Query ORD-1001)
    const scen1Res = await request(app.getHttpServer())
      .post('/scenarios')
      .send({
        targetId,
        name: '业务场景1-订单发货履约追踪',
        steps: [dummyStep],
      })
      .expect(201)

    scenario1Id = scen1Res.body.id
    expect(scenario1Id).toBeTruthy()

    const authoringDoc1: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        {
          kind: 'module',
          invocationId: newId(),
          name: '调用订单状态查询',
          moduleId,
          moduleVersionId: publishedVersionId,
          implementationKey: 'default',
          inputBindings: {
            orderUrl: { kind: 'literal', value: `${baseUrl}/orders?id=ORD-1001` },
            orderId: { kind: 'literal', value: 'ORD-1001' },
            expectedStatus: { kind: 'literal', value: 'SHIPPED' },
          },
          outputBindings: {
            queryStatus: 's1_order_status',
          },
        },
        {
          kind: 'step',
          step: {
            id: newId(),
            name: '消费查询结果',
            type: 'echo',
            effectType: 'READ_ONLY',
            input: { from: 's1_order_status' },
            outputKey: 's1_final_echo',
          },
        },
      ],
    }

    const draftRes1 = await request(app.getHttpServer())
      .post(`/scenarios/${scenario1Id}/draft`)
      .send({
        revision: 1,
        document: authoringDoc1,
      })
    if (draftRes1.status !== 200) {
      console.log('SCENARIO 1 DRAFT FAILED:', draftRes1.status, draftRes1.body)
    }
    expect(draftRes1.status).toBe(200)

    const pubScen1Res = await request(app.getHttpServer())
      .post(`/scenarios/${scenario1Id}/publish`)
      .send({
        revision: 2,
      })
    if (pubScen1Res.status !== 200) {
      console.log('SCENARIO 1 PUBLISH FAILED:', pubScen1Res.status, pubScen1Res.body)
    }
    expect(pubScen1Res.status).toBe(200)

    // Verify split step budget: authored <= 32, system verification <= 32, total compiled <= 64
    const scen1Versions = await handle.db.select().from(schemaFor(handle.db).scenarioVersions)
    const scen1Ver = scen1Versions.find((v) => v.id === pubScen1Res.body.latestVersionId)
    expect(scen1Ver).toBeDefined()
    const compiledSteps1 = (scen1Ver?.definition as any).steps as Step[]
    expect(compiledSteps1.length).toBeLessThanOrEqual(MAX_COMPILED_SCENARIO_STEPS)
    expect(authoringDoc1.nodes.length).toBeLessThanOrEqual(MAX_SCENARIO_STEPS)
    // Verify synthesized verify_context step exists in compiled definition
    const verifyStep1 = compiledSteps1.find((s) => s.type === 'verify_context')
    expect(verifyStep1).toBeDefined()

    // 6.2 Create Scenario 2: Order Return Tracking (Query ORD-2002)
    const scen2Res = await request(app.getHttpServer())
      .post('/scenarios')
      .send({
        targetId,
        name: '业务场景2-订单退货核实流程',
        steps: [dummyStep],
      })
      .expect(201)

    scenario2Id = scen2Res.body.id
    expect(scenario2Id).toBeTruthy()

    const authoringDoc2: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        {
          kind: 'module',
          invocationId: newId(),
          name: '调用订单状态查询',
          moduleId,
          moduleVersionId: publishedVersionId,
          implementationKey: 'default',
          inputBindings: {
            orderUrl: { kind: 'literal', value: `${baseUrl}/orders?id=ORD-2002` },
            orderId: { kind: 'literal', value: 'ORD-2002' },
            expectedStatus: { kind: 'literal', value: 'RETURNED' },
          },
          outputBindings: {
            queryStatus: 's2_order_status',
          },
        },
        {
          kind: 'step',
          step: {
            id: newId(),
            name: '消费查询结果',
            type: 'echo',
            effectType: 'READ_ONLY',
            input: { from: 's2_order_status' },
            outputKey: 's2_final_echo',
          },
        },
      ],
    }

    const draftRes2 = await request(app.getHttpServer())
      .post(`/scenarios/${scenario2Id}/draft`)
      .send({
        revision: 1,
        document: authoringDoc2,
      })
    if (draftRes2.status !== 200) {
      console.log('SCENARIO 2 DRAFT FAILED:', draftRes2.status, draftRes2.body)
    }
    expect(draftRes2.status).toBe(200)

    const pubScen2Res = await request(app.getHttpServer())
      .post(`/scenarios/${scenario2Id}/publish`)
      .send({
        revision: 2,
      })
    if (pubScen2Res.status !== 200) {
      console.log('SCENARIO 2 PUBLISH FAILED:', pubScen2Res.status, pubScen2Res.body)
    }
    expect(pubScen2Res.status).toBe(200)

    // 6.3 Execute Scenario 1 and verify context contains exposed output
    const run1Res = await request(app.getHttpServer())
      .post('/runs')
      .send({
        scenarioId: scenario1Id,
        targetAccountId: accountId,
      })
      .expect(201)

    const scenRun1 = await executeRun(run1Res.body.id)
    expect(scenRun1?.status).toBe('SUCCEEDED')
    expect(scenRun1?.context).toHaveProperty('s1_order_status', 'SHIPPED')
    expect(scenRun1?.context).toHaveProperty('s1_final_echo', 'SHIPPED')

    // 6.4 Execute Scenario 2 and verify context contains exposed output
    const run2Res = await request(app.getHttpServer())
      .post('/runs')
      .send({
        scenarioId: scenario2Id,
        targetAccountId: accountId,
      })
      .expect(201)

    const scenRun2 = await executeRun(run2Res.body.id)
    expect(scenRun2?.status).toBe('SUCCEEDED')
    expect(scenRun2?.context).toHaveProperty('s2_order_status', 'RETURNED')
    expect(scenRun2?.context).toHaveProperty('s2_final_echo', 'RETURNED')
  })

  // -------------------------------------------------------------------------
  // 7. AMR-08: References Pagination & Deletion Protection (MODULE_IN_USE)
  // -------------------------------------------------------------------------
  it('AMR-08: 引用列表服务端分页与防误删保护 (MODULE_IN_USE)', async () => {
    // 7.1 Query module references
    const refRes = await request(app.getHttpServer())
      .get(`/action-modules/${moduleId}/references?page=1&pageSize=10`)
      .expect(200)

    expect(refRes.body.total).toBe(3)
    expect(refRes.body.items).toHaveLength(3)
    const refScenarioIds = refRes.body.items.map((i: any) => i.scenarioId)
    expect(refScenarioIds).toContain(scenario1Id)
    expect(refScenarioIds).toContain(scenario2Id)
    const verRef = refRes.body.items.find((i: any) => i.purpose === 'module_verification')
    expect(verRef).toBeDefined()

    // 7.2 Attempt protected delete -> Must fail with 409 Conflict
    const delRes = await request(app.getHttpServer())
      .post(`/action-modules/${moduleId}/delete`)
      .expect(409)

    expect(delRes.body.code).toBe('MODULE_REFERENCED')
    expect(delRes.body.message).toMatch(/仍被用户场景引用/)
    expect(delRes.body.details?.references).toHaveLength(2)

    // Verify module remains intact
    const modRes = await request(app.getHttpServer())
      .get(`/action-modules/${moduleId}`)
      .expect(200)

    expect(modRes.body.id).toBe(moduleId)
    expect(modRes.body.deletedAt).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // 8. AMR-06: Batch Regression Aggregation & 20-Case Cap Enforcement
  // -------------------------------------------------------------------------
  it('AMR-06: 批量回归测试聚合与 20 例上限保护', async () => {
    // 8.1 Exceeding MAX_TEST_BATCH_CASES (20) must be rejected
    const tooManyCases = Array.from({ length: MAX_TEST_BATCH_CASES + 1 }, () => newId())
    await request(app.getHttpServer())
      .post(`/action-modules/${moduleId}/test-batches`)
      .send({
        caseIds: tooManyCases,
        targetAccountId: accountId,
        confirmedEnv: true,
      })
      .expect(400)

    // 8.2 Create legitimate batch with Case 1 & Case 2
    const batchRes = await request(app.getHttpServer())
      .post(`/action-modules/${moduleId}/test-batches`)
      .send({
        caseIds: [case1Id, case2Id],
        targetAccountId: accountId,
        confirmedEnv: true,
      })
      .expect(201)

    const batchId = batchRes.body.id
    expect(batchId).toBeTruthy()
    expect(batchRes.body.totalCases).toBe(2)
    expect(batchRes.body.status).toBe('RUNNING')

    // 8.3 Get Batch detail
    const getBatchRes = await request(app.getHttpServer())
      .get(`/action-modules/${moduleId}/test-batches/${batchId}`)
      .expect(200)

    expect(getBatchRes.body.id).toBe(batchId)
    expect(getBatchRes.body.totalCases).toBe(2)
    expect(getBatchRes.body.executions).toHaveLength(2)
  })
})
