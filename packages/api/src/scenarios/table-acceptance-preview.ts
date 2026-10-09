import {
  AUTHORING_OPERATION_LIMITS,
  authoringDocumentDigest,
  authoringSteps,
  canonicalJson,
  evaluateTableExpectation,
  isTablePreviewOnly,
  syncSha256,
  toAuthoringDocumentV2,
  validateTableExpectRuleAgainstPlan,
  tableExpectRuleSchema,
  type AcceptanceCardTestResult,
  type ScenarioDetailDto,
  type AcceptanceIntentRequest,
  type AcceptancePreviewRequestBody,
  type AcceptancePreviewResponse,
  type AcceptanceProposalCard,
  type AssistantAuthoringProposal,
  type AuthoringOperation,
  type Step,
  type TableExpectRule,
  type TableReadPlan,
  type TableSample,
} from '@cairn/shared'
import { applyAuthoringOperations } from '@cairn/authoring'
import { buildAcceptanceCard, type BuiltCard, type IntentTarget } from '../assistant/handlers/propose-acceptance.handler.js'
import {
  conflict,
  getRun,
  getScenario,
  loadEvidenceById,
  newId,
  notFound,
  type DbHandle,
} from '@cairn/db'

const TABLE_INTENT_LIMIT = 1

/**
 * 人工验收预览：不依赖 Assistant 轮次与模型。
 * 表格意图走「服务端证据 → 规则试算」两步流；其余意图直接用与 AI 提案相同的
 * 共用生成器（buildAcceptanceCard）做确定性构造，两条路径共用 Schema、编译器与诊断。
 */
export async function compileAcceptancePreview(
  db: DbHandle,
  scenarioId: string,
  body: AcceptancePreviewRequestBody,
  actorId: string,
): Promise<AcceptancePreviewResponse> {
  // 1. 验证场景与草稿
  const scenario = await getScenario(db, scenarioId)
  if (!scenario) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')

  if (!scenario.draft) {
    throw conflict('NO_DRAFT', '场景无活动草稿')
  }

  if (scenario.draft.revision !== body.revision) {
    throw conflict('REVISION_MISMATCH', '草稿版本不匹配，请先刷新草稿')
  }

  const document = toAuthoringDocumentV2(scenario.draft.document)
  const currentDigest = await authoringDocumentDigest(document)
  if (body.documentDigest && body.documentDigest !== currentDigest) {
    throw conflict('DOCUMENT_DIGEST_MISMATCH', '场景文档指纹不匹配')
  }

  const steps = authoringSteps(document)

  const tableIntents = body.intents.filter(
    (intent): intent is Extract<AcceptanceIntentRequest, { kind: 'table_acceptance' }> => intent.kind === 'table_acceptance',
  )
  if (tableIntents.length > TABLE_INTENT_LIMIT) {
    throw conflict('TABLE_INTENT_LIMIT', '单次预览至多包含一个表格验收意图，请逐个预览')
  }

  const builtCards: BuiltCard[] = []
  const diagnostics: string[] = []
  let evidenceUsed:
    | { evidenceId: string; planDigest: string; sampleDigest: string; sampledAt: string; stale: boolean }
    | undefined

  // 2. 表格意图：服务端证据核验 + 规则试算
  if (tableIntents.length === 1) {
    const tableIntent = tableIntents[0]!
    evidenceUsed = await compileTableIntent(db, scenario, body, actorId, tableIntent, steps, builtCards, diagnostics)
  }

  // 3. 非表格意图：共用生成器确定性构造
  for (const intent of body.intents) {
    if (intent.kind === 'table_acceptance') continue
    builtCards.push(buildManualIntentCard(intent, steps))
  }

  // 4. 合并操作并验证可应用性
  const operations: AuthoringOperation[] = builtCards.flatMap((built) => built.ops)
  const applied = applyAuthoringOperations(document, operations, AUTHORING_OPERATION_LIMITS.acceptance)
  if (!applied.ok) {
    throw conflict(applied.error.code, applied.error.message)
  }

  // 5. 汇总试算结论
  const testResult = aggregateTestResult(builtCards.map((built) => built.card))
  const acceptable = evidenceUsed ? !evidenceUsed.stale : true
  if (evidenceUsed?.stale) {
    diagnostics.unshift('OBSERVATION_STALE：采样已超过 60 秒，以下为历史样本结论；重新采样后才能标记为可采纳')
  }

  const candidateDigest = await authoringDocumentDigest(applied.document)
  const proposal: AssistantAuthoringProposal = {
    kind: 'authoring_proposal',
    proposalId: newId(),
    scenarioId: scenario.id,
    base: {
      draftRevision: scenario.draft.revision,
      documentDigest: currentDigest,
      dependencyFingerprint: `${scenario.targetId}:${scenario.draft.revision}`,
    },
    operations,
    candidateDigest,
    intentCoverage: builtCards.map((built) => ({ intentId: built.card.id, operationIds: built.card.operationIds })),
    diffs: applied.diffs,
    diagnostics: [],
    executable: true,
    validation: { schema: 'passed', expansion: 'passed', compiler: 'passed' },
    source: 'acceptance',
    cards: builtCards.map((built) => built.card),
  }

  return {
    proposal,
    operations,
    testResult,
    diagnostics,
    acceptable,
    ...(evidenceUsed
      ? {
          evidenceId: evidenceUsed.evidenceId,
          planDigest: evidenceUsed.planDigest,
          sampleDigest: evidenceUsed.sampleDigest,
          sampledAt: evidenceUsed.sampledAt,
        }
      : {}),
    draftRevision: scenario.draft.revision,
  }
}

