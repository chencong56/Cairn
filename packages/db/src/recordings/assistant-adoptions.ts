import { and, desc, eq, gte } from 'drizzle-orm'
import {
  assistantRecordingDecisionSchema, assistantRecordingSelectionError, authoringNodeId, authoringSteps, canonicalJson, normalizeAuthoringDocument,
  recordingItemExclusionId, syncSha256, targetDescriptorFromInspectSelector, walkAuthoringNodes,
  type AssistantRecordingDecision, type AssistantRecordingProposalResult, type AuthoringOperation, type LocatorCandidate, type Step, type RecordingAdoptionReceiptDto,
  type RecordingImportReceipt, type RecordingInsertAnchor, type ScenarioAuthoringDocumentV2,
} from '@cairn/shared'
import { applyAuthoringOperations, applyDemonstrationToDocument, previewDemonstration, suggestDemonstration } from '@cairn/authoring'
import type { Db } from '../client.js'
import { locked, schemaFor } from '../native.js'
import { badRequest, conflict, forbidden, notFound } from '../runs/errors.js'
import { newId } from '../id.js'
import { recordAudit, type AuditActor } from '../audit/record.js'
import { assertTargetPermission, lockConsoleAuthorization } from '../console/target-authorization.js'
import { assertRecordingDraftOwner, listRecordingDraftExclusions } from './exclusions.js'
import { compileImportPreview, composeRecordingHandoffDocument, exclusionReasonForItem } from './imports.js'
import { expandWithLoader, syncScenarioModuleRefsTx } from '../runs/scenarios.js'
import { getDemonstration } from './demonstrations.js'

