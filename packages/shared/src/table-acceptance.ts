import { z } from 'zod'
import { entityIdSchema, jsonValueSchema, utcInstantSchema, type JsonValue } from './wire.js'
import { pageRefSchema, type PageRef } from './managed-browser.js'
import { targetDescriptorSchema, type TargetDescriptor } from './target-descriptor.js'
import {
  exprSchema,
  validateSafeRegexPattern,
  type Expr,
  evaluateExpression,
  inferExpressionShape,
} from './expression.js'
import type { OutputShape } from './output-schema.js'
import {
  fixedComparisonSchema,
  numericComparisonPolicySchema,
  toleranceComparisonSchema,
  compareWithNumericPolicy,
  type FixedComparison,
  type NumericComparisonPolicy,
  type ToleranceComparison,
} from './numeric-policy.js'
import {
  averageScaled,
  compareScaled,
  extremumScaled,
  parseScaledDecimal,
  roundScaled,
  scaledToString,
  sumScaled,
  toScaledDecimal,
  type ScaledDecimal,
} from './table-aggregate.js'

export {
  fixedComparisonSchema,
  numericComparisonPolicySchema,
  toleranceComparisonSchema,
  type FixedComparison,
  type NumericComparisonPolicy,
  type ToleranceComparison,
}

// ---------------------------------------------------------------------------
// 1. Table Read Plan & Columns
// ---------------------------------------------------------------------------

export const TABLE_READ_PLAN_PROTOCOL = 'table.read@1' as const
/**
 * 表格验收执行能力（extract as=table、context expect kind=table、表达式 mul/numericPolicy）。
 * 使用这些特性的 Run 快照必须声明该协议；旧 Worker 不得领取。
 */
export const TABLE_ACCEPTANCE_PROTOCOL = 'table.acceptance@1' as const
/**
 * 结构化数据读取 v2：列映射不猜、非数据行排除、frame 感知、仅规则定位、体积预算与敏感列。
 * 含 table.read@2 计划的 Run 快照必须声明该能力；旧 Worker 不得领取。
 */
export const TABLE_READ_PROTOCOL_V2 = 'table.read@2' as const

/** date：规范化为不带时区的 `YYYY-MM-DD` / `YYYY-MM-DD HH:mm:ss` 字符串；本期只做展示与等值比较。 */
export const tableColumnTypeSchema = z.enum(['text', 'number', 'boolean', 'date'])
export type TableColumnType = z.infer<typeof tableColumnTypeSchema>

export const tableNumericKindSchema = z.enum(['integer', 'decimal', 'float'])
export type TableNumericKind = z.infer<typeof tableNumericKindSchema>

export const tableColumnSourceSchema = z.enum(['header', 'index'])
export type TableColumnSource = z.infer<typeof tableColumnSourceSchema>

export const tableColumnSpecSchema = z
  .strictObject({
    key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, '列 key 须为字母开头的标识符'),
    /** 表头里的列名（v2 按它找列，所以不能随意改）。 */
    name: z.string().min(1).max(64),
    /** v2：给人看的显示名；缺省用 name。改显示名不影响取数。 */
    label: z.string().min(1).max(64).optional(),
    /** v2：控件里的列字段名（easyui `field`、jqGrid 列名、layui `data-field`）。有它时优先按它找列。 */
    field: z.string().min(1).max(128).optional(),
    target: targetDescriptorSchema.optional(),
    selector: z.string().max(256).optional(),
    valueType: tableColumnTypeSchema,
    numericKind: tableNumericKindSchema.optional(),
    format: z.string().max(64).optional(),
    /** v2：列来源。缺省按表头名映射；`index` 为用户显式选择的“按第几列取”。 */
    source: tableColumnSourceSchema.optional(),
    /** v2：source=index 时的列序号（从 0 起，按 DOM 列序）。 */
    index: z.number().int().min(0).max(255).optional(),
    /** v2：敏感列。输出、证据与报告中打码。 */
    sensitive: z.boolean().optional(),
    /** v2：数字列把“万 / 亿”换算为数值；缺省不换算。 */
    scaleUnits: z.boolean().optional(),
  })
  .refine(
    (col) => col.valueType !== 'number' || col.numericKind !== undefined,
    { message: '数字列必须声明 numericKind (integer/decimal/float)' },
  )
  .refine(
    (col) => col.source !== 'index' || col.index !== undefined,
    { message: '按序号取列必须提供 index' },
  )
export type TableColumnSpec = z.infer<typeof tableColumnSpecSchema>

export const tableReadinessPolicySchema = z.strictObject({
  waitVisible: z.boolean().default(true),
  loadingSelector: z.string().max(256).optional(),
  emptySelector: z.string().max(256).optional(),
  /** v2：用户确认“空着就代表没有数据”。零行且无空态标记时仍可判为 complete。 */
  emptyMeansNone: z.boolean().optional(),
  timeoutMs: z.number().int().min(100).max(30_000).default(10_000),
})
export type TableReadinessPolicy = z.infer<typeof tableReadinessPolicySchema>

export const tableReadPlanV1Schema = z.strictObject({
  protocol: z.literal(TABLE_READ_PLAN_PROTOCOL).default(TABLE_READ_PLAN_PROTOCOL),
  target: targetDescriptorSchema,
  scope: z.literal('current_page').default('current_page'),
  rows: z
    .strictObject({
      selector: z.string().max(256).optional(),
      excludeHeader: z.boolean().default(true),
    })
    .optional(),
  columns: z.array(tableColumnSpecSchema).min(1).max(32),
  readiness: tableReadinessPolicySchema.optional(),
  limits: z
    .strictObject({
      maxRows: z.number().int().min(1).max(200).default(200),
      maxCols: z.number().int().min(1).max(32).default(32),
    })
    .default({ maxRows: 200, maxCols: 32 }),
})

/** v2 单步输出体积预算（字节）的默认值与上限；单步输出硬上限为 256 KiB。 */
export const TABLE_READ_DEFAULT_MAX_BYTES = 192 * 1024
export const TABLE_READ_MAX_BYTES_LIMIT = 240 * 1024

export const tableReadPlanV2Schema = z.strictObject({
  protocol: z.literal(TABLE_READ_PROTOCOL_V2),
  /** 表根的完整目标描述（含 framePath）。采样器按它定位，不再只认第一个 css 候选。 */
  target: targetDescriptorSchema,
  scope: z.literal('current_page').default('current_page'),
  /** 读取形态：缺省按表格；cards = 一组重复卡片（每张一行），keyvalue = 一块“名称：值”信息（一行）。 */
  kind: z.enum(['table', 'cards', 'keyvalue']).optional(),
  rows: z
    .strictObject({
      selector: z.string().max(256).optional(),
      excludeHeader: z.boolean().default(true),
      /** 表头位置：自动（thead 或首行全为 th）/ 强制首行 / 无表头。 */
      header: z.enum(['auto', 'first_row', 'none']).default('auto'),
      /**
       * 合计行：默认按“首列文字是 合计 / 总计 / 小计 / 汇总 / Total”自动识别并移出数据行；
       * 这里可手工指定“某列等于某文字的行”是合计行。合计行单独输出，不计入数据行。
       */
      totalRow: z
        .strictObject({
          columnKey: z.string().min(1).max(64),
          equals: z.string().min(1).max(128),
        })
        .optional(),
    })
    .default({ excludeHeader: true, header: 'auto' }),
  columns: z.array(tableColumnSpecSchema).min(1).max(32),
  readiness: tableReadinessPolicySchema.optional(),
  limits: z
    .strictObject({
      maxRows: z.number().int().min(1).max(200).default(200),
      maxCols: z.number().int().min(1).max(32).default(32),
      maxBytes: z.number().int().min(8 * 1024).max(TABLE_READ_MAX_BYTES_LIMIT).default(TABLE_READ_DEFAULT_MAX_BYTES),
    })
    .default({ maxRows: 200, maxCols: 32, maxBytes: TABLE_READ_DEFAULT_MAX_BYTES }),
})
export type TableReadPlanV2 = z.infer<typeof tableReadPlanV2Schema>
export type TableReadPlanV1 = z.infer<typeof tableReadPlanV1Schema>

