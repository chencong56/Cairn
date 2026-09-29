import {
  type AcceptanceRequest,
  type AssistantAcceptanceAuditReport,
  type AssistantAuthoringProposal,
  type AssistantResult,
  type AssistantTurn,
  scenarioAcceptanceHistoryResponseSchema,
  type ScenarioAcceptanceHistoryResponse,
} from '@cairn/shared'
import {
  createAssistantConversation,
  createAssistantTurn,
  fetchAssistantTurn,
  observeAssistantTurn,
} from '@/lib/assistant-api'
import { apiFetch, toQueryString } from '@/lib/api-client'

const TERMINAL_TURN_STATUSES = new Set<AssistantTurn['status']>(['COMPLETED', 'CLARIFY', 'FAILED', 'CANCELLED', 'INTERRUPTED'])

function clientId(prefix: string): string {
  const id = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}-${id}`
}

export type AcceptanceProposalOutcome =
  | { kind: 'proposal'; proposal: AssistantAuthoringProposal }
  | { kind: 'clarify'; message: string }
  | { kind: 'message'; message: string }

function outcomeOf(result: AssistantResult | null, turn: AssistantTurn): AcceptanceProposalOutcome {
  if (result?.kind === 'authoring_proposal' && result.source === 'acceptance') return { kind: 'proposal', proposal: result }
  if (result?.kind === 'clarify') return { kind: 'clarify', message: result.question }
  if (result && 'message' in result && typeof result.message === 'string') return { kind: 'message', message: result.message }
  if (turn.status === 'CANCELLED') return { kind: 'message', message: '已取消' }
  return { kind: 'message', message: turn.stopReason ?? '没能生成验收方案，请稍后重试' }
}

export type AcceptanceAuditOutcome =
  | { kind: 'report'; report: AssistantAcceptanceAuditReport }
  | { kind: 'message'; message: string }

function auditOutcomeOf(result: AssistantResult | null, turn: AssistantTurn): AcceptanceAuditOutcome {
  if (result?.kind === 'acceptance_audit_report') return { kind: 'report', report: result }
  if (result?.kind === 'clarify') return { kind: 'message', message: result.question }
  if (result && 'message' in result && typeof result.message === 'string') return { kind: 'message', message: result.message }
  if (turn.status === 'CANCELLED') return { kind: 'message', message: '已取消' }
  return { kind: 'message', message: turn.stopReason ?? '验收体检未能完成，请稍后重试' }
}

/**
 * 以识途助手的一轮对话生成验收方案：模型调用、耗时与 Token 记在该轮下，
 * 与场景草稿修订、基线运行一起可追溯。进度走 SSE，断线时补读持久化的轮次。
 */
export async function requestAcceptanceProposal(input: {
  scenarioId: string
  draftRevision: number
  acceptance: AcceptanceRequest
  onStage?: (stage: string) => void
  signal?: AbortSignal
}): Promise<AcceptanceProposalOutcome> {
  const question = input.acceptance.description
    ? `为当前场景生成验收方案（自然语言描述）`
    : `为当前场景生成验收方案（${input.acceptance.intents.length} 项）`
  const conversation = await createAssistantConversation({ idempotencyKey: clientId('acc'), title: '补全验收', question })
  const accepted = await createAssistantTurn(
    conversation.id,
    {
      clientTurnId: clientId('turn'),
      question,
      capabilityHint: 'scenario.propose-acceptance',
      pageContext: {
        page: 'studio',
        scenarioId: input.scenarioId,
        draftRevision: input.draftRevision,
        ...(input.acceptance.baselineRunId ? { runId: input.acceptance.baselineRunId } : {}),
      },
      acceptance: input.acceptance,
    },
    input.signal,
  )

  return await new Promise<AcceptanceProposalOutcome>((resolve, reject) => {
    let settled = false
    let cleanup: () => void = () => undefined
    const finish = (turn: AssistantTurn) => {
      if (settled || !TERMINAL_TURN_STATUSES.has(turn.status)) return
      settled = true
      cleanup()
      resolve(outcomeOf(turn.result, turn))
    }
    const fail = (error: Error) => {
      if (settled) return
      // 流断了先补读一次持久化的轮次，已结束就直接用结果。
      void fetchAssistantTurn(conversation.id, accepted.turnId)
        .then((turn) => {
          if (TERMINAL_TURN_STATUSES.has(turn.status)) finish(turn)
          else if (!settled) {
            settled = true
            cleanup()
            reject(error)
          }
        })
        .catch(() => {
          if (settled) return
          settled = true
          cleanup()
          reject(error)
        })
    }
    input.signal?.addEventListener('abort', () => fail(new Error('已取消')), { once: true })
    cleanup = observeAssistantTurn(conversation.id, accepted.turnId, {
      onEvent: (event) => input.onStage?.(event.stage),
      onTurn: finish,
      onError: fail,
    })
  })
}

/**
 * 以识途助手的一轮对话发起验收体检：先执行确定性静态体检，
 * 模型可用时由模型给出补充建议。进度走 SSE，断线时补读持久化的轮次。
 */
export async function requestAcceptanceAudit(input: {
  scenarioId: string
  draftRevision: number
  onStage?: (stage: string) => void
  signal?: AbortSignal
}): Promise<AcceptanceAuditOutcome> {
  const question = '对当前场景验收设计进行体检'
  const conversation = await createAssistantConversation({ idempotencyKey: clientId('acc-audit'), title: '验收体检', question })
  const accepted = await createAssistantTurn(
    conversation.id,
    {
      clientTurnId: clientId('turn'),
      question,
      capabilityHint: 'scenario.audit-acceptance',
      pageContext: {
        page: 'studio',
        scenarioId: input.scenarioId,
        draftRevision: input.draftRevision,
      },
    },
    input.signal,
  )

  return await new Promise<AcceptanceAuditOutcome>((resolve, reject) => {
    let settled = false
    let cleanup: () => void = () => undefined
    const finish = (turn: AssistantTurn) => {
      if (settled || !TERMINAL_TURN_STATUSES.has(turn.status)) return
      settled = true
      cleanup()
      resolve(auditOutcomeOf(turn.result, turn))
    }
    const fail = (error: Error) => {
      if (settled) return
      void fetchAssistantTurn(conversation.id, accepted.turnId)
        .then((turn) => {
          if (TERMINAL_TURN_STATUSES.has(turn.status)) finish(turn)
          else if (!settled) {
            settled = true
            cleanup()
            reject(error)
          }
        })
        .catch(() => {
          if (settled) return
          settled = true
          cleanup()
          reject(error)
        })
    }
    input.signal?.addEventListener('abort', () => fail(new Error('已取消')), { once: true })
    cleanup = observeAssistantTurn(conversation.id, accepted.turnId, {
      onEvent: (event) => input.onStage?.(event.stage),
      onTurn: finish,
      onError: fail,
    })
  })
}

export async function fetchScenarioAcceptanceHistory(
  scenarioId: string,
  params?: { limit?: number; since?: string },
): Promise<ScenarioAcceptanceHistoryResponse> {
  const query = toQueryString(params)
  return apiFetch(`/api/scenarios/${scenarioId}/acceptance-history${query}`, scenarioAcceptanceHistoryResponseSchema)
}