const EMPTY: ScenarioAuthoringDocumentV2 = { authoringSchemaVersion: 2, schemaVersion: 1, inputs: [], nodes: [] }
const digest = (value: unknown) => syncSha256(canonicalJson(value))
function proposalNodeId(proposalId: string, source: string | number) {
  const hex = digest({ proposalId, source })
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** Same normalized item identities and exclusions as the regular recording importer. */
export async function getAssistantRecordingProposalFacts(db: Db, recordingId: string, actorId: string) {
  const row = await assertRecordingDraftOwner(db, recordingId, actorId)
  const exclusions = await listRecordingDraftExclusions(db, recordingId)
  const recordingDigest = digest({ payload: row.payloadDigest, revision: row.revision, exclusions })
  let decisions: AssistantRecordingDecision[]
  const steps = new Map<string, Step>()
  const sourceIdsByItem = new Map<string, string[]>()
  const observedAlternatives = new Map<string, LocatorCandidate[]>()
  let outcomeOptions: NonNullable<AssistantRecordingProposalResult['outcomeOptions']> = []
  if (row.sourceProtocol === 'demonstration@1') {
    const demo = await getDemonstration(db, recordingId, actorId)
    const excluded = new Set(exclusions.map((e) => e.itemId))
    decisions = suggestDemonstration(demo.source).map((item) => {
      sourceIdsByItem.set(item.id, item.sourceIds)
      const keep = !excluded.has(item.id) && item.status === 'mapped' && Boolean(item.step) && !item.outcome
      if (keep && item.step) steps.set(item.id, item.step)
      if (!excluded.has(item.id) && item.outcome) outcomeOptions.push({ itemId: item.id, afterItemId: item.outcome.afterSourceId, meaning: item.outcome.meaning, rule: item.outcome.rule })
      return { itemId: item.id, label: item.step?.name ?? item.id, sourceId: item.id,
        action: keep ? 'keep' : 'exclude', reason: excluded.has(item.id) ? '录制中已排除' : item.outcome ? '成功条件需要先确认预期结果' : keep ? '可转换为步骤' : '待处理，请先在录制详情修正' }
    })
  } else {
    let previousActionId: string | undefined
    decisions = compileImportPreview(row.events, row.sourceVersion, row.name).items.map((item) => {
      const exclusion = exclusionReasonForItem(item, exclusions)
      const keep = !exclusion && item.ready && !item.outcomeCandidate
      const itemId = recordingItemExclusionId(item)
      sourceIdsByItem.set(itemId, item.sourceIndexes.map(String))
      const candidates = item.sourceIndexes.flatMap((index) => {
        const event = row.events[index] as { selector?: unknown } | undefined
        const selector = typeof event?.selector === 'string' ? event.selector.trim() : ''
        // Only complete atomic selectors are equivalent observations. Never flatten chains/frames.
        if (!/^internal:(?:role=[a-z]+\[name="[^"\\]+"i?\]|(?:label|text)="[^"\\]+"i?)$/.test(selector)) return []
        return targetDescriptorFromInspectSelector(selector)?.candidates ?? []
      })
      observedAlternatives.set(itemId, candidates)
      if (keep && item.candidateStep) steps.set(itemId, item.candidateStep)
      if (!exclusion && item.outcomeCandidate && previousActionId) outcomeOptions.push({
        itemId, afterItemId: previousActionId, meaning: item.outcomeCandidate.meaning,
        rule: { kind: 'deterministic', expect: item.outcomeCandidate.expect, ...(item.outcomeCandidate.target ? { target: item.outcomeCandidate.target } : {}) },
      })
      if (!item.outcomeCandidate) previousActionId = itemId
      return { itemId, label: item.name.slice(0, 256), sourceIndex: item.sourceIndexes[0],
        action: keep ? 'keep' : 'exclude', reason: exclusion ?? (item.outcomeCandidate ? '成功条件需要先确认预期结果' : keep ? '可转换为步骤' : '待处理，请先在录制详情修正') }
    })
  }
  outcomeOptions = outcomeOptions.filter((option) => steps.has(option.afterItemId))
  const locatorDecisions: AssistantRecordingDecision[] = []
  for (const decision of decisions) {
    const step = steps.get(decision.itemId)
    if (!step || !('target' in step.input) || !step.input.target) continue
    const before = step.input.target
    // Drop structural fallback only when this exact action already recorded semantic candidates.
    // Do not synthesize selectors, change frame/anchor, or claim live verification.
    const semantic = [...before.candidates, ...(observedAlternatives.get(decision.itemId) ?? [])]
      .filter((candidate) => candidate.by !== 'css')
      .filter((candidate, index, all) => all.findIndex((other) => canonicalJson(other) === canonicalJson(candidate)) === index)
      .slice(0, 5)
    if (!semantic.length || !before.candidates.some((candidate) => candidate.by === 'css')) continue
    locatorDecisions.push({ itemId: `locator:${digest(decision.itemId).slice(0, 24)}`, label: `改进定位：${decision.label ?? '录制动作'}`,
      action: 'modify', reason: '保留已记录的语义定位，移除结构 CSS 兜底，避免页面结构变化时误定位；尚需试跑验证。',
      sourceId: decision.sourceId, sourceIndex: decision.sourceIndex,
      change: { kind: 'locator', sourceItemId: decision.itemId, before, after: { ...before, candidates: semantic } } })
  }
  return { recordingId, targetId: row.targetId, name: row.name, revision: row.revision,
    protocolVersion: row.sourceProtocol, recordingDigest, decisions, locatorDecisions, outcomeOptions, sourceIdsByItem }
}

export interface PreviewAssistantRecordingAdoptionInput {
  recordingId: string
  proposalId: string
  recordingDigest: string
  selectedItemIds: string[]
  destinationScenarioId?: string
  insertAnchor?: RecordingInsertAnchor
  /** Loaded from the immutable assistant turn, never from an adoption request body. */
  decisions?: AssistantRecordingDecision[]
}
export interface AdoptAssistantRecordingProposalInput extends PreviewAssistantRecordingAdoptionInput {
  proposalFamilyId: string
  proposalDigest: string
  candidateDigest: string
  proposalSummary?: string
  sourceProtocol?: string
  idempotencyKey: string
  newScenarioName?: string
  expectedRevision?: number
  expectedDigest?: string
}
export interface AdoptAssistantRecordingProposalResult {
  receiptId: string; scenarioId: string; draftRevision: number; draftDigest: string; status: 'applied'
}
export interface RevertAssistantRecordingAdoptionResult {
  receiptId: string; scenarioId: string; draftRevision: number; status: 'reverted'
}

async function destination(db: Db, scenarioId: string, targetId: string, actorId: string, write: boolean) {
  const { scenarios, scenarioDrafts } = schemaFor(db)
  const query = db.select().from(scenarios).where(eq(scenarios.id, scenarioId)).limit(1)
  const [scenario] = write ? await locked(db, query) : await query
  if (!scenario || scenario.deletedAt) throw notFound('SCENARIO_NOT_FOUND', '目标场景不存在')
  if (scenario.targetId !== targetId) throw forbidden('TARGET_MISMATCH', '录制与场景必须属于同一目标')
  await assertTargetPermission(db, actorId, scenario.targetId, 'workflow:write')
  const draftQuery = db.select().from(scenarioDrafts).where(eq(scenarioDrafts.scenarioId, scenarioId)).limit(1)
  const [draft] = write ? await locked(db, draftQuery) : await draftQuery
  if (!draft) throw notFound('SCENARIO_DRAFT_NOT_FOUND', '目标场景草稿不存在')
  return draft
}

async function candidate(db: Db, input: PreviewAssistantRecordingAdoptionInput, actorId: string, write = false) {
  const row = await assertRecordingDraftOwner(db, input.recordingId, actorId, write)
  const facts = await getAssistantRecordingProposalFacts(db, input.recordingId, actorId)
  if (facts.recordingDigest !== input.recordingDigest) throw conflict('RECORDING_IMPORT_STALE', '录制或排除项已变化，请重新生成提案')
  const selected = new Set(input.selectedItemIds)
  const decisions = (input.decisions ?? facts.decisions).map((item) => assistantRecordingDecisionSchema.parse(item))
  const selectionError = assistantRecordingSelectionError(decisions, input.selectedItemIds)
  if (selectionError) throw badRequest('RECORDING_SELECTION_INVALID', selectionError)
  const changes = decisions.filter((item) => selected.has(item.itemId) && item.change)
  const allowed = new Set(facts.decisions.filter((d) => d.action === 'keep').map((d) => d.itemId))
  const changedIds = new Set(changes.map((item) => item.itemId))
  if ([...selected].some((id) => !changedIds.has(id) && !allowed.has(id))) {
    throw badRequest('RECORDING_SELECTION_INVALID', '请选择有效的可导入项，已排除和待处理项不能采纳')
  }
  for (const item of changes) {
    const change = item.change!
    if (!allowed.has(change.sourceItemId)) throw badRequest('RECORDING_SELECTION_INVALID', '修改对应的录制动作已排除或不能导入')
    if (change.kind === 'locator') {
      if (!facts.locatorDecisions.some((known) => canonicalJson(known.change) === canonicalJson(change))) throw badRequest('RECORDING_LOCATOR_UNOBSERVED', '定位替换必须来自该动作的真实录制候选')
    } else {
      if (change.confirmedBy !== actorId) throw forbidden('RECORDING_OUTCOME_UNCONFIRMED', '成功条件尚未经当前用户确认')
      if (change.recordedItemId) {
        if (!facts.outcomeOptions.some((option) => option.itemId === change.recordedItemId && option.afterItemId === change.sourceItemId && option.meaning === change.meaning && canonicalJson(option.rule) === canonicalJson(change.rule))) throw badRequest('RECORDING_OUTCOME_UNCONFIRMED', '录制成功条件或前序动作与已确认内容不一致')
      } else if (change.rule.kind !== 'ai' || change.rule.instruction !== change.meaning) throw badRequest('RECORDING_OUTCOME_UNCONFIRMED', '新增成功条件必须与用户确认的页面预期一致')
    }
  }
  const draft = input.destinationScenarioId ? await destination(db, input.destinationScenarioId, row.targetId, actorId, write) : undefined
  const before = draft ? normalizeAuthoringDocument(draft.document) : structuredClone(EMPTY)
  const tail = before.nodes.at(-1)
  const anchor: RecordingInsertAnchor = input.insertAnchor ?? (tail ? { kind: 'after', stepId: authoringNodeId(tail) } : { kind: 'start' })
  let document: ScenarioAuthoringDocumentV2
  let sourceMap: RecordingImportReceipt['sourceMap']
  let normalizerVersion: string
  if (row.sourceProtocol === 'demonstration@1') {
    const demo = await getDemonstration(db, input.recordingId, actorId)
    const preview = previewDemonstration({ source: demo.source, recordingDraftId: input.recordingId,
      scenarioId: input.destinationScenarioId ?? input.recordingId, baseRevision: draft?.revision ?? 1,
      placement: anchor.kind === 'start' ? anchor : { kind: 'after', nodeId: anchor.stepId }, remainingCapacity: Math.max(0, 500 - walkAuthoringNodes(before).length) })
    const applied = applyDemonstrationToDocument(before, preview, { protocolVersion: preview.protocolVersion,
      recordingDraftId: input.recordingId, baseRevision: preview.baseRevision, placement: preview.placement,
      factDigest: preview.factDigest, suggestionDigest: preview.suggestionDigest, adapterVersion: preview.adapterVersion,
      ruleVersion: preview.ruleVersion, idempotencyKey: `assistant:${input.proposalId}`,
      decisions: preview.suggestions.map((item) => selected.has(item.id) && item.step
        ? { id: item.id, disposition: 'replace', step: { ...item.step, id: proposalNodeId(input.proposalId, item.id) } }
        : { id: item.id, disposition: 'discard', reason: '本次未选择或需先确认' }) })
    document = applied.document
    sourceMap = applied.sourceMap.map((s) => ({ sourceIndexes: s.sourceIds.map((id) => demo.source.facts.findIndex((f) => f.id === id)).filter((i) => i >= 0), stepId: s.nodeId, disposition: s.disposition === 'discard' ? 'discard' : 'accept' }))
    normalizerVersion = preview.adapterVersion
  } else {
    let ordinal = 0
    const composed = composeRecordingHandoffDocument({ events: row.events, sourceVersion: row.sourceVersion, recordingName: row.name,
      recordingDraftId: input.recordingId, exclusions: await listRecordingDraftExclusions(db, input.recordingId),
      selectedItemIds: input.selectedItemIds.filter((id) => allowed.has(id)), baseDocument: before, insertAnchor: anchor, createId: () => proposalNodeId(input.proposalId, ordinal++) })
    document = composed.document; sourceMap = composed.sourceMap; normalizerVersion = composed.normalizerVersion
  }
  if (changes.length) {
    const operations: AuthoringOperation[] = changes.map((item) => {
      const change = item.change!
      const sourceIds = facts.sourceIdsByItem.get(change.sourceItemId) ?? []
      // Merged actions retain all their original identities; never infer placement from display ordinal.
      const node = walkAuthoringNodes(document).find(({ node }) => node.kind === 'step' &&
        node.origin?.kind === 'recording' && node.origin.recordingDraftId === input.recordingId &&
        sourceIds.some((id) => node.origin?.kind === 'recording' && node.origin.sourceIds.includes(id)) &&
        !authoringSteps(before).some((old) => old.id === node.step.id))
      const stepId = node?.node.kind === 'step' ? node.node.step.id : undefined
      if (!stepId) throw badRequest('RECORDING_SELECTION_INVALID', '找不到修改对应的本次导入动作')
      return change.kind === 'locator'
        ? { kind: 'update_step', id: proposalNodeId(input.proposalId, item.itemId), stepId, patch: { input: { target: change.after } } }
        : { kind: 'add_outcome', id: proposalNodeId(input.proposalId, item.itemId), stepId, meaning: change.meaning, rule: change.rule, severity: 'MUST', onViolation: 'halt', provenance: 'generalized' }
    })
    const applied = applyAuthoringOperations(document, operations)
    if (!applied.ok) throw badRequest(applied.error.code, applied.error.message)
    document = applied.document
  }
  // Existing module invocations and all authoring contracts participate in compilation.
  const expanded = await expandWithLoader(db, row.targetId, document, 'preview', true)
  const oldIds = new Set(authoringSteps(before).map((s) => s.id))
  const proposedSteps = authoringSteps(document).filter((s) => !oldIds.has(s.id)).map((s) => ({ name: s.name, type: s.type }))
  const proposedChanges = changes.map((item) => ({ label: item.label ?? '录制修改', detail: item.change!.kind === 'outcome' ? `在对应动作后核对：${item.change!.meaning}；必须满足，失败时停止。未执行验证。` : item.reason }))
  return { row, draft, before, document, sourceMap, normalizerVersion, anchor, expanded, proposedSteps, proposedChanges,
    sourceDigest: facts.recordingDigest, baseDigest: draft ? digest(draft.document) : undefined, candidateDigest: digest(document) }
}

export async function previewAssistantRecordingAdoption(db: Db, input: PreviewAssistantRecordingAdoptionInput, actorId: string) {
  const c = await candidate(db, input, actorId)
  return { sourceDigest: c.sourceDigest, destinationScenarioId: input.destinationScenarioId, baseRevision: c.draft?.revision,
    baseDigest: c.baseDigest, candidateDigest: c.candidateDigest, diagnostics: c.expanded.diagnostics as unknown as Array<Record<string, unknown>>,
    proposedSteps: c.proposedSteps, proposedStepCount: c.proposedSteps.length,
    proposedChanges: c.proposedChanges,
    changesSummary: `${input.destinationScenarioId ? '保留原有内容，向草稿插入' : '新建场景草稿，包含'} ${c.proposedSteps.length} 个步骤${c.proposedChanges.length ? `，含 ${c.proposedChanges.length} 项已选修改` : ''}` }
}
export type PreviewAssistantRecordingAdoptionResult = Awaited<ReturnType<typeof previewAssistantRecordingAdoption>>

export async function adoptAssistantRecordingProposal(db: Db, input: AdoptAssistantRecordingProposalInput, actor: AuditActor): Promise<AdoptAssistantRecordingProposalResult> {
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db
    const { recordingImportReceipts: receipts, scenarios, scenarioDrafts } = schemaFor(tx)
    await lockConsoleAuthorization(tx, actor.id)
    const source = await assertRecordingDraftOwner(tx, input.recordingId, actor.id, true)
    const requestDigest = digest(input)
    const [existing] = await tx.select().from(receipts).where(and(eq(receipts.createdByConsoleAccountId, actor.id), eq(receipts.idempotencyKey, input.idempotencyKey))).limit(1)
    if (existing) {
      if (existing.requestDigest !== requestDigest || existing.status !== 'applied') throw conflict('RECORDING_IMPORT_CONFLICT', '该请求已使用或已撤销，请刷新回执')
      await destination(tx, existing.scenarioId, source.targetId, actor.id, true)
      return { receiptId: existing.id, scenarioId: existing.scenarioId, draftRevision: existing.newRevision, draftDigest: existing.afterDigest!, status: 'applied' }
    }
    const [family] = await tx.select({ id: receipts.id }).from(receipts).where(and(eq(receipts.createdByConsoleAccountId, actor.id), eq(receipts.proposalFamilyId, input.proposalFamilyId))).limit(1)
    if (family) throw conflict('RECORDING_PROPOSAL_ALREADY_ADOPTED', '该提案已采纳或撤销，请查看回执')
    const c = await candidate(tx, input, actor.id, true)
    if (c.candidateDigest !== input.candidateDigest || (c.draft && (input.expectedRevision !== c.draft.revision || input.expectedDigest !== c.baseDigest))) {
      throw conflict('SCENARIO_DRAFT_CONFLICT', '草稿或预览已变化，请重新预览后采纳')
    }
    if (!c.expanded.ok) throw badRequest('SCENARIO_COMPILE_BLOCKED', '提案未通过编译，请先修正', { diagnostics: c.expanded.diagnostics })
    const now = new Date(), scenarioId = input.destinationScenarioId ?? newId(), nextRevision = (c.draft?.revision ?? 1) + 1
    if (c.draft) {
      await tx.update(scenarioDrafts).set({ document: c.document, revision: nextRevision, updatedByConsoleAccountId: actor.id, updatedAt: now }).where(and(eq(scenarioDrafts.scenarioId, scenarioId), eq(scenarioDrafts.revision, c.draft.revision)))
      await tx.update(scenarios).set({ updatedAt: now }).where(eq(scenarios.id, scenarioId))
    } else {
      await tx.insert(scenarios).values({ id: scenarioId, targetId: source.targetId, name: input.newScenarioName?.trim() || `${source.name}（助手草稿）`, createdByConsoleAccountId: actor.id, createdAt: now, updatedAt: now })
      await tx.insert(scenarioDrafts).values({ scenarioId, document: c.document, revision: nextRevision, updatedByConsoleAccountId: actor.id, updatedAt: now })
    }
    await syncScenarioModuleRefsTx(tx, scenarioId, null, c.document)
    const receiptId = newId()
    await tx.insert(receipts).values({ id: receiptId, scenarioId, recordingDraftId: input.recordingId, createdByConsoleAccountId: actor.id,
      idempotencyKey: input.idempotencyKey, requestDigest, sourceDigest: c.sourceDigest, normalizerVersion: c.normalizerVersion,
      baseRevision: c.draft?.revision ?? 1, newRevision: nextRevision, insertAnchor: c.anchor, sourceMap: c.sourceMap,
      proposalId: input.proposalId, proposalFamilyId: input.proposalFamilyId, importScopeKey: input.proposalFamilyId, proposalSummary: input.proposalSummary,
      sourceProtocol: source.sourceProtocol, status: 'applied', beforeDocument: c.before, beforeDigest: digest(c.before), afterDigest: c.candidateDigest, createdAt: now })
    await recordAudit(tx, actor, 'recording.create', 'scenario', scenarioId, '采纳助手录制提案')
    return { receiptId, scenarioId, draftRevision: nextRevision, draftDigest: c.candidateDigest, status: 'applied' }
  })
}

