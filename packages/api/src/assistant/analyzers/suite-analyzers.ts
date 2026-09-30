import { allSuiteMembers, effectiveSuiteStages, validateStageDependencies, STAGE_VARIABLE_REGEX, canonicalJson,
  type AssistantSourceItem, type AssistantAnalysisFinding } from '@cairn/shared'
import { getSuite, listSuites, listSuiteRuns, loadScenarioVersion, assertTargetPermission, getAccountSessionDetail } from '@cairn/db'
import type { AssistantCapabilityHandlerContext } from '../registry.js'
import { analysisResult, collectionFilters, median, nearestRankP90 } from './analyzer-common.js'

type Ctx = AssistantCapabilityHandlerContext
const finding = (code: string, message: string, refs: string[], severity: 'info' | 'warning' | 'error' = 'info'): AssistantAnalysisFinding =>
  ({ id: `${code}-${refs.length}`.slice(0, 64), code, message: message.slice(0, 1024), citationRefs: refs, severity })
async function suiteFacts(ctx: Ctx, id: string) {
  const suite = await getSuite(ctx.db, id, ctx.actor.id)
  const source: AssistantSourceItem = { kind: 'suite', id, targetId: suite.targetId, revision: suite.draft.revision,
    requiredPermissions: ['suite:read', 'workflow:read'] }
  return { suite, sources: [source] }
}

export async function analyzeSuiteCollectionSummary(ctx: Ctx) {
  const filters = collectionFilters(ctx)
  const response = await listSuites(ctx.db, { ...filters, limit: 100 }, ctx.actor.id)
  const sources: AssistantSourceItem[] = []
  const findings: AssistantAnalysisFinding[] = []
  for (const item of response.items) {
    const { suite, sources: refs } = await suiteFacts(ctx, item.id)
    sources.push(...refs)
    const doc = suite.draft.document
    findings.push(finding('SUITE_COLLECTION_ITEM', `「${suite.name}」：${allSuiteMembers(doc).length} 个成员，${effectiveSuiteStages(doc).length} 个阶段，${doc.executionMode === 'sequential' ? '顺序' : '并行'}执行，上限 ${doc.maxConcurrency}。`, [`suite:${suite.id}`]))
  }
  return analysisResult('suite.collection-summary', `当前筛选内读取 ${response.items.length} 个场景集。`, sources, findings,
    { scope: filters, sampleSize: response.items.length, missing: response.nextCursor ? ['达到 100 个场景集上限，尚有未读取对象'] : [] })
}

export async function analyzeSuiteDependencies(ctx: Ctx, id: string) {
  const { suite, sources } = await suiteFacts(ctx, id)
  const stages = effectiveSuiteStages(suite.draft.document)
  const versions = new Map<string, Awaited<ReturnType<typeof loadScenarioVersion>>['version']>()
  for (const member of allSuiteMembers(suite.draft.document)) {
    const loaded = await loadScenarioVersion(ctx.db, member.scenarioId, member.scenarioVersionId)
    await assertTargetPermission(ctx.db, ctx.actor.id, loaded.scenario.targetId, 'workflow:read')
    versions.set(member.memberId, loaded.version)
    sources.push({ kind: 'scenario', id: member.scenarioId, targetId: loaded.scenario.targetId, version: member.scenarioVersionId,
      requiredPermissions: ['workflow:read'] })
  }
  const findings = validateStageDependencies(stages).map((issue) => finding(issue.code, issue.message, [`suite:${id}`], issue.severity))
  let edges = 0
  for (const stage of stages) for (const member of stage.members) {
    const text = JSON.stringify({ ...suite.draft.document.sharedInput, ...member.input })
    for (const match of text.matchAll(new RegExp(STAGE_VARIABLE_REGEX.source, 'g'))) {
      edges++
      const producer = stages.find((s) => s.id === match[1])?.members.find((m) => m.memberId === match[2])
      const definition = producer && versions.get(producer.memberId)?.authoringDocument
      const [root, field] = match[3]!.split('.')
      const declared = definition?.outputs
      const metric = declared?.metrics.some((o) => o.key === (root === 'metrics' ? field : root))
      const data = declared?.dataRowFields.some((o) => o.columnKey === (root === 'dataRow' || root === 'customData' ? field : root))
      const output = root === 'summary' ? Boolean(declared?.summaryTemplate || declared?.summaryFromContextKey) : metric || data
      findings.push(finding(output ? 'SUITE_DEPENDENCY_EDGE' : 'SUITE_MISSING_OUTPUT',
        `${match[1]}/${match[2]} → ${stage.name}/${member.displayName ?? member.memberId}，引用输出 ${match[3]}${output ? '' : '：固定成员版本没有该输出声明'}。`,
        [`suite:${id}`, ...(producer ? [`scenario:${producer.scenarioId}`] : [])], output ? 'info' : 'error'))
    }
  }
  return analysisResult('suite.dependencies', `「${suite.name}」检查了 ${stages.length} 个阶段、${versions.size} 个固定成员版本，发现 ${edges} 条输出依赖引用。阶段顺序按已保存定义保留。`, sources, findings,
    { scope: { suiteId: id, revision: suite.draft.revision }, sampleSize: versions.size })
}