/** v2 在前：显式带 protocol 的走 v2；缺省 protocol 的旧计划落到 v1。 */
export const tableReadPlanSchema = z.union([tableReadPlanV2Schema, tableReadPlanV1Schema])
export type TableReadPlan = z.infer<typeof tableReadPlanSchema>

export function isTableReadPlanV2(plan: TableReadPlan): plan is TableReadPlanV2 {
  return plan.protocol === TABLE_READ_PROTOCOL_V2
}

/** 编辑器切到“表格数据”时生成的占位计划（还没点选过表格）。运行前必须被真实计划替换。 */
export const TABLE_PLACEHOLDER_COLUMN_NAME = '数据列'
export function isTablePlanUnconfigured(plan: Pick<TableReadPlan, 'columns'>): boolean {
  return (
    plan.columns.length === 1 &&
    plan.columns[0]?.key === 'col_1' &&
    plan.columns[0]?.name === TABLE_PLACEHOLDER_COLUMN_NAME
  )
}

// ---------------------------------------------------------------------------
// 2. Table Sample
// ---------------------------------------------------------------------------

export const TABLE_SAMPLE_PROTOCOL = 'table.sample@1' as const

export const tableRowFieldSchema = z.strictObject({
  value: jsonValueSchema,
  rawText: z.string().optional(),
  decimalValue: z.string().optional(),
  status: z.enum(['ok', 'masked', 'missing', 'error']).default('ok'),
})
export type TableRowField = z.infer<typeof tableRowFieldSchema>

export const tableSampleCoverageSchema = z.strictObject({
  requestedScope: z.literal('current_page').default('current_page'),
  observedScope: z.literal('current_page').default('current_page'),
  status: z.enum(['complete', 'partial', 'unknown']),
  reasonCode: z.string().optional(),
  reasonMessage: z.string().optional(),
  clues: z.array(z.string()).optional(),
})
export type TableSampleCoverage = z.infer<typeof tableSampleCoverageSchema>

export const tableSampleSchema = z.strictObject({
  protocol: z.literal(TABLE_SAMPLE_PROTOCOL).default(TABLE_SAMPLE_PROTOCOL),
  source: z.strictObject({
    runId: entityIdSchema,
    stepRunId: entityIdSchema.optional(),
    attemptId: entityIdSchema.optional(),
    pageRef: pageRefSchema.optional(),
    sampledAt: utcInstantSchema,
    planDigest: z.string().min(1).max(128),
    evidenceId: entityIdSchema.optional(),
  }),
  columns: z.array(tableColumnSpecSchema),
  rows: z.array(z.record(z.string(), tableRowFieldSchema)),
  rowCount: z.number().int().nonnegative(),
  coverage: tableSampleCoverageSchema,
  /** v2：被排除的非数据行计数（分组标题 / 说明行、分页栏、页脚）。 */
  excluded: z
    .strictObject({
      mergedRows: z.number().int().nonnegative(),
      paginationRows: z.number().int().nonnegative(),
      footerRows: z.number().int().nonnegative(),
    })
    .optional(),
  /** v2：合计 / 页脚行（tfoot、easyui 页脚、jqGrid 汇总、ExtJS summary、layui 合计行、自动或手工识别的合计行），用同样的列读出，不计入数据行；至多 5 行。 */
  summaryRows: z.array(z.record(z.string(), tableRowFieldSchema)).max(5).optional(),
  presentation: z.strictObject({
    omitted: z.boolean().default(false),
    previewCount: z.number().int().nonnegative().default(20),
  }),
})
export type TableSample = z.infer<typeof tableSampleSchema>

// ---------------------------------------------------------------------------
// 3. Table Predicates & Rules
// ---------------------------------------------------------------------------

export const tablePredicateSchema = z.discriminatedUnion('op', [
  z
    .strictObject({
      op: z.enum(['eq', 'neq']),
      value: z.union([z.string().max(1024), z.number().finite(), z.boolean()]),
      numericPolicy: numericComparisonPolicySchema.optional(),
    })
    .refine(
      (value) => !value.numericPolicy || typeof value.value === 'number',
      { message: '精度策略只适用于数字比较' },
    ),
  z.strictObject({
    op: z.enum(['gt', 'gte', 'lt', 'lte']),
    value: z.number().finite(),
    numericPolicy: fixedComparisonSchema.optional(),
  }),
  z.strictObject({
    op: z.enum(['contains', 'starts_with', 'ends_with']),
    value: z.string().min(1).max(1024),
  }),
  z.strictObject({
    op: z.literal('matches'),
    value: z.string().min(1).max(128).refine(
      (value) => validateSafeRegexPattern(value).valid,
      { message: '不支持的正则表达式' },
    ),
  }),
  z.strictObject({ op: z.enum(['is_empty', 'is_not_empty']) }),
])
export type TablePredicate = z.infer<typeof tablePredicateSchema>

export const tableExpectRuleSchema = z.discriminatedUnion('rule', [
  z.strictObject({
    rule: z.literal('row_count'),
    op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte']),
    value: z.number().int().nonnegative(),
  }),
  z.strictObject({
    rule: z.literal('all_rows'),
    column: z.string().min(1).max(64),
    predicate: tablePredicateSchema,
    allowEmpty: z.boolean().default(false),
  }),
  z.strictObject({
    rule: z.literal('any_row'),
    column: z.string().min(1).max(64),
    predicate: tablePredicateSchema,
  }),
  /** 数字列的合计 / 平均 / 最小 / 最大与给定数值比较（精确十进制）。 */
  z.strictObject({
    rule: z.literal('column_stat'),
    column: z.string().min(1).max(64),
    stat: z.enum(['sum', 'avg', 'min', 'max']),
    op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte']),
    value: z.number().finite(),
    numericPolicy: numericComparisonPolicySchema.optional(),
    /** 默认列里有空值就“无法确认”；勾选后忽略空值，结果里写明忽略了几行。 */
    ignoreEmpty: z.boolean().default(false),
  }),
  /** 数字列各行相加，与读取到的合计行里同一列的值核对。 */
  z.strictObject({
    rule: z.literal('total_row_match'),
    column: z.string().min(1).max(64),
    /** display：按合计行显示的小数位比较（显示值常是四舍五入的）；exact：精确比较。 */
    precision: z.enum(['display', 'exact']).default('display'),
  }),
  /** 列里没有重复值（去首尾空白后比较，空值不参与）。 */
  z.strictObject({
    rule: z.literal('column_unique'),
    column: z.string().min(1).max(64),
  }),
  z
    .strictObject({
      rule: z.literal('row_expression'),
      quantifier: z.enum(['all', 'any']),
      expression: exprSchema,
      allowEmpty: z.boolean().default(false),
    })
    .refine(
      (value) => value.quantifier !== 'any' || !value.allowEmpty,
      { message: 'any 不允许空表通过' },
    ),
])
export type TableExpectRule = z.infer<typeof tableExpectRuleSchema>

