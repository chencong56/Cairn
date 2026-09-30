import { deterministicStepId } from '@cairn/authoring'
import {
  acceptanceIntentNeedsTarget,
  acceptanceIntentRequestSchema,
  type AcceptanceIntentKind,
  type AcceptanceIntentRequest,
  type AcceptanceProposalCard,
  type AssistantAuthoringProposal,
  type AuthoringOperation,
  type OutcomeVerdict,
  type RunDetailDto,
  type TargetDescriptor,
  type TableReadPlan,
  type TableExpectRule,
} from '@cairn/shared'

export type AcceptanceIntentMeta = {
  label: string
  description: string
  needsTarget: boolean
  /** 能否选异常/警告；取值进报告只记录，不判定。 */
  judged: boolean
}

export const ACCEPTANCE_INTENT_META: Record<AcceptanceIntentKind, AcceptanceIntentMeta> = {
  table_acceptance: { label: '表格验收', description: '解析页面表格结构，并按行数与单元格规则验收', needsTarget: true, judged: true },
  table_non_empty: { label: '列表非空', description: '这一步之后的列表或表格有数据，并统计行数', needsTarget: true, judged: true },
  page_reachable: { label: '页面可达', description: '这一步之后页面能正常打开', needsTarget: true, judged: true },
  page_duration: { label: '页面耗时', description: '这一步耗时不超过上限，并把耗时放进报告', needsTarget: false, judged: true },
  scenario_duration: { label: '全程耗时', description: '场景全程执行耗时不超过上限，并把耗时放进报告', needsTarget: false, judged: true },
  number_range: { label: '数值在范围', description: '这一步之后页面上的某个数值满足比较', needsTarget: true, judged: true },
  text_present_or_absent: { label: '文字出现 / 不出现', description: '这一步之后整页出现或不出现某段文字', needsTarget: false, judged: true },
  extract_to_report: { label: '取值进报告', description: '把这一步之后页面上的某个值放进报告', needsTarget: true, judged: false },
  value_consistency: { label: '跨页对账', description: '比较两个步骤产出的数值差额在容差范围内', needsTarget: false, judged: true },
}

export const ACCEPTANCE_INTENT_ORDER: AcceptanceIntentKind[] = [
  'table_acceptance',
  'table_non_empty',
  'page_reachable',
  'page_duration',
  'scenario_duration',
  'text_present_or_absent',
  'number_range',
  'extract_to_report',
  'value_consistency',
]

/** 面板里正在编辑的一张意图卡；数值类字段先按文本收，提交时再校验。 */
export type IntentDraft = {
  key: string
  kind: AcceptanceIntentKind
  stepId?: string
  stepIdA?: string
  stepIdB?: string
  severity: 'MUST' | 'SHOULD'
  target?: TargetDescriptor
  maxMs?: string
  text?: string
  absent?: boolean
  op?: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
  value?: string
  metricName?: string
  unit?: string
  tolerance?: string
  tablePlan?: TableReadPlan
  rules?: TableExpectRule[]
  tableEvidenceId?: string
}

export function newIntentDraft(kind: AcceptanceIntentKind, stepId: string, key: string): IntentDraft {
  return {
    key,
    kind,
    stepId: kind === 'scenario_duration' ? undefined : stepId,
    severity: ACCEPTANCE_INTENT_META[kind].judged ? (kind === 'scenario_duration' ? 'SHOULD' : 'MUST') : 'SHOULD',
    ...(kind === 'page_duration' ? { maxMs: '3000' } : {}),
    ...(kind === 'scenario_duration' ? { maxMs: '60000' } : {}),
    ...(kind === 'text_present_or_absent' ? { text: '', absent: false } : {}),
    ...(kind === 'number_range' ? { op: 'gte' as const, value: '' } : {}),
    ...(kind === 'extract_to_report' ? { metricName: '' } : {}),
    ...(kind === 'value_consistency' ? { stepIdA: stepId, stepIdB: '', tolerance: '0', metricName: '' } : {}),
    ...(kind === 'table_acceptance' ? {
      metricName: '数据表',
      rules: [{ rule: 'row_count', op: 'gte', value: 1 }],
    } : {}),
  }
}

