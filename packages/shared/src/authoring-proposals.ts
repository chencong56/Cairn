import { z } from 'zod'
import { entityIdSchema, utcInstantSchema, jsonValueSchema, timeoutMsSchema } from './wire.js'
import {
  outcomeContractSchema,
  outcomeRuleSchema,
  outcomeScopeSchema,
  outcomeSeveritySchema,
  outcomeOnViolationSchema,
  type OutcomeContract,
  type OutcomeScope,
  type OutcomeSeverity,
  type OutcomeOnViolation,
} from './outcome.js'
import {
  scenarioMetricDeclSchema,
  scenarioOutputDeclSchema,
  type ScenarioMetricDecl,
  type ScenarioOutputDecl,
} from './run-output.js'
import { targetDescriptorSchema, type TargetDescriptor } from './target-descriptor.js'
import {
  contextKeySchema,
  effectTypeSchema,
  executableStepTypeSchema,
  scenarioInputTypeSchema,
  stepSchema,
  type EffectType,
  type ScenarioInputType,
  type Step,
  type ExecutableStepType,
} from './step.js'
import { authoringNodeSchema, type AuthoringNode } from './authoring-document.js'
import { compileDiagnosticSchema, type CompileDiagnostic } from './scenario.js'
import { dataBindingSchema, type DataBinding } from './dataset.js'
import { tableReadPlanSchema, tableExpectRuleSchema, type TableReadPlan } from './table-acceptance.js'

export const digestHexSchema = z.string().regex(/^[a-f0-9]{64}$/, '摘要须为 64 位十六进制 SHA-256')

// ---------------------------------------------------------------------------
// C0: Assistant Authoring Proposal & Operations (Structured Draft Editing)
// ---------------------------------------------------------------------------

export const AUTHORING_ALLOWED_STEP_TYPES = [
  'navigate',
  'click',
  'fill',
  'extract',
  'assert',
  'select',
  'keyboard',
  'wait',
  'ai_action',
  'ai_extract',
  'ai_assert',
  'compute',
  // 验收提案会生成只读的上下文判定步骤（表格验收等）；不放开有副作用的系统步骤。
  'check_context',
] as const
export type AuthoringAllowedStepType = (typeof AUTHORING_ALLOWED_STEP_TYPES)[number]
export const authoringAllowedStepTypeSchema = z.enum(AUTHORING_ALLOWED_STEP_TYPES)

export function isAuthoringAllowedStepType(type: string): type is AuthoringAllowedStepType {
  return (AUTHORING_ALLOWED_STEP_TYPES as readonly string[]).includes(type)
}

export const AUTHORING_STEP_FIELD_POLICIES: Record<
  AuthoringAllowedStepType,
  {
    allowedInputKeys: readonly string[]
    allowsOutputKey: boolean
  }
> = {
  navigate: {
    allowedInputKeys: ['url'],
    allowsOutputKey: false,
  },
  click: {
    allowedInputKeys: ['target'],
    allowsOutputKey: false,
  },
  select: {
    allowedInputKeys: ['target', 'value', 'label'],
    allowsOutputKey: false,
  },
  keyboard: {
    allowedInputKeys: ['target', 'key'],
    allowsOutputKey: false,
  },
  wait: {
    allowedInputKeys: ['target', 'condition', 'timeoutMs', 'kind', 'durationMs', 'urlPattern', 'text'],
    allowsOutputKey: false,
  },
  fill: {
    allowedInputKeys: ['target', 'from', 'fromField', 'value', 'sensitive'],
    allowsOutputKey: false,
  },
  extract: {
    allowedInputKeys: ['target', 'as', 'attribute', 'many', 'table'],
    allowsOutputKey: true,
  },
  assert: {
    allowedInputKeys: ['target', 'expect'],
    allowsOutputKey: false,
  },
  ai_action: {
    allowedInputKeys: ['instruction'],
    allowsOutputKey: false,
  },
  ai_extract: {
    allowedInputKeys: ['instruction', 'outputSchema', 'schema'],
    allowsOutputKey: true,
  },
  ai_assert: {
    allowedInputKeys: ['instruction'],
    allowsOutputKey: false,
  },
  compute: {
    allowedInputKeys: ['expression'],
    allowsOutputKey: true,
  },
  check_context: {
    allowedInputKeys: ['key', 'field', 'expect'],
    allowsOutputKey: false,
  },
}

