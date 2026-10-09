import { z } from 'zod'
import { nextCursorSchema } from './rbac.js'
import { resourceDeletedBySchema } from './resource-lifecycle.js'
import { locatorPlanSchema } from './locator-plan.js'
import { outputFieldNameSchema } from './output-schema.js'
import {
  contextKeySchema,
  FORBIDDEN_CONTEXT_KEYS,
  scenarioInputDeclSchema,
  stepSchema,
  type ScenarioInputDecl,
  type Step,
} from './step.js'
import { entityIdSchema, RUNTIME_SCHEMA_VERSION, runtimeSchemaVersionSchema, utcInstantSchema } from './wire.js'
import { runEvidenceStatusSchema } from './evidence.js'
// 只取类型：run-health 运行时依赖 run.ts，而 run.ts 依赖本文件。
import type { RunHealthBucket } from './run-health.js'
import {
  moduleManifestSchema,
  scenarioAuthoringDocumentV2Schema,
} from './authoring-document.js'

export const SCENARIO_STATUSES = ['active', 'disabled'] as const
export type ScenarioStatus = (typeof SCENARIO_STATUSES)[number]
export const scenarioStatusSchema = z.enum(SCENARIO_STATUSES)

export const SCENARIO_VERSION_KINDS = ['published', 'trial'] as const
export type ScenarioVersionKind = (typeof SCENARIO_VERSION_KINDS)[number]
export const scenarioVersionKindSchema = z.enum(SCENARIO_VERSION_KINDS)

export const SCENARIO_ERROR_CODES = [
  'SCENARIO_NOT_FOUND',
  'SCENARIO_VERSION_NOT_FOUND',
  'SCENARIO_NAME_CONFLICT',
  'SCENARIO_HAS_RUNS',
  'RESOURCE_BUSY',
  'RESOURCE_DELETED',
  'SCENARIO_UNRESOLVED_REF',
  'SCENARIO_DISABLED',
  'SCENARIO_DRAFT_CONFLICT',
  'SCENARIO_COMPILE_BLOCKED',
  'SCENARIO_VERSION_NOT_PUBLISHED',
  'SCENARIO_COPY_UNSUPPORTED',
] as const
export type ScenarioErrorCode = (typeof SCENARIO_ERROR_CODES)[number]

export const MAX_SCENARIO_STEPS = 32
export const MAX_SYSTEM_VERIFICATION_STEPS = 32
export const MAX_COMPILED_SCENARIO_STEPS = 64
export const MAX_SCENARIO_LOOP_BUDGET_STEPS = 2000

export const scenarioNameSchema = z.string().trim().min(1).max(128)

export { scenarioInputDeclSchema, type ScenarioInputDecl }

import {
  scenarioMetricDeclSchema,
  scenarioDataRowFieldDeclSchema,
  scenarioOutputDeclSchema,
  type ScenarioMetricDecl,
  type ScenarioDataRowFieldDecl,
  type ScenarioOutputDecl,
} from './run-output.js'

export {
  scenarioMetricDeclSchema,
  scenarioDataRowFieldDeclSchema,
  scenarioOutputDeclSchema,
  type ScenarioMetricDecl,
  type ScenarioDataRowFieldDecl,
  type ScenarioOutputDecl,
}

