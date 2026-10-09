import type { ScenarioRow, ScenarioVersionRow } from '../records.js'
import { atomic, locked, lockedShared, schemaFor } from '../native.js'
import { and, asc, count, desc, eq, inArray, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm'
import {
  compileScenarioDocument,
  deriveOutcomeManifest,
  deriveRuntimeInvariantManifest,
  expandAuthoringDocument,
  type ExpansionResult,
  type LoadedModuleVersion,
} from '@cairn/authoring'
import {
  ACTIVE_RUN_STATUSES,
  COMPILER_VERSION,
  FACTORY_COMPILE_RESOLUTION,
  resolutionCapabilitiesFromPlatform,
  stepsNeedLocatorAiExecute,
  canonicalJson,
  copyScenarioResponseSchema,
  scenarioCopyName,
  syncSha256,
  ScenarioValidationError,
  assertRunFromResolved,
  deletePreviewResponseSchema,
  isAuthoringDocumentV2,
  authoringHasModuleInvocations,
  authoringHasOutcomes,
  authoringNodeId,
  authoringSteps,
  insertNodeAfter,
  locateNode,
  defaultPageHealthInvariants,
  normalizeAuthoringDocument,
  parseScenarioDocument,
  removeNode,
  replaceNode,
  scenarioAuthoringDocumentV2Schema,
  walkAuthoringNodes,
  scenarioDefinitionFromSteps,
  scenarioDetailSchema,
  scenarioDocumentSchema,
  scenarioListQuerySchema,
  scenarioListResponseSchema,
  scenarioSchema,
  type ScenarioLatestRun,
  type ScenarioScheduleSummary,
  scenarioVersionListResponseSchema,
  scenarioVersionSchema,
  validateScenarioDefinition,
  type AuthoringStepNode,
  type CompileResult,
  type CopyScenarioResponse,
  type ScenarioCopyNotCopied,
  type DeletePreviewResponse,
  type DeleteResourceBody,
  type DeleteResourceResult,
  type JsonValue,
  type ModuleManifest,
  type ScenarioAuthoringDocumentV2,
  type CompileDiagnostic,
  type ScenarioDefinition,
  type ScenarioDetailDto,
  type ScenarioDocument,
  type ScenarioDto,
  type ScenarioInputDecl,
  type ScenarioOutputDecl,
  type ScenarioListQuery,
  type ScenarioListResponse,
  type ScenarioStatus,
  type ScenarioVersionDto,
  type ScenarioVersionListResponse,
  type Step,
  type ModuleContent,
  type CompileContext,
  type CompileResolutionContext,
} from '@cairn/shared'
import { recordAudit, type AuditActor } from '../audit/record.js'
import { freezeMapDraftBindingsTx, reconcileMapDraftBindingsTx } from '../map/references.js'
import type { Db } from '../client.js'
import { assertRunAccountChoice } from '../console/target-identity.js'
import { newId } from '../id.js'
import { sha256Hex } from './digest.js'
import { expireRepairCandidatesOnPublishTx } from '../repair/index.js'
import {
  computeContentDigest,
  computeContractDigest,
  computeImplementationDigest,
} from '../action-modules/digest.js'
import { badRequest, conflict, constraintName, forbidden, isUniqueViolation, mapRestriction, notFound } from './errors.js'
import {
  assertTargetPermission,
  loadAccountGrants,
  lockConsoleAuthorization,
  scopeFromGrants,
  shareConsoleAuthorization,
  targetScopeFor,
} from '../console/target-authorization.js'
import { draftValidationSubject, saveValidationSubjectTx } from './validation.js'
import { suiteReferenceBlockers, suitesReferencingScenario } from '../suites/suites.js'
import { cursorFilter, paginateResults } from '../cursor.js'
import {
  activeRunBlockers,
  assertExpectedCounts,
  assertResourceIdle,
  closeOpenBindings,
  deletedOccupancyMessage,
  snapshotDeletedBy,
  toDeleteResult,
} from '../lifecycle.js'

function iso(value: Date): string {
  return value.toISOString()
}

function rethrow(error: unknown): never {
  if (error instanceof ScenarioValidationError) {
    throw badRequest(error.code, error.message)
  }
  const mapped = mapRestriction(error)
  if (mapped) throw mapped
  throw error
}

function sourceDocumentDigest(value: unknown): string {
  return sha256Hex(scenarioDocumentSchema.parse(value))
}

function authoringExtrasDigest(input: {
  authoringDocument?: ScenarioAuthoringDocumentV2 | null
  definition?: ScenarioDefinition | null
}): string {
  return sha256Hex({
    runtimeInvariantManifest: deriveRuntimeInvariantManifest(input.authoringDocument ?? null) ?? null,
    outcomeManifest: deriveOutcomeManifest({
      authoringDocument: input.authoringDocument ?? null,
      definition: input.definition ?? null,
    }) ?? null,
  })
}

function isDraftDirty(draftDocument: unknown, publishedDefinition: unknown, publishedAuthoringDocument?: unknown): boolean {
  try {
    // v2 编排文档与编译后的运行定义结构不同；应与发布时冻结的编排文档比较。
    if (publishedAuthoringDocument) {
      return sha256Hex(normalizeAuthoringDocument(draftDocument)) !==
        sha256Hex(normalizeAuthoringDocument(publishedAuthoringDocument))
    }
    return sourceDocumentDigest(draftDocument) !== sourceDocumentDigest(publishedDefinition)
  } catch {
    return true
  }
}

function publishedVersionNo(row: ScenarioVersionRow): number {
  if (row.versionNo == null) {
    throw notFound('SCENARIO_VERSION_NOT_FOUND', '已发布场景版本不存在')
  }
  return row.versionNo
}

async function findLatestPublishedVersion(db: Db, scenarioId: string) {
  const { scenarioVersions } = schemaFor(db)
  const [row] = await db
    .select()
    .from(scenarioVersions)
    .where(and(eq(scenarioVersions.scenarioId, scenarioId), eq(scenarioVersions.kind, 'published')))
    .orderBy(desc(scenarioVersions.versionNo))
    .limit(1)
  return row
}

async function latestPublishedVersion(db: Db, scenarioId: string) {
  const row = await findLatestPublishedVersion(db, scenarioId)
  if (!row) throw notFound('SCENARIO_VERSION_NOT_FOUND', '场景尚未发布，请先发布版本')
  return row
}

async function loadTargetContext(db: Db, targetId: string) {
  const { targets } = schemaFor(db)
  const [target] = await db.select().from(targets).where(eq(targets.id, targetId)).limit(1)
  if (!target || target.deletedAt) return { exists: false as const, status: 'disabled' as const, row: null }
  return { exists: true as const, status: target.status, row: target }
}

export type ScenarioCompileOptions = {
  executableTypes?: readonly string[]
  resolution?: CompileResolutionContext
}

async function compileResolutionFromPlatform(db: Db, targetId?: string): Promise<CompileResolutionContext> {
  const { loadResolutionLayers } = await import('./resolution-layers.js')
  const layers = await loadResolutionLayers(db, targetId)
  const caps = resolutionCapabilitiesFromPlatform(layers.document)
  return {
    ...FACTORY_COMPILE_RESOLUTION,
    waitKindsAvailable: caps.waitKindsAvailable,
    locatorDocument: layers.document,
    locatorTarget: layers.targetPolicy,
  }
}

function compileDocument(
  document: ScenarioDocument,
  target: { exists: boolean; status: 'active' | 'disabled' },
  mode: 'save' | 'release',
  options?: ScenarioCompileOptions,
  outcomeManifest?: ReturnType<typeof deriveOutcomeManifest> | { entries: [] },
): CompileResult {
  return compileScenarioDocument(document, {
    mode,
    target,
    executableTypes: mode === 'save' ? undefined : options?.executableTypes,
    resolution: {
      ...FACTORY_COMPILE_RESOLUTION,
      ...options?.resolution,
      documentLocatorPlan: options?.resolution?.documentLocatorPlan ?? document.locatorPlan,
    },
    ...(outcomeManifest !== undefined ? { outcomeManifest } : {}),
  })
}

function throwIfBlocked(result: CompileResult): CompileResult {
  if (!result.ok) {
    throw badRequest('SCENARIO_COMPILE_BLOCKED', '场景编译未通过', {
      diagnostics: result.diagnostics,
    })
  }
  return result
}

function parseDocument(input: unknown): ScenarioDocument {
  try {
    if (isAuthoringDocumentV2(input)) {
      return parseScenarioDocument({
        schemaVersion: input.schemaVersion,
        inputs: input.inputs,
        steps: authoringSteps(input),
        ...(input.locatorPlan ? { locatorPlan: input.locatorPlan } : {}),
      })
    }
    return parseScenarioDocument(input)
  } catch (error) {
    if (isZodError(error)) {
      throw badRequest('BAD_REQUEST', error.issues[0]?.message ?? '场景文档不合法')
    }
    throw error
  }
}

async function loadDraft(db: Db, scenarioId: string) {
  const { scenarioDrafts } = schemaFor(db)
  const [draft] = await db
    .select()
    .from(scenarioDrafts)
    .where(eq(scenarioDrafts.scenarioId, scenarioId))
    .limit(1)
  return draft ?? null
}

async function draftUpdatedBy(db: Db, accountId: string) {
  const { consoleAccounts } = schemaFor(db)
  const [account] = await db
    .select({ id: consoleAccounts.id, displayName: consoleAccounts.displayName })
    .from(consoleAccounts)
    .where(eq(consoleAccounts.id, accountId))
    .limit(1)
  return { id: accountId, displayName: account?.displayName || '控制台用户' }
}

export function createModuleVersionLoader(
  db: Db,
  scenarioTargetId: string,
  allowDraftFallback = false,
) {
  return async (moduleId: string, versionId?: string): Promise<LoadedModuleVersion | null> => {
    const { actionModules, actionModuleVersions } = schemaFor(db)
    const [mod] = await db
      .select()
      .from(actionModules)
      .where(and(eq(actionModules.id, moduleId), isNull(actionModules.deletedAt)))
      .limit(1)
    if (!mod) return null

    if (versionId) {
      const [ver] = await db
        .select()
        .from(actionModuleVersions)
        .where(and(eq(actionModuleVersions.id, versionId), eq(actionModuleVersions.moduleId, moduleId)))
        .limit(1)
      if (!ver) return null
      return {
        versionId: ver.id,
        moduleId: ver.moduleId,
        targetId: mod.targetId,
        moduleKey: mod.key,
        name: mod.name,
        versionNo: ver.versionNo,
        publicationStatus: ver.publicationStatus,
        contentDigest: ver.contentDigest,
        contractDigest: ver.contractDigest,
        implementationDigest: ver.implementationDigest,
        content: ver.content as ModuleContent,
      }
    }

    if (allowDraftFallback && mod.draftContent) {
      const content = mod.draftContent as ModuleContent
      return {
        versionId: undefined,
        moduleId: mod.id,
        targetId: mod.targetId,
        moduleKey: mod.key,
        name: mod.name,
        versionNo: 0,
        draftRevision: mod.draftRevision,
        publicationStatus: 'published',
        contentDigest: computeContentDigest(content),
        contractDigest: computeContractDigest(content.contract),
        implementationDigest: computeImplementationDigest(content.implementations),
        content,
      }
    }

    return null
  }
}

export interface ExpandWithLoaderPrecomputed {
  platform?: Awaited<ReturnType<typeof import('../platform-config/store.js').getOrCreatePlatformConfig>>
  resolution?: CompileResolutionContext
}

/**
 * 一次性加载某目标的平台配置与 resolution 编译上下文；同目标的批量编译
 * （如验收巡检批次）复用同一份结果，避免逐场景重复读取与编译。
 */
export async function loadTargetCompileContext(
  db: Db,
  targetId?: string,
): Promise<Required<ExpandWithLoaderPrecomputed>> {
  const { getOrCreatePlatformConfig } = await import('../platform-config/store.js')
  const platform = await getOrCreatePlatformConfig(db)
  const resolution = await compileResolutionFromPlatform(db, targetId)
  return { platform, resolution }
}

export async function expandWithLoader(
  db: Db,
  targetId: string,
  doc: ScenarioAuthoringDocumentV2,
  mode: 'publish' | 'trial' | 'preview',
  allowDraftFallback: boolean,
  compilerCtx?: Partial<CompileContext>,
  precomputed?: ExpandWithLoaderPrecomputed,
): Promise<ExpansionResult> {
  const loader = createModuleVersionLoader(db, targetId, allowDraftFallback)
  const loadedModules = new Map<string, LoadedModuleVersion>()
  for (const item of walkAuthoringNodes(doc)) {
    const node = item.node
    if (node.kind === 'module') {
      const loaded = await loader(node.moduleId, node.moduleVersionId)
      if (loaded) {
        // 键必须与 expandAuthoringDocument 的查找键一致：引用版本用 versionId，
        // 引用草稿用 moduleId。两者都写会让同一模块的草稿与已发布版本互相覆盖。
        if (loaded.versionId) {
          loadedModules.set(loaded.versionId, loaded)
        } else {
          loadedModules.set(loaded.moduleId, loaded)
        }
      }
    }
  }
  const { getOrCreatePlatformConfig } = await import('../platform-config/store.js')
  const platform = precomputed?.platform ?? (await getOrCreatePlatformConfig(db))
  const resolution = precomputed?.resolution ?? (await compileResolutionFromPlatform(db, targetId))
  return expandAuthoringDocument(doc, {
    targetId,
    mode,
    loadedModules,
    compilerCtx: {
      ...compilerCtx,
      resolution: {
        ...resolution,
        ...compilerCtx?.resolution,
      },
    },
    fallbackEnabled: platform.document.moduleFallback.enabled,
  })
}

export async function syncScenarioModuleRefsTx(
  tx: Db,
  scenarioId: string,
  scenarioVersionId: string | null,
  document: ScenarioAuthoringDocumentV2,
): Promise<void> {
  const { scenarioModuleRefs } = schemaFor(tx)
  // 同一作用域（草稿或某个版本）先清后写，重复试跑同一摘要不会累积重复引用行
  await tx
    .delete(scenarioModuleRefs)
    .where(
      and(
        eq(scenarioModuleRefs.scenarioId, scenarioId),
        scenarioVersionId === null
          ? isNull(scenarioModuleRefs.scenarioVersionId)
          : eq(scenarioModuleRefs.scenarioVersionId, scenarioVersionId),
      ),
    )
  const invocations = walkAuthoringNodes(document).flatMap((item) =>
    item.node.kind === 'module' ? [item.node] : [],
  )
  if (invocations.length === 0) return

  const moduleIds = [...new Set(invocations.map((node) => node.moduleId))]
  if (moduleIds.length > 0) {
    const { actionModules } = schemaFor(tx)
    const lockedModules = await locked(
      tx,
      tx.select({ id: actionModules.id, deletedAt: actionModules.deletedAt })
        .from(actionModules)
        .where(inArray(actionModules.id, moduleIds)),
    )
    for (const m of lockedModules) {
      if (m.deletedAt) {
        throw conflict('MODULE_NOT_FOUND', '引用的动作模块已被删除')
      }
    }
  }

  for (const node of invocations) {
    await tx.insert(scenarioModuleRefs).values({
      id: newId(),
      scenarioId,
      scenarioVersionId,
      invocationId: node.invocationId,
      moduleId: node.moduleId,
      moduleVersionId: node.moduleVersionId ?? null,
      createdAt: new Date(),
    })
  }
}

function toScenarioDto(
  row: ScenarioRow,
  latest: ScenarioVersionRow | undefined,
  draftDirty: boolean,
  extras?: {
    draftStepCount?: number
    createdByName?: string | null
    latestRun?: ScenarioLatestRun | null
    schedule?: ScenarioScheduleSummary | null
  },
): ScenarioDto {
  return scenarioSchema.parse({
    id: row.id,
    targetId: row.targetId,
    name: row.name,
    status: row.status,
    purpose: row.purpose ?? 'user',
    latestVersionId: latest?.id ?? null,
    latestVersionNo: latest ? publishedVersionNo(latest) : null,
    stepCount: latest?.definition.steps.length ?? extras?.draftStepCount ?? 0,
    draftDirty,
    runAccountId: row.runAccountId ?? null,
    createdByName: extras?.createdByName ?? null,
    latestRun: extras?.latestRun ?? null,
    schedule: extras?.schedule ?? null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  })
}

function toVersionDto(version: ScenarioVersionRow): ScenarioVersionDto {
  return scenarioVersionSchema.parse({
    id: version.id,
    scenarioId: version.scenarioId,
    versionNo: version.versionNo,
    kind: version.kind,
    definition: version.definition,
    compilerVersion: version.compilerVersion,
    authoringDocument: version.authoringDocument ?? undefined,
    moduleManifest: version.moduleManifest ?? undefined,
    createdAt: iso(version.createdAt),
  })
}

function isV2Document(doc: unknown): boolean {
  if (!doc || typeof doc !== 'object') return false
  const d = doc as Record<string, unknown>
  if (d.authoringSchemaVersion === 2) return true
  if (Array.isArray(d.nodes)) return true
  return false
}

async function toDetailDto(
  db: Db,
  row: ScenarioRow,
  latest: ScenarioVersionRow | undefined,
  options?: ScenarioCompileOptions,
): Promise<ScenarioDetailDto> {
  const draft = await loadDraft(db, row.id)
  const target = await loadTargetContext(db, row.targetId)
  const authoringDoc = normalizeAuthoringDocument(
    draft?.document ?? latest?.authoringDocument ?? latest?.definition,
  )
  let compiled: CompileResult
  const hasModuleInvocations = authoringHasModuleInvocations(authoringDoc)
  const resolution = options?.resolution ?? (await compileResolutionFromPlatform(db, row.targetId))
  const compileOptions = { ...options, resolution }
  if (hasModuleInvocations) {
    const expansion = await expandWithLoader(db, row.targetId, authoringDoc, 'preview', true, {
      resolution,
    })
    compiled = {
      ok: expansion.ok,
      definition: expansion.definition!,
      compilerVersion: COMPILER_VERSION,
      diagnostics: expansion.diagnostics,
    }
  } else {
    const legacyDoc: ScenarioDocument = {
      schemaVersion: 1,
      inputs: authoringDoc.inputs,
      steps: authoringSteps(authoringDoc),
      ...(authoringDoc.locatorPlan ? { locatorPlan: authoringDoc.locatorPlan } : {}),
    }
    compiled = compileDocument(
      legacyDoc,
      target,
      'release',
      compileOptions,
      deriveOutcomeManifest({ authoringDocument: authoringDoc }) ?? { entries: [] },
    )
  }
  const dirty = draft ? !latest || isDraftDirty(draft.document, latest.definition, latest.authoringDocument) : false
  return scenarioDetailSchema.parse({
    ...toScenarioDto(row, latest, dirty, { draftStepCount: authoringSteps(authoringDoc).length }),
    steps: latest?.definition.steps ?? [],
    published: latest ? {
      versionId: latest.id,
      versionNo: publishedVersionNo(latest),
      definition: latest.definition,
      compilerVersion: latest.compilerVersion,
      authoringDocument: latest.authoringDocument ?? undefined,
      moduleManifest: latest.moduleManifest ?? undefined,
      createdAt: iso(latest.createdAt),
    } : undefined,
    draft: draft
      ? {
          revision: draft.revision,
          document: draft.document,
          updatedAt: iso(draft.updatedAt),
          updatedBy: await draftUpdatedBy(db, draft.updatedByConsoleAccountId),
        }
      : undefined,
    compile: {
      ok: compiled.ok,
      compilerVersion: compiled.compilerVersion,
      diagnostics: compiled.diagnostics,
    },
  })
}

export async function getScenario(
  db: Db,
  scenarioId: string,
  options?: ScenarioCompileOptions,
): Promise<ScenarioDetailDto> {
  const { scenarios } = schemaFor(db)
  const [row] = await db
    .select()
    .from(scenarios)
    .where(and(eq(scenarios.id, scenarioId), isNull(scenarios.deletedAt)))
    .limit(1)
  if (!row) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
  const latest = await findLatestPublishedVersion(db, scenarioId)
  return toDetailDto(db, row, latest, options)
}

export async function listScenarios(
  db: Db,
  query: ScenarioListQuery = {},
  actorId?: string,
): Promise<ScenarioListResponse> {
  const parsed = scenarioListQuerySchema.parse(query)
  const { consoleAccounts, runs, schedules, scheduleVersions, scenarioDrafts, scenarioVersions, scenarios } = schemaFor(db)
  const limit = parsed.limit
  const filters: (SQL | undefined)[] = [
    await (await import('../console/target-authorization.js')).scopedTargetFilter(db, actorId, scenarios.targetId, 'workflow:read'),
    isNull(scenarios.deletedAt),
    parsed.targetId ? eq(scenarios.targetId, parsed.targetId) : undefined,
    parsed.status ? eq(scenarios.status, parsed.status) : undefined,
    parsed.purpose
      ? eq(scenarios.purpose, parsed.purpose)
      : or(eq(scenarios.purpose, 'user'), isNull(scenarios.purpose)),
    parsed.search
      ? sql`lower(${scenarios.name}) like ${'%' + parsed.search.toLowerCase() + '%'}`
      : undefined,
    parsed.hasDraft === true
      ? inArray(
          scenarios.id,
          db.select({ scenarioId: scenarioDrafts.scenarioId }).from(scenarioDrafts),
        )
      : parsed.hasDraft === false
        ? notInArray(
            scenarios.id,
            db.select({ scenarioId: scenarioDrafts.scenarioId }).from(scenarioDrafts),
          )
        : undefined,
    cursorFilter(scenarios.createdAt, scenarios.id, parsed.cursor),
  ]
  const rows = await db
    .select()
    .from(scenarios)
    .where(and(...filters.filter((f): f is SQL => f !== undefined)))
    .orderBy(desc(scenarios.createdAt), desc(scenarios.id))
    .limit(limit + 1)

  const paginated = paginateResults(rows, limit)
  const pageScenarioIds = paginated.items.map((r) => r.id)

  let latestByScenario = new Map<string, typeof scenarioVersions.$inferSelect>()
  if (pageScenarioIds.length > 0) {
    const rankedVersions = db
      .select({
        id: scenarioVersions.id,
        scenarioId: scenarioVersions.scenarioId,
        rn: sql<number>`ROW_NUMBER() OVER (PARTITION BY ${scenarioVersions.scenarioId} ORDER BY ${scenarioVersions.versionNo} DESC)`.as(
          'rn',
        ),
      })
      .from(scenarioVersions)
      .where(
        and(
          inArray(scenarioVersions.scenarioId, pageScenarioIds),
          eq(scenarioVersions.kind, 'published'),
        ),
      )
      .as('ranked_versions')

    const latestVersionRows = await db
      .select({ version: scenarioVersions })
      .from(scenarioVersions)
      .innerJoin(
        rankedVersions,
        and(eq(scenarioVersions.id, rankedVersions.id), eq(rankedVersions.rn, 1)),
      )

    latestByScenario = new Map(latestVersionRows.map((r) => [r.version.scenarioId, r.version]))
  }

  const drafts =
    pageScenarioIds.length > 0
      ? await db
          .select()
          .from(scenarioDrafts)
          .where(inArray(scenarioDrafts.scenarioId, pageScenarioIds))
      : []
  const draftById = new Map(drafts.map((draft) => [draft.scenarioId, draft]))

  // 1. 批量查询创建人 DisplayName
  const creatorIds = Array.from(
    new Set(paginated.items.map((r) => r.createdByConsoleAccountId).filter(Boolean)),
  )
  const creatorRows =
    creatorIds.length > 0
      ? await db
          .select({ id: consoleAccounts.id, displayName: consoleAccounts.displayName })
          .from(consoleAccounts)
          .where(inArray(consoleAccounts.id, creatorIds))
      : []
  const creatorNameById = new Map(creatorRows.map((c) => [c.id, c.displayName]))

  // 2. 批量聚合各场景的最近一次运行 (latestRun)
  let latestRunByScenario = new Map<string, ScenarioLatestRun>()
  if (pageScenarioIds.length > 0) {
    const rankedRuns = db
      .select({
        id: runs.id,
        scenarioId: runs.scenarioId,
        status: runs.status,
        outcomeStatus: runs.outcomeStatus,
        createdAt: runs.createdAt,
        rn: sql<number>`ROW_NUMBER() OVER (PARTITION BY ${runs.scenarioId} ORDER BY ${runs.createdAt} DESC)`.as(
          'rn',
        ),
      })
      .from(runs)
      .where(inArray(runs.scenarioId, pageScenarioIds))
      .as('ranked_runs')

    const latestRunRows = await db
      .select()
      .from(rankedRuns)
      .where(eq(rankedRuns.rn, 1))

    latestRunByScenario = new Map(
      latestRunRows.map((r) => [
        r.scenarioId,
        {
          id: r.id,
          status: r.status,
          outcomeStatus: r.outcomeStatus ?? undefined,
          createdAt: iso(r.createdAt),
        },
      ]),
    )
  }

  // 3. 批量查询关联的直属定时调度 (schedule)
  const scheduleByScenario = new Map<string, ScenarioScheduleSummary>()
  if (pageScenarioIds.length > 0) {
    const scheduleRows = await db
      .select({
        id: schedules.id,
        name: schedules.name,
        enabled: schedules.enabled,
        nextDueAt: schedules.nextDueAt,
        consumer: scheduleVersions.consumer,
        timeRule: scheduleVersions.timeRule,
      })
      .from(schedules)
      .innerJoin(scheduleVersions, eq(scheduleVersions.id, schedules.currentVersionId))
      .where(eq(schedules.consumerKey, 'scenario_run'))

    for (const s of scheduleRows) {
      const consumer = s.consumer as { type?: string; scenarioId?: string } | null
      if (consumer?.scenarioId && pageScenarioIds.includes(consumer.scenarioId)) {
        const existing = scheduleByScenario.get(consumer.scenarioId)
        if (!existing || (!existing.enabled && Boolean(s.enabled))) {
          let summary = '定时调度'
          if (s.timeRule && typeof s.timeRule === 'object') {
            const tr = s.timeRule as {
              kind?: string
              intervalMs?: number
              windows?: Array<{ windowStart?: string; windowEnd?: string }>
            }
            if (tr.kind === 'interval' && tr.intervalMs) {
              summary = `每隔 ${Math.round(tr.intervalMs / 60000)} 分钟`
            } else if (tr.windows && tr.windows.length > 0 && tr.windows[0]?.windowStart) {
              summary = `每天 ${tr.windows[0].windowStart}`
            }
          }
          scheduleByScenario.set(consumer.scenarioId, {
            id: s.id,
            name: s.name,
            enabled: Boolean(s.enabled),
            summary,
            nextDueAt: s.nextDueAt ? iso(s.nextDueAt) : undefined,
          })
        }
      }
    }
  }

  const items: ScenarioDto[] = []
  for (const row of paginated.items) {
    const latest = latestByScenario.get(row.id)
    const draft = draftById.get(row.id)
    items.push(
      toScenarioDto(
        row,
        latest,
        draft ? !latest || isDraftDirty(draft.document, latest.definition, latest.authoringDocument) : false,
        {
          draftStepCount: draft ? authoringSteps(draft.document).length : 0,
          createdByName: creatorNameById.get(row.createdByConsoleAccountId) ?? null,
          latestRun: latestRunByScenario.get(row.id) ?? null,
          schedule: scheduleByScenario.get(row.id) ?? null,
        },
      ),
    )
  }
  return scenarioListResponseSchema.parse({
    items,
    nextCursor: paginated.nextCursor,
    hasMore: paginated.hasMore,
  })
}

export async function listScenarioVersions(
  db: Db,
  scenarioId: string,
): Promise<ScenarioVersionListResponse> {
  const { scenarioVersions, scenarios } = schemaFor(db)
  const [row] = await db
    .select()
    .from(scenarios)
    .where(and(eq(scenarios.id, scenarioId), isNull(scenarios.deletedAt)))
    .limit(1)
  if (!row) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
  const versions = await db
    .select()
    .from(scenarioVersions)
    .where(and(eq(scenarioVersions.scenarioId, scenarioId), eq(scenarioVersions.kind, 'published')))
    .orderBy(asc(scenarioVersions.versionNo))
  return scenarioVersionListResponseSchema.parse({
    items: versions.map(toVersionDto),
  })
}

export async function createScenarioWithVersion(
  db: Db,
  input: {
    targetId: string
    name: string
    steps: Step[]
    inputs?: ScenarioInputDecl[]
    outputs?: ScenarioOutputDecl
    status?: ScenarioStatus
    /** 运行账号；省略或 null 表示跟随目标默认。 */
    runAccountId?: string | null
    actor: AuditActor
    compileMode?: 'save' | 'release'
    executableTypes?: readonly string[]
    /** 新建场景默认带页面接口 / 脚本错误约束。由 API 按平台开关传入；缺省不带（存量与直接调用方不受影响）。 */
    pageHealthGuards?: boolean
    /** 写进默认「页面接口」约束的忽略清单（平台默认忽略清单）。 */
    pageHealthIgnore?: readonly string[]
  },
): Promise<ScenarioDetailDto & { latestVersionId: string; latestVersionNo: number }> {
  const { scenarioDrafts, scenarioVersions, scenarios } = schemaFor(db)
  const document = parseDocument(scenarioDefinitionFromSteps(input.steps, input.inputs ?? [], input.outputs))
  const target = await loadTargetContext(db, input.targetId)
  if (!target.exists) throw notFound('TARGET_NOT_FOUND', '目标系统不存在')
  if (target.status === 'disabled')
    throw conflict('TARGET_DISABLED', '目标系统已停用，不能新建场景')
  const resolution = await compileResolutionFromPlatform(db, input.targetId)
  const compiled = compileDocument(document, target, input.compileMode ?? 'release', {
    executableTypes: input.executableTypes,
    resolution,
  })
  if ((input.compileMode ?? 'release') === 'release') throwIfBlocked(compiled)
  // 新建场景默认带页面接口 / 脚本错误约束（由调用方按平台开关决定；存量场景不回填）。
  const seededAuthoring: ScenarioAuthoringDocumentV2 | undefined = input.pageHealthGuards
    ? { ...normalizeAuthoringDocument(compiled.definition), runtimeInvariants: defaultPageHealthInvariants(newId, { networkIgnore: input.pageHealthIgnore }) }
    : undefined

  const id = newId()
  const versionId = newId()
  const now = new Date()
  const digest = sourceDocumentDigest(compiled.definition)
  try {
    await db.transaction(async (tx) => {
      if (input.runAccountId) await assertRunAccountChoice(tx as unknown as Db, input.targetId, input.runAccountId)
      await tx.insert(scenarios).values({
        id,
        targetId: input.targetId,
        name: input.name,
        status: input.status ?? 'active',
        runAccountId: input.runAccountId ?? null,
        createdByConsoleAccountId: input.actor.id,
        createdAt: now,
        updatedAt: now,
      })
      await tx.insert(scenarioVersions).values({
        id: versionId,
        scenarioId: id,
        versionNo: 1,
        kind: 'published',
        definition: compiled.definition,
        compilerVersion: COMPILER_VERSION,
        sourceDigest: digest,
        ...(seededAuthoring ? { authoringDocument: seededAuthoring } : {}),
        createdByConsoleAccountId: input.actor.id,
        createdAt: now,
      })
      await tx.insert(scenarioDrafts).values({
        scenarioId: id,
        revision: 1,
        document: seededAuthoring ?? compiled.definition,
        updatedByConsoleAccountId: input.actor.id,
        updatedAt: now,
      })
      const authoring = seededAuthoring ?? normalizeAuthoringDocument(compiled.definition)
      const expansion = await expandWithLoader(tx as unknown as Db, input.targetId, authoring, 'preview', true)
      if (expansion.ok) await saveValidationSubjectTx(tx as unknown as Db, versionId, await draftValidationSubject(tx as unknown as Db, input.targetId, id, authoring, expansion))
      await recordAudit(
        tx as unknown as Db,
        input.actor,
        'scenario.create',
        'scenario',
        id,
        `创建了 ${compiled.definition.steps.length} 步的场景「${input.name}」`,
      )
    })
  } catch (error) {
    if (isUniqueViolation(error)) {
      const occupied = await deletedOccupancyMessage(db, 'scenario_name', {
        targetId: input.targetId,
        name: input.name,
      })
      if (occupied) throw conflict('SCENARIO_NAME_CONFLICT', occupied)
    }
    rethrow(error)
  }
  const detail = await getScenario(db, id, input)
  if (!detail.latestVersionId || !detail.latestVersionNo) throw notFound('SCENARIO_VERSION_NOT_FOUND', '新建发布版本不可读取')
  return { ...detail, latestVersionId: detail.latestVersionId, latestVersionNo: detail.latestVersionNo }
}

/**
 * 复制为同一目标系统下的独立新场景：草稿与最新发布版本原样带过去（节点 id 不变，不重新编译），
 * 连同地图绑定、模块引用、报告配置与推送策略。运行事实、调度、套件与批量任务不复制。
 */
export async function copyScenario(
  db: Db,
  sourceScenarioId: string,
  input: { actor: AuditActor },
): Promise<CopyScenarioResponse> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const copied = await db.transaction((tx) => copyScenarioTx(tx as unknown as Db, sourceScenarioId, input.actor))
      return copyScenarioResponseSchema.parse({ ...(await getScenario(db, copied.id)), notCopied: copied.notCopied })
    } catch (error) {
      // 并发复制同一原名会抢到同一序号：整笔重来，下一轮能读到对方已占用的名字
      if (attempt < 3 && isUniqueViolation(error) && constraintName(error) === 'scenarios_target_name_idx') continue
      rethrow(error)
    }
  }
}