export const authoringInsertStepOperationSchema = z.strictObject({
  kind: z.literal('insert_step'),
  id: z.string().min(1).max(128),
  step: stepSchema,
  parentBlockId: entityIdSchema.optional(),
  branchKey: z.enum(['then', 'else', 'body']).optional(),
  anchorStepId: z.string().min(1).max(128).nullable().optional(),
})
export type AuthoringInsertStepOperation = z.infer<typeof authoringInsertStepOperationSchema>

export const authoringUpdateStepOperationSchema = z.strictObject({
  kind: z.literal('update_step'),
  id: z.string().min(1).max(128),
  stepId: entityIdSchema,
  patch: z.strictObject({
    name: z.string().trim().min(1).max(128).optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    outputKey: contextKeySchema.optional(),
  }),
})
export type AuthoringUpdateStepOperation = z.infer<typeof authoringUpdateStepOperationSchema>

export const authoringRemoveStepOperationSchema = z.strictObject({
  kind: z.literal('remove_step'),
  id: z.string().min(1).max(128),
  stepId: entityIdSchema,
})
export type AuthoringRemoveStepOperation = z.infer<typeof authoringRemoveStepOperationSchema>

export const authoringMoveStepOperationSchema = z.strictObject({
  kind: z.literal('move_step'),
  id: z.string().min(1).max(128),
  stepId: entityIdSchema,
  parentBlockId: entityIdSchema.optional(),
  branchKey: z.enum(['then', 'else', 'body']).optional(),
  anchorStepId: z.string().min(1).max(128).nullable().optional(),
})
export type AuthoringMoveStepOperation = z.infer<typeof authoringMoveStepOperationSchema>

export const authoringSetStepPolicyOperationSchema = z.strictObject({
  kind: z.literal('set_step_policy'),
  id: z.string().min(1).max(128),
  stepId: entityIdSchema,
  timeoutMs: timeoutMsSchema.optional(),
  retryLimit: z.number().int().min(0).max(10).optional(),
})
export type AuthoringSetStepPolicyOperation = z.infer<typeof authoringSetStepPolicyOperationSchema>

export const authoringAddOutcomeOperationSchema = z.strictObject({
  kind: z.literal('add_outcome'),
  id: z.string().min(1).max(128),
  stepId: entityIdSchema.optional(),
  meaning: z.string().min(1).max(512),
  rule: outcomeRuleSchema,
  severity: outcomeSeveritySchema.default('SHOULD'),
  onViolation: outcomeOnViolationSchema.default('continue'),
  /** 条件来源：验收提案生成记为 ai_compiled，人工编写入口记为 manual；缺省沿用 generalized。 */
  provenance: z.enum(['generalized', 'ai_compiled', 'manual']).optional(),
})
export type AuthoringAddOutcomeOperation = z.infer<typeof authoringAddOutcomeOperationSchema>

export const authoringUpdateOutcomeOperationSchema = z
  .strictObject({
    kind: z.literal('update_outcome'),
    id: z.string().min(1).max(128),
    contractId: entityIdSchema,
    patch: z
      .strictObject({
        meaning: z.string().trim().min(1).max(512).optional(),
        severity: outcomeSeveritySchema.optional(),
        onViolation: outcomeOnViolationSchema.optional(),
        rule: outcomeRuleSchema.optional(),
      })
      .refine(
        (patch) =>
          patch.meaning !== undefined ||
          patch.severity !== undefined ||
          patch.onViolation !== undefined ||
          patch.rule !== undefined,
        { message: 'update_outcome 的 patch 至少需要提供一个修改项' },
      ),
  })
  .superRefine((op, ctx) => {
    if (op.patch.rule?.kind === 'run_duration' && op.patch.onViolation === 'halt') {
      ctx.addIssue({
        code: 'custom',
        path: ['patch', 'onViolation'],
        message: '运行耗时条件不允许配置 halt',
      })
    }
    if (
      (op.patch.severity === 'SHOULD' || op.patch.severity === 'INFO') &&
      op.patch.onViolation === 'halt'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['patch', 'onViolation'],
        message: 'SHOULD 或 INFO 级别的条件不允许配置 halt',
      })
    }
  })
