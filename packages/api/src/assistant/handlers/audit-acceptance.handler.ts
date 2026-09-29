import {
  type AssistantAcceptanceAuditReport,
  type AssistantResult,
  type ScenarioAuthoringDocumentV2,
  acceptanceIntentNeedsTarget,
  acceptanceIntentRequestSchema,
  authoringSteps,
  hasPermission,
  isAuthoringDocumentV2,
  parseScenarioDocument,
  toAuthoringDocumentV2,
} from '@cairn/shared'
import { auditAcceptance } from '@cairn/authoring'
import { DomainError, expandWithLoader, getScenario, newId } from '@cairn/db'
import type { AssistantCapabilityHandlerContext } from '../registry.js'
import { generateAcceptanceAuditSuggestions } from '../model-session.js'

export async function handleScenarioAuditAcceptance(
  ctx: AssistantCapabilityHandlerContext,
): Promise<AssistantResult> {
  const { db, actor, slots, body, session, onProgress, signal } = ctx

  if (!hasPermission(actor.permissions, 'ai:assist')) {
    throw new DomainError('forbidden', 'AI_ASSIST_FORBIDDEN', '没有 AI 助手访问权限')
  }
  if (!hasPermission(actor.permissions, 'workflow:read')) {
    throw new DomainError('forbidden', 'WORKFLOW_READ_FORBIDDEN', '没有工作流读取权限')
  }

  const scenarioId = (slots.scenarioId as string | undefined) ?? body.pageContext?.scenarioId
  if (!scenarioId) {
    throw new DomainError('bad_request', 'MISSING_SLOT', '缺少必需参数 scenarioId')
  }

  const detail = await getScenario(db, scenarioId)
  if (!detail) throw new DomainError('not_found', 'SCENARIO_NOT_FOUND', '场景不存在')
  if (!detail.draft) throw new DomainError('bad_request', 'DRAFT_NOT_FOUND', '当前场景没有待编辑的草稿')
  const draftRevisionSlot = slots.draftRevision as number | undefined
  if (draftRevisionSlot !== undefined && draftRevisionSlot !== detail.draft.revision) {
    throw new DomainError('conflict', 'DRAFT_REVISION_MISMATCH', '场景草稿已被修改，请保存后重新体检')
  }

  const rawDoc = detail.draft.document
  const document: ScenarioAuthoringDocumentV2 = isAuthoringDocumentV2(rawDoc)
    ? rawDoc
    : toAuthoringDocumentV2(parseScenarioDocument(rawDoc))

  await onProgress?.('loading_facts', '正在编译草稿并运行规则体检...')
  // 与试跑一致的展开与编译，获得编译诊断
  const compileResult = await expandWithLoader(db, detail.targetId, document, 'trial', true)

  // 1. 确定性体检（纯函数，无模型也可全量执行）
  const report: AssistantAcceptanceAuditReport = auditAcceptance(
    document,
    compileResult.diagnostics,
    detail.id,
  )

  // 2. 模型增补建议（有模型时追加，无模型或调用失败时优雅降级）
  if (session) {
    try {
      await onProgress?.('generating', '正在结合业务逻辑生成增补建议...')
      const steps = authoringSteps(document).map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type,
      }))
      const auditResult = await generateAcceptanceAuditSuggestions(
        session,
        {
          steps,
          findings: report.findings.map((f) => ({
            code: f.code,
            message: f.message,
            ...(f.stepId ? { stepId: f.stepId } : {}),
          })),
        },
        signal,
      )
      if (auditResult.output?.suggestedIntents) {
        for (const item of auditResult.output.suggestedIntents) {
          const parsedIntent = acceptanceIntentRequestSchema.safeParse({
            key: `acc_audit_ai_${newId().replace(/-/g, '').slice(-6)}`,
            kind: item.kind,
            ...(item.stepId ? { stepId: item.stepId } : {}),
            ...(item.stepIdA ? { stepIdA: item.stepIdA } : {}),
            ...(item.stepIdB ? { stepIdB: item.stepIdB } : {}),
            severity: item.severity ?? 'SHOULD',
            ...(item.maxMs ? { maxMs: item.maxMs } : {}),
            ...(item.op && item.value !== undefined ? { op: item.op, value: item.value } : {}),
            ...(item.tolerance !== undefined ? { tolerance: item.tolerance } : {}),
            ...(item.text ? { text: item.text, absent: item.absent ?? false } : {}),
            ...(item.metricName ? { metricName: item.metricName } : {}),
            ...(item.unit ? { unit: item.unit } : {}),
          })
          if (parsedIntent.success) {
            report.suggestedIntents.push({
              id: `suggest-ai-${newId()}`,
              intent: parsedIntent.data,
              label: item.label,
              rationale: item.rationale,
              needsTarget: acceptanceIntentNeedsTarget(parsedIntent.data.kind),
              source: 'model',
            })
          }
        }
      }
    } catch {
      // 模型增补失败时不阻断，保留确定性体检结果
    }
  }

  return report
}