// ---------------------------------------------------------------------------
// 4. Outcome Details & Budget Limits
// ---------------------------------------------------------------------------

export const TABLE_OUTCOME_PROTOCOL = 'table.outcome@1' as const

export const tableViolatingRowPreviewSchema = z.strictObject({
  rowIndex: z.number().int().nonnegative(),
  rowDigest: z.string().optional(),
  actualValue: z.strictObject({
    text: z.string().max(1024),
    truncated: z.boolean(),
    originalBytes: z.number().int().nonnegative(),
  }),
  expected: z
    .strictObject({
      text: z.string().max(1024),
      truncated: z.boolean(),
      originalBytes: z.number().int().nonnegative(),
    })
    .optional(),
  reasonCode: z.string().max(128),
  reasonSummary: z.string().max(512),
})
export type TableViolatingRowPreview = z.infer<typeof tableViolatingRowPreviewSchema>

export const tableOutcomeDetailsSchema = z.strictObject({
  protocol: z.literal(TABLE_OUTCOME_PROTOCOL).default(TABLE_OUTCOME_PROTOCOL),
  totalRowsChecked: z.number().int().nonnegative(),
  matchedRows: z.number().int().nonnegative().nullable(),
  violatingRowsCount: z.number().int().nonnegative().nullable(),
  violatingRows: z.array(tableViolatingRowPreviewSchema).max(5),
  presentation: z.strictObject({
    truncated: z.boolean(),
    omittedViolatingRows: z.number().int().nonnegative(),
    truncatedFields: z.boolean(),
  }),
  coverage: z.strictObject({
    status: z.enum(['complete', 'partial', 'unknown']),
    reasonCode: z.string().optional(),
    reasonSummary: z.string().max(512).optional(),
  }),
})
export type TableOutcomeDetails = z.infer<typeof tableOutcomeDetailsSchema>

export const MAX_TABLE_DETAILS_BYTES = 32 * 1024 // 32 KiB
export const MAX_TABLE_OUTPUT_BYTES = 64 * 1024 // 64 KiB
export const MAX_REASON_SUMMARY_BYTES = 512

/**
 * 截断文本至最大 UTF-8 字节数，保持多字节字符完整。
 */
export function truncateUtf8Bytes(str: string, maxBytes: number): { text: string; truncated: boolean; originalBytes: number } {
  const encoder = new TextEncoder()
  const bytes = encoder.encode(str)
  const originalBytes = bytes.length
  if (originalBytes <= maxBytes) {
    return { text: str, truncated: false, originalBytes }
  }

  // 截断到 maxBytes，并避免切碎 UTF-8 尾随字节
  let cut = maxBytes
  while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) {
    cut--
  }
  const decoder = new TextDecoder('utf-8')
  const sliced = decoder.decode(bytes.slice(0, cut))
  return { text: sliced, truncated: true, originalBytes }
}

export function createValuePreview(val: unknown): { text: string; truncated: boolean; originalBytes: number } {
  const json = JSON.stringify(val ?? null)
  return truncateUtf8Bytes(json, 1024)
}

export type TablePredicateOutcome =
  | { status: 'pass' }
  | { status: 'fail'; reasonCode: string; reasonSummary: string }
  | { status: 'unknown'; reasonCode: string; reasonSummary: string }

/**
 * 三值单列谓词判定。字段缺失、遮蔽、解析失败与类型不匹配均返回 unknown，
 * 不做布尔/文本/数字之间的隐式转换；`0`、`false` 均非业务空值。
 */
export function checkTablePredicate(
  field: TableRowField | undefined,
  predicate: TablePredicate,
): TablePredicateOutcome {
  if (!field || field.status === 'missing') {
    return { status: 'unknown', reasonCode: 'FIELD_MISSING', reasonSummary: '字段缺失或未读取到' }
  }
  if (field.status === 'error') {
    return { status: 'unknown', reasonCode: 'FIELD_PARSE_ERROR', reasonSummary: '字段值解析失败' }
  }
  if (field.status === 'masked') {
    return { status: 'unknown', reasonCode: 'FIELD_MASKED', reasonSummary: '字段已被脱敏遮蔽' }
  }
  const val = field.value
  if (predicate.op === 'is_empty' || predicate.op === 'is_not_empty') {
    const empty = val === null || val === undefined || val === ''
    if (predicate.op === 'is_empty') {
      return empty
        ? { status: 'pass' }
        : { status: 'fail', reasonCode: 'NOT_EMPTY', reasonSummary: `字段非空（实际值：${JSON.stringify(val)}）` }
    }
    return empty
      ? { status: 'fail', reasonCode: 'EMPTY', reasonSummary: '字段为空' }
      : { status: 'pass' }
  }
  if (predicate.op === 'eq' || predicate.op === 'neq') {
    if (typeof predicate.value === 'number') {
      if (typeof val !== 'number') {
        return {
          status: 'unknown',
          reasonCode: 'NOT_A_NUMBER',
          reasonSummary: `期望数字，实际值「${JSON.stringify(val) ?? val}」不是数字，不做隐式转换`,
        }
      }
      const actual = field.decimalValue ?? val
      const comp = compareWithNumericPolicy(actual, predicate.value, predicate.op, predicate.numericPolicy)
      return comp.matched
        ? { status: 'pass' }
        : {
            status: 'fail',
            reasonCode: predicate.op === 'eq' ? 'NUMERIC_NOT_EQUAL' : 'NUMERIC_EQUAL',
            reasonSummary: comp.error ?? `数字${predicate.op === 'eq' ? '不相等' : '相等'}（实际 ${val}，期望 ${predicate.value}）`,
          }
    }
    if (typeof predicate.value === 'boolean') {
      if (typeof val !== 'boolean') {
        return {
          status: 'unknown',
          reasonCode: 'TYPE_MISMATCH',
          reasonSummary: `期望布尔值，实际值「${JSON.stringify(val) ?? val}」不是布尔，不做隐式转换`,
        }
      }
      const eq = val === predicate.value
      const passed = predicate.op === 'eq' ? eq : !eq
      return passed
        ? { status: 'pass' }
        : {
            status: 'fail',
            reasonCode: predicate.op === 'eq' ? 'VALUE_NOT_EQUAL' : 'VALUE_EQUAL',
            reasonSummary: `布尔值${predicate.op === 'eq' ? '不匹配' : '匹配'}（实际 ${val}，期望 ${predicate.value}）`,
          }
    }
    if (typeof val !== 'string') {
      return {
        status: 'unknown',
        reasonCode: 'TYPE_MISMATCH',
        reasonSummary: `期望文本，实际值「${JSON.stringify(val) ?? val}」不是文本，不做隐式转换`,
      }
    }
    const eq = val === predicate.value
    const passed = predicate.op === 'eq' ? eq : !eq
    return passed
      ? { status: 'pass' }
      : {
          status: 'fail',
          reasonCode: predicate.op === 'eq' ? 'VALUE_NOT_EQUAL' : 'VALUE_EQUAL',
          reasonSummary: `文本${predicate.op === 'eq' ? '不匹配' : '匹配'}（实际「${val}」，期望「${predicate.value}」）`,
        }
  }
  if (predicate.op === 'gt' || predicate.op === 'gte' || predicate.op === 'lt' || predicate.op === 'lte') {
    if (typeof val !== 'number') {
      return {
        status: 'unknown',
        reasonCode: 'NOT_A_NUMBER',
        reasonSummary: `期望数字，实际值「${JSON.stringify(val) ?? val}」不是数字，不做隐式转换`,
      }
    }
    const actual = field.decimalValue ?? val
    const comp = compareWithNumericPolicy(actual, predicate.value, predicate.op, predicate.numericPolicy)
    return comp.matched
      ? { status: 'pass' }
      : {
          status: 'fail',
          reasonCode: 'NUMERIC_COMPARE_FAILED',
          reasonSummary: comp.error ?? `大小比较不满足（实际 ${val}，期望 ${predicate.op} ${predicate.value}）`,
        }
  }
  if (predicate.op === 'contains' || predicate.op === 'starts_with' || predicate.op === 'ends_with') {
    if (typeof val !== 'string') {
      return {
        status: 'unknown',
        reasonCode: 'TYPE_MISMATCH',
        reasonSummary: `期望文本，实际值「${JSON.stringify(val) ?? val}」不是文本，不做隐式转换`,
      }
    }
    const passed =
      predicate.op === 'contains'
        ? val.includes(predicate.value)
        : predicate.op === 'starts_with'
          ? val.startsWith(predicate.value)
          : val.endsWith(predicate.value)
    return passed
      ? { status: 'pass' }
      : {
          status: 'fail',
          reasonCode: 'TEXT_PREDICATE_FAILED',
          reasonSummary: `文本不满足 ${predicate.op}「${predicate.value}」（实际「${val}」）`,
        }
  }
  if (predicate.op === 'matches') {
    if (typeof val !== 'string') {
      return {
        status: 'unknown',
        reasonCode: 'TYPE_MISMATCH',
        reasonSummary: `期望文本，实际值「${JSON.stringify(val) ?? val}」不是文本，不做隐式转换`,
      }
    }
    try {
      const reg = new RegExp(predicate.value)
      const passed = reg.test(val)
      return passed
        ? { status: 'pass' }
        : {
            status: 'fail',
            reasonCode: 'REGEX_NOT_MATCHED',
            reasonSummary: `文本未匹配正则「${predicate.value}」`,
          }
    } catch {
      return { status: 'unknown', reasonCode: 'INVALID_REGEX', reasonSummary: '无效正则表达式' }
    }
  }
  return { status: 'unknown', reasonCode: 'UNKNOWN_PREDICATE', reasonSummary: '未知谓词' }
}