export type AuthoringUpdateOutcomeOperation = z.infer<typeof authoringUpdateOutcomeOperationSchema>

export const authoringSetOutputsOperationSchema = z.strictObject({
  kind: z.literal('set_outputs'),
  id: z.string().min(1).max(128),
  summaryTemplate: z.string().trim().max(500).optional(),
  metrics: z.array(scenarioMetricDeclSchema).max(20).optional(),
  mode: z.enum(['merge', 'replace']).default('merge'),
})
export type AuthoringSetOutputsOperation = z.infer<typeof authoringSetOutputsOperationSchema>

export const authoringOperationSchema = z.discriminatedUnion('kind', [
  authoringInsertStepOperationSchema,
  authoringUpdateStepOperationSchema,
  authoringRemoveStepOperationSchema,
  authoringMoveStepOperationSchema,
  authoringSetStepPolicyOperationSchema,
  authoringAddOutcomeOperationSchema,
  authoringUpdateOutcomeOperationSchema,
  authoringSetOutputsOperationSchema,
])
export type AuthoringOperation = z.infer<typeof authoringOperationSchema>

export const authoringDiffAddSchema = z.strictObject({
  type: z.literal('add'),
  stepId: entityIdSchema,
  stepName: z.string().min(1).max(128),
  stepType: executableStepTypeSchema,
  parentBlockId: entityIdSchema.optional(),
  branchKey: z.enum(['then', 'else', 'body']).optional(),
  index: z.number().int().nonnegative(),
  detail: z.string().max(512).optional(),
  riskLevel: effectTypeSchema.optional(),
})
export type AuthoringDiffAdd = z.infer<typeof authoringDiffAddSchema>

export const authoringDiffRemoveSchema = z.strictObject({
  type: z.literal('remove'),
  stepId: entityIdSchema,
  stepName: z.string().min(1).max(128),
  stepType: executableStepTypeSchema,
  parentBlockId: entityIdSchema.optional(),
  branchKey: z.enum(['then', 'else', 'body']).optional(),
  index: z.number().int().nonnegative(),
  detail: z.string().max(512).optional(),
  riskLevel: effectTypeSchema.optional(),
})
export type AuthoringDiffRemove = z.infer<typeof authoringDiffRemoveSchema>

export const authoringDiffModifySchema = z.strictObject({
  type: z.literal('modify'),
  stepId: entityIdSchema,
  stepName: z.string().min(1).max(128),
  stepType: executableStepTypeSchema,
  fieldPath: z.array(z.string().min(1)).max(8),
  from: z.unknown().optional(),
  to: z.unknown().optional(),
  sensitive: z.boolean().optional(),
})
export type AuthoringDiffModify = z.infer<typeof authoringDiffModifySchema>

export const authoringDiffMoveSchema = z.strictObject({
  type: z.literal('move'),
  stepId: entityIdSchema,
  stepName: z.string().min(1).max(128),
  stepType: executableStepTypeSchema,
  parentBlockId: entityIdSchema.optional(),
  branchKey: z.enum(['then', 'else', 'body']).optional(),
  fromIndex: z.number().int().nonnegative(),
  toIndex: z.number().int().nonnegative(),
  detail: z.string().max(512).optional(),
})
export type AuthoringDiffMove = z.infer<typeof authoringDiffMoveSchema>

export const authoringDiffOutcomeAddSchema = z.strictObject({
  type: z.literal('outcome_add'),
  stepId: entityIdSchema.optional(),
  stepName: z.string().min(1).max(128).optional(),
  contractId: entityIdSchema,
  meaning: z.string().min(1).max(512),
  ruleKind: z.enum(['deterministic', 'ai', 'context', 'step_duration', 'run_duration', 'table', 'page_request']),
  severity: outcomeSeveritySchema,
  onViolation: outcomeOnViolationSchema,
  scope: outcomeScopeSchema.optional(),
  detail: z.string().max(512).optional(),
})
export type AuthoringDiffOutcomeAdd = z.infer<typeof authoringDiffOutcomeAddSchema>

