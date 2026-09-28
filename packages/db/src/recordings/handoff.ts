import { eq } from 'drizzle-orm'
import {
  canonicalJson,
  COMPILER_VERSION,
  DEMONSTRATION_ADAPTER_VERSION,
  DEMONSTRATION_PROTOCOL,
  DEMONSTRATION_RULE_VERSION,
  createScenarioHandoffBodySchema,
  type CreateScenarioHandoffBody,
  type DemonstrationDecision,
  type RecordingImportReceipt,
  type ScenarioAuthoringDocumentV2,
  type ScenarioDetailDto,
} from '@cairn/shared'
import { applyDemonstrationToDocument, DemonstrationApplyError, previewDemonstration } from '@cairn/authoring'
import { sha256Hex } from '../runs/digest.js'
import type { Db } from '../client.js'
import { badRequest, conflict, notFound } from '../runs/errors.js'
import { newId } from '../id.js'
import { schemaFor } from '../native.js'
import { recordAudit, type AuditActor } from '../audit/record.js'
import { expandWithLoader, getScenario } from '../runs/scenarios.js'
import { assertRecordingDraftOwner, listRecordingDraftExclusions } from './exclusions.js'
import { enforceDemonstrationExclusions } from './demonstrations.js'
import { composeRecordingHandoffDocument } from './imports.js'

export {
  createScenarioHandoffBodySchema,
  type CreateScenarioHandoffBody,
}

const EMPTY_AUTHORING: ScenarioAuthoringDocumentV2 = {
  authoringSchemaVersion: 2,
  schemaVersion: 1,
  inputs: [],
  nodes: [],
}

