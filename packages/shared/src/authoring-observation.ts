import { z } from 'zod'
import { resolverDiagnosticsSchema } from './browser-command.js'
import { pageRefSchema, type PageRef } from './managed-browser.js'
import { isSensitiveLocatorHay } from './sensitive-fill.js'
import { stepSchema } from './step.js'
import { targetDescriptorSchema } from './target-descriptor.js'
import { entityIdSchema } from './wire.js'
import {
  TABLE_DETECT_MAX_COLS,
  TABLE_FILE_MAX_BYTES,
  tableFilePlanSchema,
  tableSampleSchema,
  tableReadPlanSchema,
  tableReadPlanV2Schema,
  type TableSample,
} from './table-acceptance.js'

export const TARGET_OBSERVATION_OUTCOMES = [
  'FOUND',
  'NOT_FOUND',
  'AMBIGUOUS',
  'SURFACE_LOST',
  'CAPABILITY_MISSING',
] as const
export type TargetObservationOutcome = (typeof TARGET_OBSERVATION_OUTCOMES)[number]
export const targetObservationOutcomeSchema = z.enum(TARGET_OBSERVATION_OUTCOMES)

export const targetAssistSchema = z.strictObject({
  explanation: z.string().max(1024).optional(),
  recommendedRanking: z.array(z.number().int().nonnegative()).optional(),
  suggestedStepName: z.string().max(128).optional(),
})
export type TargetAssist = z.infer<typeof targetAssistSchema>