export const authoringDiffOutcomeUpdateSchema = z.strictObject({
  type: z.literal('outcome_update'),
  contractId: entityIdSchema,
  meaning: z.string().min(1).max(512),
  ruleKind: z.enum(['deterministic', 'ai', 'context', 'step_duration', 'run_duration', 'table', 'page_request']),
  severity: outcomeSeveritySchema,
  onViolation: outcomeOnViolationSchema,
  scope: outcomeScopeSchema.optional(),
  detail: z.string().max(512).optional(),
  stepId: entityIdSchema.optional(),
  stepName: z.string().min(1).max(128).optional(),
  before: z.record(z.string(), jsonValueSchema).optional(),
  after: z.record(z.string(), jsonValueSchema).optional(),
})
export type AuthoringDiffOutcomeUpdate = z.infer<typeof authoringDiffOutcomeUpdateSchema>

export const authoringDiffOutputsChangeSchema = z.strictObject({
  type: z.literal('outputs_change'),
  summaryTemplate: z
    .strictObject({
      from: z.string().optional(),
      to: z.string().optional(),
    })
    .optional(),
  metricsAdded: z.array(scenarioMetricDeclSchema).optional(),
  metricsRemoved: z.array(scenarioMetricDeclSchema).optional(),
  metricsUpdated: z
    .array(
      z.strictObject({
        key: z.string(),
        from: scenarioMetricDeclSchema,
        to: scenarioMetricDeclSchema,
      }),
    )
    .optional(),
  detail: z.string().max(512).optional(),
})
export type AuthoringDiffOutputsChange = z.infer<typeof authoringDiffOutputsChangeSchema>

export const authoringDiffSchema = z.discriminatedUnion('type', [
  authoringDiffAddSchema,
  authoringDiffRemoveSchema,
  authoringDiffModifySchema,
  authoringDiffMoveSchema,
  authoringDiffOutcomeAddSchema,
  authoringDiffOutcomeUpdateSchema,
  authoringDiffOutputsChangeSchema,
])
export type AuthoringDiff = z.infer<typeof authoringDiffSchema>

export const authoringIntentCoverageItemSchema = z.strictObject({
  intentId: z.string().min(1).max(128),
  operationIds: z.array(z.string().min(1).max(128)),
})
export type AuthoringIntentCoverageItem = z.infer<typeof authoringIntentCoverageItemSchema>

/** 单轮编排操作上限：通用助手按「一次加一两步」设计；验收提案一次可含多张卡，单独放宽。 */
export const AUTHORING_OPERATION_LIMITS = {
  step: { maxOperations: 4, maxInserts: 2 },
  acceptance: { maxOperations: 24, maxInserts: 12 },
} as const

export function authoringOperationLimitsFor(proposal: { source?: 'step' | 'acceptance' }): {
  maxOperations: number
  maxInserts: number
} {
  return AUTHORING_OPERATION_LIMITS[proposal.source === 'acceptance' ? 'acceptance' : 'step']
}

export const ACCEPTANCE_INTENT_KINDS = [
  'page_reachable',
  'page_duration',
  'table_non_empty',
  'table_acceptance',
  'number_range',
  'text_present_or_absent',
  'extract_to_report',
  'scenario_duration',
  'value_consistency',
] as const
export type AcceptanceIntentKind = (typeof ACCEPTANCE_INTENT_KINDS)[number]
export const acceptanceIntentKindSchema = z.enum(ACCEPTANCE_INTENT_KINDS)

/** 需要页面对象定位的意图：没有人工点选时，必须有基线页面结构供模型定位。 */
export const ACCEPTANCE_TARGET_INTENTS = [
  'page_reachable',
  'table_non_empty',
  'table_acceptance',
  'number_range',
  'extract_to_report',
] as const satisfies readonly AcceptanceIntentKind[]