export async function createScenarioFromRecordingHandoff(
  db: Db,
  recordingDraftId: string,
  body: CreateScenarioHandoffBody,
  actor: AuditActor,
): Promise<{ scenario: ScenarioDetailDto; receipt: RecordingImportReceipt }> {
  createScenarioHandoffBodySchema.parse(body)

  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db
    const {
      recordingDemonstrationSources,
      scenarios,
      scenarioVersions,
      scenarioDrafts,
      recordingImportReceipts,
    } = schemaFor(txDb)

    const draftRow = await assertRecordingDraftOwner(txDb, recordingDraftId, actor.id, true)

    if (draftRow.revision !== body.expectedRevision) {
      throw conflict('RECORDING_DRAFT_REVISION_MISMATCH', '草稿已被修改，请刷新后重试')
    }

    const exclusions = await listRecordingDraftExclusions(txDb, recordingDraftId)

    let authoringDoc: ScenarioAuthoringDocumentV2
    let sourceMap: RecordingImportReceipt['sourceMap'] = []
    let sourceDigest = draftRow.payloadDigest
    let suggestionDigest = ''
    let normalizerVersion = draftRow.sourceVersion
    let demonstrationDecisions: DemonstrationDecision[] = []
    let demonstrationSourceMap: Array<{
      sourceIds: string[]
      nodeId?: string
      contractId?: string
      disposition: string
    }> = []

    if (draftRow.sourceProtocol === DEMONSTRATION_PROTOCOL) {
      const [sourceRow] = await txDb
        .select()
        .from(recordingDemonstrationSources)
        .where(eq(recordingDemonstrationSources.recordingDraftId, recordingDraftId))
        .limit(1)

      if (!sourceRow) {
        throw notFound('RECORDING_SOURCE_NOT_FOUND', '示教录制来源不存在')
      }
      sourceDigest = sourceRow.factDigest
      normalizerVersion = DEMONSTRATION_RULE_VERSION
      const preview = previewDemonstration({
        source: sourceRow.source,
        recordingDraftId,
        scenarioId: recordingDraftId,
        baseRevision: draftRow.revision,
        placement: { kind: 'start' },
        remainingCapacity: 500,
      })
      suggestionDigest = preview.suggestionDigest
      if (preview.suggestions.length === 0) {
        throw badRequest('RECORDING_IMPORT_INCOMPLETE', '没有可回填的步骤')
      }
      demonstrationDecisions = enforceDemonstrationExclusions(
        preview.suggestions.map((item) =>
          item.status === 'mapped'
            ? { id: item.id, disposition: 'accept' as const }
            : { id: item.id, disposition: 'discard' as const, reason: '待处理项已在就地回填中忽略' },
        ),
        exclusions,
      )
      let next
      try {
        next = applyDemonstrationToDocument(EMPTY_AUTHORING, preview, {
          protocolVersion: DEMONSTRATION_PROTOCOL,
          recordingDraftId,
          baseRevision: draftRow.revision,
          placement: { kind: 'start' },
          idempotencyKey: 'handoff-apply',
          factDigest: preview.factDigest,
          suggestionDigest: preview.suggestionDigest,
          adapterVersion: preview.adapterVersion,
          ruleVersion: preview.ruleVersion,
          decisions: demonstrationDecisions,
        })
      } catch (error) {
        if (error instanceof DemonstrationApplyError) throw badRequest(error.code, error.message)
        throw error
      }
      authoringDoc = next.document
      demonstrationSourceMap = next.sourceMap
      sourceMap = next.sourceMap.map((entry) => {
        const decision = demonstrationDecisions.find(
          (item) =>
            item.disposition === 'discard' &&
            preview.suggestions
              .find((suggestion) => suggestion.id === item.id)
              ?.sourceIds.some((id) => entry.sourceIds.includes(id)),
        )
        return {
          sourceIndexes: sourceRow.source.facts
            .filter((fact) => fact.sourceIds.some((id) => entry.sourceIds.includes(id)))
            .map((fact) => fact.sequence),
          stepId: entry.nodeId,
          disposition: entry.disposition as 'accept' | 'replace' | 'discard',
          ...(entry.disposition === 'discard'
            ? { reason: decision?.disposition === 'discard' ? decision.reason : '手动剔除' }
            : {}),
        }
      })
    } else {
      const composed = composeRecordingHandoffDocument({
        events: draftRow.events,
        sourceVersion: draftRow.sourceVersion,
        recordingName: draftRow.name,
        recordingDraftId,
        exclusions,
      })
      authoringDoc = composed.document
      sourceMap = composed.sourceMap
      sourceDigest = composed.sourceDigest
      normalizerVersion = composed.normalizerVersion
    }

    const expanded = await expandWithLoader(txDb, draftRow.targetId, authoringDoc, 'preview', true)
    if (!expanded.ok) {
      throw badRequest('SCENARIO_COMPILE_BLOCKED', '回填的场景草稿未通过编译', {
        diagnostics: expanded.diagnostics,
      })
    }

    const scenarioId = newId()
    const now = new Date()

    await txDb.insert(scenarios).values({
      id: scenarioId,
      targetId: draftRow.targetId,
      name: body.name,
      createdByConsoleAccountId: actor.id,
      createdAt: now,
      updatedAt: now,
    })

    const versionId = newId()
    const compiledDef = expanded.definition ?? {
      schemaVersion: 1,
      inputs: authoringDoc.inputs,
      steps: [],
    }
    const digest = expanded.sourceDigest ?? sha256Hex(canonicalJson(compiledDef))
    await txDb.insert(scenarioVersions).values({
      id: versionId,
      scenarioId,
      versionNo: 1,
      kind: 'published',
      definition: compiledDef,
      compilerVersion: COMPILER_VERSION,
      sourceDigest: digest,
      authoringDocument: authoringDoc,
      createdByConsoleAccountId: actor.id,
      createdAt: now,
    })

    await txDb.insert(scenarioDrafts).values({
      scenarioId,
      revision: 2,
      document: authoringDoc,
      updatedByConsoleAccountId: actor.id,
      updatedAt: now,
    })

    const receiptId = newId()
    const demonstrationMetadata =
      draftRow.sourceProtocol === DEMONSTRATION_PROTOCOL
        ? {
            protocolVersion: DEMONSTRATION_PROTOCOL,
            factDigest: sourceDigest,
            suggestionDigest,
            adapterVersion: DEMONSTRATION_ADAPTER_VERSION,
            ruleVersion: DEMONSTRATION_RULE_VERSION,
            placement: { kind: 'start' as const },
            decisions: demonstrationDecisions,
            sourceMap: demonstrationSourceMap,
          }
        : undefined

    const receiptData = {
      id: receiptId,
      scenarioId,
      recordingDraftId,
      createdByConsoleAccountId: actor.id,
      idempotencyKey: newId(),
      requestDigest: sha256Hex(
        canonicalJson({ recordingDraftId, scenarioId, revision: draftRow.revision }),
      ),
      sourceDigest,
      normalizerVersion,
      baseRevision: 1,
      newRevision: 2,
      insertAnchor: { kind: 'start' as const },
      sourceMap,
      demonstration: demonstrationMetadata,
      createdAt: now,
    }
    await txDb.insert(recordingImportReceipts).values(receiptData)

    await recordAudit(
      txDb,
      actor,
      'scenario.create',
      'scenario',
      scenarioId,
      `从录制草稿新建场景「${body.name}」`,
    )

    const scenarioDetail = await getScenario(txDb, scenarioId)
    const receipt: RecordingImportReceipt = {
      id: receiptId,
      scenarioId,
      recordingDraftId,
      sourceDigest,
      normalizerVersion,
      baseRevision: 1,
      newRevision: 2,
      insertedStepIds: [...new Set(sourceMap.flatMap((entry) => (entry.stepId ? [entry.stepId] : [])))],
      sourceMap,
      demonstration: demonstrationMetadata,
      createdAt: now.toISOString(),
    }

    return {
      scenario: scenarioDetail,
      receipt,
    }
  })
}