async function copyScenarioTx(
  tx: Db,
  sourceScenarioId: string,
  actor: AuditActor,
): Promise<{ id: string; notCopied: ScenarioCopyNotCopied[] }> {
  const {
    mapScenarioBindings,
    scenarioDrafts,
    scenarioModuleRefs,
    scenarioOutboundPolicies,
    scenarioReportDefaults,
    scenarioValidationSubjects,
    scenarioVersions,
    scenarios,
  } = schemaFor(tx)
  await shareConsoleAuthorization(tx, actor.id)
  // 共享锁挡住同时保存草稿或发布，读到的草稿与发布版本是同一时刻的；不挡该场景新建运行
  const [source] = await lockedShared(
    tx,
    tx.select().from(scenarios).where(and(eq(scenarios.id, sourceScenarioId), isNull(scenarios.deletedAt))).limit(1),
  )
  if (!source) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
  await assertTargetPermission(tx, actor.id, source.targetId, 'workflow:write')
  if ((source.purpose ?? 'user') !== 'user') throw badRequest('SCENARIO_COPY_UNSUPPORTED', '只能复制普通场景')
  const target = await loadTargetContext(tx, source.targetId)
  if (!target.exists) throw notFound('TARGET_NOT_FOUND', '目标系统不存在')
  if (target.status === 'disabled') throw conflict('TARGET_DISABLED', '目标系统已停用，不能复制场景')
  const [draft] = await tx.select().from(scenarioDrafts).where(eq(scenarioDrafts.scenarioId, source.id)).limit(1)
  if (!draft) throw notFound('SCENARIO_NOT_FOUND', '场景草稿不存在')
  const latest = await latestPublishedVersion(tx, source.id)

  // 已删除场景的名字仍占唯一约束，编号时一并避开
  const names = await tx.select({ name: scenarios.name }).from(scenarios).where(eq(scenarios.targetId, source.targetId))
  const name = scenarioCopyName(source.name, names.map((row) => row.name))
  const id = newId()
  const versionId = newId()
  const now = new Date()
  await tx.insert(scenarios).values({
    id,
    targetId: source.targetId,
    name,
    status: 'active',
    purpose: 'user',
    // 运行账号是场景级配置，随复制带过去。
    runAccountId: source.runAccountId ?? null,
    createdByConsoleAccountId: actor.id,
    createdAt: now,
    updatedAt: now,
  })
  await tx.insert(scenarioVersions).values({
    id: versionId,
    scenarioId: id,
    versionNo: 1,
    kind: 'published',
    definition: latest.definition,
    compilerVersion: latest.compilerVersion,
    sourceDigest: latest.sourceDigest,
    authoringDocument: latest.authoringDocument,
    moduleManifest: latest.moduleManifest,
    createdByConsoleAccountId: actor.id,
    createdAt: now,
  })
  await tx.insert(scenarioDrafts).values({
    scenarioId: id,
    revision: 1,
    document: draft.document,
    updatedByConsoleAccountId: actor.id,
    updatedAt: now,
  })
  // 校验主体只由编排内容决定，与场景 id 无关；验证样本（试跑）不复制，副本从未验证起步
  const [subject] = await tx
    .select()
    .from(scenarioValidationSubjects)
    .where(eq(scenarioValidationSubjects.scenarioVersionId, latest.id))
    .limit(1)
  if (subject) {
    await tx.insert(scenarioValidationSubjects).values({
      scenarioVersionId: versionId,
      protocolVersion: subject.protocolVersion,
      subjectDigest: subject.subjectDigest,
      createdAt: now,
    })
  }
  const refs = await tx
    .select()
    .from(scenarioModuleRefs)
    .where(
      and(
        eq(scenarioModuleRefs.scenarioId, source.id),
        or(isNull(scenarioModuleRefs.scenarioVersionId), eq(scenarioModuleRefs.scenarioVersionId, latest.id)),
      ),
    )
  for (const ref of refs) {
    await tx.insert(scenarioModuleRefs).values({
      id: newId(),
      scenarioId: id,
      scenarioVersionId: ref.scenarioVersionId === null ? null : versionId,
      invocationId: ref.invocationId,
      moduleId: ref.moduleId,
      moduleVersionId: ref.moduleVersionId,
      createdAt: now,
    })
  }
  const bindings = await tx
    .select()
    .from(mapScenarioBindings)
    .where(
      and(
        eq(mapScenarioBindings.scenarioId, source.id),
        eq(mapScenarioBindings.targetId, source.targetId),
        eq(mapScenarioBindings.status, 'active'),
        or(eq(mapScenarioBindings.versionSlot, 'draft'), eq(mapScenarioBindings.versionSlot, latest.id)),
      ),
    )
  for (const row of bindings) {
    const draftSlot = row.versionSlot === 'draft'
    await tx.insert(mapScenarioBindings).values({
      ...row,
      id: newId(),
      scenarioId: id,
      draftRevision: draftSlot ? 1 : null,
      scenarioVersionId: draftSlot ? null : versionId,
      versionSlot: draftSlot ? 'draft' : versionId,
      createdAt: now,
      updatedAt: now,
    })
  }

  // 推送策略与自动报告各有额外权限门槛，复制不能绕过：缺权限的项不带过去并如实返回
  const grants = await loadAccountGrants(tx, actor.id)
  const allows = (permission: string) => {
    const scope = scopeFromGrants(grants, permission)
    return scope.all || scope.ids.includes(source.targetId)
  }
  const notCopied: ScenarioCopyNotCopied[] = []
  const [report] = await tx
    .select()
    .from(scenarioReportDefaults)
    .where(eq(scenarioReportDefaults.scenarioId, source.id))
    .limit(1)
  if (report) {
    let outputPolicy = report.outputPolicy
    if (outputPolicy?.autoGenerateReport && !allows('report:export')) {
      outputPolicy = { ...outputPolicy, autoGenerateReport: false }
      notCopied.push({ item: 'auto_report', reason: '缺少报告导出权限，副本未开启自动生成报告' })
    }
    await tx.insert(scenarioReportDefaults).values({ scenarioId: id, profileId: report.profileId, revision: 1, outputPolicy })
  }
  const [outbound] = await tx
    .select()
    .from(scenarioOutboundPolicies)
    .where(eq(scenarioOutboundPolicies.scenarioId, source.id))
    .limit(1)
  if (outbound) {
    if (outbound.policy.enabled && !allows('run:read')) {
      notCopied.push({ item: 'outbound_policy', reason: '缺少运行查看权限，副本未复制消息推送设置' })
    } else {
      await tx.insert(scenarioOutboundPolicies).values({
        scenarioId: id,
        revision: 1,
        policy: outbound.policy,
        updatedBy: actor.id,
        updatedAt: now,
      })
    }
  }

  await recordAudit(
    tx,
    actor,
    'scenario.create',
    'scenario',
    id,
    `复制场景「${source.name}」（草稿 r${draft.revision}，发布版本 ${publishedVersionNo(latest)}）为「${name}」`,
  )
  return { id, notCopied }
}