/** 表格意图的证据核验、规则交叉校验与现场试算；结果以 BuiltCard 形式并入。 */
async function compileTableIntent(
  db: DbHandle,
  scenario: ScenarioDetailDto,
  body: AcceptancePreviewRequestBody,
  actorId: string,
  intent: Extract<AcceptanceIntentRequest, { kind: 'table_acceptance' }>,
  steps: Step[],
  builtCards: BuiltCard[],
  diagnostics: string[],
): Promise<{ evidenceId: string; planDigest: string; sampleDigest: string; sampledAt: string; stale: boolean }> {
  if (!body.evidenceId) {
    throw conflict('EVIDENCE_REQUIRED', '表格验收预览必须携带现场采样证据（先在挂起页面执行采样）')
  }
  const evidence = await loadEvidenceById(db, body.evidenceId)
  if (!evidence) {
    throw conflict('EVIDENCE_NOT_FOUND', '采样证据不存在或已被清理')
  }

  // 证据时效性（<= 60 秒）：过期只显示历史样本结论，标记需重采样后才能采纳
  const ageMs = Date.now() - new Date(evidence.createdAt).getTime()
  const stale = ageMs > 60_000

  const payload = evidence.payload as {
    role?: string
    sample?: TableSample
    holdId?: string
    sessionGeneration?: number
  } | null
  if (!payload || payload.role !== 'table_sample' || !payload.sample) {
    throw conflict('EVIDENCE_INVALID_ROLE', '证据类型不是有效的表格采样')
  }
  const sample = payload.sample

  // 校验证据归属 Run 与场景、目标匹配；引用的基线 Run 不一致时拒绝
  const run = await getRun(db, evidence.runId, actorId)
  if (!run || run.scenarioId !== scenario.id) {
    throw conflict('EVIDENCE_SCENARIO_MISMATCH', '采样证据不属于当前场景')
  }
  if (run.targetId !== scenario.targetId) {
    throw conflict('EVIDENCE_TARGET_MISMATCH', '采样证据所属运行与当前场景的目标不一致，不能跨目标混用')
  }
  if (body.baselineRunId && body.baselineRunId !== evidence.runId) {
    throw conflict('EVIDENCE_BINDING_MISMATCH', '采样证据不是当前基线运行产生的，请重新在挂起页面上采样')
  }
  // 采样时点必须仍是当前挂起检查点：继续/重挂起会换 holdId，旧证据不能冒充当前页
  if (run.status !== 'HOLDING') {
    throw conflict('EVIDENCE_BINDING_MISMATCH', '基线运行已不在挂起状态，页面可能已被继续或已结束，请重新建立基线并采样')
  }
  if (run.checkpoint?.holdId && payload.holdId && run.checkpoint.holdId !== payload.holdId) {
    throw conflict('EVIDENCE_BINDING_MISMATCH', '采样时的挂起检查点已被替换（页面可能已继续或重新挂起），请重新采样')
  }

  // 计划一致性校验（服务端规范化计算 digest，客户端值只作期望）
  const intentPlan = intent.tablePlan
  const plan: TableReadPlan | undefined = body.plan ?? intentPlan
  if (!plan) {
    throw conflict('TABLE_PLAN_MISSING', '缺少表格执行计划')
  }
  const planDigest = syncSha256(canonicalJson(plan))
  if (planDigest !== sample.source.planDigest) {
    throw conflict('TABLE_PLAN_MISMATCH', '请求读取计划与证据中的执行计划不一致，修改定位/列/范围/就绪后必须重新采样')
  }

  // 定位挂靠步骤
  const step = steps.find((s) => s.id === intent.stepId) ?? steps[steps.length - 1]
  if (!step) {
    throw conflict('STEP_NOT_FOUND', '未找到挂靠步骤')
  }

  // 规则解析 + 列类型交叉校验 + 服务端试算
  const rules: TableExpectRule[] = []
  if (intent.rules && intent.rules.length > 0) {
    for (const raw of intent.rules) {
      const parsed = tableExpectRuleSchema.safeParse(raw)
      if (!parsed.success) {
        throw conflict('TABLE_RULE_INVALID', `表格验收规则未通过契约校验：${parsed.error.issues[0]?.message ?? '结构非法'}`)
      }
      rules.push(parsed.data)
    }
  }
  if (rules.length === 0) {
    rules.push(tableExpectRuleSchema.parse({ rule: 'row_count', op: 'gt', value: 0 }))
  }
  for (const rule of rules) {
    const crossCheck = validateTableExpectRuleAgainstPlan(rule, plan.columns)
    if (!crossCheck.valid) {
      throw conflict(crossCheck.code, crossCheck.message)
    }
  }

  let hasFail = false
  let hasUnknown = false
  if (isTablePreviewOnly(sample)) {
    diagnostics.push(`只按预览的 ${sample.rows.length} 行试算；正式运行时按全量 ${sample.storage?.rowCount ?? sample.rowCount} 行检查`)
  }
  for (const rule of rules) {
    // 编写期预览：外置记录集只有预览行，这里允许按预览算，结果由界面标注“保存后按全量计算”
    const outcome = evaluateTableExpectation(sample, rule, { allowPreview: true })
    if (outcome.factsUnavailable) {
      hasUnknown = true
      diagnostics.push(outcome.reasonMessage ?? '数据事实不完整')
    } else if (outcome.passed) {
      diagnostics.push('验证通过')
    } else {
      hasFail = true
      diagnostics.push(outcome.reasonMessage ?? '规则不满足')
    }
  }
  const testResult: AcceptanceCardTestResult = hasFail ? 'VIOLATED' : hasUnknown ? 'FACTS_UNAVAILABLE' : 'PASSED'

  const tableOutputKey = `acc_tbl_${newId().replace(/-/g, '').slice(-8).toLowerCase()}`
  const label = intent.metricName ?? plan.target.semantic ?? '表格'

  const extractStep: Step = {
    id: newId(),
    type: 'extract',
    name: `提取「${label}」数据`,
    effectType: 'READ_ONLY',
    input: { as: 'table', target: plan.target, table: plan },
    outputKey: tableOutputKey,
  }
  const ops: AuthoringOperation[] = [{ kind: 'insert_step', id: newId(), step: extractStep, anchorStepId: step.id }]
  let lastStepId = extractStep.id
  rules.forEach((rule, rIdx) => {
    const checkStep: Step = {
      id: newId(),
      type: 'check_context',
      name: `验证「${label}」规则 ${rIdx + 1}`,
      effectType: 'READ_ONLY',
      input: { key: tableOutputKey, expect: { kind: 'table', rule } },
    }
    ops.push({ kind: 'insert_step', id: newId(), step: checkStep, anchorStepId: lastStepId })
    lastStepId = checkStep.id
    ops.push({
      kind: 'add_outcome',
      id: newId(),
      stepId: checkStep.id,
      meaning: `「${label}」规则 ${rIdx + 1} 满足预期`,
      rule: { kind: 'context', key: tableOutputKey, expect: { kind: 'table', rule } },
      severity: intent.severity,
      onViolation: 'continue',
      provenance: 'manual',
    })
  })

  const card: AcceptanceProposalCard = {
    id: newId(),
    intentKey: intent.key,
    intentKind: 'table_acceptance',
    meaning: `「${label}」数据验收（${rules.length} 条规则）`,
    stepId: step.id,
    evidenceId: body.evidenceId,
    testResult,
    target: plan.target,
    targetSource: 'manual',
    expectsMany: true,
    severity: intent.severity,
    onViolation: 'continue',
    provenance: 'manual',
    operationIds: ops.map((op) => op.id),
    config: { ruleKind: 'table', stepName: step.name },
  }
  builtCards.push({ card, ops })

  return {
    evidenceId: body.evidenceId,
    planDigest,
    sampleDigest: syncSha256(canonicalJson(sample)),
    sampledAt: sample.source.sampledAt,
    stale,
  }
}