function refineScenarioDocument(
  document: {
    inputs: Array<{ key: string }>
    steps: Array<{ id: string; outputKey?: string }>
    outputs?: { metrics?: Array<{ key: string }>; dataRowFields?: Array<{ columnKey: string }> }
  },
  ctx: z.RefinementCtx,
) {
  const inputKeys = new Set<string>()
  for (const [index, input] of document.inputs.entries()) {
    if (inputKeys.has(input.key)) {
      ctx.addIssue({
        code: 'custom',
        path: ['inputs', index, 'key'],
        message: '同一场景内 inputs.key 不能重复',
      })
    }
    inputKeys.add(input.key)
  }
  const stepIds = new Set<string>()
  const outputKeys = new Set<string>()
  for (const [index, step] of document.steps.entries()) {
    if (stepIds.has(step.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['steps', index, 'id'],
        message: '同一场景内 step.id 不能重复',
      })
    }
    stepIds.add(step.id)
    if (step.outputKey) {
      if (outputKeys.has(step.outputKey)) {
        ctx.addIssue({
          code: 'custom',
          path: ['steps', index, 'outputKey'],
          message: '同一场景内 outputKey 不能重复',
        })
      }
      outputKeys.add(step.outputKey)
    }
  }
  if (document.outputs?.metrics) {
    const metricKeys = new Set<string>()
    for (const [index, metric] of document.outputs.metrics.entries()) {
      if (metricKeys.has(metric.key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['outputs', 'metrics', index, 'key'],
          message: '同一场景内 metrics.key 不能重复',
        })
      }
      metricKeys.add(metric.key)
    }
  }
  if (document.outputs?.dataRowFields) {
    const colKeys = new Set<string>()
    for (const [index, field] of document.outputs.dataRowFields.entries()) {
      if (colKeys.has(field.columnKey)) {
        ctx.addIssue({
          code: 'custom',
          path: ['outputs', 'dataRowFields', index, 'columnKey'],
          message: '同一场景内 dataRowFields.columnKey 不能重复',
        })
      }
      colKeys.add(field.columnKey)
    }
  }
}

export const scenarioDocumentSchema = z
  .strictObject({
    schemaVersion: runtimeSchemaVersionSchema,
    inputs: z.array(scenarioInputDeclSchema).max(64).default([]),
    steps: z.array(stepSchema).min(1).max(MAX_SCENARIO_STEPS),
    outputs: scenarioOutputDeclSchema.optional(),
    locatorPlan: locatorPlanSchema.optional(),
  })
  .superRefine((document, ctx) => {
    refineScenarioDocument(document, ctx)
  })
export type ScenarioDocument = z.infer<typeof scenarioDocumentSchema>

export const scenarioDefinitionSchema = z
  .strictObject({
    schemaVersion: runtimeSchemaVersionSchema,
    inputs: z.array(scenarioInputDeclSchema).max(64).default([]),
    steps: z.array(stepSchema).min(1).max(MAX_COMPILED_SCENARIO_STEPS),
    outputs: scenarioOutputDeclSchema.optional(),
    locatorPlan: locatorPlanSchema.optional(),
  })
  .superRefine((document, ctx) => {
    refineScenarioDocument(document, ctx)
  })
export type ScenarioDefinition = z.infer<typeof scenarioDefinitionSchema>

export class ScenarioValidationError extends Error {
  readonly code: ScenarioErrorCode

  constructor(code: ScenarioErrorCode, message: string) {
    super(message)
    this.name = 'ScenarioValidationError'
    this.code = code
  }
}

function contextFrom(step: Step): string[] {
  if (step.type === 'ai_action' && 'operation' in step.input && step.input.operation === 'input') {
    return step.input.from ? [step.input.from] : []
  }
  if (step.type === 'echo' || step.type === 'fill' || step.type === 'select') {
    return step.input.from ? [step.input.from] : []
  }
  if (step.type === 'upload') {
    return step.input.files
      .filter((f): f is Extract<typeof f, { source: 'context' }> => f.source === 'context')
      .map((f) => f.from)
      .filter(Boolean)
  }
  return []
}

/** 保存期：`from` 不得指向本步或更晚步骤的 outputKey。指向未声明的 key 是参数化，放过。 */
export function assertNoForwardFrom(steps: readonly Step[]): void {
  for (const [index, step] of steps.entries()) {
    const froms = contextFrom(step)
    if (froms.length === 0) continue
    const laterOrSelf = new Set(
      steps.slice(index).flatMap((item) => (item.outputKey ? [item.outputKey] : [])),
    )
    for (const from of froms) {
      if (laterOrSelf.has(from)) {
        throw new ScenarioValidationError(
          'SCENARIO_UNRESOLVED_REF',
          `步骤「${step.name}」的 from=${from} 不得指向本步或更晚步骤的 outputKey`,
        )
      }
    }
  }
}

/**
 * 创建 Run 时解析不到的引用：既不在 input 里，也没有更早步骤的 outputKey 供给。
 * 返回键与提出要求的步骤名——调用方要么据此报错，要么把键列给外部调用方。
 */
