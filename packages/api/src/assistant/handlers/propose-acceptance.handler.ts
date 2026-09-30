import {
  type AcceptanceCardBlockReason,
  type AcceptanceIntentRequest,
  type AcceptanceProposalCard,
  type AcceptanceRequest,
  type AssistantAuthoringProposal,
  type AssistantResult,
  type AuthoringOperation,
  type Expr,
  type LocatorCandidate,
  type OutcomeSeverity,
  type ProposalUnsupportedItem,
  type ScenarioAuthoringDocumentV2,
  type ScenarioMetricDecl,
  type Step,
  type TargetDescriptor,
  type TableExpectRule,
  type TableReadPlan,
  AUTHORING_OPERATION_LIMITS,
  MAX_ACCEPTANCE_INTENTS,
  acceptanceIntentNeedsTarget,
  acceptanceIntentRequestSchema,
  acceptanceRequestSchema,
  authoringDocumentDigest,
  authoringSteps,
  hasPermission,
  isAuthoringDocumentV2,
  parseScenarioDocument,
  targetDescriptorSchema,
  tableExpectRuleSchema,
  validateTableExpectRuleAgainstPlan,
  toAuthoringDocumentV2,
  walkAuthoringNodes,
} from '@cairn/shared'
import { applyAuthoringOperations } from '@cairn/authoring'
import {
  DomainError,
  expandWithLoader,
  getScenario,
  listRunStructureSnapshots,
  loadRunDetail,
  newId,
  type RunStructureSnapshot,
} from '@cairn/db'
import type { AssistantCapabilityHandlerContext } from '../registry.js'
import {
  generateAcceptanceIntents,
  generateAcceptanceTargets,
  type ModelAcceptanceIntents,
  type ModelAcceptanceTargets,
} from '../model-session.js'

/** 单项送给模型的结构快照上限；采集上限是 32K。后台页常有大段导航，过小会截掉正文里的表格。 */
const MODEL_SNAPSHOT_CHARS = 24_000
/** 列表取数上限与表达式运行期列表上限一致，超过则整项结果为「无法判定」。 */
const TABLE_MAX_ROWS = 200

const INTENT_LABELS: Record<AcceptanceIntentRequest['kind'], string> = {
  page_reachable: '页面可达',
  page_duration: '页面耗时',
  table_non_empty: '列表非空',
  table_acceptance: '表格验收',
  number_range: '数值在范围',
  text_present_or_absent: '文字出现/不出现',
  extract_to_report: '取值进报告',
  scenario_duration: '全程耗时',
  value_consistency: '跨页数值一致',
}

const COMPARE_LABELS: Record<string, string> = {
  eq: '等于',
  neq: '不等于',
  gt: '大于',
  gte: '不小于',
  lt: '小于',
  lte: '不大于',
}

export type IntentTarget = {
  target: TargetDescriptor
  source: 'manual' | 'model'
  headerRows: number
  label?: string
  rationale?: string
  evidenceId?: string
}

export type BuiltCard = { card: AcceptanceProposalCard; ops: AuthoringOperation[] }

/** 步骤所在的分支；在其后插入取数步骤时必须落在同一分支。 */
export type StepPlacement = { parentBlockId?: string; branchKey?: 'then' | 'else' | 'body' }

/** 新写入的上下文键与指标键共用：小写字母开头，满足两边的格式要求。 */
function contextKey(prefix: string): string {
  return `acc_${prefix}_${newId().replace(/-/g, '').slice(-8).toLowerCase()}`
}

function describeTarget(target: TargetDescriptor | undefined, fallback: string): string {
  const first = target?.candidates[0]
  if (!first) return target?.semantic ?? fallback
  return first.name ?? first.value
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 模型给的定位只许引用快照里真实出现的角色、名称和文字，否则按「未接地」拦下，
 * 不让编造的定位进入可采纳方案。
 */
/** 纯数值、金额、百分比这类文字每次运行都会变，不能当定位。 */
export function isVolatileValueText(text: string | undefined): boolean {
  if (!text) return false
  return /\d/.test(text) && /^[\s$¥￥€£+\-\d.,%:：/]+$/.test(text)
}

export function isCandidateGrounded(snapshot: string, candidate: LocatorCandidate): boolean {
  if (candidate.by === 'css' || candidate.by === 'testId') return false
  if (candidate.by === 'role') {
    // 名称含引号时整行会被再包一层单引号：- 'row "A"':
    const rolePattern = new RegExp(`(^|\\n)\\s*-\\s*'?${escapeRegExp(candidate.value)}(?=[\\s:"']|$)`)
    if (!rolePattern.test(snapshot)) return false
    return candidate.name === undefined || snapshot.includes(candidate.name)
  }
  return snapshot.includes(candidate.value)
}

/** 快照里带 columnheader 的 row 数；模型给的值优先，这里只作兜底。 */
export function countHeaderRows(snapshot: string): number {
  const lines = snapshot.split('\n')
  let headers = 0
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*-\s*'?row\b/.test(lines[i]!)) continue
    const indent = lines[i]!.search(/\S/)
    for (let j = i + 1; j < lines.length; j++) {
      const nextIndent = lines[j]!.search(/\S/)
      if (nextIndent <= indent) break
      if (/^\s*-\s*'?columnheader\b/.test(lines[j]!)) {
        headers++
        break
      }
    }
  }
  return headers
}

function latestSnapshotByStep(snapshots: RunStructureSnapshot[]): Map<string, RunStructureSnapshot> {
  const byStep = new Map<string, RunStructureSnapshot>()
  for (const item of snapshots) {
    if (item.stepId) byStep.set(item.stepId, item)
  }
  return byStep
}

