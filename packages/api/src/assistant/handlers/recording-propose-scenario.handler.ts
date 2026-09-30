import { canonicalJson, normalizeAssistantPageContext, syncSha256, type AssistantRecordingProposalResult, type AssistantResult } from '@cairn/shared'
import { getAssistantRecordingProposalFacts, newId } from '@cairn/db'
import type { AssistantCapabilityHandlerContext } from '../registry.js'

export async function handleRecordingProposeScenario(ctx: AssistantCapabilityHandlerContext): Promise<AssistantResult> {
  const page = normalizeAssistantPageContext(ctx.body.pageContext)
  const recordingId = typeof ctx.slots.recordingId === 'string' ? ctx.slots.recordingId : page?.primaryRef?.kind === 'recording' ? page.primaryRef.id : undefined
  if (!recordingId) return { kind: 'clarify', question: '请打开要整理的录制。', missingFields: ['recordingId'] }
  const intent = /成功条件|断言|验收/.test(ctx.body.question) ? 'outcome' : /定位器|定位方式|选择器/.test(ctx.body.question) ? 'locator' : 'cleanup'
  await ctx.onProgress?.('loading_facts', '正在核对录制、排除项和可导入步骤…')
  const facts = await getAssistantRecordingProposalFacts(ctx.db, recordingId, ctx.actor.id)
  const proposalId = newId()
  const kept = facts.decisions.filter((d) => d.action === 'keep')
  if (intent === 'locator' && !facts.locatorDecisions.length) return { kind: 'clarify', question: '当前录制没有可据实替换的定位候选：可能只有结构定位或自然语言描述，也可能已经使用语义定位。请先补录目标元素的定位观察，再生成改进提案；不能凭空猜测选择器。', missingFields: ['recordedLocatorCandidate'] }
  const decisions = [...facts.decisions, ...(intent === 'locator' ? facts.locatorDecisions.slice(0, 4) : [])]
  const sources = [{ kind: 'recording', id: recordingId, targetId: facts.targetId, revision: facts.revision, digest: facts.recordingDigest, requiredPermissions: ['workflow:write', 'target:read'] }]
  const asOf = new Date().toISOString()
  const result: AssistantRecordingProposalResult = {
    kind: 'recording_proposal', proposalId, proposalFamilyId: proposalId,
    protocolVersion: facts.protocolVersion === 'demonstration@1' ? 'demonstration@1' : 'script@1',
    recordingId, targetId: facts.targetId, recordingRevision: facts.revision, recordingDigest: facts.recordingDigest,
    adapterVersion: 'assistant-import:3', intent,
    proposalSummary: intent === 'outcome' ? `请先确认「${facts.name}」在哪个动作后、应看到什么结果，再生成成功条件提案。`
      : intent === 'locator' ? `「${facts.name}」有 ${Math.min(4, facts.locatorDecisions.length)} 项定位改进建议。下方列出修改前后；采纳时会连同所选录制动作导入草稿。`
      : `「${facts.name}」可导入 ${kept.length} 项，另有 ${facts.decisions.length - kept.length} 项已排除或需要确认。请选择内容并预览场景草稿。`,
    sourceManifest: { version: '1.0', asOf, scope: { recordingId }, sources, digest: syncSha256(canonicalJson(sources)) },
    decisions, excludedItemIds: facts.decisions.filter((d) => d.action === 'exclude').map((d) => d.itemId),
    diagnostics: [], missingConfirmations: intent === 'outcome' ? ['尚未确认业务预期，不能预览或采纳成功条件。'] : [
      ...(facts.decisions.some((d) => d.reason.includes('成功条件')) ? ['录制中的成功条件尚未确认，本次不会导入。'] : []),
      ...(intent === 'locator' && facts.locatorDecisions.length > 4 ? [`本轮仅提出前 4 项定位修改，另有 ${facts.locatorDecisions.length - 4} 项未覆盖。`] : []),
    ],
    ...(intent === 'outcome' ? { outcomeOptions: facts.outcomeOptions, needsOutcomeConfirmation: true } : {}),
    applicable: kept.length > 0 && intent !== 'outcome', candidateDigest: syncSha256(canonicalJson({ recordingDigest: facts.recordingDigest, decisions, intent })),
  }
  return result
}