/** 把草稿转成请求；缺参数时给出一句能直接显示的提示。 */
export function toIntentRequest(draft: IntentDraft): { ok: true; value: AcceptanceIntentRequest } | { ok: false; message: string } {
  const common = { key: draft.key, severity: draft.severity }
  const metricName = draft.metricName?.trim() || undefined
  const target = draft.target ? { target: draft.target } : {}
  let candidate: unknown
  switch (draft.kind) {
    case 'page_reachable':
      if (!draft.stepId) return { ok: false, message: '请选择步骤' }
      candidate = { ...common, stepId: draft.stepId, kind: draft.kind, ...target }
      break
    case 'table_acceptance':
      if (!draft.stepId) return { ok: false, message: '请选择步骤' }
      candidate = {
        ...common,
        stepId: draft.stepId,
        kind: draft.kind,
        ...target,
        ...(metricName ? { metricName } : {}),
        ...(draft.tablePlan ? { tablePlan: draft.tablePlan } : {}),
        ...(draft.rules && draft.rules.length > 0 ? { rules: draft.rules } : {}),
      }
      break
    case 'page_duration': {
      if (!draft.stepId) return { ok: false, message: '请选择步骤' }
      const maxMs = Number(draft.maxMs)
      if (!Number.isInteger(maxMs) || maxMs < 100) return { ok: false, message: '耗时上限请填不小于 100 的整数毫秒' }
      candidate = { ...common, stepId: draft.stepId, kind: draft.kind, maxMs }
      break
    }
    case 'scenario_duration': {
      const maxMs = Number(draft.maxMs)
      if (!Number.isInteger(maxMs) || maxMs < 100) return { ok: false, message: '耗时上限请填不小于 100 的整数毫秒' }
      candidate = { ...common, kind: draft.kind, maxMs }
      break
    }
    case 'table_non_empty':
      if (!draft.stepId) return { ok: false, message: '请选择步骤' }
      candidate = { ...common, stepId: draft.stepId, kind: draft.kind, ...target, ...(metricName ? { metricName } : {}) }
      break
    case 'number_range': {
      if (!draft.stepId) return { ok: false, message: '请选择步骤' }
      const value = Number(draft.value)
      if (draft.value === undefined || draft.value.trim() === '' || !Number.isFinite(value)) {
        return { ok: false, message: '请填写要比较的数值' }
      }
      candidate = { ...common, stepId: draft.stepId, kind: draft.kind, ...target, op: draft.op ?? 'gte', value, ...(metricName ? { metricName } : {}) }
      break
    }
    case 'text_present_or_absent':
      if (!draft.stepId) return { ok: false, message: '请选择步骤' }
      if (!draft.text?.trim()) return { ok: false, message: '请填写要检查的文字' }
      candidate = { ...common, stepId: draft.stepId, kind: draft.kind, text: draft.text.trim(), absent: Boolean(draft.absent) }
      break
    case 'extract_to_report':
      if (!draft.stepId) return { ok: false, message: '请选择步骤' }
      if (!metricName) return { ok: false, message: '请填写报告里的指标名' }
      candidate = { ...common, stepId: draft.stepId, kind: draft.kind, ...target, metricName, ...(draft.unit?.trim() ? { unit: draft.unit.trim() } : {}) }
      break
    case 'value_consistency': {
      if (!draft.stepIdA || !draft.stepIdB) return { ok: false, message: '请选择要比对的两个步骤' }
      if (draft.stepIdA === draft.stepIdB) return { ok: false, message: '比对的两个步骤不能相同' }
      const tolerance = draft.tolerance !== undefined && draft.tolerance.trim() !== '' ? Number(draft.tolerance) : 0
      if (!Number.isFinite(tolerance) || tolerance < 0) return { ok: false, message: '容差必须是非负数值' }
      candidate = {
        ...common,
        kind: draft.kind,
        stepIdA: draft.stepIdA,
        stepIdB: draft.stepIdB,
        tolerance,
        ...(metricName ? { metricName } : {}),
      }
      break
    }
  }
  const parsed = acceptanceIntentRequestSchema.safeParse(candidate)
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, message: '参数不完整，请检查这张意图卡' }
}

/** 卡片在面板上的可变状态：实测结果与用户改过的严重度、勾选。 */
export type CardUiState = {
  testResult: AcceptanceProposalCard['testResult']
  severity: AcceptanceProposalCard['severity']
  selected: boolean
}

export function initialCardState(card: AcceptanceProposalCard): CardUiState {
  const state = { testResult: card.testResult, severity: card.severity, selected: false }
  return { ...state, selected: cardCanAdopt(card, state) }
}

/** 需要页面对象的卡必须实测命中才可采纳；列表类允许「多项匹配」。 */
export function cardCanAdopt(card: AcceptanceProposalCard, state: Pick<CardUiState, 'testResult'>): boolean {
  if (card.blockedReason || card.operationIds.length === 0) return false
  if (state.testResult === 'NOT_REQUIRED' || state.testResult === 'FOUND') return true
  return Boolean(card.expectsMany && state.testResult === 'AMBIGUOUS')
}