export async function analyzeSuiteResourceGroups(ctx: Ctx, id: string) {
  const { suite, sources } = await suiteFacts(ctx, id)
  const doc = suite.draft.document
  const findings: AssistantAnalysisFinding[] = []
  const missing: string[] = ['业务写锁与外部系统容量未包含在平台事实中，候选分组须业务核对']
  for (const stage of effectiveSuiteStages(doc)) {
    const groups = new Map<string, string[]>()
    for (const member of stage.members) {
      const accountId = member.targetAccountId ?? doc.defaultTargetAccountId
      if (!accountId) { missing.push(`阶段「${stage.name}」成员「${member.displayName ?? member.memberId}」的有效账号未固定`); continue }
      groups.set(accountId, [...(groups.get(accountId) ?? []), member.displayName ?? member.memberId])
    }
    for (const [accountId, names] of groups) {
      await assertTargetPermission(ctx.db, ctx.actor.id, suite.targetId, 'session:read')
      const detail = await getAccountSessionDetail(ctx.db, { targetId: suite.targetId, targetAccountId: accountId })
      sources.push({ kind: 'account', id: accountId, targetId: suite.targetId, requiredPermissions: ['session:read'] })
      const cap = stage.executionMode === 'sequential' ? 1 : Math.min(stage.maxConcurrency, detail.effectiveCap)
      findings.push(finding('SUITE_RESOURCE_GROUP', `阶段「${stage.name}」：${names.join('、')}共用账号，候选组每组至多 ${cap} 个成员；账号容量 ${detail.effectiveCap}，当前活会话 ${detail.liveCount}。不跨阶段重排。`, [`suite:${id}`, `account:${accountId}`]))
    }
  }
  return analysisResult('suite.resource-groups', `「${suite.name}」按阶段执行策略与账号容量检查候选分组。`, sources, findings, { missing })
}

export async function analyzeSuiteDuration(ctx: Ctx, id: string) {
  const { suite, sources } = await suiteFacts(ctx, id)
  const response = await listSuiteRuns(ctx.db, { suiteId: id, limit: 50 }, ctx.actor.id)
  const missing: string[] = []
  const cutoff = Date.now() - 30 * 86400_000
  const published = suite.published
  const sameDefinition = published && canonicalJson(published.document) === canonicalJson(suite.draft.document)
  const recent = response.items.filter((r) => Date.parse(r.createdAt) >= cutoff)
  const eligible = sameDefinition ? recent.filter((r) => r.suiteVersionId === published.id &&
    r.executionMode === published.document.executionMode && r.maxConcurrency === published.document.maxConcurrency &&
    r.failurePolicy === published.document.failurePolicy && r.status === 'COMPLETED' && r.startedAt && r.finishedAt) : []
  for (const run of recent) sources.push({ kind: 'suiteRun', id: run.id, targetId: run.targetId, requiredPermissions: ['suite:read', 'run:read'] })
  if (!sameDefinition) missing.push('当前草稿与已发布定义不同，没有可确认的同定义历史样本')
  if (response.nextCursor && (response.items.at(-1)?.createdAt ?? '') >= new Date(cutoff).toISOString()) missing.push('达到 50 条历史记录预算，时间范围尚未读完')
  const durations = eligible.map((r) => Math.max(0, Date.parse(r.finishedAt!) - Date.parse(r.startedAt!)))
  if (durations.length < 5) missing.push(`完整且同定义同策略的样本仅 ${durations.length} 条，不足 5 条，不计算参考区间`)
  const enough = durations.length >= 5 && !missing.length
  const summary = enough ? `「${suite.name}」近 30 天 ${durations.length} 个同定义同策略样本：中位数 ${median(durations) / 1000} 秒，P90 ${nearestRankP90(durations) / 1000} 秒。` : `「${suite.name}」历史耗时检查：当前可确认 ${durations.length} 个完整同定义同策略样本，暂不提供参考区间。`
  return analysisResult('suite.duration', summary, sources, recent.map((r) => finding('SUITE_DURATION_SAMPLE', `${r.createdAt}：${r.status}；${eligible.some((e) => e.id === r.id) ? '纳入统计' : '未纳入完整同定义样本'}。`, [`suiteRun:${r.id}`])),
    { missing, sampleSize: eligible.length, scope: { suiteId: id, from: new Date(cutoff).toISOString() } })
}