export function unresolvedRunInputs(
  steps: readonly Step[],
  input: Readonly<Record<string, unknown>>,
): { key: string; stepName: string }[] {
  const available = new Set(Object.keys(input))
  const unresolved: { key: string; stepName: string }[] = []
  for (const step of steps) {
    if (!step.disabled) {
      const froms = contextFrom(step)
      for (const from of froms) {
        if (!available.has(from) && !unresolved.some((item) => item.key === from)) {
          unresolved.push({ key: from, stepName: step.name })
        }
      }
    }
    if (step.outputKey) available.add(step.outputKey)
    if (step.type === 'loop') {
      const loopInput = step.input as any
      if (loopInput?.control?.type === 'for_each') {
        if (loopInput.control.as) available.add(loopInput.control.as)
        if (loopInput.control.indexAs) available.add(loopInput.control.indexAs)
      }
      for (const rule of loopInput?.collect ?? []) {
        if (rule.into) available.add(rule.into)
      }
    }
  }
  return unresolved
}

/** 创建 Run：`from` 必须是 input 键或更早步骤的 outputKey。 */
export function assertRunFromResolved(
  steps: readonly Step[],
  input: Readonly<Record<string, unknown>>,
): void {
  const [first] = unresolvedRunInputs(steps, input)
  if (first) {
    throw new ScenarioValidationError('SCENARIO_UNRESOLVED_REF', unresolvedRunInputMessage(first))
  }
}

/** 建 Run 被拒时人看见的那句话。三条路径共用，改词只改这里。 */
export function unresolvedRunInputMessage(first: { key: string; stepName: string }): string {
  return `步骤「${first.stepName}」的 from=${first.key} 解析不到 input 或更早步骤的 outputKey`
}

/**
 * 正式运行必须提供的 input 键。
 *
 * 声明的 `inputs` 未必覆盖全部 `from`——保存期把「指向未声明 key」当参数化放过，
 * 发布期也不强制声明。只按 `inputs` 渲染表单会让这类场景在控制台里无处填值，
 * 跑到该步才失败。这里与 `assertRunFromResolved` 同源：声明的键，加上被步骤引用
 * 却没有前序 outputKey 供给的键（标签回落为键名）。
 */
export function requiredRunInputKeys(
  definition: Pick<ScenarioDefinition, 'inputs' | 'steps'>,
): ScenarioInputDecl[] {
  const declared = new Map<string, ScenarioInputDecl>()
  for (const input of definition.inputs ?? []) {
    if (!declared.has(input.key)) declared.set(input.key, input)
  }
  const available = new Set(declared.keys())
  const derived: ScenarioInputDecl[] = []
  for (const step of definition.steps) {
    const froms = contextFrom(step)
    for (const from of froms) {
      if (!available.has(from)) {
        available.add(from)
        derived.push({ key: from, label: from })
      }
    }
    if (step.outputKey) available.add(step.outputKey)
  }
  return [...declared.values(), ...derived]
}

export function validateScenarioDocument(document: unknown): ScenarioDocument {
  const parsed = scenarioDocumentSchema.parse(document)
  assertNoForwardFrom(parsed.steps)
  return parsed
}

export function validateScenarioDefinition(definition: unknown): ScenarioDefinition {
  const parsed = scenarioDefinitionSchema.parse(definition)
  assertNoForwardFrom(parsed.steps)
  return parsed
}

export const scenarioLatestRunSchema = z.object({
  id: entityIdSchema,
  status: z.string(),
  outcomeStatus: z.string().nullable().optional(),
  createdAt: utcInstantSchema,
})
export type ScenarioLatestRun = z.infer<typeof scenarioLatestRunSchema>

/** 最近正式运行（已发布版本、未删除）；手动、调度、场景集、批量与服务调用都算，试跑不算。 */
export const scenarioRecentRunSchema = scenarioLatestRunSchema.extend({
  evidenceStatus: runEvidenceStatusSchema,
  /** manual / schedule / service；与 executionOrigin（容器）正交。 */
  triggerSource: z.string().nullable().optional(),
  /** standalone / suite_member / batch_item：经场景集或批量任务发起时提示用。 */
  executionOrigin: z.string().optional(),
})
export type ScenarioRecentRun = z.infer<typeof scenarioRecentRunSchema>

/** 按最新已发布版本算出的运行前提：列表据此决定直接运行还是先补参数、选账号。 */
export const scenarioRunRequirementsSchema = z.object({
  inputs: z.array(scenarioInputDeclSchema).max(64),
  needsAccount: z.boolean(),
})
export type ScenarioRunRequirements = z.infer<typeof scenarioRunRequirementsSchema>