export function cardNeedsLiveTest(card: AcceptanceProposalCard): boolean {
  return !card.blockedReason && Boolean(card.target) && card.testResult !== 'NOT_REQUIRED'
}

/** 合并结论模板：保留原有模板，追加尚未出现的片段。 */
export function composeSummaryTemplate(existing: string | undefined, snippets: string[]): string | undefined {
  const base = existing?.trim() ?? ''
  const additions = snippets.map((item) => item.trim()).filter((item) => item && !base.includes(item))
  if (additions.length === 0) return undefined
  return [base, ...additions].filter(Boolean).join('；').slice(0, 500)
}

/**
 * 按勾选的卡组装一份可直接走 Studio 采纳链路的提案：只带这些卡的操作，
 * 套用面板上改过的严重度，并追加一条结论模板操作。
 */
export function buildAdoptionProposal(input: {
  proposal: AssistantAuthoringProposal
  states: Record<string, CardUiState>
  existingSummaryTemplate?: string
  summaryOperationId: string
}): AssistantAuthoringProposal | null {
  const cards = (input.proposal.cards ?? []).filter((card) => {
    const state = input.states[card.id]
    return state?.selected && cardCanAdopt(card, state)
  })
  if (cards.length === 0) return null
  const severityByOp = new Map<string, CardUiState['severity']>()
  for (const card of cards) for (const opId of card.operationIds) severityByOp.set(opId, input.states[card.id]!.severity)
  const operations: AuthoringOperation[] = input.proposal.operations
    .filter((op) => severityByOp.has(op.id))
    .map((op) => (op.kind === 'add_outcome' ? { ...op, severity: severityByOp.get(op.id)!, onViolation: 'continue' as const } : op))
  const summaryTemplate = composeSummaryTemplate(
    input.existingSummaryTemplate,
    cards.flatMap((card) => (card.summarySnippet ? [card.summarySnippet] : [])),
  )
  if (summaryTemplate) {
    operations.push({ kind: 'set_outputs', id: input.summaryOperationId, mode: 'merge', summaryTemplate })
  }
  return {
    ...input.proposal,
    operations,
    cards: cards.map((card) => ({ ...card, severity: input.states[card.id]!.severity, testResult: input.states[card.id]!.testResult })),
    intentCoverage: input.proposal.intentCoverage.filter((item) => cards.some((card) => card.id === item.intentId)),
    diffs: input.proposal.diffs,
  }
}

/** 采纳后该卡落成的成功条件 id，与编写层 add_outcome 的写法一致。 */
export function cardContractIds(card: AcceptanceProposalCard, proposal: AssistantAuthoringProposal): string[] {
  return proposal.operations
    .filter((op): op is Extract<AuthoringOperation, { kind: 'add_outcome' }> => op.kind === 'add_outcome' && card.operationIds.includes(op.id))
    .map((op) => deterministicStepId(op.stepId ?? 'scenario', op.id, 'outcome'))
}

export type CardVerification =
  | { status: 'pending' }
  | { status: 'evaluated'; verdict: OutcomeVerdict; actual?: unknown }
  | { status: 'not_evaluated' }
  | { status: 'report_only'; value?: unknown }

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'NEEDS_REVIEW'])

/** 复跑结果对回卡片：判定类看成功条件结论，取值类看报告指标。 */
export function cardVerification(
  card: AcceptanceProposalCard,
  proposal: AssistantAuthoringProposal,
  run: RunDetailDto | undefined,
): CardVerification {
  if (!run || !TERMINAL.has(run.status)) return { status: 'pending' }
  const contractIds = cardContractIds(card, proposal)
  if (contractIds.length === 0) {
    const key = card.config?.metric?.key
    return { status: 'report_only', value: key ? run.output?.metrics?.[key] : undefined }
  }
  const results = run.outcomeResults.filter((item) => contractIds.includes(item.contractId))
  if (results.length === 0) return { status: 'not_evaluated' }
  const last = results[results.length - 1]!
  const verdict: OutcomeVerdict = results.some((item) => item.verdict === 'FAIL')
    ? 'FAIL'
    : results.some((item) => item.verdict === 'UNKNOWN')
      ? 'UNKNOWN'
      : results.some((item) => item.verdict === 'WARN')
        ? 'WARN'
        : 'PASS'
  return { status: 'evaluated', verdict, actual: last.actual ?? undefined }
}

export function nextStepId(stepIds: string[], stepId: string): string | undefined {
  const index = stepIds.indexOf(stepId)
  return index >= 0 ? stepIds[index + 1] : undefined
}

export function intentNeedsTarget(kind: AcceptanceIntentKind): boolean {
  return acceptanceIntentNeedsTarget(kind)
}