export type TableEvaluationResult = {
  passed: boolean
  factsUnavailable?: boolean
  reasonCode?: string
  reasonMessage?: string
  details: TableOutcomeDetails
}

function unknownResult(
  sample: TableSample,
  reasonCode: string,
  reasonMessage: string,
): TableEvaluationResult {
  return {
    passed: false,
    factsUnavailable: true,
    reasonCode,
    reasonMessage,
    details: {
      protocol: TABLE_OUTCOME_PROTOCOL,
      totalRowsChecked: 0,
      matchedRows: null,
      violatingRowsCount: null,
      violatingRows: [],
      presentation: { truncated: false, omittedViolatingRows: 0, truncatedFields: false },
      coverage: {
        status: sample.coverage.status,
        reasonCode: sample.coverage.reasonCode,
        ...(sample.coverage.reasonMessage
          ? { reasonSummary: truncateUtf8Bytes(sample.coverage.reasonMessage, 512).text }
          : {}),
      },
    },
  }
}

function coverageDetailsOf(sample: TableSample): TableOutcomeDetails['coverage'] {
  return {
    status: sample.coverage.status,
    reasonCode: sample.coverage.reasonCode,
    ...(sample.coverage.reasonMessage
      ? { reasonSummary: truncateUtf8Bytes(sample.coverage.reasonMessage, 512).text }
      : {}),
  }
}

function rowPreview(
  rowIndex: number,
  actual: unknown,
  expected: unknown,
  reasonCode: string,
  reasonSummary: string,
): TableViolatingRowPreview {
  return {
    rowIndex,
    actualValue: createValuePreview(actual),
    expected: createValuePreview(expected),
    reasonCode,
    reasonSummary: truncateUtf8Bytes(reasonSummary, 512).text,
  }
}


type ColumnRule = Extract<TableExpectRule, { rule: 'column_stat' | 'total_row_match' | 'column_unique' }>

function detailsOf(
  sample: TableSample,
  coverage: TableOutcomeDetails['coverage'],
  extra: Partial<Pick<TableOutcomeDetails, 'matchedRows' | 'violatingRowsCount' | 'violatingRows'>> = {},
): TableOutcomeDetails {
  const violating = extra.violatingRows ?? []
  const count = extra.violatingRowsCount ?? violating.length
  return {
    protocol: TABLE_OUTCOME_PROTOCOL,
    totalRowsChecked: sample.rows.length,
    matchedRows: extra.matchedRows ?? null,
    violatingRowsCount: count,
    violatingRows: violating.slice(0, 5),
    presentation: { truncated: count > 5, omittedViolatingRows: Math.max(0, count - 5), truncatedFields: false },
    coverage,
  }
}

type NumericColumn =
  | { ok: true; values: ScaledDecimal[]; ignoredEmpty: number }
  | { ok: false; reasonCode: string; reasonMessage: string }

/** 取数字列的精确值：有无法解析 / 脱敏的值 → 不可判定；空值按 ignoreEmpty 处理。 */
function readNumericColumn(sample: TableSample, column: string, ignoreEmpty: boolean): NumericColumn {
  const label = sample.columns.find((c) => c.key === column)?.name ?? column
  const values: ScaledDecimal[] = []
  let ignoredEmpty = 0
  const badRows: number[] = []
  const emptyRows: number[] = []
  sample.rows.forEach((row, i) => {
    const field = row[column]
    if (!field || field.status === 'missing' || (field.status === 'ok' && field.value === null)) {
      emptyRows.push(i + 1)
      return
    }
    if (field.status !== 'ok' || typeof field.value !== 'number') {
      badRows.push(i + 1)
      return
    }
    const scaled = toScaledDecimal(field.decimalValue, field.value)
    if (!scaled) badRows.push(i + 1)
    else values.push(scaled)
  })
  const rowsText = (rows: number[]): string => `第 ${rows.slice(0, 5).join('、')} 行${rows.length > 5 ? `等 ${rows.length} 行` : ''}`
  if (badRows.length > 0) {
    return {
      ok: false,
      reasonCode: 'TABLE_FIELD_UNAVAILABLE',
      reasonMessage: `「${label}」列有读不出数字的值（${rowsText(badRows)}），无法确认合计结果`,
    }
  }
  if (emptyRows.length > 0 && !ignoreEmpty) {
    return {
      ok: false,
      reasonCode: 'TABLE_FIELD_EMPTY',
      reasonMessage: `「${label}」列有空值（${rowsText(emptyRows)}），无法确认结果；如果空值可以忽略，请勾选“忽略空值”`,
    }
  }
  ignoredEmpty = emptyRows.length
  return { ok: true, values, ignoredEmpty }
}

const STAT_LABEL = { sum: '合计', avg: '平均值', min: '最小值', max: '最大值' } as const