export const scenarioScheduleSummarySchema = z.object({
  id: entityIdSchema,
  name: z.string().nullable().optional(),
  enabled: z.boolean(),
  summary: z.string(),
  nextDueAt: utcInstantSchema.nullable().optional(),
})
export type ScenarioScheduleSummary = z.infer<typeof scenarioScheduleSummarySchema>

export const scenarioSchema = z.object({
  id: entityIdSchema,
  targetId: entityIdSchema,
  name: scenarioNameSchema,
  status: scenarioStatusSchema,
  purpose: z.enum(['user', 'module_verification', 'map_job']).default('user'),
  latestVersionId: entityIdSchema.nullable(),
  latestVersionNo: z.number().int().min(1).nullable(),
  stepCount: z.number().int().min(0).max(MAX_COMPILED_SCENARIO_STEPS),
  draftDirty: z.boolean().default(false),
  /** 场景运行账号；null 表示跟随目标默认。场景级、不随版本。 */
  runAccountId: entityIdSchema.nullable().optional(),
  deletedAt: utcInstantSchema.nullable().optional(),
  deletedBy: resourceDeletedBySchema.nullable().optional(),
  createdByName: z.string().nullable().optional(),
  /** 创建人；已删除或由系统创建时为 null。仅列表返回。 */
  createdBy: z
    .object({ id: entityIdSchema, displayName: z.string(), avatar: z.string().nullable().optional() })
    .nullable()
    .optional(),
  latestRun: scenarioLatestRunSchema.nullable().optional(),
  /** 最近至多 5 次正式运行，旧 → 新；仅列表返回。 */
  recentRuns: z.array(scenarioRecentRunSchema).max(5).optional(),
  /** 最新已发布版本的运行前提；未发布为 null；仅列表返回。 */
  runRequirements: scenarioRunRequirementsSchema.nullable().optional(),
  schedule: scenarioScheduleSummarySchema.nullable().optional(),
  createdAt: utcInstantSchema,
  updatedAt: utcInstantSchema,
})
export type ScenarioDto = z.infer<typeof scenarioSchema>

export const compileDiagnosticSchema = z.object({
  code: z.string().min(1).max(64),
  severity: z.enum(['error', 'warning']),
  message: z.string().min(1).max(512),
  stepId: entityIdSchema.optional(),
  inputKey: contextKeySchema.optional(),
  fieldPath: z.array(z.string().min(1).max(64)).max(8).optional(),
})
export type CompileDiagnostic = z.infer<typeof compileDiagnosticSchema>

export const compileResultSchema = z.object({
  ok: z.boolean(),
  compilerVersion: z.number().int().min(1),
  diagnostics: z.array(compileDiagnosticSchema),
})
export type CompileResultDto = z.infer<typeof compileResultSchema>

export const scenarioDraftDtoSchema = z.object({
  revision: z.number().int().min(1),
  document: z.lazy(() => z.union([scenarioAuthoringDocumentV2Schema, scenarioDocumentSchema])),
  updatedAt: utcInstantSchema,
  updatedBy: z.object({
    id: entityIdSchema,
    displayName: z.string().min(1),
  }),
})
export type ScenarioDraftDto = z.infer<typeof scenarioDraftDtoSchema>

export const scenarioPublishedDtoSchema = z.object({
  versionId: entityIdSchema,
  versionNo: z.number().int().min(1),
  definition: scenarioDefinitionSchema,
  compilerVersion: z.number().int().min(1),
  authoringDocument: z.lazy(() => scenarioAuthoringDocumentV2Schema).optional(),
  moduleManifest: z.lazy(() => moduleManifestSchema).optional(),
  createdAt: utcInstantSchema,
})
export type ScenarioPublishedDto = z.infer<typeof scenarioPublishedDtoSchema>

export const scenarioDetailSchema = scenarioSchema.extend({
  steps: z.array(stepSchema),
  published: scenarioPublishedDtoSchema.optional(),
  draft: scenarioDraftDtoSchema.optional(),
  compile: compileResultSchema.optional(),
})
export type ScenarioDetailDto = z.infer<typeof scenarioDetailSchema>