export async function updateScenarioMeta(
  db: Db,
  scenarioId: string,
  input: { name?: string; status?: ScenarioStatus; runAccountId?: string | null; actor: AuditActor },
): Promise<ScenarioDetailDto> {
  const { scenarios } = schemaFor(db)
  const [current] = await db
    .select()
    .from(scenarios)
    .where(and(eq(scenarios.id, scenarioId), isNull(scenarios.deletedAt)))
    .limit(1)
  if (!current) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
  const now = new Date()
  try {
    await db.transaction(async (tx) => {
      if (input.runAccountId) await assertRunAccountChoice(tx as unknown as Db, current.targetId, input.runAccountId)
      await tx
        .update(scenarios)
        .set({
          name: input.name ?? current.name,
          status: input.status ?? current.status,
          runAccountId: input.runAccountId === undefined ? current.runAccountId : input.runAccountId,
          updatedAt: now,
        })
        .where(eq(scenarios.id, scenarioId))
      if (input.runAccountId !== undefined && input.runAccountId !== (current.runAccountId ?? null)) {
        await recordAudit(
          tx as unknown as Db,
          input.actor,
          'scenario.update',
          'scenario',
          scenarioId,
          input.runAccountId ? '修改了运行账号' : '运行账号改为跟随目标默认',
        )
      }
      if (input.name !== undefined && input.name !== current.name) {
        await recordAudit(
          tx as unknown as Db,
          input.actor,
          'scenario.update',
          'scenario',
          scenarioId,
          `改名为 ${input.name}`,
        )
      }
      if (input.status !== undefined && input.status !== current.status) {
        await recordAudit(
          tx as unknown as Db,
          input.actor,
          'scenario.update',
          'scenario',
          scenarioId,
          input.status === 'disabled' ? '停用' : '启用',
        )
      }
    })
  } catch (error) {
    if (isUniqueViolation(error) && input.name) {
      const occupied = await deletedOccupancyMessage(db, 'scenario_name', {
        targetId: current.targetId,
        name: input.name,
      })
      if (occupied) throw conflict('SCENARIO_NAME_CONFLICT', occupied)
    }
    rethrow(error)
  }
  return getScenario(db, scenarioId)
}