export function acceptanceIntentNeedsTarget(kind: AcceptanceIntentKind): boolean {
  return (ACCEPTANCE_TARGET_INTENTS as readonly string[]).includes(kind)
}

export const MAX_ACCEPTANCE_INTENTS = 6

const acceptanceSeveritySchema = z.enum(['MUST', 'SHOULD'])
const acceptanceMetricNameSchema = z.string().trim().min(1).max(64)

const acceptanceIntentBase = {
  /** 客户端生成的意图键，回显在卡片上，便于把卡片对回意图。 */
  key: z.string().min(1).max(64),
  severity: acceptanceSeveritySchema.default('MUST'),
}

const acceptanceStepIntentBase = {
  ...acceptanceIntentBase,
  /** 在哪一步完成后的页面上检查；耗时意图为被计时的步骤。 */
  stepId: entityIdSchema,
}

/**
 * 一张意图卡的结构化请求。`target` 只来自人工点选；缺省时由模型按基线页面结构定位。
 */
export const acceptanceIntentRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...acceptanceStepIntentBase, kind: z.literal('page_reachable'), target: targetDescriptorSchema.optional() }),
  z.strictObject({
    ...acceptanceStepIntentBase,
    kind: z.literal('page_duration'),
    maxMs: z.number().int().min(100).max(600_000),
  }),
  z.strictObject({
    ...acceptanceStepIntentBase,
    kind: z.literal('table_non_empty'),
    target: targetDescriptorSchema.optional(),
    metricName: acceptanceMetricNameSchema.optional(),
  }),
  z.strictObject({
    ...acceptanceStepIntentBase,
    kind: z.literal('table_acceptance'),
    target: targetDescriptorSchema.optional(),
    tablePlan: tableReadPlanSchema.optional(),
    rules: z.array(tableExpectRuleSchema).min(1).max(10).optional(),
    metricName: acceptanceMetricNameSchema.optional(),
  }),
  z.strictObject({
    ...acceptanceStepIntentBase,
    kind: z.literal('number_range'),
    target: targetDescriptorSchema.optional(),
    op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte']),
    value: z.number().finite(),
    metricName: acceptanceMetricNameSchema.optional(),
  }),
  z.strictObject({
    ...acceptanceStepIntentBase,
    kind: z.literal('text_present_or_absent'),
    text: z.string().trim().min(1).max(256),
    absent: z.boolean(),
  }),
  z.strictObject({
    ...acceptanceStepIntentBase,
    kind: z.literal('extract_to_report'),
    target: targetDescriptorSchema.optional(),
    metricName: acceptanceMetricNameSchema,
    unit: z.string().trim().max(16).optional(),
  }),
  z.strictObject({
    ...acceptanceIntentBase,
    kind: z.literal('scenario_duration'),
    maxMs: z.number().int().min(100).max(600_000),
  }),
  z.strictObject({
    ...acceptanceIntentBase,
    kind: z.literal('value_consistency'),
    stepIdA: entityIdSchema,
    stepIdB: entityIdSchema,
    tolerance: z.number().finite().nonnegative().optional(),
    metricName: acceptanceMetricNameSchema.optional(),
  }),
])
export type AcceptanceIntentRequest = z.infer<typeof acceptanceIntentRequestSchema>

export const acceptanceRequestSchema = z
  .strictObject({
    /** 基线调试运行；带结构采集，助手据此定位。 */
    baselineRunId: entityIdSchema.optional(),
    intents: z.array(acceptanceIntentRequestSchema).max(MAX_ACCEPTANCE_INTENTS).default([]),
    description: z.string().trim().max(500).optional(),
  })
  .superRefine((val, ctx) => {
    const hasIntents = val.intents.length > 0
    const hasDescription = val.description !== undefined && val.description.trim().length > 0
    if (!hasIntents && !hasDescription) {
      ctx.addIssue({
        code: 'custom',
        message: '验收请求必须提供 intents 列表或 description 描述之一',
      })
    }
  })
export type AcceptanceRequest = z.infer<typeof acceptanceRequestSchema>