function evaluateColumnRule(
  sample: TableSample,
  rule: ColumnRule,
  coverage: TableOutcomeDetails['coverage'],
): TableEvaluationResult {
  const label = sample.columns.find((c) => c.key === rule.column)?.name ?? rule.column
  if (rule.rule === 'column_unique') {
    const seen = new Map<string, number>()
    const violating: TableViolatingRowPreview[] = []
    let duplicateCount = 0
    let unreadable = 0
    sample.rows.forEach((row, i) => {
      const field = row[rule.column]
      if (!field || field.status === 'missing' || (field.status === 'ok' && (field.value === null || field.value === ''))) return
      if (field.status !== 'ok') {
        unreadable++
        return
      }
      const key = String(field.rawText ?? field.value).trim()
      if (key === '') return
      const first = seen.get(key)
      if (first === undefined) seen.set(key, i)
      else {
        duplicateCount++
        if (violating.length < 5) {
          violating.push(
            rowPreview(i, field.value, undefined, 'DUPLICATE_VALUE', `「${label}」第 ${first + 1} 行和第 ${i + 1} 行重复：${key}`),
          )
        }
      }
    })
    if (duplicateCount > 0) {
      return {
        passed: false,
        reasonCode: 'COLUMN_NOT_UNIQUE',
        reasonMessage: `「${label}」列有 ${duplicateCount} 处重复值`,
        details: detailsOf(sample, coverage, { matchedRows: sample.rows.length - duplicateCount, violatingRowsCount: duplicateCount, violatingRows: violating }),
      }
    }
    if (unreadable > 0) {
      return unknownResult(sample, 'TABLE_FIELD_UNAVAILABLE', `「${label}」列有 ${unreadable} 行读不出值（解析失败或已脱敏），无法确认是否重复`)
    }
    return { passed: true, details: detailsOf(sample, coverage, { matchedRows: sample.rows.length, violatingRowsCount: 0 }) }
  }

  const ignoreEmpty = rule.rule === 'column_stat' ? rule.ignoreEmpty : false
  const column = readNumericColumn(sample, rule.column, ignoreEmpty)
  if (!column.ok) return unknownResult(sample, column.reasonCode, column.reasonMessage)

  if (rule.rule === 'column_stat') {
    let actual: ScaledDecimal | null
    if (rule.stat === 'sum') actual = sumScaled(column.values)
    else if (rule.stat === 'avg') actual = averageScaled(column.values)
    else actual = extremumScaled(column.values, rule.stat)
    if (!actual) {
      return unknownResult(sample, 'TABLE_EMPTY_STAT', `表里没有可计算的数据，无法得出「${label}」的${STAT_LABEL[rule.stat]}`)
    }
    const expected = parseScaledDecimal(String(rule.value)) ?? { int: BigInt(Math.round(rule.value)), scale: 0 }
    let matched: boolean
    if (rule.numericPolicy) {
      matched = compareWithNumericPolicy(scaledToString(actual), rule.value, rule.op, rule.numericPolicy).matched
    } else {
      const cmp = compareScaled(actual, expected)
      matched =
        rule.op === 'eq' ? cmp === 0
          : rule.op === 'neq' ? cmp !== 0
            : rule.op === 'gt' ? cmp > 0
              : rule.op === 'gte' ? cmp >= 0
                : rule.op === 'lt' ? cmp < 0
                  : cmp <= 0
    }
    const ignoredNote = column.ignoredEmpty > 0 ? `（已忽略 ${column.ignoredEmpty} 行空值）` : ''
    if (matched) {
      return { passed: true, details: detailsOf(sample, coverage, { matchedRows: column.values.length, violatingRowsCount: 0 }) }
    }
    return {
      passed: false,
      reasonCode: 'COLUMN_STAT_NOT_SATISFIED',
      reasonMessage: `「${label}」的${STAT_LABEL[rule.stat]}是 ${scaledToString(actual)}，不满足 ${rule.op} ${rule.value}${ignoredNote}`,
      details: detailsOf(sample, coverage, {
        matchedRows: 0,
        violatingRowsCount: 1,
        violatingRows: [
          rowPreview(0, scaledToString(actual), rule.value, 'COLUMN_STAT_NOT_SATISFIED', `${label} ${STAT_LABEL[rule.stat]}=${scaledToString(actual)}，期望 ${rule.op} ${rule.value}`),
        ],
      }),
    }
  }

  // total_row_match
  const totalRow = sample.summaryRows?.[0]
  const totalField = totalRow?.[rule.column]
  if (!totalRow) {
    return unknownResult(sample, 'TOTAL_ROW_NOT_FOUND', '没有读到合计行，无法核对合计；请确认这张表有合计行，或在“一般不用动”里指定哪一行是合计行')
  }
  if (!totalField || totalField.status !== 'ok' || typeof totalField.value !== 'number') {
    return unknownResult(sample, 'TOTAL_ROW_FIELD_UNAVAILABLE', `合计行里「${label}」读不出数字，无法核对合计`)
  }
  const shown = toScaledDecimal(totalField.decimalValue, totalField.value)
  if (!shown) return unknownResult(sample, 'TOTAL_ROW_FIELD_UNAVAILABLE', `合计行里「${label}」读不出数字，无法核对合计`)
  const sum = sumScaled(column.values)
  const compared = rule.precision === 'display' ? roundScaled(sum, shown.scale) : sum
  if (compareScaled(compared, shown) === 0) {
    return { passed: true, details: detailsOf(sample, coverage, { matchedRows: sample.rows.length, violatingRowsCount: 0 }) }
  }
  return {
    passed: false,
    reasonCode: 'TOTAL_ROW_MISMATCH',
    reasonMessage: `「${label}」各行相加是 ${scaledToString(sum)}，合计行显示 ${scaledToString(shown)}`,
    details: detailsOf(sample, coverage, {
      matchedRows: 0,
      violatingRowsCount: 1,
      violatingRows: [rowPreview(0, scaledToString(sum), scaledToString(shown), 'TOTAL_ROW_MISMATCH', `各行相加 ${scaledToString(sum)}，合计行 ${scaledToString(shown)}`)],
    }),
  }
}

/**
 * 求值前置门：要求范围非 complete 时一律 UNKNOWN，不利用部分样本给全表结论。
 */