export async function appendScenarioVersion(
  db: Db,
  scenarioId: string,
  input: { steps: Step[]; inputs?: ScenarioInputDecl[]; outputs?: ScenarioOutputDecl; actor: AuditActor; executableTypes?: readonly string[] },
): Promise<ScenarioDetailDto> {
  const { scenarioVersions, scenarios } = schemaFor(db)
  const document = parseDocument(scenarioDefinitionFromSteps(input.steps, input.inputs ?? [], input.outputs))
  const now = new Date()
  try {
    await db.transaction(async (tx) => {
      const [current] = await locked(
        tx,
        tx.select().from(scenarios).where(and(eq(scenarios.id, scenarioId), isNull(scenarios.deletedAt))).limit(1),
      )
      if (!current) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
      const target = await loadTargetContext(tx as unknown as Db, current.targetId)
      throwIfBlocked(
        compileDocument(document, target, 'release', {
          executableTypes: input.executableTypes,
          resolution: await compileResolutionFromPlatform(tx as unknown as Db, current.targetId),
        }),
      )
      const latest = await findLatestPublishedVersion(tx as unknown as Db, scenarioId)
      const versionNo = latest ? publishedVersionNo(latest) + 1 : 1
      const versionId = newId()
      await tx.insert(scenarioVersions).values({
        id: versionId,
        scenarioId,
        versionNo,
        kind: 'published',
        definition: document,
        compilerVersion: COMPILER_VERSION,
        sourceDigest: sourceDocumentDigest(document),
        createdByConsoleAccountId: input.actor.id,
        createdAt: now,
      })
      const authoring = normalizeAuthoringDocument(document)
      const expansion = await expandWithLoader(tx as unknown as Db, current.targetId, authoring, 'preview', true)
      await saveValidationSubjectTx(tx as unknown as Db, versionId, await draftValidationSubject(tx as unknown as Db, current.targetId, scenarioId, authoring, expansion))
      await freezeMapDraftBindingsTx(tx as unknown as Db, { scenarioId, targetId: current.targetId, scenarioVersionId: versionId })
      await tx.update(scenarios).set({ updatedAt: now }).where(eq(scenarios.id, scenarioId))
      await recordAudit(
        tx as unknown as Db,
        input.actor,
        'scenario.update',
        'scenario',
        scenarioId,
        `追加了 ${document.steps.length} 步的版本 ${versionNo}`,
      )
    })
  } catch (error) {
    rethrow(error)
  }
  return getScenario(db, scenarioId, input)
}