export const targetObservationPreviewSchema = z.strictObject({
  box: z
    .strictObject({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .optional(),
  tag: z.string().optional(),
  text: z.string().optional(),
  cropObjectKey: z.string().optional(),
})
export type TargetObservationPreview = z.infer<typeof targetObservationPreviewSchema>

export const pickDisambiguationSchema = z.strictObject({
  visibleText: z.string().min(1).max(80),
  accessibleName: z.string().min(1).max(80),
  recommended: z.enum(['visible_text', 'accessible_name']),
})
export type PickDisambiguation = z.infer<typeof pickDisambiguationSchema>

export const targetObservationSchema = z.strictObject({
  outcome: targetObservationOutcomeSchema,
  target: targetDescriptorSchema.optional(),
  page: z.strictObject({
    pageRef: pageRefSchema.optional(),
    url: z.string().optional(),
    title: z.string().optional(),
  }),
  preview: targetObservationPreviewSchema.optional(),
  diagnostics: resolverDiagnosticsSchema,
  source: z.enum(['managed', 'extension']),
  alternatives: z
    .array(
      z.strictObject({
        index: z.number().int().nonnegative(),
        reason: z.string(),
        label: z.string().max(80).optional(),
      }),
    )
    .optional(),
  assist: targetAssistSchema.optional(),
  disambiguation: pickDisambiguationSchema.optional(),
  enclosingTable: targetDescriptorSchema.optional(),
})
export type TargetObservation = z.infer<typeof targetObservationSchema>

export const observeGrantSchema = z.strictObject({
  runId: entityIdSchema,
  sessionGeneration: z.number().int().nonnegative(),
  pageRef: pageRefSchema,
  epoch: z.number().int().nonnegative(),
})
export type ObserveGrant = z.infer<typeof observeGrantSchema>

export const MAX_STRUCTURE_SNAPSHOT_CHARS = 32_000

/** 作用页：省略时为执行当前页；Web 传入正在查看的受管页，保证看的与指认的是同一页。 */
const observePageIdSchema = entityIdSchema.optional()

export const observeTableDiscoverOperationSchema = z.strictObject({
  op: z.literal('table'),
  subOp: z.literal('discover'),
  target: targetDescriptorSchema.optional(),
  pageId: observePageIdSchema,
})
export type ObserveTableDiscoverOperation = z.infer<typeof observeTableDiscoverOperationSchema>

export const observeTableSampleOperationSchema = z.strictObject({
  op: z.literal('table'),
  subOp: z.literal('sample'),
  target: targetDescriptorSchema.optional(),
  plan: tableReadPlanSchema,
  pageId: observePageIdSchema,
})
export type ObserveTableSampleOperation = z.infer<typeof observeTableSampleOperationSchema>

/**
 * 点选识别：用户在受管画面点一下表格里任意位置，Worker 找出整张表并给出建议的读取计划与预览。
 * 点选位置（x / y）与指定表根（rootSelector，用于“范围大一点 / 小一点”）二选一。
 */
export const observeTableDetectOperationSchema = z
  .strictObject({
    op: z.literal('table'),
    subOp: z.literal('detect'),
    x: z.number().optional(),
    y: z.number().optional(),
    rootSelector: z.string().min(1).max(512).optional(),
    framePath: targetDescriptorSchema.shape.framePath.optional(),
    pageId: observePageIdSchema,
  })
  .refine(
    (op) => (op.rootSelector !== undefined) !== (op.x !== undefined && op.y !== undefined),
    { message: '点选识别必须且只能提供点选位置（x / y）或表根（rootSelector）之一' },
  )
export type ObserveTableDetectOperation = z.infer<typeof observeTableDetectOperationSchema>

export const observeTableOperationSchema = z.union([
  observeTableDiscoverOperationSchema,
  observeTableSampleOperationSchema,
  observeTableDetectOperationSchema,
])
export type ObserveTableOperation = z.infer<typeof observeTableOperationSchema>

export const observeOperationSchema = z.union([
  z.strictObject({
    op: z.enum(['highlight', 'pick', 'structure']),
    x: z.number().optional(),
    y: z.number().optional(),
    target: targetDescriptorSchema.optional(),
    applyOverlay: z.boolean().optional(),
    clearOverlayStepId: entityIdSchema.optional(),
    pageId: observePageIdSchema,
  }),
  observeTableOperationSchema,
])
export type ObserveOperation = z.infer<typeof observeOperationSchema>

export const structureObservationSchema = z.strictObject({
  evidenceId: entityIdSchema,
  pageRef: pageRefSchema.optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  snapshot: z.string(),
  truncated: z.boolean(),
})
export type StructureObservation = z.infer<typeof structureObservationSchema>

export const tableDiscoveredItemSchema = z.strictObject({
  index: z.number().int().nonnegative(),
  target: targetDescriptorSchema,
  columns: z.array(
    z.strictObject({
      key: z.string(),
      name: z.string(),
      tag: z.string().optional(),
      /** 依据样本单元格探测的类型建议；供人工确认或修正，不是最终声明。 */
      valueType: z.enum(['text', 'number', 'boolean']).optional(),
      numericKind: z.enum(['integer', 'decimal', 'float']).optional(),
    }),
  ),
  rowCountHint: z.number().int().nonnegative().optional(),
  box: z
    .strictObject({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .optional(),
  readinessClues: z.array(z.string()).optional(),
})
export type TableDiscoveredItem = z.infer<typeof tableDiscoveredItemSchema>

export const tableDiscoveryObservationSchema = z.strictObject({
  outcome: targetObservationOutcomeSchema,
  page: z.strictObject({
    pageRef: pageRefSchema.optional(),
    url: z.string().optional(),
    title: z.string().optional(),
  }),
  tables: z.array(tableDiscoveredItemSchema).max(10),
  source: z.enum(['managed', 'extension']).default('managed'),
})
export type TableDiscoveryObservation = z.infer<typeof tableDiscoveryObservationSchema>

export const tableDetectedColumnSchema = z.strictObject({
  key: z.string(),
  name: z.string(),
  groupPath: z.string().optional(),
  /** 被自动排除的原因：复选框 / 序号 / 操作按钮。 */
  excludedReason: z.enum(['checkbox', 'index', 'action', 'hidden']).optional(),
  /** 依据样本单元格给出的类型建议，供勾回被排除的列或改类型时使用。 */
  valueType: z.enum(['text', 'number', 'boolean', 'date']),
  numericKind: z.enum(['integer', 'decimal']).optional(),
  /** 控件里的列字段名（easyui / jqGrid / layui）。 */
  field: z.string().optional(),
  source: z.enum(['header', 'index']),
  /** DOM 列序号（从 0 起）。 */
  index: z.number().int().nonnegative(),
  /** 表头为空或重名，只能按第几列取。 */
  indexOnly: z.boolean().optional(),
})
export type TableDetectedColumn = z.infer<typeof tableDetectedColumnSchema>

export const tableDetectedSchema = z.strictObject({
  plan: tableReadPlanV2Schema,
  sample: tableSampleSchema,
  title: z.string().optional(),
  selectorQuality: z.enum(['stable', 'positional']),
  rowCount: z.number().int().nonnegative(),
  colCount: z.number().int().nonnegative(),
  columns: z.array(tableDetectedColumnSchema).max(TABLE_DETECT_MAX_COLS),
  /** 可切换的其它表根（外层 / 内层），供“范围大一点 / 小一点”。 */
  alternatives: z
    .array(
      z.strictObject({
        selector: z.string(),
        level: z.enum(['inner', 'outer', 'chosen']),
        title: z.string().optional(),
        rowCount: z.number().int().nonnegative(),
        colCount: z.number().int().nonnegative(),
        selectorQuality: z.enum(['stable', 'positional']),
      }),
    )
    .max(6),
  /** 识别出的控件形态：原生表格 / ARIA 网格 / easyui / jqGrid / ExtJS / layui。 */
  shape: z.enum(['native', 'aria', 'easyui', 'jqgrid', 'extjs', 'layui', 'elementui', 'finereport', 'aggrid', 'antd', 'handsontable', 'cards', 'keyvalue', 'listgrid']).optional(),
  /** 给用户看的识别说明（自动排除了哪些列、表没有表头等）。 */
  notes: z.array(z.string()).max(16),
})
export type TableDetected = z.infer<typeof tableDetectedSchema>

/**
 * 文件来源的编写期预览：解析最近一次运行里该下载步骤产出的文件，或用户上传的样例（只用于预览，不保存）。
 * 解析在 API 内存里完成，复用与 Worker 执行相同的 @cairn/table-file。
 */
export const tableFilePreviewRequestSchema = z.strictObject({
  /** 本步的读取计划；没有时按识别结果给出建议计划。 */
  plan: tableFilePlanSchema.optional(),
  fromKey: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/),
  /** 产出这个文件的下载步骤（用来在最近的运行里找文件）。 */
  downloadStepId: entityIdSchema,
  /** 识别时的提示：指定工作表、表头位置、编码、分隔符。 */
  hints: z
    .strictObject({
      sheet: tableFilePlanSchema.shape.sheet,
      header: tableFilePlanSchema.shape.header.optional(),
      encoding: tableFilePlanSchema.shape.encoding.optional(),
      delimiter: tableFilePlanSchema.shape.delimiter.optional(),
    })
    .optional(),
  source: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('latest_run') }),
    z.strictObject({
      kind: z.literal('upload'),
      name: z.string().min(1).max(255),
      base64: z.string().min(1).max(Math.ceil((TABLE_FILE_MAX_BYTES * 4) / 3) + 16),
    }),
  ]),
})
export type TableFilePreviewRequest = z.infer<typeof tableFilePreviewRequestSchema>

