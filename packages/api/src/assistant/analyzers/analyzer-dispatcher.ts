import {
  type AssistantBusinessIntentId,
  type AssistantKnowledgeAnswerResult,
  type AssistantPageContext,
  ASSISTANT_BUSINESS_INTENTS,
  normalizeAssistantPageContext,
} from '@cairn/shared'
import type { AssistantCapabilityHandlerContext } from '../registry.js'
import {
  buildPermissionDeniedResult,
  buildSourceManifest,
  checkIntentPermissions,
  analysisResult,
} from './analyzer-common.js'
import {
  analyzeSuiteCollectionSummary,
  analyzeSuiteDependencies,
  analyzeSuiteDuration,
  analyzeSuiteResourceGroups,
} from './suite-analyzers.js'
import {
  analyzeModuleInputContract,
  analyzeModuleReferences,
  analyzeModuleRepeatedFragments,
} from './module-analyzers.js'
import {
  analyzeRecordingCollectionSummary,
  analyzeRecordingQuality,
} from './recording-analyzers.js'
import {
  analyzeScheduleResourceContention,
  analyzeScheduleSkipSummary,
  analyzeScheduleWindowOverlap,
} from './schedule-analyzers.js'
import {
  analyzeBatchCollectionSummary,
  analyzeBatchInputMapping,
  analyzeBatchResourceLimits,
} from './batch-analyzers.js'

export function detectBusinessIntent(
  pageContext: AssistantPageContext | { pageKind?: string; primaryRef?: { kind?: string; id?: string } } | undefined,
  question: string,
  hint?: string,
  slots?: Record<string, unknown>,
): AssistantBusinessIntentId | null {
  // 1. Explicit intent id in slots or hint
  const candidateId = String(slots?.businessIntentId || hint || '').trim()
  const exactMatch = ASSISTANT_BUSINESS_INTENTS.find((i) => i.id === candidateId)
  if (exactMatch) return exactMatch.id

  const normalized = normalizeAssistantPageContext(pageContext as AssistantPageContext)
  const pageKind = normalized?.pageKind ?? (pageContext && 'pageKind' in pageContext ? (pageContext as any).pageKind : undefined)
  const q = question.trim()

  // 2. Page-context-aware pattern recognition
  if (pageKind === 'suite') {
    if (/资源|并发|分组|独占|互斥/.test(q)) return 'suite.resource-groups'
    if (/依赖|顺序|输入输出|边/.test(q)) return 'suite.dependencies'
    if (/耗时|时间|历史|p90|中位数|慢/.test(q)) return 'suite.duration'
    if (/概览|汇总|场景集|列表/.test(q)) return 'suite.collection-summary'
  }

  if (pageKind === 'action-module') {
    if (/重复|片段|候选|复用/.test(q)) return 'module.repeated-fragments'
    if (/入参|参数|契约|默认值|必填/.test(q)) return 'module.input-contract'
    if (/引用|升级|版本|场景调用/.test(q)) return 'module.references'
  }

  if (pageKind === 'recording') {
    if (/汇总|待处理|列表|录制总数/.test(q)) return 'recording.collection-summary'
    if (/质量|定位|断言|缺口|诊断|观测/.test(q)) return 'recording.quality'
  }

  if (pageKind === 'schedule') {
    if (/重叠|窗口|集中|交集|未来/.test(q)) return 'schedule.window-overlap'
    if (/跳过|skip|原因|近期跳过|历史触发/.test(q)) return 'schedule.skip-summary'
    if (/竞争|冲突|账号|租约|容量|排队/.test(q)) return 'schedule.resource-contention'
  }

  if (pageKind === 'batch') {
    if (/映射|绑定|binding|列|参数映射/.test(q)) return 'batch.input-mapping'
    if (/并发|限额|节奏|pacing|资源/.test(q)) return 'batch.resource-limits'
    if (/进度|汇总|任务|列表|总览/.test(q)) return 'batch.collection-summary'
  }

  return null
}

