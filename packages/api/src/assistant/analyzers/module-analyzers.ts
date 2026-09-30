import { normalizeAuthoringDocument, canonicalJson, moduleContractSchema, walkAuthoringNodes,
  type AuthoringNode, type AssistantSourceItem, type AssistantAnalysisFinding } from '@cairn/shared'
import { proposeModuleFromSteps } from '@cairn/authoring'
import { getActionModule, getActionModuleVersion, listModuleReferences, listScenarios, getScenario, assertTargetPermission } from '@cairn/db'
import type { AssistantCapabilityHandlerContext } from '../registry.js'
import { analysisResult, collectionFilters } from './analyzer-common.js'
type Ctx = AssistantCapabilityHandlerContext

export async function analyzeModuleRepeatedFragments(ctx: Ctx) {
  const filters = collectionFilters(ctx)
  const response = await listScenarios(ctx.db, { ...(typeof filters.targetId === 'string' ? { targetId: filters.targetId } : {}), limit: 100 }, ctx.actor.id)
  const sources: AssistantSourceItem[] = [], missing: string[] = response.nextCursor ? ['场景数量超过 100 条预算'] : []
  if (Object.keys(filters).some((key) => key !== 'targetId')) missing.push('动作库属性筛选不等同于场景筛选，本次仅按目标范围扫描场景')
  const fragments = new Map<string, { names: Map<string, string>; label: string }>()
  let totalSteps = 0
  for (const summary of response.items) {
    const scenario = await getScenario(ctx.db, summary.id)
    await assertTargetPermission(ctx.db, ctx.actor.id, scenario.targetId, 'workflow:read')
    if (!scenario.draft) { missing.push(`「${scenario.name}」没有可读取的已保存草稿`); continue }
    const doc = normalizeAuthoringDocument(scenario.draft.document)
    const stepCount = walkAuthoringNodes(doc).filter((entry) => entry.node.kind === 'step').length
    if (totalSteps + stepCount > 5000) { missing.push('达到 5000 个步骤预算'); break }
    totalSteps += stepCount
    sources.push({ kind: 'scenario', id: scenario.id, targetId: scenario.targetId, revision: scenario.draft.revision, requiredPermissions: ['workflow:read'] })
    function scan(nodes: AuthoringNode[]) {
      // Every block/module is a boundary. Scan each branch separately.
      let sequence: Extract<AuthoringNode, { kind: 'step' }>[] = []
      function flush() {
        for (let length = 2; length <= 8; length++) for (let at = 0; at + length <= sequence.length; at++) {
          const slice = sequence.slice(at, at + length)
          const preflight = proposeModuleFromSteps(doc, slice.map((node) => node.step.id))
          if (!preflight.ok) continue
          const key = canonicalJson({ targetId: scenario.targetId, steps: slice.map(({ step, outcomes }) => {
            const { id: _id, name: _name, ...semantic } = step
            return { ...semantic, outcomes }
          }) })
          const item = fragments.get(key) ?? { names: new Map<string, string>(), label: slice.map((n) => n.step.name).join(' → ') }
          item.names.set(scenario.id, scenario.name)
          fragments.set(key, item)
        }
        sequence = []
      }
      for (const node of nodes) {
        if (node.kind === 'step' && !node.step.disabled) sequence.push(node)
        else {
          flush()
          if (node.kind === 'block' && !node.disabled) {
            if ('then' in node) { scan(node.then); if (node.else) scan(node.else) }
            else scan(node.body)
          }
        }
      }
      flush()
    }
    scan(doc.nodes)
  }
  const repeated = [...fragments.values()].filter((f) => f.names.size >= 2)
  const findings: AssistantAnalysisFinding[] = repeated.slice(0, 20).map((item, i) => ({ id: `fragment-${i}`, code: 'MODULE_REPEATED_CANDIDATE',
    message: `候选「${item.label}」在 ${item.names.size} 个不同场景中具有相同动作、输入、输出和风险配置。出处：${[...item.names.values()].slice(0, 4).map((name) => `「${name}」`).join('、')}${item.names.size > 4 ? '等' : ''}；已通过模块提炼预检，业务意图与参数化范围仍需核对。`.slice(0, 1024),
    citationRefs: [...item.names.keys()].map((id) => `scenario:${id}`), severity: 'info' }))
  if (repeated.length > 20) missing.push('仅展示前 20 个重复候选，请缩小范围')
  return analysisResult('module.repeated-fragments', `读取 ${sources.length} 个场景、${totalSteps} 个独立步骤，发现 ${repeated.length} 个跨场景重复候选。`, sources, findings,
    { missing, scope: { ...(typeof filters.targetId === 'string' ? { targetId: filters.targetId } : {}), scannedScenarios: sources.length, totalSteps }, sampleSize: totalSteps })
}

export async function analyzeModuleInputContract(ctx: Ctx, id: string) {
  const mod = await getActionModule(ctx.db, id, ctx.actor.id)
  const versionId = typeof ctx.slots.versionId === 'string' ? ctx.slots.versionId : undefined
  const content = versionId ? (await getActionModuleVersion(ctx.db, id, versionId)).content : mod.draftContent
  const sources: AssistantSourceItem[] = [{ kind: 'actionModule', id, targetId: mod.targetId, version: versionId, revision: mod.draftRevision ?? undefined, requiredPermissions: ['module:read'] }]
  const parsed = moduleContractSchema.safeParse(content?.contract)
  const findings: AssistantAnalysisFinding[] = parsed.success ? parsed.data.inputs.map((input, i) => ({ id: `input-${i}`, code: 'MODULE_INPUT',
    message: `「${input.label}」：${input.valueType}，${input.required ? '必填' : '选填'}。`, citationRefs: [`actionModule:${id}`] })) : []
  return analysisResult('module.input-contract', parsed.success ? `「${mod.name}」${versionId ? '指定发布版本' : `草稿修订 ${mod.draftRevision}`}声明 ${parsed.data.inputs.length} 个入参；已按平台契约校验。` : `「${mod.name}」没有可通过校验的入参契约。`, sources, findings,
    { missing: parsed.success ? [] : parsed.error.issues.map((issue) => issue.message) })
}

export async function analyzeModuleReferences(ctx: Ctx, id: string) {
  const mod = await getActionModule(ctx.db, id, ctx.actor.id)
  const refs = await listModuleReferences(ctx.db, id, { page: 1, pageSize: 100 }, { id: ctx.actor.id })
  const sources: AssistantSourceItem[] = [{ kind: 'actionModule', id, targetId: mod.targetId, revision: mod.draftRevision ?? undefined, requiredPermissions: ['module:read'] },
    ...refs.items.map((ref) => ({ kind: 'scenario', id: ref.scenarioId, targetId: mod.targetId, requiredPermissions: ['workflow:read'] }))]
  return analysisResult('module.references', `「${mod.name}」读取 ${refs.items.length} 个引用场景。修改草稿不改变已发布调用或历史运行的冻结版本。`, sources,
    refs.items.map((ref, i) => ({ id: `reference-${i}`, code: 'MODULE_REFERENCE', message: `「${ref.name}」：草稿 ${ref.draftUses.length} 处，已发布版本 ${ref.publishedUses.length} 处；${ref.upgradeAvailable ? '存在可升级引用' : '未发现可升级引用'}。`, citationRefs: [`scenario:${ref.scenarioId}`] })),
    { missing: refs.total > refs.items.length ? ['引用场景超过 100 条预算'] : [], sampleSize: refs.items.length })
}
