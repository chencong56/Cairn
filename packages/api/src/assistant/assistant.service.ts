import {
  Inject,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common'
import type { Request, Response } from 'express'
import {
  ASSISTANT_BUSINESS_INTENTS,
  assistantFocusSchema,
  assistantRecordingSelectionError,
  confirmRecordingOutcomeBodySchema,
  recordingInsertAnchorSchema,
  assistantGuideTopicSchema,
  assistantQuoteContextSchema,
  availableAssistantCapabilities,
  resolveAvailableContextFeatures,
  canonicalJson,
  createAssistantTurnBodySchema,
  hasAllPermissions,
  isTargetDeletionGuideQuestion,
  sha256Hex,
  syncSha256,
  quoteTargetSystemId,
  unpackAssistantResultEnvelope,
  authoringOperationLimitsFor,
  canAdoptAuthoringProposal,
  compareCompileDiagnostics,
  normalizeAuthoringDocument,
  type AuthoringDiff,
  type AuthoringOperation,
  type CompileDiagnostic,
  type CreateAssistantTurnBody,
  type DeleteAssistantConversationResult,
  type SubmitAccepted,
  type CancelResult,
  type ModelInvocationRecord,
  packAssistantResultEnvelope,
  type CreateRecordingSelectionBody,
  type CreateRecordingSelectionResult,
  type RecordingPreviewQuery,
  type RecordingPreviewResult,
  type CreateRecordingAdoptionBody,
  type CreateRecordingAdoptionResult,
  type AssistantRecordingProposalResult,
  type ConfirmRecordingOutcomeBody,
  type ConfirmRecordingOutcomeResult,
} from '@cairn/shared'
import { applyAuthoringOperations } from '@cairn/authoring'
import {
  DomainError,
  assertTargetPermission,
  authorizeTargetRequest,
  beginAssistantTurn,
  createAssistantConversation,
  deleteAssistantConversation,
  expandWithLoader,
  getAssistantTurnRecord,
  getDataset,
  getRun,
  getScenario,
  getSchedule,
  getScheduleOccurrence,
  getSessionDto,
  interruptExpiredAssistantTurns,
  listAssistantConversations,
  listAssistantTurnEvents,
  listAssistantTurnRecords,
  listPlatformAiCalls,
  adoptAssistantRecordingProposal,
  getAssistantRecordingProposalFacts,
  previewAssistantRecordingAdoption,
  createCompletedAssistantTurn,
  type ChangeHintBus,
  type DbHandle,
} from '@cairn/db'
import { DB_HANDLE } from '../db/db.module'
import { CHANGE_HINT } from '../observe/change-hint.module'
import { observeObject } from '../common/observe-object'
import { rethrowDomain } from '../common/domain-error'
import { redactKnowledgeQuestion } from '@cairn/map'
import { PlatformConfigService } from '../platform-config/platform-config.service'
import { TargetsService } from '../targets/targets.service'
import { AssistantAsyncRunner } from './async-runner'
import { effectiveHelpCatalog } from './help/catalog'
import {
  buildCapabilityOverviewResult,
  buildKnowledgeStatusResult,
  buildNamedTargetAccountRunResult,
  buildPageContextMismatchResult,
  buildTargetCpuUnavailableResult,
  knowledgeStatusFromCitation,
  PAGE_CONTEXT_MISMATCH_CITATION,
  NAMED_TARGET_SCOPE_CITATION,
  NAMED_TARGET_ACCOUNT_RUN_CITATION,
  RUN_FAILURE_DIGEST_CITATION,
  TARGET_CPU_UNAVAILABLE_CITATION,
} from './handlers/knowledge-answer.handler'
import { buildManifestPageGuidance, isTargetPageEntryQuestion, namedTargetForPageEntryQuestion, resolveObservedTargetPageEntry } from './handlers/in-page-guidance.handler'
import { buildPlatformGuideForQuestion, targetDeletionGuide } from './handlers/guide.handler'
import type { RequestAccount as Actor } from '../common/request-account'

const TITLE_MAX = 40

function redactQuestion(question: string): string {
  return redactKnowledgeQuestion(question)
}

function conversationTitle(question: string): string {
  const text = redactQuestion(question).replace(/\s+/g, ' ').trim()
  return text.length <= TITLE_MAX ? text || '新对话' : `${text.slice(0, TITLE_MAX - 1)}…`
}

@Injectable()
export class AssistantService implements OnModuleInit {
  private readonly hints: ChangeHintBus

  constructor(
    @Inject(DB_HANDLE) private readonly db: DbHandle,
    private readonly platformConfig: PlatformConfigService,
    private readonly targets: TargetsService,
    private readonly asyncRunner: AssistantAsyncRunner,
    @Inject(CHANGE_HINT) hints: ChangeHintBus,
  ) {
    this.hints = hints
  }

  /**
   * AIF-25: On startup, recover expired turns and resume queue.
   */
  async onModuleInit(): Promise<void> {
    try {
      await interruptExpiredAssistantTurns(this.db)
    } catch {
      // In-memory or stub DB handles in integration tests may not support turn recovery
    }
    try {
      await this.asyncRunner.promoteNextQueuedTurn()
    } catch {
      // Queue promotion can fail when the database handle is a test stub
    }
  }

  async capabilities(actor: Actor) {
    const access = await this.platformConfig.resolvePlatformAiAccess()
    return {
      items: availableAssistantCapabilities(actor.permissions),
      modelEnabled: access !== null,
      contextFeatures: resolveAvailableContextFeatures(actor.permissions),
    }
  }

  async createConversation(
    actor: Actor,
    body: { idempotencyKey?: string; title?: string; question?: string },
    question?: string,
  ) {
    this.requireAssist(actor)
    const effectiveQuestion = body.question ?? question ?? body.title
    return createAssistantConversation(this.db, {
      ownerAccountId: actor.id,
      title: conversationTitle(effectiveQuestion ?? '新对话'),
      idempotencyKey: body.idempotencyKey,
    }).catch(rethrowDomain)
  }

  async listConversations(actor: Actor, query: { cursor?: string; limit?: number }) {
    this.requireAssist(actor)
    return listAssistantConversations(this.db, actor.id, query).catch(rethrowDomain)
  }

  async deleteConversation(actor: Actor, id: string): Promise<DeleteAssistantConversationResult> {
    this.requireAssist(actor)
    try {
      const turns = await listAssistantTurnRecords(this.db, id, actor.id, { limit: 100 })
      for (const t of turns.items) {
        if (t.turn.status === 'RUNNING' || t.turn.status === 'QUEUED') {
          await this.asyncRunner.cancel(t.turn.id, actor.id).catch(() => undefined)
        }
      }
    } catch {
      // 容错：若轮次列表拉取失败仍继续删除会话主体
    }
    return deleteAssistantConversation(this.db, id, actor.id).catch(rethrowDomain)
  }

  async listTurns(actor: Actor, conversationId: string, query: { cursor?: string; limit?: number }) {
    this.requireAssist(actor)
    const list = await listAssistantTurnRecords(this.db, conversationId, actor.id, query).catch(rethrowDomain)
    return {
      items: await Promise.all(
        list.items.map((item) => this.sanitizeStoredTurn(actor, item.turn, item.slots)),
      ),
      nextCursor: list.nextCursor,
    }
  }

  async getTurn(actor: Actor, conversationId: string, turnId: string) {
    this.requireAssist(actor)
    const record = await getAssistantTurnRecord(this.db, turnId, actor.id).catch(rethrowDomain)
    if (record.turn.conversationId !== conversationId) {
      rethrowDomain(new DomainError('not_found', 'ASSISTANT_TURN_NOT_FOUND', '轮次不存在'))
    }
    return this.sanitizeStoredTurn(actor, record.turn, record.slots)
  }

  /**
   * AIF-21: Single responsibility submission entry.
   * Returns immediately with SubmitAccepted (HTTP 202), never blocks on LLM generation.
   */
  async createTurn(
    actor: Actor,
    conversationId: string,
    body: CreateAssistantTurnBody,
  ): Promise<SubmitAccepted> {
    this.requireAssist(actor)
    const parsed = createAssistantTurnBodySchema.parse(body)
    await interruptExpiredAssistantTurns(this.db).catch(rethrowDomain)

    // AI-01 OCC optimistic concurrency validation
    if (parsed.taskId && parsed.expectedRevision !== undefined) {
      try {
        const existing = await getAssistantTurnRecord(this.db, parsed.taskId, actor.id)
        if (existing.epoch !== parsed.expectedRevision) {
          throw new DomainError('conflict', 'ASSISTANT_CONCURRENCY_CONFLICT', '任务版本已更新，请重新加载后再试')
        }
      } catch (err) {
        if (err instanceof DomainError) throw err
      }
    }

    const access = await this.platformConfig.resolvePlatformAiAccess().catch(() => null)
    if (!access) {
      rethrowDomain(new DomainError('forbidden', 'ASSISTANT_MODEL_DISABLED', '当前平台未启用 AI 模型或未配置有效模型提供商，识途助手已暂停服务'))
    }

    const config = await this.platformConfig.get()
    const platformAi = config.document.platformAi
    const deadlineAt = new Date(Date.now() + platformAi.turnTimeoutMs)
    const processingToken = crypto.randomUUID()
    const requestDigest = await sha256Hex(
      canonicalJson({
        question: parsed.question,
        capabilityHint: parsed.capabilityHint ?? null,
        pageContext: parsed.pageContext ?? null,
        replyToTurnId: parsed.replyToTurnId ?? null,
      }),
    )

    // AIF-23: beginAssistantTurn with allowQueue: true enables FIFO queuing on capacity
    const started = await beginAssistantTurn(this.db, {
      conversationId,
      ownerAccountId: actor.id,
      clientTurnId: parsed.clientTurnId,
      requestDigest,
      question: redactQuestion(parsed.question),
      parentTurnId: parsed.replyToTurnId,
      deadlineAt,
      processingToken,
      userLimit: platformAi.userInflightLimit,
      platformLimit: platformAi.platformInflightLimit,
      allowQueue: true,
      ownerInstanceId: this.asyncRunner.ownerInstanceId,
      leaseUntil: new Date(Date.now() + 15_000),
      requestPayload: parsed as unknown as Record<string, unknown>,
    }).catch(rethrowDomain)

    if (started.replay) {
      const isQueued = started.turn.status === 'QUEUED'
      return {
        turnId: started.turn.id,
        taskId: started.turn.id,
        state: isQueued ? 'QUEUED' : (started.turn.status === 'RUNNING' ? 'RUNNING' : 'RUNNING'),
        stage: (started.turn.stage as SubmitAccepted['stage']) ?? (isQueued ? 'queued' : 'accepted'),
        eventSeq: started.turn.eventSeq ?? 0,
        queuePosition: started.turn.queuePosition ?? null,
      }
    }

    if (started.turn.status === 'QUEUED') {
      return {
        turnId: started.turn.id,
        taskId: started.turn.id,
        state: 'QUEUED',
        stage: 'queued',
        eventSeq: 0,
        queuePosition: started.turn.queuePosition ?? null,
      }
    }

    // Status is RUNNING: start asynchronous execution in background
    this.asyncRunner.startExecution(
      started.turn.id,
      actor,
      parsed,
      processingToken,
      deadlineAt,
      started.epoch,
    )

    return {
      turnId: started.turn.id,
      taskId: started.turn.id,
      state: 'RUNNING',
      stage: 'accepted',
      eventSeq: 0,
      queuePosition: null,
    }
  }

  /**
   * AIF-21, AIF-22: Observe turn via SSE with Last-Event-ID catch-up.
   */
  async observeTurn(
    actor: Actor,
    conversationId: string,
    turnId: string,
    req: Request,
    res: Response,
  ): Promise<void> {
    this.requireAssist(actor)
    // Fail before SSE if turn doesn't exist
    await this.getTurn(actor, conversationId, turnId)
    return observeObject({
      req,
      res,
      hints: this.hints,
      objectId: turnId,
      after: 0,
      event: 'turn',
      matches: (hint) => hint.objectType === 'assistant_turn' && hint.objectId === turnId,
      snapshot: () => this.getTurn(actor, conversationId, turnId),
      events: (afterSeq) => listAssistantTurnEvents(this.db, turnId, afterSeq),
      finished: (snap) => snap.status !== 'RUNNING' && snap.status !== 'QUEUED',
      readyData: { thinkingStream: false },
      writeEvent: (event, write) => {
        // Old turns may still have persisted raw reasoning events. Advance the
        // durable cursor without replaying those events to the user.
        if (event.channel === 'event') write(event.channel, event.payload, event.seq)
      },
    })
  }

  /**
   * AIF-22, AIF-24: Cancel turn explicitly.
   */
  async cancelTurn(actor: Actor, conversationId: string, turnId: string): Promise<CancelResult> {
    this.requireAssist(actor)
    const turn = await this.getTurn(actor, conversationId, turnId)
    if (turn.conversationId !== conversationId) {
      throw new DomainError('not_found', 'ASSISTANT_TURN_NOT_FOUND', '轮次不存在')
    }
    return this.asyncRunner.cancel(turnId, actor.id)
  }

  /**
   * AIF-08: Cross-host model invocation records query.
   */
  async listModelInvocations(
    actor: Actor,
    query: { turnId?: string; limit?: number },
  ): Promise<{ items: ModelInvocationRecord[] }> {
    this.requireAssist(actor)
    const rows = await listPlatformAiCalls(this.db, {
      ...query,
      ownerAccountId: actor.id,
    })
    const items: ModelInvocationRecord[] = rows.map((r) => ({
      callId: r.id,
      ownerRef: { kind: 'assistant_turn', turnId: r.turnId ?? 'unknown' },
      purpose: r.purpose,
      capabilityVersion: (r.capabilityVersion as any) ?? '1.0.0',
      promptVersion: r.promptVersion,
      policyRevision: r.configRevision ?? 1,
      contextManifestId: r.contextManifestId,
      requestedModel: r.requestedModel ?? r.model ?? 'unknown',
      actualModel: r.model,
      route: r.route,
      usage: (r.usage as any) ?? 'unknown',
      cost: (r.cost as any) ?? 'unknown',
      durationMs: r.durationMs ?? 0,
      errorClass: (r.errorClass as any) ?? (r.error ? 'provider_error' : 'none'),
      validation: (r.validation as any) ?? { schemaOk: !r.error, grounded: 'not_checked' },
    }))
    return { items }
  }

  async getProposalPreview(actor: Actor, conversationId: string, turnId: string) {
    this.requireAssist(actor)
    if (!hasAllPermissions(actor.permissions, ['workflow:write', 'target:read'])) {
      throw new DomainError('forbidden', 'PERMISSION_DENIED', '缺少 workflow:write 或 target:read 权限')
    }

    const record = await getAssistantTurnRecord(this.db, turnId, actor.id).catch(rethrowDomain)
    if (record.turn.conversationId !== conversationId) {
      throw new DomainError('not_found', 'ASSISTANT_TURN_NOT_FOUND', '轮次不存在')
    }

    const result = unpackAssistantResultEnvelope(record.turn.result)
    if (!result || (result.kind !== 'authoring_proposal' && result.kind !== 'proposal')) {
      throw new DomainError('bad_request', 'PROPOSAL_NOT_FOUND', '当前轮次不包含可预览的编排建议')
    }

    let scenarioId: string
    let draftRevision: number
    let targetId: string
    let baselineDigest: string
    let candidateDigest: string
    let operations: AuthoringOperation[]
    let diffs: AuthoringDiff[]
    let proposalId: string

    if (result.kind === 'authoring_proposal') {
      scenarioId = result.scenarioId
      proposalId = result.proposalId
      draftRevision = result.base.draftRevision
      baselineDigest = result.base.documentDigest
      candidateDigest = result.candidateDigest
      operations = result.operations
      diffs = result.diffs
    } else {
      scenarioId = String(record.slots?.scenarioId ?? '')
      proposalId = turnId
      draftRevision = Number(record.slots?.draftRevision ?? 0)
      baselineDigest = result.documentDigest
      candidateDigest = result.documentDigest
      operations = []
      diffs = result.diffs as any
    }

    await authorizeTargetRequest(this.db, actor.id, {
      scenarioId,
      permissions: ['workflow:write'],
    }).catch(rethrowDomain)
    const scenario = await getScenario(this.db, scenarioId).catch(rethrowDomain)
    targetId = scenario.targetId
    await this.requireVisibleTarget(actor, targetId)

    const draft = scenario.draft
    let canAdopt = false
    let staleReason: string | undefined

    if (!draft) {
      canAdopt = false
      staleReason = '场景草稿不存在'
    } else if (result.kind === 'authoring_proposal') {
      const draftDoc = normalizeAuthoringDocument(draft.document)
      const adoptCheck = await canAdoptAuthoringProposal({
        proposal: result,
        scenarioId: scenario.id,
        revision: draft.revision,
        document: draftDoc,
        hasFieldDrafts: false,
        remoteConflict: false,
      })
      canAdopt = adoptCheck.ok
      if (!adoptCheck.ok) {
        staleReason = adoptCheck.reason
      }
    } else {
      canAdopt = draft.revision === draftRevision
      if (!canAdopt) staleReason = '草稿版本已更新'
    }

    let diagnostics: any[] = []
    let executable = false

    if (draft && operations.length > 0) {
      const draftDoc = normalizeAuthoringDocument(draft.document)
      const applied = applyAuthoringOperations(
        draftDoc,
        operations,
        result.kind === 'authoring_proposal' ? authoringOperationLimitsFor(result) : undefined,
      )
      if (applied.ok) {
        let baselineDiagnostics: CompileDiagnostic[] = []
        try {
          const baselineRes = await expandWithLoader(this.db, targetId, draftDoc, 'preview', true)
          baselineDiagnostics = baselineRes.diagnostics
        } catch {
          // ignore
        }

        try {
          const candRes = await expandWithLoader(this.db, targetId, applied.document, 'preview', true)
          diagnostics = candRes.diagnostics
          compareCompileDiagnostics(baselineDiagnostics, candRes.diagnostics)
          executable = !candRes.diagnostics.some((d) => d.severity === 'error')
        } catch {
          executable = false
        }
      }
    } else if (result.kind === 'authoring_proposal') {
      diagnostics = result.diagnostics
      executable = result.executable
    }

    return {
      proposalId,
      scenarioId,
      draftRevision,
      targetId,
      baselineDigest,
      candidateDigest,
      operations,
      diffs,
      diagnostics,
      executable,
      canAdopt,
      staleReason,
    }
  }

  async createRecordingSelection(
    actor: Actor,
    conversationId: string,
    turnId: string,
    body: CreateRecordingSelectionBody,
  ): Promise<CreateRecordingSelectionResult> {
    this.requireAssist(actor)
    if (!hasAllPermissions(actor.permissions, ['workflow:write', 'target:read'])) {
      throw new DomainError('forbidden', 'PERMISSION_DENIED', '缺少 workflow:write 或 target:read 权限')
    }

    const record = await getAssistantTurnRecord(this.db, turnId, actor.id).catch(rethrowDomain)
    if (record.turn.conversationId !== conversationId) {
      throw new DomainError('not_found', 'ASSISTANT_TURN_NOT_FOUND', '轮次不存在')
    }

    const result = unpackAssistantResultEnvelope(record.turn.result)
    if (!result || result.kind !== 'recording_proposal') {
      throw new DomainError('bad_request', 'PROPOSAL_NOT_FOUND', '当前轮次不包含可选择的录制提案')
    }

    const proposal = result as AssistantRecordingProposalResult
    await this.requireVisibleTarget(actor, proposal.targetId)

    if (
      !proposal.candidateDigest || body.proposalDigest !== proposal.candidateDigest
    ) {
      throw new DomainError('conflict', 'PROPOSAL_DIGEST_MISMATCH', '提案摘要与当前轮次不一致')
    }

    const facts = await getAssistantRecordingProposalFacts(this.db, proposal.recordingId, actor.id).catch(rethrowDomain)
    if (facts.recordingDigest !== proposal.recordingDigest) throw new DomainError('conflict', 'RECORDING_IMPORT_STALE', '录制已变化，请重新生成提案')
    const selectedSet = new Set(body.selectedItemIds)
    if (proposal.needsOutcomeConfirmation) throw new DomainError('bad_request', 'RECORDING_OUTCOME_UNCONFIRMED', '请先确认业务预期并生成新的提案')
    const selectionError = assistantRecordingSelectionError(proposal.decisions, body.selectedItemIds)
    if (selectionError) throw new DomainError('bad_request', 'RECORDING_SELECTION_INVALID', selectionError)
    const filteredDecisions = proposal.decisions.filter((d) => selectedSet.has(d.itemId))
    const excludedItemIds = proposal.decisions
      .map((d) => d.itemId)
      .filter((id) => !selectedSet.has(id))

    if (filteredDecisions.length === 0) {
      throw new DomainError('bad_request', 'EMPTY_SELECTION', '至少需要保留一项提案内容')
    }

    const newProposalId = syncSha256(canonicalJson({
      familyId: proposal.proposalFamilyId,
      selectedItemIds: body.selectedItemIds,
      timestamp: Date.now(),
    })).slice(0, 32)

    const newCandidateDigest = syncSha256(
      canonicalJson({
        protocolVersion: proposal.protocolVersion,
        recordingId: proposal.recordingId,
        recordingDigest: proposal.recordingDigest,
        decisions: filteredDecisions,
      }),
    )

    const selectionSummary = `已选择 ${filteredDecisions.length} 项提案内容`

    const subProposal: AssistantRecordingProposalResult = {
      ...proposal,
      proposalId: newProposalId,
      decisions: filteredDecisions,
      excludedItemIds,
      proposalSummary: selectionSummary,
      candidateDigest: newCandidateDigest,
    }

    const newTurn = await createCompletedAssistantTurn(this.db, {
      conversationId,
      ownerAccountId: actor.id,
      parentTurnId: turnId,
      question: selectionSummary,
      capabilityId: 'recording.propose-scenario',
      result: packAssistantResultEnvelope(subProposal),
      slots: {
        recordingId: proposal.recordingId,
        targetId: proposal.targetId,
        proposalId: newProposalId,
        proposalFamilyId: proposal.proposalFamilyId,
      },
    }).catch(rethrowDomain)

    return {
      turnId: newTurn.id,
      proposalId: newProposalId,
      proposalFamilyId: proposal.proposalFamilyId,
      proposalDigest: newCandidateDigest,
      selectionSummary,
    }
  }

  async confirmRecordingOutcome(actor: Actor, conversationId: string, turnId: string, input: ConfirmRecordingOutcomeBody): Promise<ConfirmRecordingOutcomeResult> {
    this.requireAssist(actor)
    if (!hasAllPermissions(actor.permissions, ['workflow:write', 'target:read'])) throw new DomainError('forbidden', 'PERMISSION_DENIED', '缺少录制编写权限')
    const body = confirmRecordingOutcomeBodySchema.parse(input)
    const record = await getAssistantTurnRecord(this.db, turnId, actor.id).catch(rethrowDomain)
    if (record.turn.conversationId !== conversationId) throw new DomainError('not_found', 'ASSISTANT_TURN_NOT_FOUND', '轮次不存在')
    const proposal = unpackAssistantResultEnvelope(record.turn.result)
    if (proposal?.kind !== 'recording_proposal' || proposal.intent !== 'outcome' || !proposal.needsOutcomeConfirmation) throw new DomainError('bad_request', 'PROPOSAL_NOT_FOUND', '请从待确认的成功条件提案继续')
    await this.requireVisibleTarget(actor, proposal.targetId)
    if (body.proposalDigest !== proposal.candidateDigest) throw new DomainError('conflict', 'PROPOSAL_DIGEST_MISMATCH', '提案已变化，请重新生成')
    const facts = await getAssistantRecordingProposalFacts(this.db, proposal.recordingId, actor.id).catch(rethrowDomain)
    if (facts.recordingDigest !== proposal.recordingDigest) throw new DomainError('conflict', 'RECORDING_IMPORT_STALE', '录制已变化，请重新生成提案')
    const outcome = body.outcome
    const recorded = outcome.kind === 'recorded' ? facts.outcomeOptions.find((option) => option.itemId === outcome.itemId) : undefined
    const sourceItemId = outcome.kind === 'custom' ? outcome.afterItemId : recorded?.afterItemId
    const source = proposal.decisions.find((item) => item.itemId === sourceItemId && item.action === 'keep')
    if (!source || !facts.decisions.some((item) => item.itemId === sourceItemId && item.action === 'keep')) throw new DomainError('bad_request', 'RECORDING_SELECTION_INVALID', '请选择可导入的前序录制动作')
    const meaning = outcome.kind === 'custom' ? outcome.expectedOutcome : recorded!.meaning
    if (outcome.kind === 'custom' && /^(?:成功|操作成功|执行成功|正常|没问题|通过|都对了)[。！!\s]*$/.test(meaning)) throw new DomainError('bad_request', 'RECORDING_OUTCOME_VAGUE', '请描述页面上能核对的具体结果，例如显示的文字或列表内容')
    const proposalId = syncSha256(canonicalJson({ parent: proposal.proposalId, actorId: actor.id, outcome, source: facts.recordingDigest })).slice(0, 32)
    const decisions: AssistantRecordingProposalResult['decisions'] = [...proposal.decisions, {
      itemId: `outcome:${proposalId}`, action: 'modify', label: `成功条件：${meaning}`.slice(0, 256),
      reason: `用户已确认在「${source.label ?? '对应动作'}」之后检查；${recorded ? '沿用录制中的断言规则' : '用 AI 核对页面预期'}，尚未执行验证。`,
      change: { kind: 'outcome', sourceItemId: source.itemId, meaning,
        rule: recorded?.rule ?? { kind: 'ai', instruction: meaning }, confirmedBy: actor.id,
        ...(recorded ? { recordedItemId: recorded.itemId } : {}) },
    }]
    const result: AssistantRecordingProposalResult = { ...proposal, proposalId, decisions, needsOutcomeConfirmation: false, applicable: true,
      proposalSummary: `已确认在「${source.label ?? '对应动作'}」之后核对：${meaning}。请检查所选动作与成功条件，再预览采纳。`.slice(0, 1024),
      missingConfirmations: [], candidateDigest: syncSha256(canonicalJson({ recordingDigest: facts.recordingDigest, decisions })) }
    const turn = await createCompletedAssistantTurn(this.db, { conversationId, ownerAccountId: actor.id, parentTurnId: turnId,
      question: `确认成功条件：${meaning}`, capabilityId: 'recording.propose-scenario', result: packAssistantResultEnvelope(result),
      slots: { recordingId: proposal.recordingId, targetId: proposal.targetId, proposalId, proposalFamilyId: proposal.proposalFamilyId },
    }).catch(rethrowDomain)
    return { turnId: turn.id, proposal: result }
  }

  async getRecordingPreview(
    actor: Actor,
    conversationId: string,
    turnId: string,
    query: RecordingPreviewQuery,
  ): Promise<RecordingPreviewResult> {
    this.requireAssist(actor)
    if (!hasAllPermissions(actor.permissions, ['workflow:write', 'target:read'])) {
      throw new DomainError('forbidden', 'PERMISSION_DENIED', '缺少 workflow:write 或 target:read 权限')
    }

    const record = await getAssistantTurnRecord(this.db, turnId, actor.id).catch(rethrowDomain)
    if (record.turn.conversationId !== conversationId) {
      throw new DomainError('not_found', 'ASSISTANT_TURN_NOT_FOUND', '轮次不存在')
    }

    const result = unpackAssistantResultEnvelope(record.turn.result)
    if (!result || result.kind !== 'recording_proposal') {
      throw new DomainError('bad_request', 'PROPOSAL_NOT_FOUND', '当前轮次不包含可预览的录制提案')
    }

    const proposal = result as AssistantRecordingProposalResult
    await this.requireVisibleTarget(actor, proposal.targetId)

    if (!proposal.applicable || proposal.needsOutcomeConfirmation || !proposal.candidateDigest) throw new DomainError('conflict', 'PROPOSAL_NOT_APPLICABLE', '请先确认业务预期或重新生成可采纳的提案')
    if (query.proposalId && query.proposalId !== proposal.proposalId) throw new DomainError('conflict', 'PROPOSAL_DIGEST_MISMATCH', '提案已变化')
    let insertAnchor
    if (query.insertAnchor) {
      try { insertAnchor = recordingInsertAnchorSchema.parse(JSON.parse(query.insertAnchor)) }
      catch { throw new DomainError('bad_request', 'INVALID_INSERT_ANCHOR', '插入位置无效') }
    }
    const destinationScenarioId = query.destinationScenarioId
    if (destinationScenarioId) {
      await authorizeTargetRequest(this.db, actor.id, {
        scenarioId: destinationScenarioId,
        permissions: ['workflow:write'],
      }).catch(rethrowDomain)
    }

    return previewAssistantRecordingAdoption(
      this.db,
      {
        recordingId: proposal.recordingId,
        proposalId: proposal.proposalId,
        recordingDigest: proposal.recordingDigest,
        selectedItemIds: proposal.decisions.filter((d) => d.action !== 'exclude').map((d) => d.itemId),
        decisions: proposal.decisions,
        insertAnchor,
        destinationScenarioId,
      },
      actor.id,
    ).catch(rethrowDomain)
  }

  async adoptRecordingProposal(
    actor: Actor,
    conversationId: string,
    turnId: string,
    body: CreateRecordingAdoptionBody,
  ): Promise<CreateRecordingAdoptionResult> {
    this.requireAssist(actor)
    if (!hasAllPermissions(actor.permissions, ['workflow:write', 'target:read'])) {
      throw new DomainError('forbidden', 'PERMISSION_DENIED', '缺少 workflow:write 或 target:read 权限')
    }

    const record = await getAssistantTurnRecord(this.db, turnId, actor.id).catch(rethrowDomain)
    if (record.turn.conversationId !== conversationId) {
      throw new DomainError('not_found', 'ASSISTANT_TURN_NOT_FOUND', '轮次不存在')
    }

    const result = unpackAssistantResultEnvelope(record.turn.result)
    if (!result || result.kind !== 'recording_proposal') {
      throw new DomainError('bad_request', 'PROPOSAL_NOT_FOUND', '当前轮次不包含可采纳的录制提案')
    }

    const proposal = result as AssistantRecordingProposalResult
    await this.requireVisibleTarget(actor, proposal.targetId)

    if (!proposal.applicable || proposal.needsOutcomeConfirmation) throw new DomainError('conflict', 'PROPOSAL_NOT_APPLICABLE', '请先确认业务预期或重新生成可采纳的提案')

    if (
      !proposal.candidateDigest || body.proposalDigest !== proposal.candidateDigest
    ) {
      throw new DomainError('conflict', 'PROPOSAL_DIGEST_MISMATCH', '提案摘要与当前轮次不一致')
    }

    if (body.destinationScenarioId) {
      await authorizeTargetRequest(this.db, actor.id, {
        scenarioId: body.destinationScenarioId,
        permissions: ['workflow:write'],
      }).catch(rethrowDomain)
    }

    return adoptAssistantRecordingProposal(
      this.db,
      {
        recordingId: proposal.recordingId,
        proposalId: proposal.proposalId,
        proposalFamilyId: proposal.proposalFamilyId,
        recordingDigest: proposal.recordingDigest,
        selectedItemIds: proposal.decisions.filter((d) => d.action !== 'exclude').map((d) => d.itemId),
        decisions: proposal.decisions,
        insertAnchor: body.insertAnchor,
        proposalDigest: body.proposalDigest,
        candidateDigest: body.candidateDigest,
        proposalSummary: proposal.proposalSummary,
        sourceProtocol: proposal.protocolVersion,
        idempotencyKey: body.idempotencyKey,
        destinationScenarioId: body.destinationScenarioId,
        newScenarioName: body.newScenarioName,
        expectedRevision: body.expectedRevision,
        expectedDigest: body.expectedDigest,
      },
      { id: actor.id },
    ).catch(rethrowDomain)
  }


  private requireAssist(actor: Actor) {
    if (!hasAllPermissions(actor.permissions, ['ai:assist'])) {
      rethrowDomain(new DomainError('forbidden', 'ASSISTANT_FORBIDDEN', '当前角色不能使用平台助手'))
    }
  }

  private async requireVisibleTarget(actor: Actor, targetId: string) {
    if (!hasAllPermissions(actor.permissions, ['target:read'])) {
      throw new DomainError('forbidden', 'TARGET_FORBIDDEN', '没有该目标系统的访问权限，助手不能继续')
    }
    await assertTargetPermission(this.db, actor.id, targetId, 'target:read')
    try {
      return await this.targets.getTarget(targetId)
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new DomainError('not_found', 'TARGET_NOT_FOUND', '目标系统不存在')
      }
      throw error
    }
  }

  private async canReadStoredKnowledgeSource(actor: Actor, citation: string, slots: Record<string, unknown> | null): Promise<boolean> {
    try {
      if (citation.startsWith('help:')) {
        const item = effectiveHelpCatalog().find((entry) => entry.id === citation)
        return Boolean(item && hasAllPermissions(actor.permissions, item.requiredPermissions))
      }
      if (citation.startsWith('target:')) {
        const targetId = citation.slice('target:'.length)
        if (!targetId || !hasAllPermissions(actor.permissions, ['target:read', 'session:read'])) return false
        await this.requireVisibleTarget(actor, targetId)
        // A target citation is also used for account/session facts. The old
        // result does not record which of those facts it contained.
        await assertTargetPermission(this.db, actor.id, targetId, 'session:read')
        return true
      }
      if (citation.startsWith('scenario:')) {
        const scenarioId = citation.slice('scenario:'.length).split(':')[0] ?? ''
        if (!scenarioId || !hasAllPermissions(actor.permissions, ['workflow:read', 'target:read'])) return false
        await authorizeTargetRequest(this.db, actor.id, { scenarioId, permissions: ['workflow:read'] })
        const scenario = await getScenario(this.db, scenarioId)
        await this.requireVisibleTarget(actor, scenario.targetId)
        return true
      }
      if (citation.startsWith('run:')) {
        const runId = citation.slice('run:'.length)
        // A digest may summarize many runs while citing only a few examples.
        // Without a single explicit run scope its complete source set is unknown.
        if (!runId || !hasAllPermissions(actor.permissions, ['run:read', 'target:read'])) return false
        const run = await getRun(this.db, runId, actor.id)
        const explicitRun = slots?.runId === runId
        const accountScoped = typeof slots?.targetId === 'string' &&
          typeof slots?.targetAccountId === 'string' &&
          run.targetId === slots.targetId && run.targetAccountId === slots.targetAccountId
        let sessionScoped = false
        if (typeof slots?.sessionId === 'string') {
          const boundSession = await getSessionDto(this.db, slots.sessionId)
          sessionScoped = Boolean(boundSession && run.targetId === boundSession.targetId &&
            run.targetAccountId === boundSession.targetAccountId)
        }
        if (!explicitRun && !accountScoped && !sessionScoped) return false
        await this.requireVisibleTarget(actor, run.targetId)
        return true
      }
      if (citation.startsWith('session:')) {
        const sessionId = citation.slice('session:'.length)
        if (!sessionId || !hasAllPermissions(actor.permissions, ['session:read', 'target:read'])) return false
        await authorizeTargetRequest(this.db, actor.id, { sessionId, permissions: ['session:read'] })
        const session = await getSessionDto(this.db, sessionId)
        if (!session) return false
        await this.requireVisibleTarget(actor, session.targetId)
        return true
      }
      if (citation.startsWith('schedule:')) {
        const scheduleId = citation.slice('schedule:'.length)
        if (!scheduleId || !hasAllPermissions(actor.permissions, ['schedule:read', 'target:read'])) return false
        const schedule = await getSchedule(this.db, scheduleId, actor.id)
        if (!schedule) return false
        await this.requireVisibleTarget(actor, schedule.targetId)
        return true
      }
      if (citation.startsWith('occurrence:')) {
        const occurrenceId = citation.slice('occurrence:'.length)
        if (!occurrenceId || !hasAllPermissions(actor.permissions, ['schedule:read', 'target:read'])) return false
        const occurrence = await getScheduleOccurrence(this.db, occurrenceId, actor.id)
        if (!occurrence || (slots?.scheduleId && slots.scheduleId !== occurrence.scheduleId)) return false
        const schedule = await getSchedule(this.db, occurrence.scheduleId, actor.id)
        await this.requireVisibleTarget(actor, schedule.targetId)
        return true
      }
      if (citation.startsWith('dataset:')) {
        const datasetId = citation.slice('dataset:'.length)
        if (!datasetId || !hasAllPermissions(actor.permissions, ['dataset:read'])) return false
        return Boolean(await getDataset(this.db, datasetId, actor.id))
      }
      if (citation.startsWith('suite:')) {
        const suiteId = citation.slice('suite:'.length)
        if (!suiteId || !hasAllPermissions(actor.permissions, ['suite:read'])) return false
        const { getSuite } = await import('@cairn/db')
        return Boolean(await getSuite(this.db, suiteId, actor.id))
      }
      if (citation.startsWith('suiteRun:')) {
        const suiteRunId = citation.slice('suiteRun:'.length)
        if (!suiteRunId || !hasAllPermissions(actor.permissions, ['suite:read', 'run:read'])) return false
        const { getSuiteRunObservation } = await import('@cairn/db')
        return Boolean(await getSuiteRunObservation(this.db, suiteRunId, actor.id))
      }
      if (citation.startsWith('actionModule:')) {
        const moduleId = citation.slice('actionModule:'.length)
        if (!moduleId || !hasAllPermissions(actor.permissions, ['module:read'])) return false
        const { getActionModule } = await import('@cairn/db')
        const mod = await getActionModule(this.db, moduleId, actor.id)
        if (!mod) return false
        await this.requireVisibleTarget(actor, mod.targetId)
        return true
      }
      if (citation.startsWith('recording:')) {
        const recordingId = citation.slice('recording:'.length)
        if (!recordingId || !hasAllPermissions(actor.permissions, ['workflow:write'])) return false
        const { getRecordingDraft } = await import('@cairn/db')
        const rec = await getRecordingDraft(this.db, recordingId, actor.id)
        if (!rec) return false
        if (rec.createdBy.id !== actor.id && !actor.permissions.includes('admin')) return false
        await this.requireVisibleTarget(actor, rec.targetId)
        return true
      }
      if (citation.startsWith('batch:')) {
        const batchId = citation.slice('batch:'.length)
        if (!batchId || !hasAllPermissions(actor.permissions, ['batch:read'])) return false
        const { getBatch } = await import('@cairn/db')
        return Boolean(await getBatch(this.db, batchId, actor.id))
      }
      if (citation.startsWith('analysis:')) {
        return true
      }
    } catch {
      return false
    }
    // Step, Attempt, evidence, incident and view citations do not
    // carry enough scope to reconstruct all facts in a legacy free-text answer.
    return false
  }

  private async canReadStoredKnowledgeAnswer(
    actor: Actor,
    result: Extract<NonNullable<Awaited<ReturnType<typeof getAssistantTurnRecord>>['turn']['result']>, { kind: 'knowledge_answer' }>,
    slots: Record<string, unknown> | null,
  ): Promise<boolean> {
    if (result.analysis || result.sourceManifest) {
      if (!result.sourceManifest) return false
      const manifest = result.sourceManifest
      if (!manifest.sources) return false
      if (manifest.sources.length === 0) {
        const intent = ASSISTANT_BUSINESS_INTENTS.find((item) => item.id === result.analysis?.intentId)
        return manifest.scope.ownerAccountId === actor.id && Boolean(intent && hasAllPermissions(actor.permissions, intent.requiredPermissions))
      }
      try {
        for (const source of manifest.sources) {
          if (!hasAllPermissions(actor.permissions, source.requiredPermissions)) return false
          if (source.kind === 'target') {
            await this.requireVisibleTarget(actor, source.id)
          } else if (source.kind === 'scenario' || source.kind === 'workflow') {
            const scenario = await getScenario(this.db, source.id)
            await this.requireVisibleTarget(actor, scenario.targetId)
            if (source.version) { const { loadScenarioVersion } = await import('@cairn/db'); await loadScenarioVersion(this.db, source.id, String(source.version)) }
          } else if (source.kind === 'run') {
            const run = await getRun(this.db, source.id, actor.id)
            await this.requireVisibleTarget(actor, run.targetId)
          } else if (source.kind === 'suite') {
            const { getSuite } = await import('@cairn/db')
            const suite = await getSuite(this.db, source.id, actor.id)
            if (!suite) return false
          } else if (source.kind === 'suiteRun') {
            const { getSuiteRunObservation } = await import('@cairn/db')
            const suiteRun = await getSuiteRunObservation(this.db, source.id, actor.id)
            if (!suiteRun) return false
          } else if (source.kind === 'actionModule') {
            const { getActionModule } = await import('@cairn/db')
            const mod = await getActionModule(this.db, source.id, actor.id)
            if (!mod) return false
            await this.requireVisibleTarget(actor, mod.targetId)
          } else if (source.kind === 'recording') {
            const { getRecordingDraft } = await import('@cairn/db')
            const rec = await getRecordingDraft(this.db, source.id, actor.id)
            if (!rec) return false
            if (rec.createdBy.id !== actor.id && !actor.permissions.includes('admin')) return false
            await this.requireVisibleTarget(actor, rec.targetId)
          } else if (source.kind === 'batch') {
            const { getBatch } = await import('@cairn/db')
            const batch = await getBatch(this.db, source.id, actor.id)
            if (!batch) return false
          } else if (source.kind === 'schedule') {
            const schedule = await getSchedule(this.db, source.id, actor.id)
            if (!schedule) return false
            await this.requireVisibleTarget(actor, schedule.targetId)
          } else if (source.kind === 'dataset') {
            const dataset = await getDataset(this.db, source.id, actor.id)
            if (!dataset) return false
          } else if (source.kind === 'scheduleOccurrence') {
            if (!await getScheduleOccurrence(this.db, source.id, actor.id)) return false
          } else if (source.kind === 'account') {
            if (!source.targetId) return false
            await assertTargetPermission(this.db, actor.id, source.targetId, 'session:read')
            const { getAccountSessionDetail } = await import('@cairn/db')
            await getAccountSessionDetail(this.db, { targetId: source.targetId, targetAccountId: source.id })
          } else return false
          if (source.targetId) {
            await this.requireVisibleTarget(actor, source.targetId)
            for (const permission of source.requiredPermissions) await assertTargetPermission(this.db, actor.id, source.targetId, permission as Parameters<typeof assertTargetPermission>[3])
          }
        }
      } catch {
        return false
      }
      return true
    }

    const digestClaims = result.claims.filter((claim) =>
      claim.citations.includes(RUN_FAILURE_DIGEST_CITATION))
    if (digestClaims.length > 0) {
      // A grouped answer can summarize runs that the model did not cite in its
      // prose. Only the deterministic digest with a complete source manifest
      // can be replayed after every input Run is reauthorized.
      if (result.claims.length !== 1 || digestClaims.length !== 1 || digestClaims[0]!.factKind !== 'observed') return false
      const manifestCitations = digestClaims[0]!.citations
      if (manifestCitations[0] !== RUN_FAILURE_DIGEST_CITATION) return false
      const sourceCitations = manifestCitations.slice(1)
      if (sourceCitations.length < 1 || sourceCitations.length > 50) return false
      if (new Set(sourceCitations).size !== sourceCitations.length) return false
      if (sourceCitations.some((citation) => !/^run:[0-9a-f-]{36}$/i.test(citation))) return false
      const sourceSet = new Set(sourceCitations)
      if (result.nextActions?.some((action) => {
        if (action.kind !== 'run.detail' || action.citations.length !== 1) return true
        const citation = action.citations[0]!
        return !sourceSet.has(citation) || action.href !== `/runs/${citation.slice('run:'.length)}`
      })) return false
      if (!hasAllPermissions(actor.permissions, ['run:read', 'target:read'])) return false
      try {
        await Promise.all(sourceCitations.map(async (citation) => {
          const run = await getRun(this.db, citation.slice('run:'.length), actor.id)
          await this.requireVisibleTarget(actor, run.targetId)
        }))
      } catch {
        return false
      }
      return true
    }

    const citations = [
      ...result.claims.flatMap((claim) => claim.citations),
      ...(result.nextActions ?? []).flatMap((action) => action.citations),
    ]
    if (citations.length === 0 || result.claims.some((claim) => claim.citations.length === 0)) return false
    const staticRoutes = new Set([
      '/scenarios',
      '/runs',
      '/targets',
      '/platform-config',
      '/datasets',
      '/schedules',
      '/suites',
      '/action-modules',
      '/recordings',
      '/batches',
    ])
    if (result.nextActions?.some((action) => action.citations.length === 0 && !staticRoutes.has(action.href))) return false
    for (const citation of new Set(citations)) {
      if (!(await this.canReadStoredKnowledgeSource(actor, citation, slots))) return false
    }
    // These IDs may have supplied the uncited summary. Recheck them too.
    for (const [key, prefix] of [
      ['targetId', 'target:'],
      ['scenarioId', 'scenario:'],
      ['runId', 'run:'],
      ['sessionId', 'session:'],
      ['scheduleId', 'schedule:'],
      ['datasetId', 'dataset:'],
    ] as const) {
      const id = slots?.[key]
      if (typeof id === 'string' && id && !(await this.canReadStoredKnowledgeSource(actor, `${prefix}${id}`, slots))) return false
    }
    return true
  }

  private async sanitizeStoredTurn(
    actor: Actor,
    turn: Awaited<ReturnType<typeof getAssistantTurnRecord>>['turn'],
    slots: Record<string, unknown> | null,
  ) {
    const unpackedResult = turn.result ? unpackAssistantResultEnvelope(turn.result) : null
    if (!unpackedResult || unpackedResult.kind === 'inaccessible' || unpackedResult.kind === 'clarify') {
      return { ...turn, result: unpackedResult }
    }

    if (slots?.quote) {
      const quoteObj = assistantQuoteContextSchema.safeParse(slots.quote)
      if (quoteObj.success) {
        const quoteTargetId = quoteTargetSystemId(quoteObj.data)
        if (quoteTargetId) {
          try {
            await this.requireVisibleTarget(actor, quoteTargetId)
          } catch {
            return { ...turn, result: { kind: 'inaccessible' as const, message: '引用内容所属目标已不可访问' } }
          }
        }
      }
    }

    if (unpackedResult.kind === 'discovery') {
      if (!hasAllPermissions(actor.permissions, ['target:read'])) {
        return { ...turn, result: { kind: 'inaccessible' as const, message: '相关目标已不可访问' } }
      }
      if (unpackedResult.scope.targetId) {
        try {
          await this.requireVisibleTarget(actor, unpackedResult.scope.targetId)
        } catch {
          return { ...turn, result: { kind: 'inaccessible' as const, message: '相关目标已不可访问' } }
        }
      }
      const visibleCandidates: typeof unpackedResult.candidates = []
      for (const candidate of unpackedResult.candidates) {
        try {
          await this.requireVisibleTarget(actor, candidate.targetId)
          visibleCandidates.push(candidate)
        } catch {
          // excluded
        }
      }
      if (unpackedResult.candidates.length > 0 && visibleCandidates.length === 0) {
        return { ...turn, result: { kind: 'inaccessible' as const, message: '相关目标已不可访问' } }
      }
      return {
        ...turn,
        result: {
          ...unpackedResult,
          candidates: visibleCandidates,
          coverage: {
            ...unpackedResult.coverage,
            totalVisible: visibleCandidates.length,
          },
        },
      }
    }

    if (unpackedResult.kind === 'guide') {
      const topic = assistantGuideTopicSchema.safeParse(slots?.topic).success
        ? assistantGuideTopicSchema.parse(slots?.topic)
        : undefined
      const guide = buildPlatformGuideForQuestion(actor.permissions, topic, turn.question)
      if (guide.kind !== 'guide') return { ...turn, result: guide }
      if (isTargetDeletionGuideQuestion(turn.question)) {
        if (!guide.items.some((item) => item.topic === 'targets')) {
          return { ...turn, result: { kind: 'unsupported' as const, reasonCode: 'GUIDE_UNAVAILABLE', message: '当前权限不能打开目标系统入口。' } }
        }
        const targetId = typeof slots?.targetId === 'string' ? slots.targetId : undefined
        if (targetId) {
          try {
            await this.requireVisibleTarget(actor, targetId)
          } catch {
            return { ...turn, result: { kind: 'inaccessible' as const, message: '相关目标已不可访问' } }
          }
        }
        return { ...turn, result: targetDeletionGuide(targetId) }
      }
      return { ...turn, result: guide }
    }

    if (unpackedResult.kind === 'knowledge_answer') {
      if (unpackedResult.claims.some((claim) => claim.citations.includes(NAMED_TARGET_ACCOUNT_RUN_CITATION))) {
        const targetId = typeof slots?.targetId === 'string' ? slots.targetId : ''
        if (!targetId) return { ...turn, thinkingText: undefined, result: { kind: 'inaccessible' as const, message: '历史目标范围无法核验，请重新提问' } }
        try {
          const rebuilt = await buildNamedTargetAccountRunResult(this.db, actor, this.targets, targetId)
          return { ...turn, thinkingText: undefined, result: rebuilt }
        } catch {
          return { ...turn, thinkingText: undefined, result: { kind: 'inaccessible' as const, message: '相关目标已不可访问' } }
        }
      }
      // This answer contains no target entity facts; it only records what the
      // actor-scoped lookup found at the answer's asOf time. Keep that wording
      // instead of attempting to replay a now-stale target list as current.
      if (unpackedResult.claims.length === 1 &&
        unpackedResult.claims[0]?.citations.length === 1 &&
        unpackedResult.claims[0].citations[0] === NAMED_TARGET_SCOPE_CITATION) {
        return { ...turn, thinkingText: undefined, result: unpackedResult }
      }
      const isOverview = unpackedResult.claims.length === 1 &&
        unpackedResult.claims[0]?.factKind === 'human_confirmed' &&
        unpackedResult.claims[0]?.citations.length === 1 &&
        unpackedResult.claims[0]?.citations[0] === 'platform:capability_overview' &&
        (!unpackedResult.nextActions || unpackedResult.nextActions.length === 0)
      if (isOverview) {
        return { ...turn, thinkingText: undefined, result: buildCapabilityOverviewResult(actor.permissions) }
      }
      const isTargetCpuUnavailable = unpackedResult.claims.length === 1 &&
        unpackedResult.claims[0]?.factKind === 'human_confirmed' &&
        unpackedResult.claims[0]?.citations.length === 1 &&
        unpackedResult.claims[0]?.citations[0] === TARGET_CPU_UNAVAILABLE_CITATION &&
        (!unpackedResult.nextActions || unpackedResult.nextActions.length === 0)
      if (isTargetCpuUnavailable) {
        // This is a fixed platform capability limit with no target facts. Never
        // replay historical free text when the target context changes.
        return { ...turn, thinkingText: undefined, result: buildTargetCpuUnavailableResult() }
      }
      const isPageContextMismatch = unpackedResult.claims.length === 1 &&
        unpackedResult.claims[0]?.factKind === 'human_confirmed' &&
        unpackedResult.claims[0]?.citations.length === 1 &&
        unpackedResult.claims[0]?.citations[0] === PAGE_CONTEXT_MISMATCH_CITATION &&
        (!unpackedResult.nextActions || unpackedResult.nextActions.length === 0)
      if (isPageContextMismatch) {
        return { ...turn, thinkingText: undefined, result: buildPageContextMismatchResult() }
      }
      const statusCitation = unpackedResult.claims.length === 1 &&
        unpackedResult.claims[0]?.factKind === 'human_confirmed' &&
        unpackedResult.claims[0]?.citations.length === 1
        ? unpackedResult.claims[0].citations[0]
        : undefined
      const knowledgeStatus = statusCitation ? knowledgeStatusFromCitation(statusCitation) : null
      if (knowledgeStatus) {
        return { ...turn, thinkingText: undefined, result: buildKnowledgeStatusResult(knowledgeStatus) }
      }
      // Older model answers could publish arbitrary conclusions as inferred
      // claims once their premises had a valid citation. The summary may also
      // contain that conclusion, so do not replay any part of such an answer.
      if (unpackedResult.claims.some((claim) => claim.factKind === 'inferred')) {
        return { ...turn, thinkingText: undefined, result: {
          kind: 'inaccessible' as const,
          message: '这条历史推断未按当前证据规则核验，请重新提问',
          reasonCode: 'UNVERIFIED_HISTORY' as const,
        } }
      }
      if (!(await this.canReadStoredKnowledgeAnswer(actor, unpackedResult, slots))) {
        return { ...turn, thinkingText: undefined, result: { kind: 'inaccessible' as const, message: '历史回答的事实来源已不可访问或无法重新核验，请重新提问' } }
      }
      const helpClaims = unpackedResult.claims.filter((claim) =>
        claim.citations.some((citation) => citation.startsWith('help:')))
      const helpCatalog = effectiveHelpCatalog()
      if (helpClaims.some((claim) => {
        if (claim.factKind !== 'human_confirmed' || claim.citations.length !== 1) return true
        const item = helpCatalog.find((entry) => entry.id === claim.citations[0])
        return !item || !item.content.includes(claim.text)
      })) {
        return { ...turn, thinkingText: undefined, result: {
          kind: 'inaccessible' as const,
          reasonCode: 'UNVERIFIED_HISTORY' as const,
          message: '这条历史帮助结论无法按已发布原文核验，请重新提问',
        } }
      }
      if (helpClaims.length > 0 && helpClaims.length === unpackedResult.claims.length) {
        // A legacy summary or missing item can still contain the model's
        // discarded paraphrase. Rebuild from verified help excerpts only.
        const helpRoutes = new Set(helpClaims.map((claim) =>
          helpCatalog.find((entry) => entry.id === claim.citations[0])!.pageRoute))
        return { ...turn, thinkingText: undefined, result: {
          ...unpackedResult,
          summary: helpClaims.map((claim) => claim.text).join('\n').slice(0, 2000),
          missing: [],
          nextActions: unpackedResult.nextActions?.filter((action) =>
            action.citations.length === 0 && helpRoutes.has(action.href)),
        } }
      }
      return { ...turn, thinkingText: undefined, result: unpackedResult }
    }

    if (unpackedResult.kind === 'in_page_guidance') {
      const targetId = typeof slots?.targetId === 'string' ? slots.targetId : ''
      const page = typeof slots?.page === 'string' ? slots.page : ''
      const question = typeof slots?.question === 'string' ? slots.question : ''
      if (isTargetPageEntryQuestion(page, question)) {
        if (!targetId) {
          return { ...turn, thinkingText: undefined, result: { kind: 'inaccessible' as const, message: '历史目标页面指引缺少可核验的目标范围，请重新提问' } }
        }
        try {
          if (!hasAllPermissions(actor.permissions, ['target:read', 'map:read'])) throw new Error('permission denied')
          const target = await this.requireVisibleTarget(actor, targetId)
          const namedTarget = namedTargetForPageEntryQuestion(question)
          if (namedTarget && target.name.toLocaleLowerCase() !== namedTarget.toLocaleLowerCase()) {
            return { ...turn, thinkingText: undefined, result: { kind: 'inaccessible' as const, message: '历史页面指引的目标范围与提问名称不一致，请重新提问' } }
          }
          await assertTargetPermission(this.db, actor.id, targetId, 'map:read')
          const rebuilt = await resolveObservedTargetPageEntry({ actor, db: this.db, targets: this.targets }, targetId, question)
          return { ...turn, thinkingText: undefined, result: rebuilt }
        } catch {
          return { ...turn, thinkingText: undefined, result: { kind: 'inaccessible' as const, message: '历史页面指引的目标知识已不可访问' } }
        }
      }
      const rebuilt = typeof page === 'string' && question
        ? buildManifestPageGuidance(page, question)
        : null
      if (rebuilt) return { ...turn, thinkingText: undefined, result: rebuilt }
      return { ...turn, thinkingText: undefined, result: { kind: 'inaccessible' as const, message: '历史页面指引缺少可复核的来源，请重新提问' } }
    }

    if (unpackedResult.kind === 'diagnosis') {
      const runDetailAction = unpackedResult.nextActions.find(
        (item) => item.kind === 'run.detail' && item.href.startsWith('/runs/') && item.href !== '/runs',
      )
      const rawRunId =
        typeof slots?.runId === 'string' && slots.runId.trim().length > 0
          ? slots.runId
          : runDetailAction
            ? runDetailAction.href.split('/').pop()
            : undefined
      const runId = rawRunId && rawRunId !== 'runs' ? rawRunId : undefined
      if (!runId && unpackedResult.hypotheses.length > 0) {
        return { ...turn, result: { kind: 'inaccessible' as const, message: '历史运行诊断缺少可核验的运行范围，请重新提问' } }
      }
      if (runId) {
        if (!hasAllPermissions(actor.permissions, ['run:read', 'target:read'])) {
          return { ...turn, result: { kind: 'inaccessible' as const, message: '相关运行或目标已不可访问' } }
        }
        try {
          const run = await getRun(this.db, runId, actor.id)
          await this.requireVisibleTarget(actor, run.targetId)
          if (unpackedResult.hypotheses.length > 0) {
            return { ...turn, result: {
              ...unpackedResult,
              hypotheses: [],
              missingInformation: [
                '历史模型原因未经过语义证据核验，已隐藏；请按当前运行事实与失败步骤证据重新核对。',
                ...unpackedResult.missingInformation,
              ].slice(0, 12),
            } }
          }
        } catch {
          return {
            ...turn,
            result: { kind: 'inaccessible' as const, message: '相关运行或目标已不可访问' },
          }
        }
      }
    }

    if (unpackedResult.kind === 'compare') {
      const baseRunId = unpackedResult.baseRunId
      const targetRunId = unpackedResult.targetRunId
      if (!hasAllPermissions(actor.permissions, ['run:read', 'target:read'])) {
        return { ...turn, result: { kind: 'inaccessible' as const, message: '相关运行或目标已不可访问' } }
      }
      try {
        const [base, target] = await Promise.all([
          getRun(this.db, baseRunId, actor.id),
          getRun(this.db, targetRunId, actor.id),
        ])
        await this.requireVisibleTarget(actor, base.targetId)
        await this.requireVisibleTarget(actor, target.targetId)
      } catch {
        return {
          ...turn,
          result: { kind: 'inaccessible' as const, message: '相关运行或目标已不可访问' },
        }
      }
    }

    if (
      unpackedResult.kind === 'explanation' ||
      unpackedResult.kind === 'proposal' ||
      unpackedResult.kind === 'knowledge_proposal' ||
      unpackedResult.kind === 'authoring_proposal'
    ) {
      const scenarioId = unpackedResult.kind === 'authoring_proposal'
        ? unpackedResult.scenarioId
        : typeof slots?.scenarioId === 'string' ? slots.scenarioId : ''
      if (
        !scenarioId ||
        !hasAllPermissions(actor.permissions, ['workflow:read', 'target:read'])
      ) {
        return { ...turn, result: { kind: 'inaccessible' as const, message: '相关场景或目标已不可访问' } }
      }
      try {
        await authorizeTargetRequest(this.db, actor.id, {
          scenarioId,
          permissions: ['workflow:read'],
        })
        const detail = await getScenario(this.db, scenarioId)
        await this.requireVisibleTarget(actor, detail.targetId)
      } catch {
        return { ...turn, result: { kind: 'inaccessible' as const, message: '相关场景或目标已不可访问' } }
      }
    }

    if (unpackedResult.kind === 'recording_proposal') {
      try {
        if (!hasAllPermissions(actor.permissions, ['ai:assist', 'workflow:write', 'target:read'])) {
          return { ...turn, thinkingText: undefined, result: { kind: 'inaccessible' as const, message: '缺乏录制提案所需权限' } }
        }
        const { getRecordingDraft } = await import('@cairn/db')
        const rec = await getRecordingDraft(this.db, unpackedResult.recordingId, actor.id)
        if (!rec) {
          return { ...turn, thinkingText: undefined, result: { kind: 'inaccessible' as const, message: '录制草稿已删除或不可访问' } }
        }
        if (rec.createdBy.id !== actor.id && !actor.permissions.includes('admin')) {
          return { ...turn, thinkingText: undefined, result: { kind: 'inaccessible' as const, message: '无权访问此录制草稿' } }
        }
        await this.requireVisibleTarget(actor, unpackedResult.targetId)
        if (unpackedResult.targetScenarioId) {
          const scenario = await getScenario(this.db, unpackedResult.targetScenarioId)
          await this.requireVisibleTarget(actor, scenario.targetId)
          await authorizeTargetRequest(this.db, actor.id, {
            scenarioId: unpackedResult.targetScenarioId,
            permissions: ['workflow:write'],
          })
        }
      } catch {
        return { ...turn, thinkingText: undefined, result: { kind: 'inaccessible' as const, message: '录制或目标场景已不可访问' } }
      }
    }

    return { ...turn, result: unpackedResult }
  }
}