export function evaluateTableExpectation(
  sample: TableSample,
  rule: TableExpectRule,
): TableEvaluationResult {
  const coverageComplete = sample.coverage.status === 'complete'
  const coverageDetails = coverageDetailsOf(sample)
  const colName = (key: string): string => sample.columns.find((c) => c.key === key)?.name ?? key

  if (!coverageComplete) {
    return unknownResult(
      sample,
      'TABLE_FACTS_UNAVAILABLE',
      sample.coverage.reasonMessage
        ? `表格采样覆盖不完整（${sample.coverage.reasonCode ?? 'unknown'}），无法确认全表事实`
        : '表格采样覆盖不完整，无法确认全表事实',
    )
  }

  // 1. row_count rule
  if (rule.rule === 'row_count') {
    const count = sample.rows.length
    let passed = false
    if (rule.op === 'eq') passed = count === rule.value
    else if (rule.op === 'neq') passed = count !== rule.value
    else if (rule.op === 'gt') passed = count > rule.value
    else if (rule.op === 'gte') passed = count >= rule.value
    else if (rule.op === 'lt') passed = count < rule.value
    else if (rule.op === 'lte') passed = count <= rule.value

    return {
      passed,
      reasonCode: passed ? undefined : 'ROW_COUNT_MISMATCH',
      reasonMessage: passed ? undefined : `行数不满足条件：实际 ${count} 行，期望 ${rule.op} ${rule.value}`,
      details: {
        protocol: TABLE_OUTCOME_PROTOCOL,
        totalRowsChecked: count,
        matchedRows: null,
        violatingRowsCount: null,
        violatingRows: [],
        presentation: { truncated: false, omittedViolatingRows: 0, truncatedFields: false },
        coverage: coverageDetails,
      },
    }
  }

  // 2. all_rows rule
  if (rule.rule === 'all_rows') {
    if (sample.rows.length === 0) {
      const passed = Boolean(rule.allowEmpty)
      return {
        passed,
        reasonCode: passed ? undefined : 'EMPTY_TABLE_NOT_ALLOWED',
        reasonMessage: passed ? undefined : '空表不满足非空要求',
        details: {
          protocol: TABLE_OUTCOME_PROTOCOL,
          totalRowsChecked: 0,
          matchedRows: 0,
          violatingRowsCount: 0,
          violatingRows: [],
          presentation: { truncated: false, omittedViolatingRows: 0, truncatedFields: false },
          coverage: coverageDetails,
        },
      }
    }

    const violatingRows: TableViolatingRowPreview[] = []
    let violatingCount = 0
    let unknownCount = 0
    for (let i = 0; i < sample.rows.length; i++) {
      const row = sample.rows[i]!
      const field = row[rule.column]
      const predRes = checkTablePredicate(field, rule.predicate)
      if (predRes.status === 'unknown') {
        unknownCount++
      } else if (predRes.status === 'fail') {
        violatingCount++
        if (violatingRows.length < 5) {
          violatingRows.push(
            rowPreview(
              i,
              field?.value,
              rule.predicate,
              predRes.reasonCode,
              predRes.reasonSummary ?? `第 ${i + 1} 行「${colName(rule.column)}」未满足条件`,
            ),
          )
        }
      }
    }
    if (violatingCount > 0) {
      return {
        passed: false,
        reasonCode: 'ALL_ROWS_VIOLATED',
        reasonMessage: `全表判定不通过：共 ${violatingCount} 行不满足条件`,
        details: {
          protocol: TABLE_OUTCOME_PROTOCOL,
          totalRowsChecked: sample.rows.length - unknownCount,
          matchedRows: sample.rows.length - violatingCount - unknownCount,
          violatingRowsCount: violatingCount,
          violatingRows,
          presentation: {
            truncated: violatingCount > 5,
            omittedViolatingRows: Math.max(0, violatingCount - 5),
            truncatedFields: false,
          },
          coverage: coverageDetails,
        },
      }
    }
    if (unknownCount > 0) {
      return unknownResult(
        sample,
        'TABLE_FIELD_UNAVAILABLE',
        `${unknownCount} 行的「${colName(rule.column)}」字段不可判定（缺失、遮蔽、解析失败或类型不符），无法确认全表结论`,
      )
    }
    return {
      passed: true,
      details: {
        protocol: TABLE_OUTCOME_PROTOCOL,
        totalRowsChecked: sample.rows.length,
        matchedRows: sample.rows.length,
        violatingRowsCount: 0,
        violatingRows: [],
        presentation: { truncated: false, omittedViolatingRows: 0, truncatedFields: false },
        coverage: coverageDetails,
      },
    }
  }

  // 3. any_row rule（完整空表恒为不成立）
  if (rule.rule === 'any_row') {
    if (sample.rows.length === 0) {
      return {
        passed: false,
        reasonCode: 'NO_ROW_MATCHED',
        reasonMessage: '空表中没有任何行满足条件',
        details: {
          protocol: TABLE_OUTCOME_PROTOCOL,
          totalRowsChecked: 0,
          matchedRows: 0,
          violatingRowsCount: null,
          violatingRows: [],
          presentation: { truncated: false, omittedViolatingRows: 0, truncatedFields: false },
          coverage: coverageDetails,
        },
      }
    }

    let matchedCount = 0
    let unknownCount = 0
    const sampleViolating: TableViolatingRowPreview[] = []
    for (let i = 0; i < sample.rows.length; i++) {
      const row = sample.rows[i]!
      const field = row[rule.column]
      const predRes = checkTablePredicate(field, rule.predicate)
      if (predRes.status === 'pass') {
        matchedCount++
      } else if (predRes.status === 'unknown') {
        unknownCount++
      } else if (sampleViolating.length < 5) {
        sampleViolating.push(
          rowPreview(
            i,
            field?.value,
            rule.predicate,
            predRes.reasonCode,
            predRes.reasonSummary ?? `第 ${i + 1} 行「${colName(rule.column)}」未满足条件`,
          ),
        )
      }
    }

    if (matchedCount > 0) {
      return {
        passed: true,
        details: {
          protocol: TABLE_OUTCOME_PROTOCOL,
          totalRowsChecked: sample.rows.length - unknownCount,
          matchedRows: matchedCount,
          violatingRowsCount: null,
          violatingRows: [],
          presentation: { truncated: false, omittedViolatingRows: 0, truncatedFields: false },
          coverage: coverageDetails,
        },
      }
    }
    if (unknownCount > 0) {
      return unknownResult(
        sample,
        'TABLE_FIELD_UNAVAILABLE',
        `${unknownCount} 行的「${colName(rule.column)}」字段不可判定（缺失、遮蔽、解析失败或类型不符），无法确认是否存在满足条件的行`,
      )
    }

    return {
      passed: false,
      reasonCode: 'NO_ROW_MATCHED',
      reasonMessage: `没有任何行满足条件「${colName(rule.column)}」`,
      details: {
        protocol: TABLE_OUTCOME_PROTOCOL,
        totalRowsChecked: sample.rows.length,
        matchedRows: 0,
        violatingRowsCount: sample.rows.length,
        violatingRows: sampleViolating,
        presentation: {
          truncated: sample.rows.length > 5,
          omittedViolatingRows: Math.max(0, sample.rows.length - 5),
          truncatedFields: false,
        },
        coverage: coverageDetails,
      },
    }
  }

  // 3b. 列聚合 / 合计行核对 / 列唯一
  if (rule.rule === 'column_stat' || rule.rule === 'total_row_match' || rule.rule === 'column_unique') {
    return evaluateColumnRule(sample, rule, coverageDetails)
  }

  // 4. row_expression rule：每行只建立独立只读 row 绑定，不注入外层 Context
  if (rule.rule === 'row_expression') {
    const isAll = rule.quantifier === 'all'

    if (sample.rows.length === 0) {
      const passed = isAll ? Boolean(rule.allowEmpty) : false
      return {
        passed,
        reasonCode: passed ? undefined : (isAll ? 'EMPTY_TABLE_NOT_ALLOWED' : 'NO_ROW_MATCHED'),
        reasonMessage: passed ? undefined : (isAll ? '空表不满足非空要求' : '空表中没有任何行满足条件'),
        details: {
          protocol: TABLE_OUTCOME_PROTOCOL,
          totalRowsChecked: 0,
          matchedRows: 0,
          violatingRowsCount: passed ? 0 : (isAll ? 0 : null),
          violatingRows: [],
          presentation: { truncated: false, omittedViolatingRows: 0, truncatedFields: false },
          coverage: coverageDetails,
        },
      }
    }

    let matchedCount = 0
    let violatingCount = 0
    let unknownCount = 0
    const violatingRows: TableViolatingRowPreview[] = []
    const sampleViolating: TableViolatingRowPreview[] = []

    for (let i = 0; i < sample.rows.length; i++) {
      const row = sample.rows[i]!
      const rowNormalizedValues: Record<string, unknown> = {}
      for (const [k, f] of Object.entries(row)) {
        rowNormalizedValues[k] = f?.value ?? null
      }
      const env = { row: rowNormalizedValues }
      let rowStatus: 'pass' | 'fail' | 'unknown'
      let failReason = `第 ${i + 1} 行表达式计算不成立`
      let unknownReason = `第 ${i + 1} 行表达式无法判定`
      try {
        const res = evaluateExpression(rule.expression, env)
        if (!res.ok) {
          rowStatus = 'unknown'
          unknownReason = res.message ?? unknownReason
        } else if (typeof res.value !== 'boolean') {
          rowStatus = 'unknown'
          unknownReason = `第 ${i + 1} 行表达式结果不是布尔值（行表达式必须返回 boolean）`
        } else if (res.value) {
          rowStatus = 'pass'
        } else {
          rowStatus = 'fail'
        }
      } catch {
        rowStatus = 'unknown'
      }

      if (rowStatus === 'pass') {
        matchedCount++
      } else if (rowStatus === 'unknown') {
        unknownCount++
      } else {
        violatingCount++
        const previewItem = rowPreview(i, rowNormalizedValues, rule.expression, 'EXPRESSION_EVAL_FALSE', failReason)
        if (violatingRows.length < 5) {
          violatingRows.push(previewItem)
        }
        if (sampleViolating.length < 5) {
          sampleViolating.push(previewItem)
        }
      }
    }

    if (isAll) {
      if (violatingCount > 0) {
        return {
          passed: false,
          reasonCode: 'ALL_ROWS_VIOLATED',
          reasonMessage: `行表达式全表判定不通过：共 ${violatingCount} 行不满足条件`,
          details: {
            protocol: TABLE_OUTCOME_PROTOCOL,
            totalRowsChecked: sample.rows.length - unknownCount,
            matchedRows: matchedCount,
            violatingRowsCount: violatingCount,
            violatingRows,
            presentation: {
              truncated: violatingCount > 5,
              omittedViolatingRows: Math.max(0, violatingCount - 5),
              truncatedFields: false,
            },
            coverage: coverageDetails,
          },
        }
      }
      if (unknownCount > 0) {
        return unknownResult(
          sample,
          'TABLE_FIELD_UNAVAILABLE',
          `${unknownCount} 行表达式无法判定（字段缺失、类型不符或计算错误），无法确认全表结论`,
        )
      }
      return {
        passed: true,
        details: {
          protocol: TABLE_OUTCOME_PROTOCOL,
          totalRowsChecked: sample.rows.length,
          matchedRows: matchedCount,
          violatingRowsCount: 0,
          violatingRows: [],
          presentation: { truncated: false, omittedViolatingRows: 0, truncatedFields: false },
          coverage: coverageDetails,
        },
      }
    }

    // quantifier === 'any'
    if (matchedCount > 0) {
      return {
        passed: true,
        details: {
          protocol: TABLE_OUTCOME_PROTOCOL,
          totalRowsChecked: sample.rows.length - unknownCount,
          matchedRows: matchedCount,
          violatingRowsCount: null,
          violatingRows: [],
          presentation: { truncated: false, omittedViolatingRows: 0, truncatedFields: false },
          coverage: coverageDetails,
        },
      }
    }
    if (unknownCount > 0) {
      return unknownResult(
        sample,
        'TABLE_FIELD_UNAVAILABLE',
        `${unknownCount} 行表达式无法判定（字段缺失、类型不符或计算错误），无法确认是否存在满足条件的行`,
      )
    }
    return {
      passed: false,
      reasonCode: 'NO_ROW_MATCHED',
      reasonMessage: '没有任何行满足行表达式条件',
      details: {
        protocol: TABLE_OUTCOME_PROTOCOL,
        totalRowsChecked: sample.rows.length,
        matchedRows: 0,
        violatingRowsCount: sample.rows.length,
        violatingRows: sampleViolating,
        presentation: {
          truncated: sample.rows.length > 5,
          omittedViolatingRows: Math.max(0, sample.rows.length - 5),
          truncatedFields: false,
        },
        coverage: coverageDetails,
      },
    }
  }

  return unknownResult(sample, 'UNSUPPORTED_RULE', '不支持的表格验收规则')
}