export async function revertAssistantRecordingAdoption(db: Db, recordingId: string, receiptId: string, actor: AuditActor): Promise<RevertAssistantRecordingAdoptionResult> {
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db
    const { recordingImportReceipts: receipts, scenarioDrafts, scenarios, scenarioVersions, runs } = schemaFor(tx)
    await lockConsoleAuthorization(tx, actor.id)
    const source = await assertRecordingDraftOwner(tx, recordingId, actor.id, true)
    const [receipt] = await locked(tx, tx.select().from(receipts).where(and(eq(receipts.id, receiptId), eq(receipts.recordingDraftId, recordingId))).limit(1))
    if (!receipt || receipt.createdByConsoleAccountId !== actor.id || !receipt.proposalId) throw notFound('RECEIPT_NOT_FOUND', '采纳回执不存在')
    const draft = await destination(tx, receipt.scenarioId, source.targetId, actor.id, true)
    if (receipt.status === 'reverted') return { receiptId, scenarioId: receipt.scenarioId, draftRevision: receipt.revertedRevision!, status: 'reverted' }
    const [version] = await tx.select({ id: scenarioVersions.id }).from(scenarioVersions).where(and(eq(scenarioVersions.scenarioId, receipt.scenarioId), gte(scenarioVersions.createdAt, receipt.createdAt))).limit(1)
    const [run] = await tx.select({ id: runs.id }).from(runs).where(and(eq(runs.scenarioId, receipt.scenarioId), gte(runs.createdAt, receipt.createdAt))).limit(1)
    if (receipt.status !== 'applied' || draft.revision !== receipt.newRevision || digest(draft.document) !== receipt.afterDigest || version || run) {
      throw conflict('SCENARIO_DRAFT_MODIFIED', '采纳后已有编辑、发布或运行，不能自动撤销；当前内容已保留')
    }
    const now = new Date(), nextRevision = draft.revision + 1
    const document = normalizeAuthoringDocument(receipt.beforeDocument ?? EMPTY)
    await tx.update(scenarioDrafts).set({ document, revision: nextRevision, updatedAt: now, updatedByConsoleAccountId: actor.id }).where(and(eq(scenarioDrafts.scenarioId, receipt.scenarioId), eq(scenarioDrafts.revision, draft.revision)))
    await tx.update(scenarios).set({ updatedAt: now }).where(eq(scenarios.id, receipt.scenarioId))
    await syncScenarioModuleRefsTx(tx, receipt.scenarioId, null, document)
    await tx.update(receipts).set({ status: 'reverted', revertedRevision: nextRevision, revertedAt: now }).where(eq(receipts.id, receiptId))
    await recordAudit(tx, actor, 'recording.delete', 'scenario', receipt.scenarioId, '撤销助手录制采纳')
    return { receiptId, scenarioId: receipt.scenarioId, draftRevision: nextRevision, status: 'reverted' }
  })
}