/** 列表可筛选的健康度；「已取消」只在全部里出现，不单独筛。 */
export const SCENARIO_HEALTH_FILTERS = ['failing', 'warning', 'running', 'passing', 'never'] as const satisfies readonly RunHealthBucket[]
export const scenarioHealthFilterSchema = z.enum(SCENARIO_HEALTH_FILTERS)
export type ScenarioHealthFilter = z.infer<typeof scenarioHealthFilterSchema>

export const SCENARIO_LIST_SORTS = ['created', 'updated'] as const
export type ScenarioListSort = (typeof SCENARIO_LIST_SORTS)[number]

const scenarioListFilterShape = {
  search: z.string().trim().optional(),
  targetId: entityIdSchema.optional(),
  status: scenarioStatusSchema.optional(),
  purpose: z.enum(['user', 'module_verification']).optional(),
  hasDraft: z.coerce.boolean().optional(),
  /** 按最近一次正式运行的健康度筛选；多个值用逗号分隔，取并集。 */
  health: z
    .preprocess(
      (value) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value),
      z.array(scenarioHealthFilterSchema).min(1).max(SCENARIO_HEALTH_FILTERS.length),
    )
    .optional(),
  /** 只看直属定时调度（不含场景集调度）。 */
  schedule: z.enum(['scheduled', 'unscheduled']).optional(),
  /** 创建人（控制台账号 id）。 */
  createdBy: entityIdSchema.optional(),
  /** 创建时间范围：含起点、不含终点；由调用方按自己的时区换算成时刻。 */
  createdFrom: utcInstantSchema.optional(),
  createdTo: utcInstantSchema.optional(),
}

export const scenarioListQuerySchema = z.object({
  ...scenarioListFilterShape,
  sort: z.enum(SCENARIO_LIST_SORTS).default('created'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional(),
})
export type ScenarioListQuery = z.input<typeof scenarioListQuerySchema>

/** 健康度计数：与列表相同的筛选，但不按健康度本身过滤、不分页。 */
export const scenarioSummaryQuerySchema = z.object(scenarioListFilterShape).omit({ health: true })
export type ScenarioSummaryQuery = z.input<typeof scenarioSummaryQuerySchema>

export const scenarioSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  /** 当前筛选（不含创建人本身）下出现过的创建人，供创建人筛选列出可选项。 */
  creators: z
    .array(
      z.object({
        id: entityIdSchema,
        displayName: z.string(),
        avatar: z.string().nullable().optional(),
        count: z.number().int().nonnegative(),
      }),
    )
    .optional(),
  byHealth: z.object({
    failing: z.number().int().nonnegative(),
    warning: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    passing: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
    never: z.number().int().nonnegative(),
  }),
})
export type ScenarioSummaryDto = z.infer<typeof scenarioSummarySchema>

export const scenarioListResponseSchema = z.object({
  items: z.array(scenarioSchema),
  nextCursor: nextCursorSchema,
})
export type ScenarioListResponse = z.infer<typeof scenarioListResponseSchema>

export const scenarioVersionSchema = z.object({
  id: entityIdSchema,
  scenarioId: entityIdSchema,
  versionNo: z.number().int().min(1).nullable(),
  kind: scenarioVersionKindSchema,
  definition: scenarioDefinitionSchema,
  compilerVersion: z.number().int().min(1),
  authoringDocument: z.lazy(() => scenarioAuthoringDocumentV2Schema).optional(),
  moduleManifest: z.lazy(() => moduleManifestSchema).optional(),
  createdAt: utcInstantSchema,
})
export type ScenarioVersionDto = z.infer<typeof scenarioVersionSchema>

export const scenarioVersionListResponseSchema = z.object({
  items: z.array(scenarioVersionSchema),
  nextCursor: nextCursorSchema,
})
export type ScenarioVersionListResponse = z.infer<typeof scenarioVersionListResponseSchema>

export const createScenarioBodySchema = z.strictObject({
  targetId: entityIdSchema,
  name: scenarioNameSchema,
  steps: z.array(stepSchema).min(1).max(MAX_SCENARIO_STEPS),
  inputs: z.array(scenarioInputDeclSchema).max(64).optional(),
  status: scenarioStatusSchema.optional(),
  /** 运行账号；省略或 null 表示跟随目标默认。 */
  runAccountId: entityIdSchema.nullable().optional(),
})
export type CreateScenarioBody = z.infer<typeof createScenarioBodySchema>