export const ACCEPTANCE_CARD_TEST_RESULTS = [
  'FOUND',
  'AMBIGUOUS',
  'NOT_FOUND',
  'SURFACE_LOST',
  'UNTESTED',
  'PASSED',
  'VIOLATED',
  'FACTS_UNAVAILABLE',
  /** 不涉及页面对象（如耗时），无需实测。 */
  'NOT_REQUIRED',
] as const
export type AcceptanceCardTestResult = (typeof ACCEPTANCE_CARD_TEST_RESULTS)[number]
export const acceptanceCardTestResultSchema = z.enum(ACCEPTANCE_CARD_TEST_RESULTS)

export const ACCEPTANCE_CARD_BLOCK_REASONS = [
  'STEP_NOT_FOUND',
  'STEP_NOT_EDITABLE',
  'NO_BASELINE_EVIDENCE',
  'NEEDS_MANUAL_PICK',
  'MODEL_NO_TARGET',
  'MODEL_TARGET_UNGROUNDED',
  'VALUE_SOURCE_MISSING',
] as const
export type AcceptanceCardBlockReason = (typeof ACCEPTANCE_CARD_BLOCK_REASONS)[number]

export const acceptanceProposalCardSchema = z.strictObject({
  id: z.string().min(1).max(128),
  /** 对应请求里的意图键。 */
  intentKey: z.string().min(1).max(64).optional(),
  intentKind: acceptanceIntentKindSchema,
  meaning: z.string().min(1).max(512),
  stepId: entityIdSchema.optional(),
  /** 依据的基线页面结构证据。 */
  evidenceId: entityIdSchema.optional(),
  testResult: acceptanceCardTestResultSchema.default('UNTESTED'),
  target: targetDescriptorSchema.optional(),
  /** 定位来源：人工点选、模型按基线结构、或由文字直接构成。 */
  targetSource: z.enum(['manual', 'model', 'literal']).optional(),
  /** 列表类目标允许匹配多项，实测「多项匹配」也算通过。 */
  expectsMany: z.boolean().optional(),
  severity: outcomeSeveritySchema.default('SHOULD'),
  onViolation: outcomeOnViolationSchema.default('continue'),
  operationIds: z.array(z.string().min(1).max(128)),
  provenance: z.enum(['ai_compiled', 'manual']).default('ai_compiled'),
  /** 不能采纳的原因；有原因时 operationIds 为空。 */
  blockedReason: z.enum(ACCEPTANCE_CARD_BLOCK_REASONS).optional(),
  blockedMessage: z.string().max(512).optional(),
  /** 拼进报告结论模板的片段，如「今日订单 ${acc_rows_x} 条」。 */
  summarySnippet: z.string().max(200).optional(),
  /** 模型给出的定位理由，供用户判断。 */
  rationale: z.string().max(512).optional(),
  config: z
    .strictObject({
      ruleKind: z.enum(['deterministic', 'ai', 'context', 'step_duration', 'run_duration', 'table', 'page_request']),
      metric: scenarioMetricDeclSchema.optional(),
      summaryTemplateSnippet: z.string().optional(),
      stepName: z.string().optional(),
    })
    .optional(),
})
export type AcceptanceProposalCard = z.infer<typeof acceptanceProposalCardSchema>

export const proposalUnsupportedItemSchema = z.strictObject({
  excerpt: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(256),
})
export type ProposalUnsupportedItem = z.infer<typeof proposalUnsupportedItemSchema>

