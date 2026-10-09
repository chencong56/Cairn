import { DRIVERS, openContractDb } from './contract-fixture.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq, isNull } from 'drizzle-orm'
import {
  DEFAULT_OUTBOUND_POLICY,
  type ModuleContent,
  type ScenarioAuthoringDocumentV2,
} from '@cairn/shared'
import {
  copyScenario,
  createActionModule,
  createScenarioWithVersion,
  deleteScenario,
  getOrCreateModuleVerificationScenario,
  getScenario,
  grantAdminScope,
  grantScopedPermissions,
  listActionModuleVersions,
  publishActionModule,
  publishScenarioDraft,
  saveActionModuleDraft,
  saveScenarioDraft,
  schemaFor,
  type NativeHandle as DbHandle,
} from '../test-entry.js'
import { newId } from '../id.js'

describe.each(DRIVERS)('%s 复制场景', { timeout: 60_000 }, (driver) => {
  let handle: DbHandle
  let t: ReturnType<typeof schemaFor>
  let actorId: string

  async function account(): Promise<string> {
    const id = newId()
    await handle.db.insert(t.consoleAccounts).values({
      id,
      displayName: '复制场景测试',
      email: `copy-${id}@example.test`,
      status: 'active',
    })
    return id
  }

  async function target(): Promise<string> {
    const id = newId()
    await handle.db.insert(t.targets).values({
      id,
      code: `copy-${id.slice(-12)}`,
      name: '复制场景目标',
      entryUrl: 'https://example.com',
    })
    return id
  }

  async function plainScenario(targetId: string, name: string) {
    return createScenarioWithVersion(handle.db, {
      targetId,
      name,
      steps: [{ id: newId(), name: '打开首页', type: 'navigate', effectType: 'IDEMPOTENT', input: { url: 'https://example.com' } }],
      actor: { id: actorId },
    })
  }

  async function publishedModule(targetId: string) {
    const content: ModuleContent = {
      contract: {
        inputs: [{ key: 'keyword', label: '搜索词', valueType: 'string', required: true }],
        outputs: [{ key: 'result', label: '结果', shape: { kind: 'scalar', type: 'string' } }],
        effectCeiling: 'READ_ONLY',
        preconditions: [],
        postconditions: [{ meaning: '结果存在', verification: { kind: 'output_required', outputKey: 'result' } }],
      },
      implementations: [
        {
          implementationKey: 'default',
          kind: 'structured_steps',
          steps: [
            { id: newId(), name: '回显', type: 'echo', effectType: 'READ_ONLY', input: { from: 'keyword' }, outputKey: 'internal_result' },
          ],
          outputMapping: { result: 'internal_result' },
        },
      ],
    }
    const created = await createActionModule(handle.db, {
      targetId,
      key: 'search.box',
      name: '搜索模块',
      idempotencyKey: newId(),
      actor: { id: actorId },
    })
    await saveActionModuleDraft(handle.db, created.id, { baseRevision: 0, content, actor: { id: actorId } })
    await publishActionModule(handle.db, created.id, {
      idempotencyKey: newId(),
      expectedRevision: 1,
      actor: { id: actorId },
      skipReleaseGate: true,
    })
    const versions = await listActionModuleVersions(handle.db, created.id)
    return { moduleId: created.id, moduleVersionId: versions.items[0]!.id }
  }

  beforeAll(async () => {
    handle = await openContractDb(driver)
    t = schemaFor(handle.db)
    actorId = await account()
    await grantAdminScope(handle.db, actorId)
  })

  afterAll(async () => {
    await handle?.close()
  })

  it('草稿与最新发布版本原样复制，地图绑定、模块引用、报告与推送配置一并带上', async () => {
    const targetId = await target()
    const mod = await publishedModule(targetId)
    const source = await plainScenario(targetId, '报销提交')
    const navId = newId()
    const invocationId = newId()
    const document = (url: string): ScenarioAuthoringDocumentV2 => ({
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        { kind: 'step', step: { id: navId, name: '打开报销页', type: 'navigate', effectType: 'IDEMPOTENT', input: { url } } },
        {
          kind: 'module',
          invocationId,
          moduleId: mod.moduleId,
          moduleVersionId: mod.moduleVersionId,
          implementationKey: 'default',
          inputBindings: { keyword: { kind: 'literal', value: 'hello' } },
          outputBindings: { result: 'search_res' },
        },
      ],
    })
    await saveScenarioDraft(handle.db, source.id, { revision: 1, document: document('https://example.com/a'), actor: { id: actorId } })
    await handle.db.insert(t.mapScenarioBindings).values({
      targetId,
      scenarioId: source.id,
      slotKey: `step:${navId}`,
      stepId: navId,
      assetRefKey: `page:${newId()}`,
      basis: 'accepted_proposal',
      scopeKind: 'draft',
      draftRevision: 2,
      versionSlot: 'draft',
      resolution: 'resolved',
      sourceRef: { kind: 'accepted_proposal', proposalId: newId() },
      status: 'active',
    })
    const published = await publishScenarioDraft(handle.db, source.id, { revision: 2, actor: { id: actorId } })
    expect(published.published?.versionNo).toBe(2)
    // 再改一版不发布：副本应拿到这份未发布草稿
    await saveScenarioDraft(handle.db, source.id, { revision: 2, document: document('https://example.com/b'), actor: { id: actorId } })
    await handle.db.insert(t.scenarioReportDefaults).values({
      scenarioId: source.id,
      profileId: null,
      revision: 3,
      outputPolicy: { autoGenerateReport: true, memberReportPolicy: 'inherit', aiSummaryPolicy: 'inherit' },
    })
    const outboundPolicy = { ...DEFAULT_OUTBOUND_POLICY, enabled: true }
    await handle.db.insert(t.scenarioOutboundPolicies).values({
      scenarioId: source.id,
      revision: 2,
      policy: outboundPolicy,
      updatedBy: actorId,
      updatedAt: new Date(),
    })
    const before = await getScenario(handle.db, source.id)

    const copy = await copyScenario(handle.db, source.id, { actor: { id: actorId } })

    expect(copy.id).not.toBe(source.id)
    expect(copy).toMatchObject({ targetId, name: '报销提交-copy-1', status: 'active', purpose: 'user', notCopied: [] })
    expect(copy.draft?.revision).toBe(1)
    expect(copy.draft?.document).toEqual(before.draft?.document)
    expect(copy.draftDirty).toBe(true)
    expect(copy.published?.versionNo).toBe(1)
    expect(copy.published?.definition).toEqual(before.published?.definition)
    expect(copy.published?.authoringDocument).toEqual(before.published?.authoringDocument)
    expect(copy.published?.moduleManifest).toEqual(before.published?.moduleManifest)
    const copyVersionId = copy.published!.versionId

    const [sourceSubject] = await handle.db
      .select()
      .from(t.scenarioValidationSubjects)
      .where(eq(t.scenarioValidationSubjects.scenarioVersionId, before.published!.versionId))
    const [copySubject] = await handle.db
      .select()
      .from(t.scenarioValidationSubjects)
      .where(eq(t.scenarioValidationSubjects.scenarioVersionId, copyVersionId))
    expect(copySubject?.subjectDigest).toBe(sourceSubject!.subjectDigest)

    const draftRefs = await handle.db
      .select()
      .from(t.scenarioModuleRefs)
      .where(and(eq(t.scenarioModuleRefs.scenarioId, copy.id), isNull(t.scenarioModuleRefs.scenarioVersionId)))
    const versionRefs = await handle.db
      .select()
      .from(t.scenarioModuleRefs)
      .where(and(eq(t.scenarioModuleRefs.scenarioId, copy.id), eq(t.scenarioModuleRefs.scenarioVersionId, copyVersionId)))
    for (const refs of [draftRefs, versionRefs]) {
      expect(refs.map((ref) => [ref.invocationId, ref.moduleId, ref.moduleVersionId])).toEqual([
        [invocationId, mod.moduleId, mod.moduleVersionId],
      ])
    }

    const bindings = await handle.db
      .select()
      .from(t.mapScenarioBindings)
      .where(and(eq(t.mapScenarioBindings.scenarioId, copy.id), eq(t.mapScenarioBindings.status, 'active')))
    expect(bindings.map((row) => [row.scopeKind, row.versionSlot, row.scenarioVersionId, row.stepId]).sort()).toEqual(
      [
        ['draft', 'draft', null, navId],
        ['version', copyVersionId, copyVersionId, navId],
      ].sort(),
    )

    const [report] = await handle.db
      .select()
      .from(t.scenarioReportDefaults)
      .where(eq(t.scenarioReportDefaults.scenarioId, copy.id))
    expect(report).toMatchObject({ revision: 1, profileId: null, outputPolicy: { autoGenerateReport: true } })
    const [outbound] = await handle.db
      .select()
      .from(t.scenarioOutboundPolicies)
      .where(eq(t.scenarioOutboundPolicies.scenarioId, copy.id))
    expect(outbound).toMatchObject({ revision: 1, policy: outboundPolicy, updatedBy: actorId })

    const runs = await handle.db.select().from(t.runs).where(eq(t.runs.scenarioId, copy.id))
    expect(runs).toEqual([])
    const [audit] = await handle.db
      .select()
      .from(t.consoleAuditEvents)
      .where(and(eq(t.consoleAuditEvents.resourceId, copy.id), eq(t.consoleAuditEvents.action, 'scenario.create')))
    expect(audit?.summary).toBe('复制场景「报销提交」（草稿 r3，发布版本 2）为「报销提交-copy-1」')

    // 复制之后两边各改各的
    await saveScenarioDraft(handle.db, copy.id, { revision: 1, document: document('https://example.com/c'), actor: { id: actorId } })
    const after = await getScenario(handle.db, source.id)
    expect(after.draft).toEqual(before.draft)
    expect(after.published?.versionId).toBe(before.published?.versionId)
  })

  it('序号按原名续号，复制副本不叠后缀，已删除副本的名字也会避开', async () => {
    const targetId = await target()
    const source = await plainScenario(targetId, '月结对账')
    const first = await copyScenario(handle.db, source.id, { actor: { id: actorId } })
    const second = await copyScenario(handle.db, source.id, { actor: { id: actorId } })
    const ofCopy = await copyScenario(handle.db, first.id, { actor: { id: actorId } })
    expect([first.name, second.name, ofCopy.name]).toEqual(['月结对账-copy-1', '月结对账-copy-2', '月结对账-copy-3'])

    await deleteScenario(handle.db, ofCopy.id, { id: actorId })
    const afterDelete = await copyScenario(handle.db, source.id, { actor: { id: actorId } })
    expect(afterDelete.name).toBe('月结对账-copy-4')
  })

  it('同名序号被并发占用时整笔重试，换下一个序号', async () => {
    const targetId = await target()
    const source = await plainScenario(targetId, '并发复制')
    // 另一个事务先插入「并发复制-copy-1」但不提交：复制读不到它，算出同一序号后在唯一索引上等待
    let inserted!: () => void
    let release!: () => void
    const insertedSignal = new Promise<void>((resolve) => (inserted = resolve))
    const held = new Promise<void>((resolve) => (release = resolve))
    const competitor = handle.db.transaction(async (tx) => {
      await tx.insert(t.scenarios).values({
        id: newId(),
        targetId,
        name: '并发复制-copy-1',
        createdByConsoleAccountId: actorId,
      })
      inserted()
      await held
    })
    await insertedSignal
    const copying = copyScenario(handle.db, source.id, { actor: { id: actorId } })
    await new Promise((resolve) => setTimeout(resolve, 500))
    release()
    await competitor

    expect((await copying).name).toBe('并发复制-copy-2')
  })

  it('缺少推送或报告导出权限时，对应配置不带过去并如实返回', async () => {
    const targetId = await target()
    const source = await plainScenario(targetId, '权限受限复制')
    await handle.db.insert(t.scenarioReportDefaults).values({
      scenarioId: source.id,
      profileId: null,
      revision: 1,
      outputPolicy: { autoGenerateReport: true, memberReportPolicy: 'inherit', aiSummaryPolicy: 'inherit' },
    })
    await handle.db.insert(t.scenarioOutboundPolicies).values({
      scenarioId: source.id,
      revision: 1,
      policy: { ...DEFAULT_OUTBOUND_POLICY, enabled: true },
      updatedBy: actorId,
      updatedAt: new Date(),
    })
    const editor = await account()
    await grantScopedPermissions(handle.db, editor, ['target:read', 'workflow:read', 'workflow:write'])

    const copy = await copyScenario(handle.db, source.id, { actor: { id: editor } })

    expect(copy.notCopied.map((item) => item.item).sort()).toEqual(['auto_report', 'outbound_policy'])
    const [report] = await handle.db
      .select()
      .from(t.scenarioReportDefaults)
      .where(eq(t.scenarioReportDefaults.scenarioId, copy.id))
    expect(report?.outputPolicy?.autoGenerateReport).toBe(false)
    const outbound = await handle.db
      .select()
      .from(t.scenarioOutboundPolicies)
      .where(eq(t.scenarioOutboundPolicies.scenarioId, copy.id))
    expect(outbound).toEqual([])
  })

  it('无目标权限、非普通场景、目标已停用时拒绝复制', async () => {
    const targetId = await target()
    const source = await plainScenario(targetId, '拒绝复制')
    const outsider = await account()
    await expect(copyScenario(handle.db, source.id, { actor: { id: outsider } })).rejects.toMatchObject({
      code: 'TARGET_NOT_FOUND',
    })

    const mod = await publishedModule(targetId)
    const verification = await getOrCreateModuleVerificationScenario(handle.db, {
      moduleId: mod.moduleId,
      actor: { id: actorId },
    })
    await expect(
      copyScenario(handle.db, verification.scenarioId, { actor: { id: actorId } }),
    ).rejects.toMatchObject({ code: 'SCENARIO_COPY_UNSUPPORTED' })

    await handle.db.update(t.targets).set({ status: 'disabled' }).where(eq(t.targets.id, targetId))
    await expect(copyScenario(handle.db, source.id, { actor: { id: actorId } })).rejects.toMatchObject({
      code: 'TARGET_DISABLED',
    })
    const names = await handle.db.select({ name: t.scenarios.name }).from(t.scenarios).where(eq(t.scenarios.targetId, targetId))
    expect(names.map((row) => row.name).filter((name) => name.includes('-copy-'))).toEqual([])
  })
})