function blockedCard(
  intent: AcceptanceIntentRequest,
  step: Step | undefined,
  reason: AcceptanceCardBlockReason,
  message: string,
  evidenceId?: string,
): BuiltCard {
  return {
    card: {
      id: newId(),
      intentKey: intent.key,
      intentKind: intent.kind,
      meaning: `${INTENT_LABELS[intent.kind]}${step ? `（${step.name}）` : ''}`.slice(0, 512),
      stepId: 'stepId' in intent ? (intent as any).stepId : undefined,
      ...(evidenceId ? { evidenceId } : {}),
      testResult: 'UNTESTED',
      severity: intent.severity,
      onViolation: 'continue',
      operationIds: [],
      provenance: 'ai_compiled',
      blockedReason: reason,
      blockedMessage: message.slice(0, 512),
    },
    ops: [],
  }
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${ms / 1000}秒` : `${ms}毫秒`
}

export function buildScenarioDurationCard(
  intent: Extract<AcceptanceIntentRequest, { kind: 'scenario_duration' }>,
): BuiltCard {
  const cardId = newId()
  const durKey = contextKey('dur')
  const meaning = `全程耗时不超过 ${formatMs(intent.maxMs)}`
  const outcome: AuthoringOperation = {
    kind: 'add_outcome',
    id: newId(),
    meaning,
    rule: { kind: 'run_duration', op: 'lte', valueMs: intent.maxMs },
    severity: intent.severity,
    onViolation: 'continue',
    provenance: 'ai_compiled',
  }
  const metric: ScenarioMetricDecl = {
    key: durKey,
    name: '全程耗时',
    unit: 'ms',
    fromRunDuration: true,
  }
  const metricOp: AuthoringOperation = metricsOp(metric)
  const ops = [outcome, metricOp]

  return {
    card: {
      id: cardId,
      intentKey: intent.key,
      intentKind: 'scenario_duration',
      meaning,
      severity: intent.severity,
      onViolation: 'continue',
      provenance: 'ai_compiled',
      operationIds: ops.map((o) => o.id),
      testResult: 'UNTESTED',
      summarySnippet: `全程耗时 \${${durKey}} ms`,
      config: {
        ruleKind: 'run_duration',
        metric,
      },
    },
    ops,
  }
}

export function buildValueConsistencyCard(
  intent: Extract<AcceptanceIntentRequest, { kind: 'value_consistency' }>,
  steps: Step[],
  placements: Map<string, StepPlacement | null>,
): BuiltCard {
  const cardId = newId()
  const stepA = steps.find((s) => s.id === intent.stepIdA)
  const stepB = steps.find((s) => s.id === intent.stepIdB)

  if (!stepA || !stepB) {
    return blockedCard(intent, undefined, 'VALUE_SOURCE_MISSING', '所选对账步骤已不在草稿中，请重新选择')
  }

  const placementA = placements.get(stepA.id)
  const placementB = placements.get(stepB.id)
  const isBackboneA = placementA !== null && placementA !== undefined && !placementA.parentBlockId
  const isBackboneB = placementB !== null && placementB !== undefined && !placementB.parentBlockId

  if (placementA === null) {
    return blockedCard(intent, stepA, 'VALUE_SOURCE_MISSING', `步骤「${stepA.name}」位于动作模块内部，暂不支持跨页对账`)
  }
  if (placementB === null) {
    return blockedCard(intent, stepB, 'VALUE_SOURCE_MISSING', `步骤「${stepB.name}」位于动作模块内部，暂不支持跨页对账`)
  }
  if (!isBackboneA) {
    return blockedCard(intent, stepA, 'VALUE_SOURCE_MISSING', `步骤「${stepA.name}」位于分支或循环内部，暂不支持跨页对账`)
  }
  if (!isBackboneB) {
    return blockedCard(intent, stepB, 'VALUE_SOURCE_MISSING', `步骤「${stepB.name}」位于分支或循环内部，暂不支持跨页对账`)
  }

  if (!stepA.outputKey) {
    return blockedCard(intent, stepA, 'VALUE_SOURCE_MISSING', `步骤「${stepA.name}」未提取变量，请先配置取数步骤`)
  }
  if (!stepB.outputKey) {
    return blockedCard(intent, stepB, 'VALUE_SOURCE_MISSING', `步骤「${stepB.name}」未提取变量，请先配置取数步骤`)
  }

  const indexA = steps.findIndex((s) => s.id === stepA.id)
  const indexB = steps.findIndex((s) => s.id === stepB.id)
  const laterStep = indexA >= indexB ? stepA : stepB
  const anchorStepId = laterStep.id

  const diffKey = contextKey('diff')
  const exprA: Expr = {
    kind: 'call',
    fn: 'extractNumber',
    args: [{ kind: 'ref', key: stepA.outputKey }],
  }
  const exprB: Expr = {
    kind: 'call',
    fn: 'extractNumber',
    args: [{ kind: 'ref', key: stepB.outputKey }],
  }
  const diffExpr: Expr = {
    kind: 'call',
    fn: 'diff',
    args: [exprA, exprB],
  }
  const finalExpr: Expr = intent.tolerance !== undefined
    ? { kind: 'call', fn: 'abs', args: [diffExpr] }
    : diffExpr

  const computeName = `计算「${stepA.name}」与「${stepB.name}」差值`
  const compute = computeStep(computeName, finalExpr, diffKey)

  const insertComputeOp: AuthoringOperation = {
    kind: 'insert_step',
    id: newId(),
    step: compute,
    anchorStepId,
  }

  const outcomeMeaning = intent.tolerance !== undefined
    ? `「${stepA.name}」与「${stepB.name}」数值差值不超过 ${intent.tolerance}`
    : `「${stepA.name}」与「${stepB.name}」数值必须一致`

  const outcomeRule: Extract<AuthoringOperation, { kind: 'add_outcome' }>['rule'] = {
    kind: 'context',
    key: diffKey,
    expect: intent.tolerance !== undefined
      ? { kind: 'number_compare', op: 'lte', value: intent.tolerance }
      : { kind: 'number_compare', op: 'eq', value: 0 },
  }

  const outcomeOp: AuthoringOperation = {
    kind: 'add_outcome',
    id: newId(),
    meaning: outcomeMeaning,
    rule: outcomeRule,
    severity: intent.severity,
    onViolation: 'continue',
    provenance: 'ai_compiled',
  }

  const ops: AuthoringOperation[] = [insertComputeOp, outcomeOp]

  let metric: ScenarioMetricDecl | undefined
  if (intent.metricName) {
    metric = {
      key: diffKey,
      name: intent.metricName,
      fromContextKey: diffKey,
    }
    ops.push(metricsOp(metric))
  }

  return {
    card: {
      id: cardId,
      intentKey: intent.key,
      intentKind: 'value_consistency',
      meaning: outcomeMeaning,
      severity: intent.severity,
      onViolation: 'continue',
      provenance: 'ai_compiled',
      operationIds: ops.map((o) => o.id),
      testResult: 'UNTESTED',
      summarySnippet: intent.metricName ? `${intent.metricName} \${${diffKey}}` : undefined,
      config: {
        ruleKind: 'context',
        stepName: stepB.name,
        ...(metric ? { metric } : {}),
      },
    },
    ops,
  }
}

function extractStep(name: string, target: TargetDescriptor, outputKey: string, many: boolean): Step {
  return {
    id: newId(),
    name: name.slice(0, 128),
    type: 'extract',
    effectType: 'READ_ONLY',
    outputKey,
    input: {
      target,
      as: 'text',
      ...(many ? { many: { maxItems: TABLE_MAX_ROWS } } : {}),
    },
  }
}

function computeStep(name: string, expression: Expr, outputKey: string): Step {
  return {
    id: newId(),
    name: name.slice(0, 128),
    type: 'compute',
    effectType: 'READ_ONLY',
    outputKey,
    input: { expression },
  }
}

function metricsOp(metric: ScenarioMetricDecl): AuthoringOperation {
  return { kind: 'set_outputs', id: newId(), mode: 'merge', metrics: [metric] }
}

function outcomeOp(
  stepId: string,
  meaning: string,
  rule: Extract<AuthoringOperation, { kind: 'add_outcome' }>['rule'],
  severity: OutcomeSeverity,
): AuthoringOperation {
  return {
    kind: 'add_outcome',
    id: newId(),
    stepId,
    meaning: meaning.slice(0, 512),
    rule,
    severity,
    onViolation: 'continue',
    provenance: 'ai_compiled',
  }
}

/** 按意图把一张卡展开为编排操作；定位已在此前解析好（需要定位的意图必须带 resolved）。 */
export function buildAcceptanceCard(
  intent: AcceptanceIntentRequest,
  step: Step,
  resolved: IntentTarget | undefined,
  placement: StepPlacement = {},
): BuiltCard {
  const insertAfter = (inserted: Step, anchorStepId: string): AuthoringOperation => ({
    kind: 'insert_step',
    id: newId(),
    step: inserted,
    anchorStepId,
    ...(placement.parentBlockId ? { parentBlockId: placement.parentBlockId, branchKey: placement.branchKey } : {}),
  })
  const base = {
    id: newId(),
    intentKey: intent.key,
    intentKind: intent.kind,
    stepId: step.id,
    severity: intent.severity,
    onViolation: 'continue' as const,
    provenance: 'ai_compiled' as const,
    ...(resolved?.evidenceId ? { evidenceId: resolved.evidenceId } : {}),
    ...(resolved ? { target: resolved.target, targetSource: resolved.source } : {}),
    ...(resolved?.rationale ? { rationale: resolved.rationale.slice(0, 512) } : {}),
  }
  const withOps = (card: Omit<AcceptanceProposalCard, 'operationIds'>, ops: AuthoringOperation[]): BuiltCard => ({
    card: { ...card, meaning: card.meaning.slice(0, 512), operationIds: ops.map((op) => op.id) },
    ops,
  })
  const requireTarget = (): IntentTarget => {
    if (!resolved) throw new Error(`${intent.kind} 缺少页面对象定位`)
    return resolved
  }

  switch (intent.kind) {
    case 'page_duration': {
      const key = contextKey('ms')
      const meaning = `「${step.name}」耗时不超过 ${intent.maxMs} ms`
      const metric: ScenarioMetricDecl = {
        key,
        name: `${step.name}耗时`.slice(0, 64),
        unit: 'ms',
        fromStepDuration: { stepId: step.id },
      }
      return withOps(
        {
          ...base,
          meaning,
          testResult: 'NOT_REQUIRED',
          summarySnippet: `${step.name}耗时 \${${key}} ms`.slice(0, 200),
          config: { ruleKind: 'step_duration', metric, stepName: step.name },
        },
        [outcomeOp(step.id, meaning, { kind: 'step_duration', op: 'lte', valueMs: intent.maxMs }, intent.severity), metricsOp(metric)],
      )
    }
    case 'page_reachable': {
      const { target, label } = requireTarget()
      const meaning = `「${step.name}」后页面正常打开，「${label ?? describeTarget(target, '关键内容')}」可见`
      return withOps(
        { ...base, meaning, testResult: 'UNTESTED', config: { ruleKind: 'deterministic', stepName: step.name } },
        [outcomeOp(step.id, meaning, { kind: 'deterministic', target, expect: { kind: 'visible' } }, intent.severity)],
      )
    }
    case 'text_present_or_absent': {
      const meaning = intent.absent
        ? `「${step.name}」后页面不出现「${intent.text}」`
        : `「${step.name}」后页面出现「${intent.text}」`
      return withOps(
        {
          ...base,
          meaning,
          // 整页判定，不依赖页面对象；「不出现」在基线页上本来就可能不存在，不做实测。
          testResult: 'NOT_REQUIRED',
          config: { ruleKind: 'deterministic', stepName: step.name },
        },
        [
          outcomeOp(
            step.id,
            meaning,
            {
              kind: 'deterministic',
              expect: intent.absent ? { kind: 'text_absent', value: intent.text } : { kind: 'text_contains', value: intent.text },
            },
            intent.severity,
          ),
        ],
      )
    }
    case 'table_non_empty': {
      const resolvedTarget = requireTarget()
      const label = intent.metricName ?? resolvedTarget.label ?? '列表'
      const rowsKey = contextKey('rows')
      const countKey = contextKey('count')
      const rows = extractStep(`读取${label}各行`, resolvedTarget.target, rowsKey, true)
      const rowCount: Expr = { kind: 'call', fn: 'length', args: [{ kind: 'ref', key: rowsKey }] }
      const expression: Expr =
        resolvedTarget.headerRows > 0
          ? {
              kind: 'call',
              fn: 'max',
              args: [
                { kind: 'call', fn: 'sum', args: [rowCount, { kind: 'literal', value: -resolvedTarget.headerRows }] },
                { kind: 'literal', value: 0 },
              ],
            }
          : rowCount
      const count = computeStep(`统计${label}行数`, expression, countKey)
      const meaning = `「${label}」有数据（行数大于 0）`
      const metricName = (intent.metricName ?? `${label}行数`).slice(0, 64)
      const metric: ScenarioMetricDecl = { key: countKey, name: metricName, unit: '条', fromContextKey: countKey }
      return withOps(
        {
          ...base,
          meaning,
          testResult: 'UNTESTED',
          expectsMany: true,
          summarySnippet: `${metricName} \${${countKey}} 条`.slice(0, 200),
          config: { ruleKind: 'context', metric, stepName: step.name },
        },
        [
          insertAfter(rows, step.id),
          insertAfter(count, rows.id),
          outcomeOp(count.id, meaning, { kind: 'context', key: countKey, expect: { kind: 'number_compare', op: 'gt', value: 0 } }, intent.severity),
          metricsOp(metric),
        ],
      )
    }
    case 'table_acceptance': {
      const resolvedTarget = requireTarget()
      const label = intent.metricName ?? resolvedTarget.label ?? '表格'
      const tableOutputKey = contextKey('tbl')
      const plan = (intent as any).tablePlan as TableReadPlan | undefined
      const tableTarget = plan?.target ?? resolvedTarget.target
      const tablePlan: TableReadPlan = plan ?? {
        protocol: 'table.read@1',
        target: tableTarget,
        scope: 'current_page',
        columns: [{ key: 'col_1', name: '数据列', valueType: 'text' as const }],
        limits: { maxRows: 200, maxCols: 32 },
      }

      const extractStepDef: Step = {
        id: newId(),
        type: 'extract',
        name: `提取「${label}」数据`,
        effectType: 'READ_ONLY',
        input: {
          as: 'table',
          target: tableTarget,
          table: tablePlan,
        },
        outputKey: tableOutputKey,
      }

      const rawRules = (intent as any).rules as TableExpectRule[] | undefined
      let rules: TableExpectRule[] = rawRules && rawRules.length > 0
        ? rawRules
        : [{ rule: 'row_count' as const, op: 'gt' as const, value: 0 }]
      // AI 提案同样要在生成侧拦截非法/与读取计划列类型不符的规则，不能等运行时冒充 FAIL
      rules = rules
        .map((raw) => {
          const parsed = tableExpectRuleSchema.safeParse(raw)
          return parsed.success ? parsed.data : null
        })
        .filter((r): r is TableExpectRule => r !== null)
      if (rules.length === 0) {
        rules = [{ rule: 'row_count', op: 'gt', value: 0 }]
      }
      for (const rule of rules) {
        const crossCheck = validateTableExpectRuleAgainstPlan(rule, tablePlan.columns)
        if (!crossCheck.valid) {
          throw new Error(`表格验收规则非法：${crossCheck.message}`)
        }
      }

      const ops: AuthoringOperation[] = [
        insertAfter(extractStepDef, step.id),
      ]
      let lastStepId = extractStepDef.id

      for (let rIdx = 0; rIdx < rules.length; rIdx++) {
        const rule = rules[rIdx]!
        const checkStep: Step = {
          id: newId(),
          type: 'check_context',
          name: `验证「${label}」规则 ${rIdx + 1}`,
          effectType: 'READ_ONLY',
          input: {
            key: tableOutputKey,
            expect: { kind: 'table', rule },
          },
        }
        ops.push(insertAfter(checkStep, lastStepId))
        lastStepId = checkStep.id

        const meaning = `「${label}」满足数据验收规则 ${rIdx + 1}`
        ops.push(
          outcomeOp(
            checkStep.id,
            meaning,
            { kind: 'context', key: tableOutputKey, expect: { kind: 'table', rule } },
            intent.severity,
          ),
        )
      }

      const meaning = `「${label}」数据验收（共 ${rules.length} 条规则）`
      return withOps(
        {
          ...base,
          meaning,
          testResult: 'UNTESTED',
          expectsMany: true,
          config: { ruleKind: 'table', stepName: step.name },
        },
        ops,
      )
    }
    case 'number_range': {
      const resolvedTarget = requireTarget()
      const label = intent.metricName ?? resolvedTarget.label ?? describeTarget(resolvedTarget.target, '数值')
      const rawKey = contextKey('raw')
      const numKey = contextKey('num')
      const raw = extractStep(`读取${label}`, resolvedTarget.target, rawKey, false)
      const num = computeStep(
        `把${label}转成数字`,
        { kind: 'call', fn: 'extractNumber', args: [{ kind: 'ref', key: rawKey }] },
        numKey,
      )
      const meaning = `「${label}」${COMPARE_LABELS[intent.op]} ${intent.value}`
      const ops: AuthoringOperation[] = [
        insertAfter(raw, step.id),
        insertAfter(num, raw.id),
        outcomeOp(num.id, meaning, { kind: 'context', key: numKey, expect: { kind: 'number_compare', op: intent.op, value: intent.value } }, intent.severity),
      ]
      let metric: ScenarioMetricDecl | undefined
      if (intent.metricName) {
        metric = { key: numKey, name: intent.metricName, fromContextKey: numKey }
        ops.push(metricsOp(metric))
      }
      return withOps(
        {
          ...base,
          meaning,
          testResult: 'UNTESTED',
          ...(metric ? { summarySnippet: `${metric.name} \${${numKey}}`.slice(0, 200) } : {}),
          config: { ruleKind: 'context', ...(metric ? { metric } : {}), stepName: step.name },
        },
        ops,
      )
    }
    case 'extract_to_report': {
      const { target } = requireTarget()
      const valueKey = contextKey('val')
      const read = extractStep(`读取${intent.metricName}`, target, valueKey, false)
      const metric: ScenarioMetricDecl = {
        key: valueKey,
        name: intent.metricName,
        fromContextKey: valueKey,
        ...(intent.unit ? { unit: intent.unit } : {}),
      }
      return withOps(
        {
          ...base,
          meaning: `把「${intent.metricName}」放进报告`,
          severity: 'SHOULD',
          testResult: 'UNTESTED',
          summarySnippet: `${intent.metricName} \${${valueKey}}${intent.unit ? ` ${intent.unit}` : ''}`.slice(0, 200),
          config: { ruleKind: 'context', metric, stepName: step.name },
        },
        [insertAfter(read, step.id), metricsOp(metric)],
      )
    }
    case 'scenario_duration':
      return buildScenarioDurationCard(intent)
    case 'value_consistency':
      throw new Error('value_consistency intent must be built via buildValueConsistencyCard')
  }
  throw new Error(`验收意图 ${(intent as any).kind} 尚未接入提案生成`)
}

/** clarify 追问里带上「哪些部分暂不支持」，避免拆解失败时 unsupported 信息丢失。 */
function withUnsupportedNote(base: string, unsupported: ProposalUnsupportedItem[] | undefined): string {
  const text = base.slice(0, 512)
  if (!unsupported || unsupported.length === 0) return text
  const note = `未支持的部分：${unsupported.map((item) => `「${item.excerpt}」${item.reason}`).join('；')}`
  return `${text}\n${note}`.slice(0, 512)
}

/** 把模型拆出的意图收成结构化意图；步骤不在草稿、参数缺失的转成 unsupported 项，不静默丢弃。 */
export function intentsFromModel(
  output: ModelAcceptanceIntents,
  steps: Pick<Step, 'id' | 'name'>[],
): { intents: AcceptanceIntentRequest[]; unsupported: ProposalUnsupportedItem[] } {
  const intents: AcceptanceIntentRequest[] = []
  const unsupported: ProposalUnsupportedItem[] = []
  const stepLabel = (id?: string) => steps.find((s) => s.id === id)?.name ?? id ?? '未指明步骤'
  const dropped = (excerpt: string, reason: string) => {
    unsupported.push({ excerpt: excerpt.slice(0, 200), reason: reason.slice(0, 256) })
  }
  for (const [index, item] of output.intents.entries()) {
    if (item.kind === 'scenario_duration') {
      const parsed = acceptanceIntentRequestSchema.safeParse({
        key: `q${index + 1}`,
        kind: 'scenario_duration',
        maxMs: item.maxMs ?? 60_000,
        severity: item.severity ?? 'SHOULD',
      })
      if (parsed.success) intents.push(parsed.data)
      else dropped('全程耗时不超过指定时长', '耗时参数不合法，请补充阈值后重试')
      continue
    }

    if (item.kind === 'value_consistency') {
      if (!item.stepIdA || !item.stepIdB) {
        dropped(
          `跨页数值一致（${stepLabel(item.stepIdA)} 与 ${stepLabel(item.stepIdB)}）`,
          '缺少要比对的两个步骤，无法生成跨页一致检查',
        )
        continue
      }
      if (!steps.some((s) => s.id === item.stepIdA) || !steps.some((s) => s.id === item.stepIdB)) {
        dropped(
          `跨页数值一致（${stepLabel(item.stepIdA)} 与 ${stepLabel(item.stepIdB)}）`,
          '比对步骤不在当前草稿中，无法生成跨页一致检查',
        )
        continue
      }
      const parsed = acceptanceIntentRequestSchema.safeParse({
        key: `q${index + 1}`,
        kind: 'value_consistency',
        stepIdA: item.stepIdA,
        stepIdB: item.stepIdB,
        severity: item.severity ?? 'MUST',
        ...(item.tolerance !== undefined ? { tolerance: item.tolerance } : {}),
        ...(item.metricName ? { metricName: item.metricName } : {}),
      })
      if (parsed.success) intents.push(parsed.data)
      else dropped(
        `跨页数值一致（${stepLabel(item.stepIdA)} 与 ${stepLabel(item.stepIdB)}）`,
        '参数不合法，无法生成跨页一致检查',
      )
      continue
    }

    if (!item.stepId || !steps.some((step) => step.id === item.stepId)) {
      dropped(`${INTENT_LABELS[item.kind] ?? item.kind}（${stepLabel(item.stepId)}）`, '没有指明挂靠的步骤，或步骤不在当前草稿中')
      continue
    }
    const withMetric = item.kind === 'table_non_empty' || item.kind === 'number_range' || item.kind === 'extract_to_report'
    const parsed = acceptanceIntentRequestSchema.safeParse({
      key: `q${index + 1}`,
      kind: item.kind,
      stepId: item.stepId,
      severity: item.severity ?? 'MUST',
      ...(item.kind === 'page_duration' ? { maxMs: item.maxMs } : {}),
      ...(item.kind === 'number_range' ? { op: item.op, value: item.value } : {}),
      ...(item.kind === 'text_present_or_absent' ? { text: item.text, absent: item.absent ?? false } : {}),
      ...(withMetric && item.metricName ? { metricName: item.metricName } : {}),
      ...(item.kind === 'extract_to_report' && item.unit ? { unit: item.unit } : {}),
    })
    if (parsed.success) intents.push(parsed.data)
    else dropped(`${INTENT_LABELS[item.kind] ?? item.kind}（${stepLabel(item.stepId)}）`, '参数不完整，无法生成该检查')
  }
  return { intents: intents.slice(0, MAX_ACCEPTANCE_INTENTS), unsupported }
}

export function modelTargetFor(
  item: ModelAcceptanceTargets['items'][number] | undefined,
  snapshot: Pick<RunStructureSnapshot, 'snapshot' | 'evidenceId'>,
  intent: AcceptanceIntentRequest,
): IntentTarget | { blocked: AcceptanceCardBlockReason; message: string } {
  if (!item || !item.candidates || item.candidates.length === 0) {
    return {
      blocked: 'MODEL_NO_TARGET',
      message: item?.clarify ?? '没能在基线页面上找到要检查的对象，请在页面上点选。',
    }
  }
  const grounded = item.candidates.filter((candidate) => isCandidateGrounded(snapshot.snapshot, candidate))
  if (grounded.length === 0) {
    return { blocked: 'MODEL_TARGET_UNGROUNDED', message: '模型给出的定位在基线页面结构里找不到，已拦下，请在页面上点选。' }
  }
  // 表格计数要匹配每一行：去掉 row 的名称（名称就是行内数据），否则只会命中某一行。
  const normalized: LocatorCandidate[] =
    intent.kind === 'table_non_empty'
      ? grounded.map((candidate) => (candidate.by === 'role' && candidate.value === 'row' ? { by: 'role', value: 'row' } : candidate))
      : grounded
  const candidates = normalized.filter(
    (candidate) => !isVolatileValueText(candidate.by === 'role' ? candidate.name : candidate.value),
  )
  if (candidates.length === 0) {
    return {
      blocked: 'MODEL_TARGET_UNGROUNDED',
      message: '模型只找到了数值本身作为定位，数值每次会变，不能用来定位。请在页面上点选它所在的区域或标签。',
    }
  }
  const parsed = targetDescriptorSchema.safeParse({
    framePath: [],
    candidates,
    ...(item.semantic ? { semantic: item.semantic } : {}),
  })
  if (!parsed.success) {
    return { blocked: 'MODEL_TARGET_UNGROUNDED', message: '模型给出的定位格式不合法，请在页面上点选。' }
  }
  return {
    target: parsed.data,
    source: 'model',
    headerRows: intent.kind === 'table_non_empty' ? (item.headerRows ?? countHeaderRows(snapshot.snapshot)) : 0,
    ...(item.label ? { label: item.label } : {}),
    rationale: item.rationale,
    evidenceId: snapshot.evidenceId,
  }
}

function describeIntentGoal(intent: AcceptanceIntentRequest): string {
  switch (intent.kind) {
    case 'page_reachable':
      return '找能代表页面已正常打开的对象'
    case 'table_non_empty':
      return `统计${intent.metricName ?? '列表'}的数据行`
    case 'number_range':
      return `读取${intent.metricName ?? '要比较的数值'}，判定 ${COMPARE_LABELS[intent.op]} ${intent.value}`
    case 'extract_to_report':
      return `读取「${intent.metricName}」放进报告`
    case 'scenario_duration':
      return `监控整个场景执行耗时不超过 ${intent.maxMs}ms`
    case 'value_consistency':
      return `比较两步提取的数值一致性`
    default:
      return INTENT_LABELS[intent.kind]
  }
}

export async function handleScenarioProposeAcceptance(
  ctx: AssistantCapabilityHandlerContext,
): Promise<AssistantResult> {
  const { db, actor, slots, body, session, onProgress, signal } = ctx

  if (!hasPermission(actor.permissions, 'ai:assist')) {
    throw new DomainError('forbidden', 'AI_ASSIST_FORBIDDEN', '没有 AI 助手访问权限')
  }
  if (!hasPermission(actor.permissions, 'workflow:write')) {
    throw new DomainError('forbidden', 'WORKFLOW_WRITE_FORBIDDEN', '没有工作流编写权限')
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
    throw new DomainError('conflict', 'DRAFT_REVISION_MISMATCH', '场景草稿已被修改，请保存后重新生成')
  }

  const rawDoc = detail.draft.document
  const document: ScenarioAuthoringDocumentV2 = isAuthoringDocumentV2(rawDoc)
    ? rawDoc
    : toAuthoringDocumentV2(parseScenarioDocument(rawDoc))
  const steps = authoringSteps(document)
  const walked = walkAuthoringNodes(document)
  const placements = new Map<string, StepPlacement | null>()
  for (const item of walked) {
    if (item.node.kind !== 'step') continue
    const parent = item.parentId ? walked.find((entry) => entry.id === item.parentId) : undefined
    placements.set(
      item.id,
      !item.parentId
        ? {}
        : parent?.node.kind === 'block'
          ? { parentBlockId: item.parentId, ...(item.branchKey ? { branchKey: item.branchKey } : {}) }
          : null,
    )
  }
  if (steps.length === 0) {
    return { kind: 'unsupported', reasonCode: 'EMPTY_SCENARIO', message: '场景中没有步骤，请先录制或添加步骤后再配置验收' }
  }

  // 1. 意图：面板送来的结构化意图优先；自由描述或一句话时由模型拆成意图卡。
  let request: AcceptanceRequest | undefined
  let parsedUnsupported: ProposalUnsupportedItem[] | undefined
  let parsedIntentsForPanel: AcceptanceIntentRequest[] | undefined
  if (body.acceptance) {
    const parsed = acceptanceRequestSchema.safeParse(body.acceptance)
    if (!parsed.success) {
      return { kind: 'unsupported', reasonCode: 'ACCEPTANCE_REQUEST_INVALID', message: '验收意图参数不完整，请检查每张意图卡' }
    }
    request = parsed.data
  }
  const baselineRunId = request?.baselineRunId ?? body.pageContext?.runId

  if (request?.description) {
    if (!session) {
      return {
        kind: 'clarify',
        question: '未配置平台模型，无法从自由描述解析验收项。请直接在面板中配置意图卡。',
        missingFields: ['intents'],
      }
    }
    await onProgress?.('generating', '正在分析验收描述并拆解意图...')
    const mapped = await generateAcceptanceIntents(
      session,
      request.description,
      steps.map((step) => ({ id: step.id, name: step.name, type: step.type })),
      signal,
    )
    if (!mapped.output) {
      return { kind: 'unsupported', reasonCode: 'MODEL_UNAVAILABLE', message: mapped.error ?? '模型暂时不可用，请改用意图卡' }
    }
    const { intents: modelIntents, unsupported: droppedUnsupported } = intentsFromModel(mapped.output, steps)
    parsedUnsupported = [...(mapped.output.unsupported ?? []), ...droppedUnsupported]
    // 面板送来的结构化意图优先保留，与拆解结果合并后仍受单轮上限约束。
    const userIntents = request.intents ?? []
    const merged = [...userIntents, ...modelIntents].slice(0, MAX_ACCEPTANCE_INTENTS)
    parsedIntentsForPanel = merged.slice(userIntents.length)
    if (merged.length === 0) {
      return {
        kind: 'clarify',
        question: withUnsupportedNote(
          mapped.output.clarify ?? '没能从描述中识别出可配置的验收项。请说明要检查的步骤与业务条件（如「订单列表有数据」「整个流程不超过 30 秒」）。',
          parsedUnsupported,
        ),
        missingFields: ['intents'],
      }
    }
    request = { intents: merged, ...(baselineRunId ? { baselineRunId } : {}) }
  } else if (!request || !request.intents || request.intents.length === 0) {
    if (!session) {
      return {
        kind: 'clarify',
        question: '未配置平台模型，无法从一句话拆出验收项。请在 Studio 的「补全验收」面板里选择意图卡并点选页面对象。',
        missingFields: ['intents'],
      }
    }
    await onProgress?.('generating', '正在把目标拆成验收意图...')
    const mapped = await generateAcceptanceIntents(
      session,
      ctx.question,
      steps.map((step) => ({ id: step.id, name: step.name, type: step.type })),
      signal,
    )
    if (!mapped.output) {
      return { kind: 'unsupported', reasonCode: 'MODEL_UNAVAILABLE', message: mapped.error ?? '模型暂时不可用，请改用意图卡' }
    }
    const { intents: modelIntents, unsupported: droppedUnsupported } = intentsFromModel(mapped.output, steps)
    parsedUnsupported = [...(mapped.output.unsupported ?? []), ...droppedUnsupported]
    if (modelIntents.length === 0) {
      return {
        kind: 'clarify',
        question: withUnsupportedNote(
          mapped.output.clarify ?? '没能确定要检查什么。请说明在哪一步之后检查、检查什么（如「订单列表有数据」「打开不超过 3 秒」）。',
          parsedUnsupported,
        ),
        missingFields: ['intents'],
      }
    }
    parsedIntentsForPanel = modelIntents
    request = { intents: modelIntents, ...(baselineRunId ? { baselineRunId } : {}) }
  }

  await onProgress?.('loading_facts', '正在读取基线运行的页面结构...')

  // 2. 基线证据：只认本场景的运行。
  let snapshotsByStep = new Map<string, RunStructureSnapshot>()
  if (baselineRunId) {
    const run = await loadRunDetail(db, baselineRunId, actor.id).catch(() => null)
    if (run && run.scenarioId === scenarioId) {
      snapshotsByStep = latestSnapshotByStep(await listRunStructureSnapshots(db, baselineRunId, actor.id))
    }
  }

  // 3. 定位：人工点选直接用；否则取该步的基线结构交给模型，统一一次调用。
  const built: BuiltCard[] = []
  const pending: Array<{ intent: AcceptanceIntentRequest; step: Step }> = []
  const manualTargets = new Map<string, IntentTarget>()
  const modelItems: Array<{ intent: AcceptanceIntentRequest; step: Step; snapshot: RunStructureSnapshot }> = []

  for (const intent of request.intents) {
    if (intent.kind === 'scenario_duration') {
      built.push(buildScenarioDurationCard(intent))
      continue
    }
    if (intent.kind === 'value_consistency') {
      built.push(buildValueConsistencyCard(intent, steps, placements))
      continue
    }
    const step = steps.find((item) => item.id === intent.stepId)
    if (!step) {
      built.push(blockedCard(intent, undefined, 'STEP_NOT_FOUND', '所选步骤已不在草稿中，请重新选择'))
      continue
    }
    if (placements.get(step.id) === null) {
      built.push(blockedCard(intent, step, 'STEP_NOT_EDITABLE', '该步骤在动作模块内部，不能在其后插入检查，请改选模块之后的步骤'))
      continue
    }
    pending.push({ intent, step })
    if (!acceptanceIntentNeedsTarget(intent.kind)) continue
    const snapshot = snapshotsByStep.get(step.id)
    const manual = 'target' in intent ? intent.target : undefined
    if (manual) {
      manualTargets.set(intent.key, {
        target: manual,
        source: 'manual',
        headerRows: intent.kind === 'table_non_empty' && snapshot ? countHeaderRows(snapshot.snapshot) : 0,
        ...(snapshot ? { evidenceId: snapshot.evidenceId } : {}),
      })
    } else if (snapshot && session) {
      modelItems.push({ intent, step, snapshot })
    }
  }

  const modelResults = new Map<string, ModelAcceptanceTargets['items'][number]>()
  let modelError: string | undefined
  if (session && modelItems.length > 0) {
    await onProgress?.('generating', '正在按基线页面结构定位要检查的对象...')
    const located = await generateAcceptanceTargets(
      session,
      {
        items: modelItems.map(({ intent, step, snapshot }) => ({
          key: intent.key,
          kind: intent.kind,
          stepName: step.name,
          goal: describeIntentGoal(intent),
          snapshot: snapshot.snapshot.slice(0, MODEL_SNAPSHOT_CHARS),
        })),
      },
      signal,
    )
    if (located.output) {
      for (const item of located.output.items) modelResults.set(item.key, item)
    } else {
      modelError = located.error ?? '模型暂时不可用'
    }
  }

  await onProgress?.('generating', '正在生成验收卡片...')
  for (const { intent, step } of pending) {
    if (!acceptanceIntentNeedsTarget(intent.kind)) {
      built.push(buildAcceptanceCard(intent, step, undefined, placements.get(step.id) ?? {}))
      continue
    }
    const manual = manualTargets.get(intent.key)
    if (manual) {
      built.push(buildAcceptanceCard(intent, step, manual, placements.get(step.id) ?? {}))
      continue
    }
    const snapshot = snapshotsByStep.get(step.id)
    if (!snapshot) {
      built.push(
        blockedCard(
          intent,
          step,
          'NO_BASELINE_EVIDENCE',
          baselineRunId
            ? `基线运行还没有「${step.name}」完成后的页面结构，请让基线运行跑过这一步，或在页面上点选。`
            : '需要先做一次基线运行，或在页面上点选要检查的对象。',
        ),
      )
      continue
    }
    if (!session) {
      built.push(blockedCard(intent, step, 'NEEDS_MANUAL_PICK', '未配置平台模型，请在页面上点选要检查的对象。', snapshot.evidenceId))
      continue
    }
    if (modelError) {
      built.push(blockedCard(intent, step, 'MODEL_NO_TARGET', `${modelError}，请在页面上点选。`, snapshot.evidenceId))
      continue
    }
    const resolved = modelTargetFor(modelResults.get(intent.key), snapshot, intent)
    if ('blocked' in resolved) {
      built.push(blockedCard(intent, step, resolved.blocked, resolved.message, snapshot.evidenceId))
      continue
    }
    built.push(buildAcceptanceCard(intent, step, resolved, placements.get(step.id) ?? {}))
  }

  // 与意图卡顺序一致，便于对照。
  const order = new Map(request.intents.map((intent, index) => [intent.key, index]))
  built.sort((a, b) => (order.get(a.card.intentKey ?? '') ?? 0) - (order.get(b.card.intentKey ?? '') ?? 0))
  const cards = built.map((item) => item.card)
  const operations = built.flatMap((item) => item.ops)

  if (operations.length === 0) {
    return {
      kind: 'clarify',
      question: `暂时生成不了可采纳的验收项：${cards.map((card) => card.blockedMessage).filter(Boolean).join('；')}`.slice(0, 512),
      missingFields: ['target'],
    }
  }

  await onProgress?.('validating', '正在校验验收方案...')
  const applied = applyAuthoringOperations(document, operations, AUTHORING_OPERATION_LIMITS.acceptance)
  if (!applied.ok) {
    return { kind: 'unsupported', reasonCode: applied.error.code, message: applied.error.message }
  }
  // 与复跑验证同一口径（含成功条件清单与模块展开），避免这里显示可执行、试跑时才被编译拦下。
  const [baselineCompile, candidateCompile] = await Promise.all([
    expandWithLoader(db, detail.targetId, document, 'trial', true),
    expandWithLoader(db, detail.targetId, applied.document, 'trial', true),
  ])
  const candidateOk = !candidateCompile.diagnostics.some((item) => item.severity === 'error')

  const proposal: AssistantAuthoringProposal = {
    kind: 'authoring_proposal',
    proposalId: newId(),
    scenarioId: detail.id,
    base: {
      draftRevision: detail.draft.revision,
      documentDigest: await authoringDocumentDigest(document),
      dependencyFingerprint: `${detail.targetId}:${detail.draft.revision}`,
    },
    operations,
    candidateDigest: await authoringDocumentDigest(applied.document),
    intentCoverage: cards
      .filter((card) => card.operationIds.length > 0)
      .map((card) => ({ intentId: card.id, operationIds: card.operationIds })),
    diffs: applied.diffs,
    diagnostics: candidateCompile.diagnostics.map((item) => ({
      code: item.code,
      severity: item.severity,
      stepId: item.stepId,
      fieldPath: item.fieldPath,
      message: item.message,
      baseline: baselineCompile.diagnostics.some((base) => base.code === item.code && base.stepId === item.stepId),
    })),
    executable: candidateOk,
    validation: {
      schema: 'passed',
      expansion: 'passed',
      compiler: candidateOk ? 'passed' : 'baseline_errors',
    },
    source: 'acceptance',
    cards,
    ...(parsedUnsupported && parsedUnsupported.length > 0 ? { unsupported: parsedUnsupported } : {}),
    ...(parsedIntentsForPanel && parsedIntentsForPanel.length > 0 ? { parsedIntents: parsedIntentsForPanel } : {}),
  }
  return proposal
}