async function dispatchBusinessAnalyzerInternal(
  ctx: AssistantCapabilityHandlerContext,
  intentId: AssistantBusinessIntentId,
): Promise<AssistantKnowledgeAnswerResult> {
  const { actor, slots, body } = ctx
  const pageContext = normalizeAssistantPageContext(body.pageContext)

  // Check required permissions
  const permCheck = checkIntentPermissions(intentId, actor.permissions)
  if (!permCheck.ok) {
    return buildPermissionDeniedResult(intentId, permCheck.missingPerms)
  }

  const suiteId =
    (typeof slots.suiteId === 'string' && slots.suiteId) ||
    (pageContext?.primaryRef?.kind === 'suite' ? pageContext.primaryRef.id : undefined)

  const moduleId =
    (typeof slots.actionModuleId === 'string' && slots.actionModuleId) ||
    (typeof slots.moduleId === 'string' && slots.moduleId) ||
    (pageContext?.primaryRef?.kind === 'actionModule' ? pageContext.primaryRef.id : undefined)

  const recordingId =
    (typeof slots.recordingId === 'string' && slots.recordingId) ||
    (pageContext?.primaryRef?.kind === 'recording' ? pageContext.primaryRef.id : undefined)

  const scheduleId =
    (typeof slots.scheduleId === 'string' && slots.scheduleId) ||
    (pageContext?.primaryRef?.kind === 'schedule' ? pageContext.primaryRef.id : undefined)

  const batchId =
    (typeof slots.batchId === 'string' && slots.batchId) ||
    (pageContext?.primaryRef?.kind === 'batch' ? pageContext.primaryRef.id : undefined)

  const requiredObject = intentId.startsWith('suite.') && intentId !== 'suite.collection-summary' ? [suiteId, '场景集'] :
    ['module.input-contract', 'module.references'].includes(intentId) ? [moduleId, '动作模块'] :
    intentId === 'recording.quality' ? [recordingId, '录制草稿'] :
    intentId === 'schedule.resource-contention' ? [scheduleId, '调度'] :
    ['batch.input-mapping', 'batch.resource-limits'].includes(intentId) ? [batchId, '批量任务'] : undefined
  if (requiredObject && !requiredObject[0]) return analysisResult(intentId,
    `请先打开要检查的${requiredObject[1]}详情，再发起这项检查。列表为空时需要先创建相应对象。`, [], [],
    { missing: [`尚未选择${requiredObject[1]}`] })

  switch (intentId) {
    case 'suite.collection-summary':
      return analyzeSuiteCollectionSummary(ctx)
    case 'suite.dependencies':
      if (!suiteId) throw new Error('缺少必需的主对象 suiteId')
      return analyzeSuiteDependencies(ctx, suiteId)
    case 'suite.resource-groups':
      if (!suiteId) throw new Error('缺少必需的主对象 suiteId')
      return analyzeSuiteResourceGroups(ctx, suiteId)
    case 'suite.duration':
      if (!suiteId) throw new Error('缺少必需的主对象 suiteId')
      return analyzeSuiteDuration(ctx, suiteId)

    case 'module.repeated-fragments':
      return analyzeModuleRepeatedFragments(ctx)
    case 'module.input-contract':
      if (!moduleId) throw new Error('缺少必需的主对象 actionModuleId')
      return analyzeModuleInputContract(ctx, moduleId)
    case 'module.references':
      if (!moduleId) throw new Error('缺少必需的主对象 actionModuleId')
      return analyzeModuleReferences(ctx, moduleId)

    case 'recording.collection-summary':
      return analyzeRecordingCollectionSummary(ctx)
    case 'recording.quality':
      if (!recordingId) throw new Error('缺少必需的主对象 recordingId')
      return analyzeRecordingQuality(ctx, recordingId)

    case 'schedule.window-overlap':
      return analyzeScheduleWindowOverlap(ctx)
    case 'schedule.skip-summary':
      return analyzeScheduleSkipSummary(ctx, scheduleId)
    case 'schedule.resource-contention':
      if (!scheduleId) throw new Error('缺少必需的主对象 scheduleId')
      return analyzeScheduleResourceContention(ctx, scheduleId)

    case 'batch.collection-summary':
      return analyzeBatchCollectionSummary(ctx)
    case 'batch.input-mapping':
      if (!batchId) throw new Error('缺少必需的主对象 batchId')
      return analyzeBatchInputMapping(ctx, batchId)
    case 'batch.resource-limits':
      if (!batchId) throw new Error('缺少必需的主对象 batchId')
      return analyzeBatchResourceLimits(ctx, batchId)
  }
}

export async function dispatchBusinessAnalyzer(ctx: AssistantCapabilityHandlerContext, intentId: AssistantBusinessIntentId): Promise<AssistantKnowledgeAnswerResult> {
  const result = await dispatchBusinessAnalyzerInternal(ctx, intentId)
  if (result.sourceManifest) result.sourceManifest = buildSourceManifest({ asOf: result.sourceManifest.asOf, sources: result.sourceManifest.sources, scope: { ...result.sourceManifest.scope, ownerAccountId: ctx.actor.id }, ruleVersion: result.analysis?.ruleVersion })
  return result
}