export async function saveScenarioDraft(
  db: Db,
  scenarioId: string,
  input: { revision: number; document: unknown; actor: AuditActor; scopeActorId?: string; scopePermission?: string },
): Promise<ScenarioDetailDto> {
  const { scenarioDrafts, scenarios } = schemaFor(db)
  const document = normalizeAuthoringDocument(input.document)
  const now = new Date()
  try {
    await db.transaction(async (tx) => {
      if (input.scopeActorId) await lockConsoleAuthorization(tx as unknown as Db, input.scopeActorId)
      const [current] = await locked(
        tx,
        tx.select().from(scenarios).where(and(eq(scenarios.id, scenarioId), isNull(scenarios.deletedAt))).limit(1),
      )
      if (!current) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
      if (input.scopeActorId) {
        await assertTargetPermission(tx as unknown as Db, input.scopeActorId, current.targetId, input.scopePermission ?? 'workflow:write')
      }
      const [draft] = await locked(
        tx,
        tx.select().from(scenarioDrafts).where(eq(scenarioDrafts.scenarioId, scenarioId)).limit(1),
      )
      if (!draft) throw notFound('SCENARIO_NOT_FOUND', '场景草稿不存在')
      if (draft.revision !== input.revision) {
        throw conflict('SCENARIO_DRAFT_CONFLICT', '草稿已被他人更新', {
          revision: draft.revision,
          document: draft.document,
        })
      }
      const target = await loadTargetContext(tx as unknown as Db, current.targetId)
      const existingDoc = normalizeAuthoringDocument(draft.document)
      if (authoringHasModuleInvocations(existingDoc) && !isAuthoringDocumentV2(input.document)) {
        throw badRequest(
          'AUTHORING_SCHEMA_UNSUPPORTED',
          '草稿已包含动作模块调用，旧客户端不能覆盖为 V1 文档。请更新编辑器。',
        )
      }
      if (authoringHasOutcomes(existingDoc) && !isAuthoringDocumentV2(input.document)) {
        throw badRequest(
          'AUTHORING_SCHEMA_UNSUPPORTED',
          '草稿已包含成功条件或运行期约束，旧客户端不能覆盖为 V1 文档。请更新编辑器。',
        )
      }
      await reconcileMapDraftBindingsTx(tx as unknown as Db, {
        scenarioId,
        targetId: current.targetId,
        revision: draft.revision + 1,
        document,
      })
      await tx
        .update(scenarioDrafts)
        .set({
          revision: draft.revision + 1,
          document: document as any,
          updatedByConsoleAccountId: input.actor.id,
          updatedAt: now,
        })
        .where(eq(scenarioDrafts.scenarioId, scenarioId))
      await tx.update(scenarios).set({ updatedAt: now }).where(eq(scenarios.id, scenarioId))
      await syncScenarioModuleRefsTx(tx as unknown as Db, scenarioId, null, document)
      await recordAudit(
        tx as unknown as Db,
        input.actor,
        'scenario.update',
        'scenario',
        scenarioId,
        `保存草稿 r${draft.revision + 1}`,
      )
    })
  } catch (error) {
    rethrow(error)
  }
  return getScenario(db, scenarioId)
}