export const tableFilePreviewResponseSchema = z.strictObject({
  source: z.strictObject({
    kind: z.enum(['latest_run', 'upload']),
    runId: entityIdSchema.optional(),
    /** 文件产生的时间（运行文件）或预览时间（上传）。 */
    at: z.string(),
  }),
  file: z.strictObject({
    name: z.string(),
    byteSize: z.number().int().nonnegative(),
    format: z.enum(['csv', 'xlsx', 'html']),
    sheet: z.string().optional(),
    encoding: z.string().optional(),
  }),
  sheets: z.array(z.strictObject({ name: z.string(), rows: z.number().int().nonnegative() })).optional(),
  /** 表头所在行（从 1 起）与占几行；数据行数。 */
  headerRow: z.number().int().positive(),
  headerRows: z.number().int().positive(),
  dataRows: z.number().int().nonnegative(),
  columns: z.array(tableDetectedColumnSchema).max(TABLE_DETECT_MAX_COLS),
  plan: tableFilePlanSchema,
  sample: tableSampleSchema,
})
export type TableFilePreviewResponse = z.infer<typeof tableFilePreviewResponseSchema>

export const tableDetectObservationSchema = z.strictObject({
  outcome: targetObservationOutcomeSchema,
  page: z.strictObject({
    pageRef: pageRefSchema.optional(),
    url: z.string().optional(),
    title: z.string().optional(),
  }),
  detected: tableDetectedSchema.optional(),
  /** 没认出时的原因（给用户看的话 + 错误码）。 */
  reason: z.strictObject({ code: z.string(), message: z.string(), feedback: z.string().max(9000).optional() }).optional(),
  source: z.enum(['managed', 'extension']).default('managed'),
})
export type TableDetectObservation = z.infer<typeof tableDetectObservationSchema>

export const tableObservationSchema = z.strictObject({
  outcome: targetObservationOutcomeSchema,
  evidenceId: entityIdSchema,
  sample: tableSampleSchema,
  diagnostics: resolverDiagnosticsSchema.optional(),
  source: z.enum(['managed', 'extension']).default('managed'),
})
export type TableObservation = z.infer<typeof tableObservationSchema>

