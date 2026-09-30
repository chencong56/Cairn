import { type AssistantSourceItem } from '@cairn/shared'
import { getAssistantRecordingProposalFacts, listRecordingDrafts } from '@cairn/db'
import type { AssistantCapabilityHandlerContext } from '../registry.js'
import { analysisResult, collectionFilters } from './analyzer-common.js'

export async function analyzeRecordingCollectionSummary(ctx: AssistantCapabilityHandlerContext) {
  const filters = collectionFilters(ctx)
  const list = await listRecordingDrafts(ctx.db, ctx.actor.id, { ...filters, limit: 100 })
  const sources: AssistantSourceItem[] = list.items.map((r) => ({ kind: 'recording', id: r.id, targetId: r.targetId, revision: r.revision, requiredPermissions: ['workflow:write'] }))
  const pending = list.items.filter((r) => r.unresolvedCount > 0).length
  const imported = list.items.filter((r) => r.imported).length
  return analysisResult('recording.collection-summary', `当前筛选内读取本人录制 ${list.items.length} 条，含待处理动作的录制 ${pending} 条，已导入 ${imported} 条。`, sources,
    list.items.map((r) => ({ id: r.id, code: 'RECORDING_COLLECTION_ITEM', message: `「${r.name}」：${r.itemCount} 项，待处理 ${r.unresolvedCount} 项，${r.imported ? '已导入' : '未导入'}。`, citationRefs: [`recording:${r.id}`] })),
    { scope: filters, sampleSize: list.items.length, missing: list.nextCursor ? ['录制超过 100 条，尚有未读取对象'] : [] })
}
export async function analyzeRecordingQuality(ctx: AssistantCapabilityHandlerContext, recordingId: string) {
  const facts = await getAssistantRecordingProposalFacts(ctx.db, recordingId, ctx.actor.id)
  const sources: AssistantSourceItem[] = [{ kind: 'recording', id: recordingId, targetId: facts.targetId, revision: facts.revision, digest: facts.recordingDigest, requiredPermissions: ['workflow:write', 'target:read'] }]
  const kept = facts.decisions.filter((d) => d.action === 'keep').length
  return analysisResult('recording.quality', `「${facts.name}」规范化后 ${facts.decisions.length} 项，可导入 ${kept} 项，其余 ${facts.decisions.length - kept} 项需处理或已排除。`, sources,
    facts.decisions.map((d) => ({ id: d.itemId, code: d.action === 'keep' ? 'RECORDING_IMPORTABLE' : 'RECORDING_REVIEW_REQUIRED', message: `${d.label ?? '录制动作'}：${d.reason}`, severity: d.action === 'keep' ? 'info' : 'warning', citationRefs: [`recording:${recordingId}`] })),
    { scope: { recordingId }, sampleSize: facts.decisions.length, missing: ['定位仅核对录制来源，尚未在当前页面实测；业务成功条件需人工确认'] })
}