export async function publishScenarioDraft(
  db: Db,
  scenarioId: string,
  input: { revision: number; actor: AuditActor; executableTypes?: readonly string[] },
): Promise<ScenarioDetailDto> {
  const { scenarioDrafts, scenarioVersions, scenarios } = schemaFor(db)
  const now = new Date()
  try {
    await db.transaction(async (tx) => {
      const [current] = await locked(
        tx,
        tx.select().from(scenarios).where(and(eq(scenarios.id, scenarioId), isNull(scenarios.deletedAt))).limit(1),
      )
      if (!current) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
      if (current.status === 'disabled') throw conflict('SCENARIO_DISABLED', '场景已停用，不能发布')
      const [draft] = await locked(
        tx,
        tx.select().from(scenarioDrafts).where(eq(scenarioDrafts.scenarioId, scenarioId)).limit(1),
      )
      if (!draft) throw notFound('SCENARIO_NOT_FOUND', '场景草稿不存在')
      if (draft.revision !== input.revision) {
        throw conflict('SCENARIO_DRAFT_CONFLICT', '草稿已被他人更新', {
          revision: draft.revision,
          document: draft.document,
        })
      }
      const target = await loadTargetContext(tx as unknown as Db, current.targetId)
      if (target.status === 'disabled')
        throw conflict('TARGET_DISABLED', '目标系统已停用，不能发布')
      const authoringDoc = normalizeAuthoringDocument(draft.document)
      const expandResult = await expandWithLoader(tx as unknown as Db, current.targetId, authoringDoc, 'publish', false)
      if (!expandResult.ok) {
        throw badRequest('SCENARIO_COMPILE_BLOCKED', '场景编译未通过', {
          diagnostics: expandResult.diagnostics,
        })
      }
      const compiled = throwIfBlocked(
        compileDocument(
          expandResult.definition!,
          target,
          'release',
          {
            executableTypes: input.executableTypes,
            resolution: await compileResolutionFromPlatform(tx as unknown as Db, current.targetId),
          },
          expandResult.outcomeManifest ?? { entries: [] },
        ),
      )
      const latest = await findLatestPublishedVersion(tx as unknown as Db, scenarioId)
      const validationDigest = await draftValidationSubject(tx as unknown as Db, current.targetId, scenarioId, authoringDoc, expandResult)
      const { scenarioValidationSubjects } = schemaFor(tx)
      const [latestSubject] = latest ? await tx.select().from(scenarioValidationSubjects).where(eq(scenarioValidationSubjects.scenarioVersionId, latest.id)).limit(1) : []
      if (
        latest && latestSubject?.subjectDigest === validationDigest &&
        sourceDocumentDigest(compiled.definition) === sourceDocumentDigest(latest.definition) &&
        authoringExtrasDigest({ authoringDocument: authoringDoc, definition: compiled.definition }) ===
          authoringExtrasDigest({
            authoringDocument: latest.authoringDocument ?? null,
            definition: latest.definition,
          })
      ) {
        return
      }
      const versionNo = latest ? publishedVersionNo(latest) + 1 : 1
      const versionId = newId()
      const digest =
        expandResult.manifest.entries.length > 0
          ? expandResult.sourceDigest
          : sourceDocumentDigest(compiled.definition)
      await tx.insert(scenarioVersions).values({
        id: versionId,
        scenarioId,
        versionNo,
        kind: 'published',
        definition: compiled.definition,
        compilerVersion: COMPILER_VERSION,
        sourceDigest: digest,
        authoringDocument: authoringDoc,
        // 无模块调用时不落 manifest：旧 Worker 严格解析快照，空 manifest 也会被拒
        moduleManifest: expandResult.manifest.entries.length > 0 ? expandResult.manifest : null,
        createdByConsoleAccountId: input.actor.id,
        createdAt: now,
      })
      await syncScenarioModuleRefsTx(tx as unknown as Db, scenarioId, versionId, authoringDoc)
      await saveValidationSubjectTx(tx as unknown as Db, versionId, validationDigest)
      await freezeMapDraftBindingsTx(tx as unknown as Db, {
        scenarioId,
        targetId: current.targetId,
        scenarioVersionId: versionId,
      })
      await expireRepairCandidatesOnPublishTx(tx, scenarioId, authoringDoc)
      await tx.update(scenarios).set({ updatedAt: now }).where(eq(scenarios.id, scenarioId))
      await recordAudit(
        tx as unknown as Db,
        input.actor,
        'scenario.update',
        'scenario',
        scenarioId,
        `发布版本 ${versionNo}`,
      )
    })
  } catch (error) {
    rethrow(error)
  }
  return getScenario(db, scenarioId, input)
}

export async function prepareTrialVersion(
  db: Db,
  scenarioId: string,
  input: {
    revision: number
    runInput: Readonly<Record<string, unknown>>
    actor: AuditActor
    executableTypes?: readonly string[]
    overrideDocument?: unknown
  },
): Promise<{ versionId: string }> {
  const { scenarioDrafts, scenarioVersions, scenarios } = schemaFor(db)
  const now = new Date()
  let versionId = ''
  try {
    await atomic(db, async (tx) => {
      await lockConsoleAuthorization(tx as unknown as Db, input.actor.id)
      const [current] = await locked(
        tx,
        tx.select().from(scenarios).where(and(eq(scenarios.id, scenarioId), isNull(scenarios.deletedAt))).limit(1),
      )
      if (!current) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
      if (current.status === 'disabled') throw conflict('SCENARIO_DISABLED', '场景已停用，不能试跑')
      const [draft] = await locked(
        tx,
        tx.select().from(scenarioDrafts).where(eq(scenarioDrafts.scenarioId, scenarioId)).limit(1),
      )
      if (!draft) throw notFound('SCENARIO_NOT_FOUND', '场景草稿不存在')
      if (draft.revision !== input.revision) {
        throw conflict('SCENARIO_DRAFT_CONFLICT', '草稿已被他人更新', {
          revision: draft.revision,
          document: draft.document,
        })
      }
      const target = await loadTargetContext(tx as unknown as Db, current.targetId)
      if (!target.exists) throw notFound('TARGET_NOT_FOUND', '目标系统不存在')
      if (target.status === 'disabled')
        throw conflict('TARGET_DISABLED', '目标系统已停用，不能试跑')
      const authoringDoc = normalizeAuthoringDocument(input.overrideDocument ?? draft.document)
      const expandResult = await expandWithLoader(tx as unknown as Db, current.targetId, authoringDoc, 'trial', true)
      if (!expandResult.ok) {
        throw badRequest('SCENARIO_COMPILE_BLOCKED', '试跑编译未通过', {
          diagnostics: expandResult.diagnostics,
        })
      }
      const trialResolution = await compileResolutionFromPlatform(tx as unknown as Db, current.targetId)
      const compiled = throwIfBlocked(
        compileDocument(
          expandResult.definition!,
          target,
          'release',
          {
            executableTypes: input.executableTypes,
            resolution: trialResolution,
          },
          expandResult.outcomeManifest ?? { entries: [] },
        ),
      )
      try {
        assertRunFromResolved(compiled.definition.steps, input.runInput)
      } catch (error) {
        if (error instanceof ScenarioValidationError) throw badRequest(error.code, error.message)
        throw error
      }
      const { getOrCreatePlatformConfig } = await import('../platform-config/store.js')
      const platform = await getOrCreatePlatformConfig(tx as unknown as Db)
      if (stepsNeedLocatorAiExecute({
        steps: compiled.definition.steps,
        document: platform.document,
        target: trialResolution.locatorTarget,
        scenarioPlan: compiled.definition.locatorPlan,
      })) {
        const scope = await targetScopeFor(tx as unknown as Db, input.actor.id, 'ai:execute')
        if (!scope.all && !scope.ids.includes(current.targetId)) throw forbidden('AI_EXECUTE_FORBIDDEN', '缺少 ai:execute，不能运行含 AI 步骤或 AI 解析档位的场景')
      }
      const validationDigest = await draftValidationSubject(tx as unknown as Db, current.targetId, scenarioId, authoringDoc, expandResult)
      const digest = syncSha256(canonicalJson({ protocolVersion: 'trialSourceDigest@2', sourceDigest: expandResult.sourceDigest, validationSubjectDigest: validationDigest }))
      const [existing] = await tx
        .select()
        .from(scenarioVersions)
        .where(
          and(
            eq(scenarioVersions.scenarioId, scenarioId),
            eq(scenarioVersions.kind, 'trial'),
            eq(scenarioVersions.sourceDigest, digest),
          ),
        )
        .limit(1)
      let created = false
      if (existing) {
        versionId = existing.id
      } else {
        versionId = newId()
        try {
          await tx.insert(scenarioVersions).values({
            id: versionId,
            scenarioId,
            versionNo: null,
            kind: 'trial',
            definition: compiled.definition,
            compilerVersion: COMPILER_VERSION,
            sourceDigest: digest,
            authoringDocument: authoringDoc,
            moduleManifest:
              expandResult.manifest.entries.length > 0 ? expandResult.manifest : null,
            createdByConsoleAccountId: input.actor.id,
            createdAt: now,
          })
          created = true
        } catch (error) {
          const mapped = mapRestriction(error)
          if (mapped?.code === 'SCENARIO_NAME_CONFLICT') throw mapped
          const [again] = await tx
            .select()
            .from(scenarioVersions)
            .where(
              and(
                eq(scenarioVersions.scenarioId, scenarioId),
                eq(scenarioVersions.kind, 'trial'),
                eq(scenarioVersions.sourceDigest, digest),
              ),
            )
            .limit(1)
          if (!again) throw error
          versionId = again.id
        }
      }
      if (created) {
        await saveValidationSubjectTx(tx as unknown as Db, versionId, validationDigest)
        await syncScenarioModuleRefsTx(tx as unknown as Db, scenarioId, versionId, authoringDoc)
        await freezeMapDraftBindingsTx(tx as unknown as Db, { scenarioId, targetId: current.targetId, scenarioVersionId: versionId })
        await recordAudit(
          tx as unknown as Db,
          input.actor,
          'scenario.update',
          'scenario',
          scenarioId,
          '创建试跑版本',
        )
      }
    })
  } catch (error) {
    rethrow(error)
  }
  return { versionId }
}