function receiptDto(row: typeof import('../schema/authoring.js').recordingImportReceipts.$inferSelect): RecordingAdoptionReceiptDto {
  return { id: row.id, scenarioId: row.scenarioId, recordingDraftId: row.recordingDraftId, proposalId: row.proposalId,
    proposalFamilyId: row.proposalFamilyId, proposalSummary: row.proposalSummary, sourceProtocol: row.sourceProtocol,
    status: row.status as 'applied' | 'reverted', beforeDigest: row.beforeDigest, afterDigest: row.afterDigest,
    revertedRevision: row.revertedRevision, revertedAt: row.revertedAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString() }
}
export async function listRecordingAdoptionReceipts(db: Db, recordingId: string, actorId: string): Promise<RecordingAdoptionReceiptDto[]> {
  await assertRecordingDraftOwner(db, recordingId, actorId)
  const { recordingImportReceipts: receipts } = schemaFor(db)
  const rows = await db.select().from(receipts).where(and(eq(receipts.recordingDraftId, recordingId), eq(receipts.createdByConsoleAccountId, actorId))).orderBy(desc(receipts.createdAt)).limit(50)
  return rows.filter((r) => r.proposalId).map(receiptDto)
}
export async function getRecordingAdoptionReceipt(db: Db, recordingId: string, receiptId: string, actorId: string): Promise<RecordingAdoptionReceiptDto> {
  await assertRecordingDraftOwner(db, recordingId, actorId)
  const { recordingImportReceipts: receipts } = schemaFor(db)
  const [receipt] = await db.select().from(receipts).where(and(eq(receipts.id, receiptId), eq(receipts.recordingDraftId, recordingId), eq(receipts.createdByConsoleAccountId, actorId))).limit(1)
  if (!receipt?.proposalId) throw notFound('RECEIPT_NOT_FOUND', '采纳回执不存在')
  return receiptDto(receipt)
}