const SCENARIO_NAME_MAX = 128
const COPY_SUFFIX = /-copy-(\d+)$/

function fitCopyName(base: string, n: number): string {
  const suffix = `-copy-${n}`
  const chars = Array.from(base)
  while (chars.join('').length + suffix.length > SCENARIO_NAME_MAX) chars.pop()
  return `${chars.join('')}${suffix}`
}

/**
 * 复制场景的新名称：去掉来源名末尾的 `-copy-N`，接上 `-copy-<已用最大序号 + 1>`。
 * existingNames 须包含同一目标系统下的全部场景名（含已删除，唯一约束把它们也算在内）。
 */
export function scenarioCopyName(sourceName: string, existingNames: Iterable<string>): string {
  const base = sourceName.replace(COPY_SUFFIX, '') || sourceName
  const taken = new Set(existingNames)
  let max = 0
  for (const name of taken) {
    const match = COPY_SUFFIX.exec(name)
    if (!match) continue
    const n = Number(match[1])
    if (Number.isSafeInteger(n) && fitCopyName(base, n) === name) max = Math.max(max, n)
  }
  let next = max + 1
  while (taken.has(fitCopyName(base, next))) next += 1
  return fitCopyName(base, next)
}

/** 复制时因操作者缺少对应权限而未带过去的配置。 */
export const SCENARIO_COPY_NOT_COPIED_ITEMS = ['outbound_policy', 'auto_report'] as const
export const copyScenarioResponseSchema = scenarioDetailSchema.extend({
  notCopied: z.array(
    z.strictObject({
      item: z.enum(SCENARIO_COPY_NOT_COPIED_ITEMS),
      reason: z.string().min(1),
    }),
  ),
})
export type CopyScenarioResponse = z.infer<typeof copyScenarioResponseSchema>
export type ScenarioCopyNotCopied = CopyScenarioResponse['notCopied'][number]

export const updateScenarioBodySchema = z
  .strictObject({
    name: scenarioNameSchema.optional(),
    status: scenarioStatusSchema.optional(),
    /** 运行账号；null 表示改回跟随目标默认。 */
    runAccountId: entityIdSchema.nullable().optional(),
  })
  .refine((body) => body.name !== undefined || body.status !== undefined || body.runAccountId !== undefined, {
    message: '至少提供一个要修改的字段',
  })
export type UpdateScenarioBody = z.infer<typeof updateScenarioBodySchema>

export const saveScenarioDraftBodySchema = z.strictObject({
  revision: z.number().int().min(1),
  document: z.lazy(() => z.union([scenarioAuthoringDocumentV2Schema, scenarioDocumentSchema])),
})
export type SaveScenarioDraftBody = z.infer<typeof saveScenarioDraftBodySchema>

export const publishScenarioBodySchema = z.strictObject({
  revision: z.number().int().min(1),
})
export type PublishScenarioBody = z.infer<typeof publishScenarioBodySchema>

export const previewScenarioExpansionBodySchema = z.strictObject({
  document: z.unknown().optional(),
})
export type PreviewScenarioExpansionBody = z.infer<typeof previewScenarioExpansionBodySchema>

export const previewScenarioExpansionResponseSchema = z.strictObject({
  definition: scenarioDefinitionSchema.optional(),
  manifest: z.lazy(() => moduleManifestSchema).optional(),
  diagnostics: z.array(z.any()),
})
export type PreviewScenarioExpansionResponse = z.infer<typeof previewScenarioExpansionResponseSchema>

export const inlineScenarioModuleInvocationBodySchema = z.strictObject({
  expectedDraftLockVersion: z.number().int().min(1),
})
export type InlineScenarioModuleInvocationBody = z.infer<typeof inlineScenarioModuleInvocationBodySchema>

export function scenarioDefinitionFromSteps(
  steps: ScenarioDefinition['steps'],
  inputs: ScenarioDefinition['inputs'] = [],
  outputs?: ScenarioOutputDecl,
): ScenarioDefinition {
  return {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    inputs,
    steps,
    ...(outputs ? { outputs } : {}),
  }
}