export async function previewDeleteScenario(
  db: Db,
  scenarioId: string,
): Promise<DeletePreviewResponse> {
  const { scenarios, runs } = schemaFor(db)
  const [current] = await db
    .select()
    .from(scenarios)
    .where(and(eq(scenarios.id, scenarioId), isNull(scenarios.deletedAt)))
    .limit(1)
  if (!current) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')

  const scenarioRuns = await db
    .select({ id: runs.id, status: runs.status })
    .from(runs)
    .where(and(eq(runs.scenarioId, scenarioId), isNull(runs.deletedAt)))

  const activeRuns = scenarioRuns.filter((r) => ACTIVE_RUN_STATUSES.includes(r.status as any))
  const referenced = await suitesReferencingScenario(db, {
    targetId: current.targetId,
    scenarioId,
  })

  return deletePreviewResponseSchema.parse({
    previewToken: newId(),
    counts: {
      runs: scenarioRuns.length,
      suites: referenced.length,
    },
    blockers: [...activeRunBlockers(activeRuns), ...suiteReferenceBlockers(referenced)],
  })
}

export async function deleteScenario(
  db: Db,
  scenarioId: string,
  actor: AuditActor,
  input: DeleteResourceBody = {},
): Promise<DeleteResourceResult> {
  const { scenarios, runs } = schemaFor(db)
  try {
    return await db.transaction(async (tx) => {
      const [current] = await locked(tx, tx.select().from(scenarios).where(eq(scenarios.id, scenarioId)))
      if (!current) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
      if (current.deletedAt && current.deletedBy) {
        return toDeleteResult({
          id: scenarioId,
          deletedAt: current.deletedAt,
          deletedBy: current.deletedBy,
        })
      }
      const activeRuns = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.scenarioId, scenarioId),
            inArray(runs.status, ACTIVE_RUN_STATUSES as any),
            isNull(runs.deletedAt),
          ),
        )
        .limit(1)
      if (activeRuns.length > 0) {
        throw conflict('RUN_NOT_TERMINAL', '该场景存在运行中的任务，请先等待完成或取消')
      }
      const referenced = await suitesReferencingScenario(tx as unknown as Db, {
        targetId: current.targetId,
        scenarioId,
      })
      if (referenced.length > 0) {
        throw conflict('SCENARIO_IN_SUITE', suiteReferenceBlockers(referenced)[0]!.message)
      }
      await assertResourceIdle(tx as unknown as Db, { scenarioId })
      const [runCount] = await tx
        .select({ value: count() })
        .from(runs)
        .where(and(eq(runs.scenarioId, scenarioId), isNull(runs.deletedAt)))
      assertExpectedCounts({ runs: Number(runCount?.value ?? 0) }, input.expectedCounts)

      const now = new Date()
      const deletedBy = await snapshotDeletedBy(tx as unknown as Db, actor)
      await closeOpenBindings(tx as unknown as Db, { scenarioId }, now)
      await tx
        .update(scenarios)
        .set({ deletedAt: now, deletedBy, updatedAt: now })
        .where(eq(scenarios.id, scenarioId))
      await recordAudit(
        tx as unknown as Db,
        actor,
        'scenario.delete',
        'scenario',
        scenarioId,
        `删除场景 ${current.name}：保留历史运行 ${Number(runCount?.value ?? 0)} 条`,
      )
      return toDeleteResult({ id: scenarioId, deletedAt: now, deletedBy })
    })
  } catch (error) {
    rethrow(error)
  }
}

export async function countRunsForScenario(db: Db, scenarioId: string): Promise<number> {
  const { runs } = schemaFor(db)
  const [row] = await db.select({ n: count() }).from(runs).where(eq(runs.scenarioId, scenarioId))
  return Number(row?.n ?? 0)
}

export async function countScenariosForTarget(db: Db, targetId: string): Promise<number> {
  const { scenarios } = schemaFor(db)
  const [row] = await db
    .select({ n: count() })
    .from(scenarios)
    .where(eq(scenarios.targetId, targetId))
  return Number(row?.n ?? 0)
}

export async function loadScenarioVersion(
  db: Db,
  scenarioId: string,
  versionId?: string,
): Promise<{ scenario: ScenarioRow; version: ScenarioVersionRow }> {
  const { scenarioVersions, scenarios } = schemaFor(db)
  const [scenario] = await db.select().from(scenarios).where(eq(scenarios.id, scenarioId)).limit(1)
  if (!scenario || scenario.deletedAt) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
  if (versionId) {
    const [version] = await db
      .select()
      .from(scenarioVersions)
      .where(eq(scenarioVersions.id, versionId))
      .limit(1)
    if (!version || version.scenarioId !== scenarioId) {
      throw notFound('SCENARIO_VERSION_NOT_FOUND', '场景版本不存在')
    }
    return { scenario, version }
  }
  return { scenario, version: await latestPublishedVersion(db, scenarioId) }
}

function isZodError(error: unknown): error is { issues: { message: string }[] } {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: string }).name === 'ZodError' &&
    Array.isArray((error as { issues?: unknown }).issues)
  )
}

/** 测试夹具仍可走仓库函数发布；HTTP 不再接收 steps。 */
export function validateDefinition(steps: Step[]): ScenarioDefinition {
  try {
    return validateScenarioDefinition(scenarioDefinitionFromSteps(steps))
  } catch (error) {
    if (error instanceof ScenarioValidationError) throw badRequest(error.code, error.message)
    if (isZodError(error)) {
      throw badRequest('BAD_REQUEST', error.issues[0]?.message ?? '场景定义不合法')
    }
    throw error
  }
}

export async function previewScenarioExpansion(
  db: Db,
  scenarioId: string,
  input?: { document?: unknown },
): Promise<{
  definition: ScenarioDefinition
  manifest?: ModuleManifest
  diagnostics: CompileDiagnostic[]
}> {
  const { scenarios, scenarioDrafts } = schemaFor(db)
  const [current] = await db
    .select()
    .from(scenarios)
    .where(and(eq(scenarios.id, scenarioId), isNull(scenarios.deletedAt)))
    .limit(1)
  if (!current) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')

  let rawDoc = input?.document
  if (!rawDoc) {
    const [draft] = await db
      .select()
      .from(scenarioDrafts)
      .where(eq(scenarioDrafts.scenarioId, scenarioId))
      .limit(1)
    if (!draft) throw notFound('SCENARIO_NOT_FOUND', '场景草稿不存在')
    rawDoc = draft.document
  }
  const authoringDoc = normalizeAuthoringDocument(rawDoc)
  const result = await expandWithLoader(db, current.targetId, authoringDoc, 'preview', true)
  return {
    definition: result.definition!,
    manifest: result.manifest,
    diagnostics: result.diagnostics,
  }
}

export async function inlineScenarioModuleInvocation(
  db: Db,
  scenarioId: string,
  invocationId: string,
  input: { revision: number; actor: AuditActor },
): Promise<ScenarioDetailDto> {
  const { scenarioDrafts, scenarios } = schemaFor(db)
  const now = new Date()
  try {
    await db.transaction(async (tx) => {
      const [current] = await locked(
        tx,
        tx
          .select()
          .from(scenarios)
          .where(and(eq(scenarios.id, scenarioId), isNull(scenarios.deletedAt)))
          .limit(1),
      )
      if (!current) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
      const [draft] = await locked(
        tx,
        tx
          .select()
          .from(scenarioDrafts)
          .where(eq(scenarioDrafts.scenarioId, scenarioId))
          .limit(1),
      )
      if (!draft) throw notFound('SCENARIO_NOT_FOUND', '场景草稿不存在')
      if (draft.revision !== input.revision) {
        throw conflict('SCENARIO_DRAFT_CONFLICT', '草稿已被他人更新', {
          revision: draft.revision,
          document: draft.document,
        })
      }
      const authoringDoc = normalizeAuthoringDocument(draft.document)
      const loc = locateNode(authoringDoc, invocationId)
      if (!loc) {
        throw notFound('NODE_NOT_FOUND', '指定的动作模块调用节点不存在')
      }
      const invocationItem = walkAuthoringNodes(authoringDoc).find((item) => item.id === invocationId)
      if (!invocationItem || invocationItem.node.kind !== 'module') {
        throw notFound('NODE_NOT_FOUND', '指定的动作模块调用节点不存在')
      }
      const invocationNode = invocationItem.node
      // 必须展开整篇文档：单独展开这一个调用会让调用序号回到 0，
      // 展开出来的步骤与绑定会和文档里其余调用对不上。
      const expanded = await expandWithLoader(
        tx as unknown as Db,
        current.targetId,
        authoringDoc,
        'preview',
        true,
      )
      if (!expanded.ok) {
        throw badRequest('SCENARIO_COMPILE_BLOCKED', '内联展开失败', {
          diagnostics: expanded.diagnostics,
        })
      }
      const entry = expanded.manifest.entries.find((item) => item.invocationId === invocationId)
      if (!entry) throw notFound('NODE_NOT_FOUND', '指定的动作模块调用节点不存在')
      const expandedById = new Map(expanded.definition!.steps.map((step) => [step.id, step]))

      // 内联后这些 outputKey 进入场景命名空间并长期存在，不能继续占用 `m{序号}_`：
      // 剩余调用会重新编号，迟早撞上同名键。改用调用自身派生的前缀。
      const exposedKeys = new Set(Object.values(invocationNode.outputBindings))
      const inlinePrefix = `i${invocationId.replace(/-/g, '').slice(0, 8)}_`
      const privateRenames = new Map<string, string>()
      for (const stepId of entry.expandedStepIds) {
        const key = expandedById.get(stepId)?.outputKey
        if (key && !exposedKeys.has(key)) {
          privateRenames.set(key, `${inlinePrefix}${key}`.slice(0, 128))
        }
      }

      const inlinedNodes: ScenarioAuthoringDocumentV2['nodes'] = entry.expandedStepIds.map((stepId) => {
        const step = structuredClone(expandedById.get(stepId)!)
        if (step.outputKey && privateRenames.has(step.outputKey)) {
          step.outputKey = privateRenames.get(step.outputKey)!
        }
        const stepInput = step.input as { from?: string }
        if (typeof stepInput.from === 'string' && privateRenames.has(stepInput.from)) {
          stepInput.from = privateRenames.get(stepInput.from)!
        }
        return {
          kind: 'step' as const,
          step,
          ...(invocationNode.moduleVersionId
            ? {
                origin: {
                  moduleVersionId: invocationNode.moduleVersionId,
                  invocationId,
                },
              }
            : {}),
        }
      })

      let updatedDoc = authoringDoc
      if (inlinedNodes.length > 0) {
        updatedDoc = replaceNode(updatedDoc, invocationId, inlinedNodes[0]!)
        let prevAnchor = authoringNodeId(inlinedNodes[0]!)
        for (let i = 1; i < inlinedNodes.length; i++) {
          updatedDoc = insertNodeAfter(updatedDoc, prevAnchor, inlinedNodes[i]!)
          prevAnchor = authoringNodeId(inlinedNodes[i]!)
        }
      } else {
        updatedDoc = removeNode(updatedDoc, invocationId)
      }
      const totalNodes = walkAuthoringNodes(updatedDoc).length
      if (totalNodes > 32) {
        throw badRequest(
          'SCENARIO_STEP_LIMIT_EXCEEDED',
          `内联展开后场景总步骤数达到 ${totalNodes}，超过 32 步上限`,
        )
      }

      const newDoc: ScenarioAuthoringDocumentV2 = updatedDoc

      await tx
        .update(scenarioDrafts)
        .set({
          revision: draft.revision + 1,
          document: newDoc,
          updatedByConsoleAccountId: input.actor.id,
          updatedAt: now,
        })
        .where(eq(scenarioDrafts.scenarioId, scenarioId))
      await tx.update(scenarios).set({ updatedAt: now }).where(eq(scenarios.id, scenarioId))
      await syncScenarioModuleRefsTx(tx as unknown as Db, scenarioId, null, newDoc)
      await recordAudit(
        tx as unknown as Db,
        input.actor,
        'scenario.update',
        'scenario',
        scenarioId,
        `内联展开模块调用节点 ${invocationId}`,
      )
    })
  } catch (error) {
    rethrow(error)
  }
  return getScenario(db, scenarioId)
}