/** 非表格意图的确定性构造：定位只来自人工点选，与 AI 提案共用 buildAcceptanceCard。 */
function buildManualIntentCard(intent: AcceptanceIntentRequest, steps: Step[]): BuiltCard {
  if (intent.kind === 'value_consistency') {
    throw conflict('INTENT_REQUIRES_AI', '数值一致性意图依赖基线结构分析，模型不可用时暂不支持，请使用其他意图或开启模型')
  }
  const step =
    'stepId' in intent ? steps.find((s) => s.id === intent.stepId) : undefined
  if ('stepId' in intent && !step) {
    throw conflict('STEP_NOT_FOUND', `意图挂靠的步骤不存在（${intent.kind}）`)
  }

  const resolved: IntentTarget | undefined =
    'target' in intent && intent.target
      ? {
          target: intent.target,
          source: 'manual',
          headerRows: 0,
          ...('metricName' in intent && intent.metricName ? { label: intent.metricName } : {}),
        }
      : undefined

  let built: BuiltCard
  try {
    built = buildAcceptanceCard(intent, step ?? steps[steps.length - 1]!, resolved)
  } catch (err) {
    throw conflict('INTENT_TARGET_REQUIRED', err instanceof Error ? err.message : '意图构造失败')
  }

  // 人工入口保持 manual 来源；不能因人点采纳就改写成 ai_compiled
  const card: AcceptanceProposalCard = { ...built.card, provenance: 'manual' }
  const ops = built.ops.map((op) => (op.kind === 'add_outcome' ? { ...op, provenance: 'manual' as const } : op))
  return { card, ops }
}

function aggregateTestResult(cards: AcceptanceProposalCard[]): AcceptanceCardTestResult {
  const results = cards.map((card) => card.testResult)
  if (results.includes('VIOLATED')) return 'VIOLATED'
  if (results.includes('FACTS_UNAVAILABLE')) return 'FACTS_UNAVAILABLE'
  if (results.includes('PASSED')) return 'PASSED'
  if (results.includes('NOT_REQUIRED')) return 'NOT_REQUIRED'
  return 'UNTESTED'
}