// ---------------------------------------------------------------------------
// 5. Compile-time validation: rules × plan columns
// ---------------------------------------------------------------------------

const MAX_LITERAL_SIGNIFICANT_DIGITS = 15
const MAX_LITERAL_FRACTION_DIGITS = 8

function literalPrecisionError(value: number): string | undefined {
  if (Number.isSafeInteger(value)) return undefined
  const str = String(value)
  const match = /^-?(\d+)(?:\.(\d+))?/.exec(str)
  if (!match) return `数字字面量 ${str} 不是有限十进制数`
  const intDigits = (match[1] ?? '').replace(/^0+/, '')
  const fracDigits = match[2] ?? ''
  const significant = ((intDigits || '0') + fracDigits).replace(/^0+/, '').length
  if (significant > MAX_LITERAL_SIGNIFICANT_DIGITS) {
    return `数字字面量 ${str} 有效位数超过 ${MAX_LITERAL_SIGNIFICANT_DIGITS} 位`
  }
  if (fracDigits.length > MAX_LITERAL_FRACTION_DIGITS) {
    return `数字字面量 ${str} 小数位数超过 ${MAX_LITERAL_FRACTION_DIGITS} 位`
  }
  return undefined
}

function predicateRequiresNumericPolicy(
  numericKind: 'integer' | 'decimal' | 'float',
  value: number,
): boolean {
  if (numericKind === 'integer') {
    return !Number.isInteger(value) || !Number.isSafeInteger(value)
  }
  // decimal / float 列不能依靠默认浮点相等
  return true
}

function rowShapeOf(columns: TableColumnSpec[]): OutputShape {
  return {
    kind: 'object',
    fields: columns.map((col) => ({ name: col.key, type: (col.valueType === 'date' ? 'string' : col.valueType) as 'string' | 'number' | 'boolean', required: true })),
  }
}

type ExprSideProbe = { hasDecimalOrFloatRef: boolean; hasNonIntegerLiteral: boolean; fnFound: Set<string> }

function probeExprSide(expr: Expr, columns: TableColumnSpec[], probe: ExprSideProbe): void {
  switch (expr.kind) {
    case 'literal':
      if (typeof expr.value === 'number' && !Number.isInteger(expr.value)) {
        probe.hasNonIntegerLiteral = true
      }
      return
    case 'ref': {
      const col = columns.find((c) => c.key === expr.field)
      if (col?.valueType === 'number' && col.numericKind && col.numericKind !== 'integer') {
        probe.hasDecimalOrFloatRef = true
      }
      return
    }
    case 'not':
      probeExprSide(expr.arg, columns, probe)
      return
    case 'logic':
      for (const arg of expr.args) probeExprSide(arg, columns, probe)
      return
    case 'compare':
      probeExprSide(expr.left, columns, probe)
      probeExprSide(expr.right, columns, probe)
      return
    case 'call':
      probe.fnFound.add(expr.fn)
      for (const arg of expr.args) probeExprSide(arg, columns, probe)
      return
    default:
      return
  }
}

const FIXED_POLICY_OPERAND_FNS = new Set(['sum', 'diff', 'mul', 'abs'])