export const assistantAuthoringProposalSchema = z
  .strictObject({
    kind: z.literal('authoring_proposal'),
    proposalId: entityIdSchema,
    scenarioId: entityIdSchema,
    base: z.strictObject({
      draftRevision: z.number().int().nonnegative(),
      documentDigest: digestHexSchema,
      dependencyFingerprint: z.string().min(1).max(128),
    }),
    operations: z.array(authoringOperationSchema).min(1).max(24),
    candidateDigest: digestHexSchema,
    intentCoverage: z.array(authoringIntentCoverageItemSchema),
    diffs: z.array(authoringDiffSchema),
    diagnostics: z.array(compileDiagnosticSchema),
    executable: z.boolean(),
    validation: z.strictObject({
      schema: z.literal('passed'),
      expansion: z.literal('passed'),
      compiler: z.enum(['passed', 'baseline_errors']),
    }),
    source: z.enum(['step', 'acceptance']).optional().default('step'),
    cards: z.array(acceptanceProposalCardSchema).optional(),
    unsupported: z.array(proposalUnsupportedItemSchema).optional(),
    /** 自由描述拆解出的意图（仅 acceptance 来源填充），供面板回填为可编辑意图卡。 */
    parsedIntents: z.array(acceptanceIntentRequestSchema).optional(),
  })
  .superRefine((val, ctx) => {
    const limits = authoringOperationLimitsFor(val)
    if (val.operations.length > limits.maxOperations) {
      ctx.addIssue({
        code: 'custom',
        path: ['operations'],
        message: `该类助手提案每轮最多支持 ${limits.maxOperations} 项操作`,
      })
    }
  })
export type AssistantAuthoringProposal = z.infer<typeof assistantAuthoringProposalSchema>


// ---------------------------------------------------------------------------
// C1: Authoring Edit Proposal (V2 Scenario / Module)
// ---------------------------------------------------------------------------

export const missingSlotSchema = z.strictObject({
  key: z.string().min(1).max(128),
  label: z.string().min(1).max(128),
  reason: z.string().min(1).max(512),
})
export type MissingSlot = z.infer<typeof missingSlotSchema>

export const authoringEditProposalSchema = z.strictObject({
  proposalId: entityIdSchema,
  scenarioId: entityIdSchema,
  expectedDraftRevision: z.number().int().nonnegative(),
  diffSummary: z.string().max(2048),
  nodes: z.array(authoringNodeSchema),
  missingSlots: z.array(missingSlotSchema).default([]),
  diagnostics: z.array(compileDiagnosticSchema).default([]),
  proposalDigest: digestHexSchema,
  createdAt: utcInstantSchema,
})
export type AuthoringEditProposal = z.infer<typeof authoringEditProposalSchema>

// ---------------------------------------------------------------------------
// C2: Outcome & Output Assist Proposal
// ---------------------------------------------------------------------------

export const outcomeAssistProposalSchema = z.strictObject({
  proposalId: entityIdSchema,
  businessIntent: z.string().min(1).max(2048),
  candidateOutcomes: z.array(outcomeContractSchema).default([]),
  candidateOutputs: z.array(scenarioOutputDeclSchema).default([]),
  uncoveredRequirements: z.array(z.string().max(512)).default([]),
  unsupportedRequirements: z.array(z.string().max(512)).default([]),
  proposalDigest: digestHexSchema,
  createdAt: utcInstantSchema,
})
export type OutcomeAssistProposal = z.infer<typeof outcomeAssistProposalSchema>

// ---------------------------------------------------------------------------
// C3: Demonstration Semantic Proposal (Recording Understanding & Grouping)
// ---------------------------------------------------------------------------

export const demonstrationBusinessGroupSchema = z.strictObject({
  groupId: z.string().min(1).max(128),
  title: z.string().min(1).max(256),
  description: z.string().max(1024).optional(),
  effectType: effectTypeSchema,
  sourceIds: z.array(z.string().min(1).max(128)).min(1),
  targetStepIds: z.array(entityIdSchema).optional(),
})
export type DemonstrationBusinessGroup = z.infer<typeof demonstrationBusinessGroupSchema>

export const demonstrationSemanticSourceMapItemSchema = z.strictObject({
  sourceId: z.string().min(1).max(128),
  groupId: z.string().min(1).max(128),
  disposition: z.enum(['accept', 'replace', 'discard', 'unresolved']),
  reason: z.string().max(256).optional(),
})
export type DemonstrationSemanticSourceMapItem = z.infer<typeof demonstrationSemanticSourceMapItemSchema>

export const demonstrationParamCandidateSchema = z.strictObject({
  sourceId: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
  type: scenarioInputTypeSchema,
  sampleValue: z.string().max(1024),
})
export type DemonstrationParamCandidate = z.infer<typeof demonstrationParamCandidateSchema>