export const DEBUG_ACTIONS = [
  'retry_current',
  'continue',
  'stop',
  'pause',
  'continue_to_step',
] as const
export type DebugActionType = (typeof DEBUG_ACTIONS)[number]
export const debugActionSchema = z.strictObject({
  action: z.enum(DEBUG_ACTIONS),
  targetStepId: entityIdSchema.optional(),
  targetOverride: targetDescriptorSchema.optional(),
  stepOverride: stepSchema.optional(),
  fencingToken: z.string().min(1).optional(),
  confirmSideEffect: z.boolean().optional(),
  pageChangedAck: z.boolean().optional(),
})
export type DebugAction = z.infer<typeof debugActionSchema>

export const authoringObservationSubmitSchema = z.strictObject({
  targetId: entityIdSchema,
  url: z.string().trim().min(1).max(2048),
  title: z.string().max(512).optional(),
  target: targetDescriptorSchema.optional(),
  preview: targetObservationPreviewSchema.optional(),
  diagnostics: resolverDiagnosticsSchema.optional(),
})
export type AuthoringObservationSubmit = z.infer<typeof authoringObservationSubmitSchema>

export function pageIdentityChanged(
  checkpoint: { pageRef?: PageRef; url?: string },
  current?: { pageRef?: PageRef; url?: string } | null,
): boolean {
  if (!checkpoint.pageRef && !checkpoint.url) return false
  if (!current) return false
  if (checkpoint.pageRef && current.pageRef) {
    if (checkpoint.pageRef.pageId !== current.pageRef.pageId) return true
    if (checkpoint.pageRef.documentEpoch !== current.pageRef.documentEpoch) return true
  }
  if (checkpoint.url && current.url && checkpoint.url !== current.url) return true
  return false
}

export function observationShowsFragileCss(observation: {
  diagnostics?: {
    framePathResolved?: string[]
    candidatesTried?: Array<{ by: string; matches: number; value?: string; index?: number }>
  }
}): boolean {
  const tried = observation.diagnostics?.candidatesTried ?? []
  const unique = tried.find((item) => item.matches === 1)
  if (unique) return unique.by === 'css'
  if (tried.some((item) => item.by !== 'css' && item.matches > 0)) return false
  return observation.diagnostics?.framePathResolved?.includes('fragile-css') === true
}

export function normalizeAuthoringObservation(input: AuthoringObservationSubmit): TargetObservation {
  const candidates = input.target?.candidates ?? []
  const sanitized = candidates
    .filter((candidate) => !isSensitiveLocatorHay(`${candidate.by} ${candidate.value} ${candidate.name ?? ''}`))
    .map((candidate) => ({
      by: candidate.by,
      value: candidate.value.slice(0, 512),
      ...(candidate.name ? { name: candidate.name.slice(0, 256) } : {}),
    }))
  const css = sanitized.filter((candidate) => candidate.by === 'css')
  const rest = sanitized.filter((candidate) => candidate.by !== 'css')
  const ordered = [...rest, ...css.slice(0, 1)].slice(0, 5)
  const rawSemantic = input.target?.semantic?.trim()
  const semantic =
    rawSemantic && !isSensitiveLocatorHay(rawSemantic) ? rawSemantic.slice(0, 512) : undefined
  const target =
    ordered.length > 0 || semantic
      ? {
          framePath: (input.target?.framePath ?? []).slice(0, 4),
          candidates: ordered,
          ...(input.target?.anchor ? { anchor: input.target.anchor } : {}),
          ...(semantic ? { semantic } : {}),
        }
      : undefined
  const outcome = target ? 'FOUND' : 'NOT_FOUND'
  return targetObservationSchema.parse({
    outcome,
    ...(target ? { target } : {}),
    page: { url: input.url, title: input.title },
    preview: input.preview,
    diagnostics: input.diagnostics ?? {
      outcome,
      candidatesTried: ordered.map((candidate, index) => ({
        index,
        by: candidate.by,
        value: candidate.value,
        matches: target ? 1 : 0,
      })),
    },
    source: 'extension',
  })
}

export const authoringCapabilitiesSchema = z.strictObject({
  indicate: z.enum(['open', 'closed']),
  highlight: z.enum(['open', 'closed']),
  debugHold: z.enum(['open', 'closed']),
  assist: z.enum(['open', 'closed']),
  stepTypesExtra: z.array(z.enum(['select', 'keyboard', 'wait'])),
})
export type AuthoringCapabilities = z.infer<typeof authoringCapabilitiesSchema>