function verificationPlaceholder(name = '验证占位'): ScenarioDefinition {
  return {
    schemaVersion: 1,
    inputs: [],
    steps: [
      {
        id: newId(),
        name,
        type: 'delay',
        effectType: 'READ_ONLY',
        input: { durationMs: 10 },
      },
    ],
  }
}

export async function getOrCreateModuleVerificationScenario(
  db: Db,
  input: {
    moduleId: string
    actor: AuditActor
  },
): Promise<{ scenarioId: string; targetId: string }> {
  const { actionModules, scenarios, scenarioDrafts, scenarioVersions, scenarioModuleRefs } = schemaFor(db)
  const [mod] = await db
    .select()
    .from(actionModules)
    .where(and(eq(actionModules.id, input.moduleId), isNull(actionModules.deletedAt)))
    .limit(1)
  if (!mod) throw notFound('ACTION_MODULE_NOT_FOUND', '动作模块不存在')

  const [byRef] = await db
    .select({ id: scenarios.id, targetId: scenarios.targetId })
    .from(scenarioModuleRefs)
    .innerJoin(scenarios, eq(scenarios.id, scenarioModuleRefs.scenarioId))
    .where(
      and(
        eq(scenarioModuleRefs.moduleId, input.moduleId),
        eq(scenarios.purpose, 'module_verification'),
        isNull(scenarios.deletedAt),
      ),
    )
    .limit(1)
  if (byRef) return { scenarioId: byRef.id, targetId: byRef.targetId }

  const scenarioName = `[验证] ${mod.name} (${mod.key})`
  const [existing] = await db
    .select()
    .from(scenarios)
    .where(
      and(
        eq(scenarios.targetId, mod.targetId),
        eq(scenarios.purpose, 'module_verification'),
        eq(scenarios.name, scenarioName),
        isNull(scenarios.deletedAt),
      ),
    )
    .limit(1)

  if (existing) {
    return { scenarioId: existing.id, targetId: existing.targetId }
  }

  const now = new Date()
  const scenarioId = newId()
  const initialVersionId = newId()
  const placeholder = verificationPlaceholder()
  const draftContent = (mod.draftContent ?? null) as ModuleContent | null
  const initialDoc: ScenarioAuthoringDocumentV2 = draftContent
    ? {
        authoringSchemaVersion: 2,
        schemaVersion: 1,
        inputs: [],
        nodes: [
          {
            kind: 'module',
            invocationId: newId(),
            name: mod.name,
            moduleId: mod.id,
            moduleDraft: {
              moduleId: mod.id,
              revision: mod.draftRevision,
              contentDigest: computeContentDigest(draftContent),
            },
            implementationKey: 'default',
            inputBindings: {},
            outputBindings: {},
          },
        ],
      }
    : normalizeAuthoringDocument(placeholder)

  await db.transaction(async (tx) => {
    await tx.insert(scenarios).values({
      id: scenarioId,
      targetId: mod.targetId,
      name: scenarioName,
      status: 'active',
      purpose: 'module_verification',
      createdByConsoleAccountId: input.actor.id,
      createdAt: now,
      updatedAt: now,
    })
    await tx.insert(scenarioVersions).values({
      id: initialVersionId,
      scenarioId,
      versionNo: 1,
      kind: 'published',
      definition: placeholder,
      compilerVersion: COMPILER_VERSION,
      sourceDigest: sourceDocumentDigest(placeholder),
      createdByConsoleAccountId: input.actor.id,
      createdAt: now,
    })
    await tx.insert(scenarioDrafts).values({
      scenarioId,
      revision: 1,
      document: initialDoc,
      updatedByConsoleAccountId: input.actor.id,
      updatedAt: now,
    })
    await syncScenarioModuleRefsTx(tx as unknown as Db, scenarioId, null, initialDoc)
    await recordAudit(
      tx as unknown as Db,
      input.actor,
      'scenario.create',
      'scenario',
      scenarioId,
      `创建模块验证场景：${scenarioName}`,
    )
  })

  return { scenarioId, targetId: mod.targetId }
}

export async function prepareModuleDraftTrial(
  db: Db,
  moduleId: string,
  input: {
    inputs?: Record<string, JsonValue>
    implementationKey?: string
    actor: AuditActor
  },
): Promise<{ scenarioId: string; revision: number }> {
  const { actionModules, scenarioDrafts, scenarios } = schemaFor(db)
  const [mod] = await db
    .select()
    .from(actionModules)
    .where(and(eq(actionModules.id, moduleId), isNull(actionModules.deletedAt)))
    .limit(1)
  if (!mod) throw notFound('ACTION_MODULE_NOT_FOUND', '动作模块不存在')
  await assertTargetPermission(db, input.actor.id, mod.targetId, 'module:write')
  if (!mod.draftContent) {
    throw badRequest('MODULE_COMPILE_BLOCKED', '模块没有可试跑的草稿')
  }
  const content = mod.draftContent as ModuleContent
  const implementationKey = input.implementationKey ?? 'default'
  if (!content.implementations.some((item) => item.implementationKey === implementationKey)) {
    throw badRequest('MODULE_IMPLEMENTATION_UNKNOWN', `模块没有实现「${implementationKey}」`)
  }
  const contentDigest = computeContentDigest(content)
  const { scenarioId } = await getOrCreateModuleVerificationScenario(db, {
    moduleId,
    actor: input.actor,
  })

  const inputBindings: Record<string, { kind: 'literal'; value: JsonValue }> = {}
  for (const [key, value] of Object.entries(input.inputs ?? {})) {
    inputBindings[key] = { kind: 'literal', value }
  }

  const authoringDoc: ScenarioAuthoringDocumentV2 = {
    authoringSchemaVersion: 2,
    schemaVersion: 1,
    inputs: [],
    nodes: [
      {
        kind: 'module',
        invocationId: newId(),
        name: mod.name,
        moduleId: mod.id,
        moduleDraft: {
          moduleId: mod.id,
          revision: mod.draftRevision,
          contentDigest,
        },
        implementationKey: input.implementationKey ?? 'default',
        inputBindings,
        outputBindings: {},
      },
    ],
  }

  const now = new Date()
  let revision = 1
  await db.transaction(async (tx) => {
    const [draft] = await locked(
      tx,
      tx.select().from(scenarioDrafts).where(eq(scenarioDrafts.scenarioId, scenarioId)).limit(1),
    )
    if (!draft) throw notFound('SCENARIO_NOT_FOUND', '模块验证草稿不存在')
    revision = draft.revision + 1
    await tx
      .update(scenarioDrafts)
      .set({
        revision,
        document: authoringDoc,
        updatedByConsoleAccountId: input.actor.id,
        updatedAt: now,
      })
      .where(eq(scenarioDrafts.scenarioId, scenarioId))
    await tx.update(scenarios).set({ updatedAt: now }).where(eq(scenarios.id, scenarioId))
    await syncScenarioModuleRefsTx(tx as unknown as Db, scenarioId, null, authoringDoc)
    await recordAudit(
      tx as unknown as Db,
      input.actor,
      'scenario.update',
      'scenario',
      scenarioId,
      `写入模块试跑草稿 r${revision}`,
    )
  })
  return { scenarioId, revision }
}
