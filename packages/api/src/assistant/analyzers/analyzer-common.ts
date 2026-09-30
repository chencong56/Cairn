import {
  type AssistantAnalysisFinding,
  type AssistantAnalysisResult,
  type AssistantBusinessIntentId,
  type AssistantKnowledgeAnswerClaim,
  type AssistantKnowledgeAnswerMissing,
  type AssistantKnowledgeAnswerResult,
  type AssistantSourceItem,
  type AssistantSourceManifest,
  ASSISTANT_BUSINESS_INTENTS,
  canonicalJson,
  syncSha256,
  hasPermission,
  normalizeAssistantPageContext,
} from '@cairn/shared'
import type { AssistantCapabilityHandlerContext } from '../registry.js'

export const MAX_FACT_CHARS = 12_000
export const MAX_SOURCE_ITEMS = 2_000

export function nearestRankP90(numbers: number[]): number {
  if (numbers.length === 0) return 0
  const sorted = [...numbers].sort((a, b) => a - b)
  const index = Math.ceil(0.9 * sorted.length) - 1
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))]!
}

export function median(numbers: number[]): number {
  if (numbers.length === 0) return 0
  const sorted = [...numbers].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 !== 0 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

export function buildSourceManifest(params: {
  asOf: string
  scope: Record<string, unknown>
  sources: AssistantSourceItem[]
  ruleVersion?: string | number
}): AssistantSourceManifest {
  const sources = [...new Map(params.sources.map((source) => [`${source.kind}:${source.id}:${source.version ?? ''}`, source])).values()]
  if (sources.length > MAX_SOURCE_ITEMS || JSON.stringify(sources).length > 256 * 1024) {
    throw new Error('分析来源超过预算，请缩小筛选范围后重试')
  }
  const digest = syncSha256(
    canonicalJson({
      scope: params.scope,
      sources: sources.map((s) => ({ kind: s.kind, id: s.id, revision: s.revision, version: s.version })),
    }),
  )
  return {
    version: '1.0',
    asOf: params.asOf,
    scope: params.scope,
    sources,
    analysisRules: [
      {
        id: 'cairn.deterministic-analyzer',
        version: params.ruleVersion ?? '1.0.0',
      },
    ],
    digest,
  }
}

export function buildPermissionDeniedResult(
  intentId: AssistantBusinessIntentId,
  missingPerms: string[],
): AssistantKnowledgeAnswerResult {
  const asOf = new Date().toISOString()
  return {
    kind: 'knowledge_answer',
    summary: `缺少执行「${intentId}」分析所需的必需权限：${missingPerms.join('、')}。服务端已终止分析，未读取底层事实。`,
    claims: [
      {
        factKind: 'human_confirmed',
        text: `业务分析「${intentId}」需要 ${missingPerms.join(', ')} 权限。`,
        citations: [],
      },
    ],
    missing: [
      {
        key: 'permission',
        reason: 'permission_denied',
        description: `缺少权限: ${missingPerms.join(', ')}`,
      },
    ],
    asOf,
  }
}

export function checkIntentPermissions(
  intentId: AssistantBusinessIntentId,
  userPermissions: readonly string[],
): { ok: true } | { ok: false; missingPerms: string[] } {
  const def = ASSISTANT_BUSINESS_INTENTS.find((i) => i.id === intentId)
  if (!def) return { ok: true }
  const missing = def.requiredPermissions.filter((p) => !hasPermission(userPermissions, p))
  if (missing.length > 0) {
    return { ok: false, missingPerms: missing }
  }
  return { ok: true }
}

export function collectionFilters(ctx: AssistantCapabilityHandlerContext) {
  const filters = normalizeAssistantPageContext(ctx.body.pageContext)?.view?.filters ?? {}
  return Object.fromEntries(Object.entries(filters).filter(([key]) => !['cursor', 'page', 'pageSize', 'limit'].includes(key)))
}

export function analysisResult(
  intentId: AssistantBusinessIntentId, summary: string, sources: AssistantSourceItem[],
  findings: AssistantAnalysisFinding[], options: { missing?: string[]; scope?: Record<string, unknown>; sampleSize?: number } = {},
): AssistantKnowledgeAnswerResult {
  const asOf = new Date().toISOString()
  const missing = [...(options.missing ?? [])]
  let used = 0
  const bounded = findings.filter((finding) => { used += finding.message.length; return used <= MAX_FACT_CHARS - 2048 })
  if (bounded.length < findings.length) missing.push('结论超过展示预算，请缩小范围查看全部结果')
  const scope = options.scope ?? {}
  return {
    kind: 'knowledge_answer', summary: summary.slice(0, 2048), claims: [],
    sourceAsOf: asOf, asOf,
    missing: missing.map((description, index) => ({ key: `analysis-${index}`, reason: 'incomplete', description })),
    analysis: { version: '1.0', intentId, ruleVersion: '1.1.0', asOf, scope, findings: bounded,
      coverage: missing.length ? 'partial' : 'complete', missing, sampleSize: options.sampleSize },
    sourceManifest: buildSourceManifest({ asOf, scope, sources, ruleVersion: '1.1.0' }),
  }
}
