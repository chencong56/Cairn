/**
 * 演示档（DEMO）：浏览器文件上传/下载与 Target 夹具的完整业务闭环演示。
 * 「下载模版 → 填表 → 夹具上传（隐藏框触发）→ 上下文模版回传 → 提交生成单号」
 * 验证的是整条能力链是否走得通，属验收演示而非回归守卫——按 2026-09-29 浏览器段
 * 治理方案的「守卫 vs 演示」分类，默认套件不跑，通过 `pnpm --filter @cairn/worker
 * test:demo` 按需触发；改动上传/下载/夹具链路时由 verify:changed 的 L3 提示补跑。
 * 边界守卫（摘要篡改拦截、跨 Run 句柄伪造、无文件框报错）仍在
 * file-submission.lab.spec.ts 随默认套件执行。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  claimRun,
  commitTargetFixtureUpload,
  consoleAccounts,
  createRunWithSnapshot,
  createScenarioWithVersion,
  getRun,
  grantAdminScope,
  listRunEvidence,
  newId,
  openIsolatedDb,
  registerWorker,
  reserveTargetFixtureUpload,
  secrets,
  targetAccounts,
  targets,
  type DbHandle,
} from '@cairn/db/testing'
import { ensureTargetAccountCredential } from '@cairn/db'
import {
  DEV_CREDENTIAL_KEY,
  LOCAL_SECRET_PROVIDER,
  RUN_FILE_HANDLE_KIND,
  type RunFileHandle,
  type Step,
} from '@cairn/shared'
import { credentialKeyFromEnv, LocalSecretProvider } from '@cairn/secret'
import { createBrowserPort } from './port.js'
import { BrowserSessionManager } from './session-manager.js'
import { LocalObjectStore } from '@cairn/storage'
import { ObjectService } from '../objects/object.service.js'
import { ExecutionEngine } from '../engine/engine.js'
import { runFileWorkspaceDir } from '../engine/run-file-workspace.js'

type LabServerHandle = {
  port: number
  url: string
  close: () => Promise<void>
}

const SCHEMA = `cairn_test_${Date.now().toString(36)}_fsdemo`

describe('浏览器文件上传/下载与Target夹具全链路业务系统演示（DEMO 按需档）', { timeout: 180_000 }, () => {
  let lab: LabServerHandle
  let handle: DbHandle
  let manager: BrowserSessionManager
  let objects: ObjectService
  let objectDir: string
  let targetId: string
  let accountId: string
  let secretId: string
  let actorId: string
  let workerId: string
  let workerInstanceId: string
  let fixtureId: string
  let fixtureDigest: string
  let fixtureByteSize: number
  const secretsProvider = new LocalSecretProvider(credentialKeyFromEnv(DEV_CREDENTIAL_KEY))

  beforeAll(async () => {
    // 1. 启动受控靶场服务
    const labServerPath = resolve(__dirname, '../../../../tests/target-surface-lab/server.mjs')
    const labModule = (await import(pathToFileURL(labServerPath).href)) as {
      startLabServer: (port?: number) => Promise<LabServerHandle>
    }
    lab = await labModule.startLabServer(0)

    // 2. 初始化独立数据库
    handle = await openIsolatedDb(SCHEMA)
    actorId = newId()
    targetId = newId()
    accountId = newId()
    secretId = newId()

    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'file-submission-demo',
      email: `demo-${actorId.slice(0, 8)}@example.com`,
      status: 'active',
    })
    await grantAdminScope(handle.db, actorId)

    // 3. 接入当前业务提报目标系统
    await handle.db.insert(targets).values({
      id: targetId,
      code: `file-sub-demo-${SCHEMA.slice(-6)}`,
      name: '企业费用报销与材料提报系统',
      entryUrl: `${lab.url}/file-submission.html`,
      status: 'active',
    })

    await handle.db.insert(secrets).values({
      id: secretId,
      provider: LOCAL_SECRET_PROVIDER,
      ciphertext: secretsProvider.encrypt(secretId, 'lab-secret'),
    })
    await handle.db.insert(targetAccounts).values({
      id: accountId,
      targetId,
      displayName: '提报员',
      username: 'submitter',
      secretProvider: LOCAL_SECRET_PROVIDER,
      secretId,
      status: 'active',
    })
    await ensureTargetAccountCredential(handle, {
      account: {
        id: accountId,
        targetId,
        displayName: '提报员',
        username: 'submitter',
        configRevision: 1,
        secretId,
        secretProvider: LOCAL_SECRET_PROVIDER,
      },
      sealed: { id: secretId, provider: LOCAL_SECRET_PROVIDER },
      actor: { id: actorId },
    })

    // 4. 初始化对象存储服务与受管资产夹具
    objectDir = mkdtempSync(join(tmpdir(), 'cairn-fsdemo-obj-'))
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

    const invoiceContent = Buffer.from('%PDF-1.4 official tax invoice fixture for cairn integration test')
    fixtureByteSize = invoiceContent.byteLength
    fixtureDigest = `sha256:${createHash('sha256').update(invoiceContent).digest('hex')}`

    const reserved = await reserveTargetFixtureUpload(
      handle.db,
      {
        targetId,
        name: 'official-invoice.pdf',
        contentType: 'application/pdf',
        byteSize: fixtureByteSize,
        digest: fixtureDigest,
      },
      actorId,
    )
    fixtureId = reserved.fixtureId

    // 将夹具实体文件存入对象存储
    await objects.objectStore().put({
      key: reserved.objectKey,
      body: invoiceContent,
      contentType: 'application/pdf',
    })

    await commitTargetFixtureUpload(
      handle.db,
      {
        fixtureId,
        generationId: reserved.generationId,
        byteSize: fixtureByteSize,
        digest: fixtureDigest,
      },
      actorId,
    )

    // 5. 初始化 Worker 会话管理器
    workerId = `fsdemo-worker-${SCHEMA.slice(-6)}`
    workerInstanceId = newId()
    await registerWorker(handle.db, {
      workerId,
      instanceId: workerInstanceId,
      capacity: 4,
      lostAfterSeconds: 60,
      roles: ['executor'],
    })

    manager = new BrowserSessionManager(
      handle,
      {
        workerId,
        workerInstanceId,
        profileRoot: mkdtempSync(join(tmpdir(), 'cairn-fsdemo-prof-')),
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
    if (lab) await lab.close()
  })

  async function claimTargetRun(runId: string) {
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

  it('主流程完整闭环：下载模版 -> 填选填表单 -> 夹具上传(隐藏框触发) -> 上下文模版回传 -> 提交生成单号', async () => {
    const steps: Step[] = [
      {
        id: newId(),
        name: '打开报销与提报系统',
        type: 'navigate',
        effectType: 'IDEMPOTENT',
        input: { url: `${lab.url}/file-submission.html` },
      },
      {
        id: newId(),
        name: '下载报销标准模板',
        type: 'download',
        effectType: 'SIDE_EFFECT',
        outputKey: 'downloadedTemplate',
        input: {
          target: { framePath: [], candidates: [{ by: 'css', value: '#download-template-btn' }] },
          waitMs: 15_000,
          expect: {
            fileNamePattern: '\\.csv$',
            minBytes: 10,
          },
        },
      },
      {
        id: newId(),
        name: '填写申请人工号与姓名',
        type: 'fill',
        effectType: 'SIDE_EFFECT',
        input: {
          target: { framePath: [], candidates: [{ by: 'css', value: '#applicant-name' }] },
          value: '李四 (ENG-2048)',
        },
      },
      {
        id: newId(),
        name: '选择报销类别',
        type: 'select',
        effectType: 'SIDE_EFFECT',
        input: {
          target: { framePath: [], candidates: [{ by: 'css', value: '#category-select' }] },
          by: 'value',
          value: 'INVOICE',
        },
      },
      {
        id: newId(),
        name: '填写选填业务说明',
        type: 'fill',
        effectType: 'SIDE_EFFECT',
        input: {
          target: { framePath: [], candidates: [{ by: 'css', value: '#remarks' }] },
          value: 'Q3研发机房扩容采购及差旅报销',
        },
      },
      {
        id: newId(),
        name: '填写选填紧急联系电话',
        type: 'fill',
        effectType: 'SIDE_EFFECT',
        input: {
          target: { framePath: [], candidates: [{ by: 'css', value: '#emergency-phone' }] },
          value: '13987654321',
        },
      },
      {
        id: newId(),
        name: '勾选加急审批选项',
        type: 'click',
        effectType: 'SIDE_EFFECT',
        input: {
          target: { framePath: [], candidates: [{ by: 'css', value: '#urgent-check' }] },
        },
      },
      {
        id: newId(),
        name: '上传受管发票夹具（点击按钮唤起隐藏input）',
        type: 'upload',
        effectType: 'SIDE_EFFECT',
        input: {
          target: { framePath: [], candidates: [{ by: 'css', value: '#btn-select-invoice' }] },
          files: [
            {
              source: 'asset',
              fixtureId,
              digest: fixtureDigest,
              name: 'invoice-2026-q3.pdf',
            },
          ],
        },
      },
      {
        id: newId(),
        name: '上传上下文引用的下载模板作为补充材料',
        type: 'upload',
        effectType: 'SIDE_EFFECT',
        input: {
          target: { framePath: [], candidates: [{ by: 'css', value: '#extra-file' }] },
          files: [
            {
              source: 'context',
              from: 'downloadedTemplate',
            },
          ],
        },
      },
      {
        id: newId(),
        name: '提交提报表单',
        type: 'click',
        effectType: 'SIDE_EFFECT',
        input: {
          target: { framePath: [], candidates: [{ by: 'css', value: '#submit-btn' }] },
        },
      },
      {
        id: newId(),
        name: '断言生成申请单号',
        type: 'assert',
        effectType: 'READ_ONLY',
        input: {
          target: { framePath: [], candidates: [{ by: 'css', value: '#ticket-id' }] },
          expect: { kind: 'exists' },
        },
      },
      {
        id: newId(),
        name: '提取生成的业务单号',
        type: 'extract',
        effectType: 'READ_ONLY',
        outputKey: 'claimTicketId',
        input: {
          target: { framePath: [], candidates: [{ by: 'css', value: '#ticket-id' }] },
          as: 'text',
        },
      },
    ]

    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `fsdemo-${newId()}`,
      steps,
      actor: { id: actorId },
    })

    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: accountId,
      actor: { id: actorId },
    })
    const runId = created.detail.id

    const grant = await claimTargetRun(runId)
    const browserPort = createBrowserPort(manager, objects)
    const engine = new ExecutionEngine(handle, browserPort, secretsProvider, undefined, undefined, undefined, objects)

    await engine.execute(runId, { grant })

    // 校验 Run 状态与输出
    const detail = await getRun(handle.db, runId)
    expect(detail.status).toBe('SUCCEEDED')

    const context = detail.context as Record<string, any>
    expect(context).toBeDefined()
    expect(typeof context.claimTicketId).toBe('string')
    expect(context.claimTicketId).toMatch(/^CLAIM-\d{8}-\d{4}$/)

    // 校验下载步骤输出为合法句柄
    const downHandle = context.downloadedTemplate as RunFileHandle
    expect(downHandle.kind).toBe(RUN_FILE_HANDLE_KIND)
    expect(downHandle.scope).toBe('run')
    expect(downHandle.name).toBe('template.csv')
    expect(downHandle.mimeType).toBe('text/csv')
    expect(downHandle.digest).toMatch(/^sha256:[0-9a-f]{64}$/)

    // 校验证据链完整性且不含 Base64
    const evidences = await listRunEvidence(handle.db, runId)
    const fileEvidence = evidences.items.find((e) => e.type === 'file')
    expect(fileEvidence).toBeDefined()
    expect(fileEvidence?.status).toBe('available')

    const serializedEvidences = JSON.stringify(evidences.items)
    expect(serializedEvidences).not.toContain('data:application/pdf;base64')
    expect(serializedEvidences).not.toContain('base64,')

    // 校验生命周期隔离：Run 结束后工作区自动彻底清除
    const wsDir = runFileWorkspaceDir(runId)
    expect(existsSync(wsDir)).toBe(false)
  })
})