function validateRowExpression(
  expr: Expr,
  columns: TableColumnSpec[],
): { valid: true } | { valid: false; code: string; message: string } {
  const walk = (node: Expr): { valid: true } | { valid: false; code: string; message: string } => {
    switch (node.kind) {
      case 'literal': {
        if (typeof node.value === 'number') {
          const err = literalPrecisionError(node.value)
          if (err) return { valid: false, code: 'TABLE_LITERAL_PRECISION', message: err }
        }
        return { valid: true }
      }
      case 'ref': {
        if (node.key !== 'row' || !node.field) {
          return {
            valid: false,
            code: 'TABLE_ROW_REF_REQUIRED',
            message: `行表达式的输入来源只允许 { key: 'row', field: 列key } 引用，收到 key="${node.key}"`,
          }
        }
        if (!columns.some((c) => c.key === node.field)) {
          return {
            valid: false,
            code: 'TABLE_COLUMN_NOT_DECLARED',
            message: `行表达式引用了读取计划未声明的列 "${node.field}"`,
          }
        }
        return { valid: true }
      }
      case 'not':
        return walk(node.arg)
      case 'logic':
        for (const arg of node.args) {
          const res = walk(arg)
          if (!res.valid) return res
        }
        return { valid: true }
      case 'compare': {
        const left = walk(node.left)
        if (!left.valid) return left
        const right = walk(node.right)
        if (!right.valid) return right
        if ((node.op === 'eq' || node.op === 'ne') && !node.numericPolicy) {
          const probe: ExprSideProbe = { hasDecimalOrFloatRef: false, hasNonIntegerLiteral: false, fnFound: new Set() }
          probeExprSide(node.left, columns, probe)
          probeExprSide(node.right, columns, probe)
          if (probe.hasDecimalOrFloatRef || probe.hasNonIntegerLiteral) {
            return {
              valid: false,
              code: 'TABLE_FLOAT_EQ_REQUIRES_POLICY',
              message: 'decimal/float 列或非整数字面量参与的相等比较必须显式声明 numericPolicy，不能依赖默认浮点相等',
            }
          }
        }
        if (node.numericPolicy?.mode === 'fixed') {
          const probe: ExprSideProbe = { hasDecimalOrFloatRef: false, hasNonIntegerLiteral: false, fnFound: new Set() }
          probeExprSide(node.left, columns, probe)
          probeExprSide(node.right, columns, probe)
          const unsupported = [...probe.fnFound].filter((fn) => !FIXED_POLICY_OPERAND_FNS.has(fn))
          if (unsupported.length > 0) {
            return {
              valid: false,
              code: 'TABLE_FIXED_POLICY_OPERAND',
              message: `定点比较的数值子树只支持数字字面量、列引用与 sum/diff/mul/abs，出现不支持函数：${unsupported.join(', ')}`,
            }
          }
        }
        return { valid: true }
      }
      case 'call':
        for (const arg of node.args) {
          const res = walk(arg)
          if (!res.valid) return res
        }
        return { valid: true }
      default:
        return { valid: true }
    }
  }

  const refsOk = walk(expr)
  if (!refsOk.valid) return refsOk

  const rootShape = inferExpressionShape(expr, { row: rowShapeOf(columns) })
  if (rootShape.kind !== 'scalar' || rootShape.type !== 'boolean') {
    return {
      valid: false,
      code: 'TABLE_EXPRESSION_ROOT_BOOLEAN',
      message: '行表达式最终必须返回 boolean',
    }
  }
  return { valid: true }
}

/**
 * Schema 校验之后、编译之前的规则 × 读取计划列类型交叉检查。
 * 人工入口、AI 提案、保存与正式编译共用。
 */
export function validateTableExpectRuleAgainstPlan(
  rule: TableExpectRule,
  columns: TableColumnSpec[],
): { valid: true } | { valid: false; code: string; message: string } {
  if (rule.rule === 'row_count') return { valid: true }

  if (rule.rule === 'column_stat' || rule.rule === 'total_row_match' || rule.rule === 'column_unique') {
    const col = columns.find((c) => c.key === rule.column)
    if (!col) {
      return { valid: false, code: 'TABLE_COLUMN_NOT_DECLARED', message: `规则引用了读取计划未声明的列 "${rule.column}"` }
    }
    if (rule.rule !== 'column_unique' && col.valueType !== 'number') {
      return { valid: false, code: 'TABLE_NUMBER_COLUMN_REQUIRED', message: `合计、平均、最大最小和合计行核对只接受数字列，列 "${col.key}" 是 ${col.valueType}` }
    }
    if (rule.rule === 'column_stat' && rule.numericPolicy && rule.op !== 'eq' && rule.op !== 'neq' && rule.numericPolicy.mode === 'tolerance') {
      return { valid: false, code: 'TABLE_NUMERIC_POLICY_INVALID', message: '容差只适用于相等比较' }
    }
    return { valid: true }
  }

  if (rule.rule === 'all_rows' || rule.rule === 'any_row') {
    const col = columns.find((c) => c.key === rule.column)
    if (!col) {
      return {
        valid: false,
        code: 'TABLE_COLUMN_NOT_DECLARED',
        message: `规则引用了读取计划未声明的列 "${rule.column}"`,
      }
    }
    const pred = rule.predicate
    if ('numericPolicy' in pred && pred.numericPolicy && col.valueType !== 'number') {
      return {
        valid: false,
        code: 'TABLE_NUMERIC_POLICY_ON_NON_NUMBER',
        message: `列 "${col.key}" 不是数字列，不能声明数值精度策略`,
      }
    }
    if (pred.op === 'gt' || pred.op === 'gte' || pred.op === 'lt' || pred.op === 'lte') {
      if (col.valueType !== 'number') {
        return {
          valid: false,
          code: 'TABLE_NUMBER_COLUMN_REQUIRED',
          message: `大小比较只接受数字列，列 "${col.key}" 是 ${col.valueType}`,
        }
      }
      return { valid: true }
    }
    if (pred.op === 'contains' || pred.op === 'starts_with' || pred.op === 'ends_with' || pred.op === 'matches') {
      if (col.valueType !== 'text') {
        return {
          valid: false,
          code: 'TABLE_TEXT_COLUMN_REQUIRED',
          message: `文本谓词只接受文本列，列 "${col.key}" 是 ${col.valueType}`,
        }
      }
      return { valid: true }
    }
    if (pred.op === 'eq' || pred.op === 'neq') {
      const expectedType = col.valueType === 'text' || col.valueType === 'date' ? 'string' : col.valueType
      if (typeof pred.value !== expectedType) {
        return {
          valid: false,
          code: 'TABLE_VALUE_TYPE_MISMATCH',
          message: `eq/neq 的值必须与列类型一致：列 "${col.key}" 是 ${col.valueType}，比较值是 ${typeof pred.value}`,
        }
      }
      if (col.valueType === 'number' && typeof pred.value === 'number') {
        const numericKind = col.numericKind ?? 'float'
        if (!pred.numericPolicy && predicateRequiresNumericPolicy(numericKind, pred.value)) {
          return {
            valid: false,
            code: 'TABLE_FLOAT_EQ_REQUIRES_POLICY',
            message: `数字列 "${col.key}"（${numericKind}）的非精确相等比较必须显式声明 numericPolicy`,
          }
        }
      }
      return { valid: true }
    }
    return { valid: true }
  }

  // row_expression
  return validateRowExpression(rule.expression, columns)
}

export function validateTableExpectRulesAgainstPlan(
  rules: TableExpectRule[],
  columns: TableColumnSpec[],
): { valid: true } | { valid: false; code: string; message: string } {
  for (const rule of rules) {
    const res = validateTableExpectRuleAgainstPlan(rule, columns)
    if (!res.valid) return res
  }
  return { valid: true }
}