export const demonstrationSemanticProposalSchema = z.strictObject({
  recordingDraftId: entityIdSchema,
  factDigest: digestHexSchema,
  modelProposalDigest: digestHexSchema,
  businessGroups: z.array(demonstrationBusinessGroupSchema),
  sourceMap: z.array(demonstrationSemanticSourceMapItemSchema),
  paramCandidates: z.array(demonstrationParamCandidateSchema).default([]),
  unknownActions: z.array(z.string().min(1).max(128)).default([]),
  createdAt: utcInstantSchema,
})
export type DemonstrationSemanticProposal = z.infer<typeof demonstrationSemanticProposalSchema>

// ---------------------------------------------------------------------------
// C4.1: Dataset Profile & Data Mapping Proposal
// ---------------------------------------------------------------------------

export const datasetColumnProfileSchema = z.strictObject({
  name: z.string().min(1).max(128),
  inferredType: scenarioInputTypeSchema,
  nullCount: z.number().int().nonnegative(),
  nullRate: z.number().min(0).max(1),
  distinctCount: z.number().int().nonnegative(),
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().nonnegative().optional(),
  sampleAnomalies: z.array(z.string().max(512)).default([]),
})
export type DatasetColumnProfile = z.infer<typeof datasetColumnProfileSchema>

export const datasetProfileSchema = z.strictObject({
  datasetId: entityIdSchema,
  totalRows: z.number().int().nonnegative(),
  analyzedRows: z.number().int().nonnegative(),
  isSampled: z.boolean(),
  columns: z.array(datasetColumnProfileSchema),
  algorithmVersion: z.string().min(1).max(64),
  createdAt: utcInstantSchema,
})
export type DatasetProfile = z.infer<typeof datasetProfileSchema>

export const unresolvedInputMappingSchema = z.strictObject({
  inputKey: z.string().min(1).max(128),
  reason: z.string().min(1).max(512),
})
export type UnresolvedInputMapping = z.infer<typeof unresolvedInputMappingSchema>

export const dataMappingProposalSchema = z.strictObject({
  datasetId: entityIdSchema,
  scenarioId: entityIdSchema.optional(),
  binding: dataBindingSchema,
  unresolvedInputs: z.array(unresolvedInputMappingSchema).default([]),
  confidence: z.number().min(0).max(1),
  sampleEvaluations: z.array(
    z.strictObject({
      rowIndex: z.number().int().nonnegative(),
      values: z.record(z.string(), jsonValueSchema),
    }),
  ).default([]),
  createdAt: utcInstantSchema,
})
export type DataMappingProposal = z.infer<typeof dataMappingProposalSchema>

export const SYNC_PREFLIGHT_MAX_ROWS = 2000

// ---------------------------------------------------------------------------
// C5: Acceptance Preview Request / Response Schemas
// ---------------------------------------------------------------------------

export const acceptancePreviewRequestBodySchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  documentDigest: z.string().optional(),
  baselineRunId: entityIdSchema.optional(),
  /** 表格验收意图做现场实测时必填；非表格意图不需要证据。 */
  evidenceId: entityIdSchema.optional(),
  intents: z.array(acceptanceIntentRequestSchema).min(1).max(MAX_ACCEPTANCE_INTENTS),
  plan: tableReadPlanSchema.optional(),
})
export type AcceptancePreviewRequestBody = z.infer<typeof acceptancePreviewRequestBodySchema>

export const acceptancePreviewResponseSchema = z.strictObject({
  proposal: assistantAuthoringProposalSchema,
  operations: z.array(authoringOperationSchema),
  testResult: acceptanceCardTestResultSchema,
  diagnostics: z.array(z.string()).default([]),
  acceptable: z.boolean(),
  evidenceId: entityIdSchema.optional(),
  planDigest: z.string().optional(),
  sampleDigest: z.string().optional(),
  sampledAt: utcInstantSchema.optional(),
  draftRevision: z.number().int().nonnegative(),
})
export type AcceptancePreviewResponse = z.infer<typeof acceptancePreviewResponseSchema>

