import { dataBindingSchema, type AssistantSourceItem, type AssistantAnalysisFinding } from '@cairn/shared'
import { getBatch, getBatchAnalysisFacts, getDataset, getDatasetRows, listBatches, loadScenarioVersion, getScenario,
  assertTargetPermission, preflightDataset, getAccountSessionDetail } from '@cairn/db'
import type { AssistantCapabilityHandlerContext } from '../registry.js'
import { analysisResult, collectionFilters } from './analyzer-common.js'
type Ctx = AssistantCapabilityHandlerContext
const source = (id: string): AssistantSourceItem => ({ kind: 'batch', id, requiredPermissions: ['batch:read'] })

export async function analyzeBatchCollectionSummary(ctx: Ctx) {
  const filters = collectionFilters(ctx)
  const response = await listBatches(ctx.db, { ...filters, limit: 100 }, ctx.actor.id)
  const names: Record<string, string> = { QUEUED: '排队', RUNNING: '运行中', PAUSED: '已暂停', COMPLETED: '已完成', CANCELLED: '已取消', FAILED: '失败' }
  return analysisResult('batch.collection-summary', `当前筛选内读取 ${response.items.length} 个批量任务。`, response.items.map((b) => source(b.id)),
    response.items.map((b, i) => ({ id: `batch-${i}`, code: 'BATCH_PROGRESS', message: `「${b.name}」${names[b.status]}：共 ${b.totalItems} 项，成功 ${b.successItems}、失败 ${b.failedItems}、待核查 ${b.reviewItems}。`, citationRefs: [`batch:${b.id}`] })),
    { scope: filters, sampleSize: response.items.length, missing: response.nextCursor ? ['任务超过 100 条预算，未覆盖全部对象'] : [] })
}

export async function analyzeBatchInputMapping(ctx: Ctx, id: string) {
  const { batch, binding: rawBinding } = await getBatchAnalysisFacts(ctx.db, id, ctx.actor.id)
  const sources = [source(id)]
  const findings: AssistantAnalysisFinding[] = [], missing: string[] = []
  try {
    const dataset = await getDataset(ctx.db, batch.datasetId, ctx.actor.id)
    if (!dataset) throw new Error('数据集不可读')
    const { scenario, version } = await loadScenarioVersion(ctx.db, batch.scenarioId, batch.scenarioVersionId)
    await assertTargetPermission(ctx.db, ctx.actor.id, scenario.targetId, 'workflow:read')
    const binding = dataBindingSchema.parse(rawBinding)
    const inputs = version.authoringDocument?.inputs ?? version.definition.inputs
    sources.push({ kind: 'scenario', id: scenario.id, targetId: scenario.targetId, version: version.id, requiredPermissions: ['workflow:read'] },
      { kind: 'dataset', id: dataset.id, targetId: dataset.targetId, requiredPermissions: ['dataset:read'] })
    for (const [key, value] of Object.entries(binding)) {
      const decl = inputs.find((input) => input.key === key)
      const column = value.source === 'column' ? dataset.columns.find((col) => col.name === value.columnName || col.key === value.columnName) : undefined
      const issue = !decl ? '固定版本未声明该入参' : value.source === 'column' && !column ? '绑定的数据集列不存在' :
        column && decl.type && column.type !== decl.type ? `列类型 ${column.type} 与输入类型 ${decl.type} 不一致，需核对行转换` : undefined
      findings.push({ id: `binding-${findings.length}`, code: issue ? 'BATCH_BINDING_INVALID' : 'BATCH_BINDING',
        message: `参数「${key}」：${issue ?? (value.source === 'column' ? `绑定列「${value.columnName}」` : value.source === 'fixed' ? '固定值（不展示原值）' : '生成器')}。`,
        severity: issue ? 'warning' : 'info', citationRefs: [`batch:${id}`, `scenario:${scenario.id}`, `dataset:${dataset.id}`] })
    }
    const rows = await getDatasetRows(ctx.db, dataset.id, { limit: 200 }, ctx.actor.id)
    const checked = preflightDataset(rows.items, binding, inputs)
    for (const issue of checked.issues.slice(0, 40)) findings.push({ id: `row-${findings.length}`, code: 'BATCH_INPUT_INVALID',
      message: `第 ${issue.rowIndex + 1} 行参数「${issue.fieldKey}」未通过既有输入校验，请到数据集核对必填值和类型。`, severity: issue.severity, citationRefs: [`dataset:${dataset.id}`] })
    if (!rows.items.length) missing.push('数据集没有可用于输入校验的行')
    if (rows.nextCursor) missing.push('仅校验前 200 行，其他行尚未校验')
    if (checked.issues.length > 40) missing.push('仅展示前 40 个行校验问题')
  } catch { missing.push('数据集、固定场景版本或绑定配置无法完整读取／校验，不能宣称参数映射通过') }
  const invalid = findings.some((f) => f.code.endsWith('INVALID'))
  return analysisResult('batch.input-mapping', `「${batch.name}」固定版本参数映射：${missing.length ? '检查不完整' : invalid ? '发现需要修正的映射或行数据' : '已核对实际绑定与可读取数据行'}。`, sources, findings, { missing })
}

export async function analyzeBatchResourceLimits(ctx: Ctx, id: string) {
  const batch = await getBatch(ctx.db, id, ctx.actor.id)
  if (!batch) throw new Error('批量任务不存在')
  const scenario = await getScenario(ctx.db, batch.scenarioId)
  const sources = [source(id)]
  const missing = ['批量详情未持久化可回读的独立并发上限，不能从 pacing 推算该配置；实际派发上限需要运行配置来源']
  let summary = `「${batch.name}」节奏间隔 ${batch.pacingConfig.minDelayMs}–${batch.pacingConfig.maxDelayMs} 毫秒。`
  if (batch.targetAccountId) {
    await assertTargetPermission(ctx.db, ctx.actor.id, scenario.targetId, 'session:read')
    const detail = await getAccountSessionDetail(ctx.db, { targetId: scenario.targetId, targetAccountId: batch.targetAccountId })
    summary += `账号容量 ${detail.effectiveCap}，当前活会话 ${detail.liveCount}，占用 ${detail.instances.filter((s) => s.occupancy).length}。`
    sources.push({ kind: 'account', id: batch.targetAccountId, targetId: scenario.targetId, requiredPermissions: ['session:read'] })
  } else missing.push('账号未固定，无法确认当前账号容量')
  return analysisResult('batch.resource-limits', `${summary}目标限流政策未知，不提供速率安全保证。`, sources, [], { missing })
}
