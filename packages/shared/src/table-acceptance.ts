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
    /** 接口来源：字段在 JSON 里的路径（按行读时相对每一行，按列读时是整个响应里的数组路径）。 */
    path: z.string().regex(/^[^.]+(?:\.[^.]+)*$/, '路径须为用点分隔的字段名或序号').max(256).optional(),
    /**
     * 这一列怎么读：缺省读文字；tone＝格里状态组件（标签 / 徽标 / 进度 / 步骤 / 告警）的语义；
     * percent＝进度百分比；order＝第几项（状态区域里的步骤序号）。语义只按组件库官方类名认，认不出记为“未识别”。
     */
    read: z.enum(['text', 'tone', 'percent', 'order']).optional(),
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
/** 一次最多读取的列数（宽报表常有 60+ 列；体积由 maxBytes 预算兜底）。 */
export const TABLE_READ_MAX_COLS = 100
/** 点选识别时默认勾选的列数；其余列在列表里按需勾选。 */
export const TABLE_READ_DEFAULT_SELECTED_COLS = 32
/** 识别结果最多返回的列数。 */
export const TABLE_DETECT_MAX_COLS = 128
export const TABLE_READ_MAX_BYTES_LIMIT = 240 * 1024

/** 交叉表：列维度列的 key（第 i 层为 dim_i）与数值列的 key；行维度沿用读取计划里的列。 */
export const TABLE_CROSSTAB_DIM_PREFIX = 'dim_'
export const TABLE_CROSSTAB_VALUE_KEY = 'value'
export const TABLE_CROSSTAB_MAX_DIMS = 4
/** 合计 / 小计格随记录集内联保存的体积上限；超出时只保留前面的，核对判“无法确认”。 */
export const TABLE_CROSSTAB_TOTALS_MAX_BYTES = 40 * 1024

/**
 * 交叉表（透视表）读法：读取计划里的列是行维度（表格最前面的几列），其余列按表头层级拆成列维度，
 * 每个数值格变成长表的一行 { 行维度…, 列维度…, 值 }。表头或行头是“合计 / 小计”的格单独作为汇总，不进长表。
 */
export const tableCrosstabLayoutSchema = z.strictObject({
  mode: z.literal('crosstab'),
  /** 列头每一层叫什么（自上而下）；表头比这更深时，多出的层并进最后一层。 */
  columnDims: z.array(z.string().trim().min(1).max(64)).min(1).max(TABLE_CROSSTAB_MAX_DIMS),
  value: z
    .strictObject({
      name: z.string().trim().min(1).max(64).default('值'),
      numericKind: tableNumericKindSchema.default('decimal'),
      /** 数值把“万 / 亿”换算为数值；缺省不换算。 */
      scaleUnits: z.boolean().optional(),
    })
    .default({ name: '值', numericKind: 'decimal' }),
})
export type TableCrosstabLayout = z.infer<typeof tableCrosstabLayoutSchema>

export const tableReadPlanV2Schema = z.strictObject({
  protocol: z.literal(TABLE_READ_PROTOCOL_V2),
  /** 表根的完整目标描述（含 framePath）。采样器按它定位，不再只认第一个 css 候选。 */
  target: targetDescriptorSchema,
  scope: z.literal('current_page').default('current_page'),
  /** 读取形态：缺省按表格；cards = 一组重复卡片（每张一行），keyvalue = 一块“名称：值”信息（一行），status = 一组状态（步骤条 / 告警 / 标签，每个一行）。 */
  kind: z.enum(['table', 'cards', 'keyvalue', 'status']).optional(),
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
  columns: z.array(tableColumnSpecSchema).min(1).max(TABLE_READ_MAX_COLS),
  /**
   * 读法：缺省按普通平铺读；tree＝树形表格，每行另带层级（rowMeta）与“层级路径”列，
   * scope 选全部已展开的行 / 只取顶层 / 只取最底层。有没展开的节点就判“部分”（只取顶层时除外）。
   * crosstab＝交叉表，逆透视成长表（见 tableCrosstabLayoutSchema）。
   */
  layout: z
    .discriminatedUnion('mode', [
      /** 认出了层级，但用户选了按普通读（保留这个选择，编辑器里“读法”开关才不会消失）。 */
      z.strictObject({ mode: z.literal('flat') }),
      z.strictObject({ mode: z.literal('tree'), scope: z.enum(['all', 'top', 'leaf']).default('all') }),
      tableCrosstabLayoutSchema,
    ])
    .optional(),
  readiness: tableReadinessPolicySchema.optional(),
  limits: z
    .strictObject({
      maxRows: z.number().int().min(1).max(200).default(200),
      maxCols: z.number().int().min(1).max(TABLE_READ_MAX_COLS).default(TABLE_READ_MAX_COLS),
      maxBytes: z.number().int().min(8 * 1024).max(TABLE_READ_MAX_BYTES_LIMIT).default(TABLE_READ_DEFAULT_MAX_BYTES),
    })
    .default({ maxRows: 200, maxCols: TABLE_READ_MAX_COLS, maxBytes: TABLE_READ_DEFAULT_MAX_BYTES }),
})
export type TableReadPlanV2 = z.infer<typeof tableReadPlanV2Schema>
export type TableReadPlanV1 = z.infer<typeof tableReadPlanV1Schema>

/** v2 在前：显式带 protocol 的走 v2；缺省 protocol 的旧计划落到 v1。 */
export const tableReadPlanSchema = z.union([tableReadPlanV2Schema, tableReadPlanV1Schema])
export type TableReadPlan = z.infer<typeof tableReadPlanSchema>

export function isTableReadPlanV2(plan: TableReadPlan): plan is TableReadPlanV2 {
  return plan.protocol === TABLE_READ_PROTOCOL_V2
}

/**
 * 状态语义：按组件库官方类名的显式映射表认（antd、Element、Bootstrap、layui、ARIA），表外一律 unknown，不按颜色猜。
 * 读出来 unknown 的格记为读不出（“未识别”），拿它作条件时判“无法确认”。
 */
export const TABLE_STATUS_TONES = ['success', 'warning', 'error', 'info', 'processing', 'default'] as const
export type TableStatusTone = (typeof TABLE_STATUS_TONES)[number]
export const TABLE_STATUS_TONE_LABEL: Record<TableStatusTone, string> = {
  success: '成功',
  warning: '警告',
  error: '错误',
  info: '信息',
  processing: '进行中',
  default: '默认',
}

/** 树形读取时系统加的一列：祖先与自身首列文字用“ / ”连接（如“华东 / 上海 / 站点0001”），可用作检查条件。 */
export const TABLE_TREE_PATH_KEY = 'tree_path'
export const TABLE_TREE_PATH_NAME = '层级路径'
export const TABLE_TREE_PATH_COLUMN: TableColumnSpec = { key: TABLE_TREE_PATH_KEY, name: TABLE_TREE_PATH_NAME, valueType: 'text' }

/** 交叉表长表在行维度之后追加的列：每层列维度一列（文字），最后是数值。 */
export function tableCrosstabExtraColumns(layout: TableCrosstabLayout): TableColumnSpec[] {
  return [
    ...layout.columnDims.map((name, i) => ({ key: `${TABLE_CROSSTAB_DIM_PREFIX}${i + 1}`, name, valueType: 'text' as const })),
    {
      key: TABLE_CROSSTAB_VALUE_KEY,
      name: layout.value.name,
      valueType: 'number' as const,
      numericKind: layout.value.numericKind,
      ...(layout.value.scaleUnits ? { scaleUnits: true } : {}),
    },
  ]
}

/** 数据检查可引用的列：读取计划里的列；树形读取时另有“层级路径”；交叉表是长表的列（行维度、列维度、数值）。 */
export function tablePlanCheckColumns(plan: {
  columns: TableColumnSpec[]
  layout?: { mode: 'flat' } | { mode: 'tree' } | TableCrosstabLayout
}): TableColumnSpec[] {
  if (plan.layout?.mode === 'crosstab') return [...plan.columns, ...tableCrosstabExtraColumns(plan.layout)]
  return plan.layout?.mode === 'tree' && !plan.columns.some((c) => c.key === TABLE_TREE_PATH_KEY) ? [...plan.columns, TABLE_TREE_PATH_COLUMN] : plan.columns
}

/** 交叉表计划自身是否成立：行维度只能是表头列，列维度名不重名、不与行维度重名，列 key 不占用长表保留的 key。 */
export function validateCrosstabPlan(plan: Pick<TableReadPlanV2, 'columns' | 'layout' | 'kind'>): { valid: true } | { valid: false; code: string; message: string } {
  const layout = plan.layout
  if (layout?.mode !== 'crosstab') return { valid: true }
  if (plan.kind && plan.kind !== 'table') return { valid: false, code: 'TABLE_CROSSTAB_KIND', message: '只有表格能按交叉表读，卡片 / 详情 / 状态不行' }
  for (const c of plan.columns) {
    if (c.key === TABLE_CROSSTAB_VALUE_KEY || c.key.startsWith(TABLE_CROSSTAB_DIM_PREFIX)) {
      return { valid: false, code: 'TABLE_CROSSTAB_KEY_RESERVED', message: `行维度列的 key「${c.key}」与交叉表长表的列冲突` }
    }
    if (c.selector || (c.read && c.read !== 'text')) {
      return { valid: false, code: 'TABLE_CROSSTAB_ROW_DIM_INVALID', message: `行维度「${c.label ?? c.name}」须是表格里的一列（按表头或第几列取），不能是选择器或状态读法` }
    }
  }
  const names = [...plan.columns.map((c) => c.label ?? c.name), ...layout.columnDims, layout.value.name]
  const dup = names.find((n, i) => names.indexOf(n) !== i)
  if (dup) return { valid: false, code: 'TABLE_CROSSTAB_NAME_DUPLICATE', message: `交叉表里有两列都叫「${dup}」，请给列头各层或数值换个名字` }
  return { valid: true }
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

export const tableSampleSourceKindSchema = z.enum(['page', 'file', 'network'])
export type TableSampleSourceKind = z.infer<typeof tableSampleSourceKindSchema>

/** 外置记录集对象的格式：JSON 行，首行为头（协议、列 key、行数），之后每行一条记录；合计行在头里。 */
export const TABLE_RECORDSET_PROTOCOL = 'table.recordset@1' as const
export const TABLE_RECORDSET_CONTENT_TYPE = 'application/x-ndjson'
/** 上下文里保留的预览行数上限；全量在外置对象里。 */
export const TABLE_SAMPLE_PREVIEW_ROWS = 200
/** 一个外置记录集至多多少行；超出截断并标为部分。 */
export const TABLE_RECORDSET_MAX_ROWS = 50_000
/** 外置对象正文上限（另受对象存储单对象上限约束，取两者较小值）。 */
export const TABLE_RECORDSET_MAX_BYTES = 32 * 1024 * 1024
/** 导出文件来源：单个文件上限。 */
export const TABLE_FILE_MAX_BYTES = 20 * 1024 * 1024
/** 接口来源：单个响应体上限。 */
export const TABLE_NETWORK_RESPONSE_MAX_BYTES = 5 * 1024 * 1024

export const tableRecordSetStorageSchema = z.strictObject({
  protocol: z.literal(TABLE_RECORDSET_PROTOCOL),
  objectKey: z.string().min(1).max(512),
  digest: z.string().min(1).max(128),
  /** 外置对象里的数据行数（= 全量行数）。 */
  rowCount: z.number().int().nonnegative(),
  byteSize: z.number().int().nonnegative(),
  /** 对应的证据记录（type=file），运行复盘据此提供“下载全量数据”。 */
  evidenceId: entityIdSchema.optional(),
})
export type TableRecordSetStorage = z.infer<typeof tableRecordSetStorageSchema>

/**
 * 页面元信息：分页条上直接显示的数字。读不到的字段就不给，不推算（例如不拿“总页数 × 每页条数”反推总条数）；
 * 同一字段在分页条上出现互相矛盾的数字时也不给。rowRange 是分页条上显示的“第 from 到 to 条”。
 */
export const tablePageInfoSchema = z.strictObject({
  totalRows: z.number().int().nonnegative().optional(),
  currentPage: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().optional(),
  totalPages: z.number().int().positive().optional(),
  rowRange: z.strictObject({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative() }).optional(),
  /** 分页条原文（截断），便于复盘核对读数。 */
  rawText: z.string().max(240),
})
export type TablePageInfo = z.infer<typeof tablePageInfoSchema>

// ---------------------------------------------------------------------------
// 文件来源：把下载步骤存下的文件（CSV / XLSX / HTML 伪 XLS）读成记录集
// ---------------------------------------------------------------------------

export const TABLE_FILE_PROTOCOL = 'table.file@1' as const
export const TABLE_FILE_FORMATS = ['csv', 'xlsx', 'html'] as const
export const tableFileFormatSchema = z.enum(['auto', ...TABLE_FILE_FORMATS])

export const tableFilePlanSchema = z.strictObject({
  protocol: z.literal(TABLE_FILE_PROTOCOL),
  /** 下载步骤的输出名（上下文里的文件句柄）。 */
  fromKey: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/, '须为下载步骤的输出名'),
  /** 缺省按文件头识别；扩展名只作参考。 */
  format: tableFileFormatSchema.default('auto'),
  /** XLSX：按名称或序号（从 0 起）选工作表；缺省取第一个有数据的工作表。 */
  sheet: z
    .strictObject({
      name: z.string().min(1).max(128).optional(),
      index: z.number().int().min(0).max(255).optional(),
    })
    .optional(),
  /** 表头在第几行（从 1 起）、占几行；auto 时跳过标题 / 说明行自动找。 */
  header: z
    .strictObject({
      row: z.union([z.literal('auto'), z.number().int().min(1).max(10_000)]).default('auto'),
      rows: z.union([z.literal('auto'), z.number().int().min(1).max(4)]).default('auto'),
    })
    .default({ row: 'auto', rows: 'auto' }),
  /** 数据区：起止行（从 1 起，含）；缺省从表头下一行开始，遇到整行空白就停。 */
  range: z
    .strictObject({
      startRow: z.number().int().min(1).optional(),
      endRow: z.number().int().min(1).optional(),
      stopAtBlankRow: z.boolean().default(true),
    })
    .default({ stopAtBlankRow: true }),
  encoding: z.enum(['auto', 'utf-8', 'gb18030']).default('auto'),
  delimiter: z.enum(['auto', 'comma', 'tab', 'semicolon']).default('auto'),
  /** 合计行：缺省按“首列文字是 合计 / 总计 …”自动识别；可手工指定某列等于某文字的行。 */
  totalRow: z
    .strictObject({
      columnKey: z.string().min(1).max(64),
      equals: z.string().min(1).max(128),
    })
    .optional(),
  columns: z.array(tableColumnSpecSchema).min(1).max(TABLE_READ_MAX_COLS),
  limits: z
    .strictObject({
      maxRows: z.number().int().min(1).max(TABLE_RECORDSET_MAX_ROWS).default(TABLE_RECORDSET_MAX_ROWS),
    })
    .default({ maxRows: TABLE_RECORDSET_MAX_ROWS }),
})
export type TableFilePlan = z.infer<typeof tableFilePlanSchema>

// ---------------------------------------------------------------------------
// 接口来源：把页面自己发出的 JSON 接口响应读成记录集（只读、不重放、不存请求头）
// ---------------------------------------------------------------------------

export const TABLE_NETWORK_PROTOCOL = 'table.network@1' as const
/** 受管页面的接口响应缓冲：最近多少个、总计多大（先进先出）。单个响应上限见 TABLE_NETWORK_RESPONSE_MAX_BYTES。 */
export const TABLE_NETWORK_CAPTURE_MAX_ENTRIES = 30
export const TABLE_NETWORK_CAPTURE_MAX_BYTES = 16 * 1024 * 1024
export const TABLE_NETWORK_WAIT_MAX_MS = 60_000
export const TABLE_NETWORK_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

/** JSON 路径：用点分隔的字段名或数组序号，如 data.list、series.0.data。 */
export const tableJsonPathSchema = z.string().regex(/^[^.]+(?:\.[^.]+)*$/, '路径须为用点分隔的字段名或序号').max(256)

export const tableNetworkMatchSchema = z.strictObject({
  /** 地址里包含的片段；只和去掉查询串的地址比，时间戳等查询参数不影响匹配。 */
  url: z.string().trim().min(1).max(512),
  method: z.enum(TABLE_NETWORK_METHODS).optional(),
  /** 期望的状态码；缺省要求 2xx。 */
  status: z.number().int().min(100).max(599).optional(),
})
export type TableNetworkMatch = z.infer<typeof tableNetworkMatchSchema>

export const tableNetworkPlanSchema = z
  .strictObject({
    protocol: z.literal(TABLE_NETWORK_PROTOCOL),
    match: tableNetworkMatchSchema,
    /** latest：取窗口内最近一个；single：窗口内必须恰好一个，多个就报错。 */
    pick: z.enum(['latest', 'single']).default('latest'),
    /**
     * 什么时候的响应：page_load＝当前页面加载以来（缺省）；step_start＝本步开始后的新响应。
     * 窗口内还没有匹配、或匹配的请求还在途时，最多等 waitMs。
     */
    window: z
      .strictObject({
        since: z.enum(['page_load', 'step_start']).default('page_load'),
        waitMs: z.number().int().min(0).max(TABLE_NETWORK_WAIT_MAX_MS).default(10_000),
      })
      .default({ since: 'page_load', waitMs: 10_000 }),
    /** rows：rowsPath 指向对象数组，每项一行，列路径相对每一项；columns：图表常见的“列式”数据，每列路径指向一个数组，按下标拼行。 */
    layout: z.enum(['rows', 'columns']).default('rows'),
    rowsPath: tableJsonPathSchema.optional(),
    /** 接口给出的总条数字段，读出来作为分页信息的总条数。 */
    totalPath: tableJsonPathSchema.optional(),
    columns: z.array(tableColumnSpecSchema).min(1).max(TABLE_READ_MAX_COLS),
    limits: z
      .strictObject({
        maxRows: z.number().int().min(1).max(TABLE_RECORDSET_MAX_ROWS).default(TABLE_RECORDSET_MAX_ROWS),
      })
      .default({ maxRows: TABLE_RECORDSET_MAX_ROWS }),
  })
  .superRefine((plan, ctx) => {
    if (plan.layout === 'rows' && !plan.rowsPath) ctx.addIssue({ code: 'custom', path: ['rowsPath'], message: '按行读取须指定数据行所在的数组' })
    if (plan.layout === 'columns' && plan.rowsPath) ctx.addIssue({ code: 'custom', path: ['rowsPath'], message: '按列读取时每列各自指定数组路径，不用 rowsPath' })
    plan.columns.forEach((col, i) => {
      if (!col.path) ctx.addIssue({ code: 'custom', path: ['columns', i, 'path'], message: `列「${col.name}」缺少字段路径` })
    })
  })
export type TableNetworkPlan = z.infer<typeof tableNetworkPlanSchema>

/** 记录集里“匹配到哪个请求”的描述：只有方法、去掉查询串的地址、状态码、时间、大小与摘要，不含请求头与响应原文。 */
export const tableNetworkRequestSchema = z.strictObject({
  method: z.string().min(1).max(16),
  url: z.string().min(1).max(2048),
  status: z.number().int().min(0).max(999),
  at: utcInstantSchema,
  byteSize: z.number().int().nonnegative(),
  digest: z.string().min(1).max(128),
})
export type TableNetworkRequest = z.infer<typeof tableNetworkRequestSchema>

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
    /** 数据从哪来：页面 DOM（缺省）、下载的文件、页面发出的接口响应。 */
    kind: tableSampleSourceKindSchema.optional(),
    /** 文件来源：读的是哪个文件、什么格式、哪个工作表。 */
    file: z
      .strictObject({
        name: z.string().min(1).max(255),
        format: z.enum(['csv', 'xlsx', 'html']),
        sheet: z.string().max(128).optional(),
        encoding: z.string().max(32).optional(),
      })
      .optional(),
    /** 接口来源：匹配到的是哪个请求（去敏描述）。 */
    request: tableNetworkRequestSchema.optional(),
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
  /** 分页条上读到的分页信息（只有读到才有）。 */
  pageInfo: tablePageInfoSchema.optional(),
  /**
   * 树形读取：与 rows 一一对应的层级信息。level 从 0 起；parentIndex 是父行在 rows 里的位置（父行没读进来时不给）；
   * expanded 只在有子行时给（false＝没展开，它的子行没读到）。
   */
  rowMeta: z
    .array(
      z.strictObject({
        level: z.number().int().min(0).max(64),
        parentIndex: z.number().int().nonnegative().optional(),
        hasChildren: z.boolean(),
        expanded: z.boolean().optional(),
      }),
    )
    .optional(),
  /**
   * 交叉表读取：rows 是逆透视后的长表（只含明细格）；表头或行头为“合计 / 小计”的格单独放在 totals 里。
   * 每个合计格的 rowLevel / colLevel 说明它汇总的范围：前 rowLevel 个行维度、前 colLevel 层列维度与它相同的明细格
   * （等于维度个数时就是同一行 / 同一列）。dims 是行维度在前、列维度在后的显示文字。
   */
  crosstab: z
    .strictObject({
      rowDims: z.array(z.string()).min(1),
      colDims: z.array(z.string()).min(1).max(TABLE_CROSSTAB_MAX_DIMS),
      valueKey: z.string(),
      /** 逆透视前：读到的数据行数与数值列数。 */
      sourceRows: z.number().int().nonnegative(),
      sourceColumns: z.number().int().nonnegative(),
      totals: z.array(
        z.strictObject({
          rowLevel: z.number().int().min(0).max(64),
          colLevel: z.number().int().min(0).max(TABLE_CROSSTAB_MAX_DIMS),
          dims: z.array(z.string().nullable()),
          value: tableRowFieldSchema,
        }),
      ),
      /** 合计格太多、超出内联上限，只保留了前面的。 */
      totalsTruncated: z.boolean().optional(),
    })
    .optional(),
  presentation: z.strictObject({
    omitted: z.boolean().default(false),
    previewCount: z.number().int().nonnegative().default(20),
  }),
  /**
   * 大记录集外置：完整行写成运行对象（见 TABLE_RECORDSET_PROTOCOL），这里的 rows 只是前若干行预览。
   * 数据检查必须先按句柄加载全量；没加载就求值一律“无法确认”，不拿预览下结论。
   */
  storage: tableRecordSetStorageSchema.optional(),
})
export type TableSample = z.infer<typeof tableSampleSchema>

// ---------------------------------------------------------------------------
// 3. Table Predicates & Rules
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// 日期谓词的日期运算（只到“天”，不带时区的页面日期按字符串比较）
// ---------------------------------------------------------------------------

export const DEFAULT_TABLE_TIMEZONE = 'Asia/Shanghai'

export function isValidIsoDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return false
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1) return false
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate()
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** 取值的日期部分（YYYY-MM-DD，可带 “ HH:mm:ss” / “T…”）；不是合法日期返回 null。 */
export function datePartOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const head = /^(\d{4}-\d{2}-\d{2})(?:[ T].*)?$/.exec(value.trim())?.[1]
  return head && isValidIsoDate(head) ? head : null
}

/** 某个时刻在指定时区下的日期（YYYY-MM-DD）。 */
export function dateInTimeZone(instant: string, timezone: string): string | null {
  const t = new Date(instant)
  if (Number.isNaN(t.getTime()) || !isValidTimeZone(timezone)) return null
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(t)
  const get = (type: string) => parts.find((p) => p.type === type)?.value
  return `${get('year')}-${get('month')}-${get('day')}`
}

export function addDaysToIsoDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

export type TablePredicateContext = { sampledAt?: string }

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
  /** 日期列与固定日期比较（只比日期部分，值为 YYYY-MM-DD）。 */
  z.strictObject({
    op: z.enum(['date_on', 'date_before', 'date_after', 'date_on_or_before', 'date_on_or_after']),
    value: z.string().refine(isValidIsoDate, { message: '日期须为 YYYY-MM-DD' }),
  }),
  /** 日期不早于“今天往前 N 天”（N=0 即今天）；今天按采样时刻在 timezone 下取日期。 */
  z.strictObject({
    op: z.literal('date_within_days'),
    days: z.number().int().min(0).max(3650),
    allowFuture: z.boolean().default(false),
    timezone: z.string().min(1).max(64).default(DEFAULT_TABLE_TIMEZONE).refine(isValidTimeZone, { message: '不支持的时区' }),
  }),
])
export type TablePredicate = z.infer<typeof tablePredicateSchema>

/** 条件行检查里的一个条件：某一列满足某个谓词。 */
export const TABLE_LOOKUP_MAX_CONDITIONS = 3
export const tableConditionSchema = z.strictObject({
  column: z.string().min(1).max(64),
  predicate: tablePredicateSchema,
})
export type TableCondition = z.infer<typeof tableConditionSchema>

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
  /** 树形读取：每个父行的数字列等于它直接子行之和（精度规则同合计行核对）。 */
  z.strictObject({
    rule: z.literal('tree_rollup_match'),
    column: z.string().min(1).max(64),
    precision: z.enum(['display', 'exact']).default('display'),
  }),
  /** 交叉表读取：每个合计 / 小计格等于它汇总范围内明细格之和（空格当 0；精度规则同合计行核对）。 */
  z.strictObject({
    rule: z.literal('crosstab_total_match'),
    precision: z.enum(['display', 'exact']).default('display'),
  }),
  /** 列里没有重复值（去首尾空白后比较，空值不参与）。 */
  z.strictObject({
    rule: z.literal('column_unique'),
    column: z.string().min(1).max(64),
  }),
  /** 分页条显示的总条数与给定数值比较（总条数读自分页条，不是本页行数）。 */
  z.strictObject({
    rule: z.literal('page_total'),
    op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte']),
    value: z.number().int().nonnegative(),
  }),
  /** 本页读到的行数与分页条一致（显示的“第 x 到 y 条”，或按每页条数、总条数、当前页算出的本页应有条数）。 */
  z.strictObject({
    rule: z.literal('page_consistency'),
  }),
  /**
   * 与另一份数据一致：本步的记录集和本步之前另一个提取步骤的记录集，按键列逐行比对指定列，
   * 报告缺行、多行与值不一致（例如“页面表格与接口返回一致”）。
   */
  z.strictObject({
    rule: z.literal('record_sets_match'),
    /** 另一份数据：之前某个提取步骤的输出名。 */
    otherKey: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/, '须为提取步骤的输出名'),
    key: z.strictObject({ column: z.string().min(1).max(64), otherColumn: z.string().min(1).max(64) }),
    columns: z
      .array(
        z.strictObject({
          column: z.string().min(1).max(64),
          otherColumn: z.string().min(1).max(64),
          /** display：数字按两边中较少的小数位比较（页面显示常四舍五入）；exact：精确比较。 */
          precision: z.enum(['display', 'exact']).default('display'),
        }),
      )
      .min(1)
      .max(TABLE_READ_MAX_COLS),
  }),
  /**
   * 找到某一行，再检查它：先按 where 找行（全部满足才算这一行），再要求找到的行满足 expect。
   * 找不到这一行、找到多行怎么办由 onMissing / onMultiple 明确声明，不靠 any / all 的隐含语义。
   */
  z.strictObject({
    rule: z.literal('row_lookup'),
    where: z.array(tableConditionSchema).min(1).max(TABLE_LOOKUP_MAX_CONDITIONS),
    expect: z.array(tableConditionSchema).min(1).max(TABLE_LOOKUP_MAX_CONDITIONS),
    onMissing: z.enum(['fail', 'unknown', 'pass']).default('fail'),
    onMultiple: z.enum(['all', 'any']).default('all'),
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
  /** 条件行检查（row_lookup）的补充：一句人话、命中的行、找不到时最接近的名称。 */
  lookup: z
    .strictObject({
      summary: z.string().max(512),
      matched: z
        .array(
          z.strictObject({
            rowIndex: z.number().int().nonnegative(),
            cells: z.array(z.strictObject({ column: z.string().max(64), text: z.string().max(128) })).max(8),
          }),
        )
        .max(5),
      closest: z.array(z.string().max(128)).max(3),
    })
    .optional(),
  /** 与另一份数据比对（record_sets_match）的补充：一句人话与缺行 / 多行 / 值不一致的行数。 */
  compare: z
    .strictObject({
      summary: z.string().max(512),
      otherRowCount: z.number().int().nonnegative(),
      /** 另一份有、本表没有。 */
      missing: z.number().int().nonnegative(),
      /** 本表有、另一份没有。 */
      extra: z.number().int().nonnegative(),
      mismatched: z.number().int().nonnegative(),
    })
    .optional(),
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
  context: TablePredicateContext = {},
): TablePredicateOutcome {
  if (!field || field.status === 'missing') {
    return { status: 'unknown', reasonCode: 'FIELD_MISSING', reasonSummary: '字段缺失或未读取到' }
  }
  if (field.status === 'error') {
    return { status: 'unknown', reasonCode: 'FIELD_PARSE_ERROR', reasonSummary: field.rawText ? `字段值读不出（${field.rawText.slice(0, 60)}）` : '字段值解析失败' }
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
  if (
    predicate.op === 'date_on' || predicate.op === 'date_before' || predicate.op === 'date_after' ||
    predicate.op === 'date_on_or_before' || predicate.op === 'date_on_or_after' || predicate.op === 'date_within_days'
  ) {
    if (val === null || val === undefined || val === '') {
      return { status: 'unknown', reasonCode: 'DATE_EMPTY', reasonSummary: '日期为空，无法比较' }
    }
    const actual = datePartOf(val)
    if (!actual) {
      return { status: 'unknown', reasonCode: 'NOT_A_DATE', reasonSummary: `期望日期，实际值「${JSON.stringify(val) ?? val}」不是日期，不做隐式转换` }
    }
    if (predicate.op === 'date_within_days') {
      const today = context.sampledAt ? dateInTimeZone(context.sampledAt, predicate.timezone) : null
      if (!today) {
        return { status: 'unknown', reasonCode: 'TODAY_UNAVAILABLE', reasonSummary: '没有可用的采样时刻，无法确定“今天”' }
      }
      const earliest = addDaysToIsoDate(today, -predicate.days)
      if (actual < earliest) {
        return { status: 'fail', reasonCode: 'DATE_TOO_OLD', reasonSummary: `日期是 ${actual}，早于 ${earliest}（运行当天 ${today} 往前 ${predicate.days} 天，按 ${predicate.timezone}）` }
      }
      if (!predicate.allowFuture && actual > today) {
        return { status: 'fail', reasonCode: 'DATE_IN_FUTURE', reasonSummary: `日期是 ${actual}，晚于运行当天 ${today}（按 ${predicate.timezone}）` }
      }
      return { status: 'pass' }
    }
    const target = predicate.value
    const ok =
      predicate.op === 'date_on' ? actual === target
      : predicate.op === 'date_before' ? actual < target
      : predicate.op === 'date_after' ? actual > target
      : predicate.op === 'date_on_or_before' ? actual <= target
      : actual >= target
    return ok
      ? { status: 'pass' }
      : { status: 'fail', reasonCode: 'DATE_COMPARE_FAILED', reasonSummary: `日期是 ${actual}，不满足${describeTablePredicate(predicate)}` }
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


// ---------------------------------------------------------------------------
// 条件行检查（row_lookup）
// ---------------------------------------------------------------------------

type LookupRule = Extract<TableExpectRule, { rule: 'row_lookup' }>

const PREDICATE_OP_TEXT: Record<string, string> = {
  eq: '等于',
  neq: '不等于',
  gt: '大于',
  gte: '大于等于',
  date_on: '是',
  date_before: '早于',
  date_after: '晚于',
  date_on_or_before: '不晚于',
  date_on_or_after: '不早于',
  lt: '小于',
  lte: '小于等于',
  contains: '包含',
  starts_with: '以…开头',
  ends_with: '以…结尾',
  matches: '匹配',
}

/** 把谓词说成一句人话：等于「X」 / 不等于 0 / 为空。 */
export function describeTablePredicate(predicate: TablePredicate): string {
  if (predicate.op === 'is_empty') return '为空'
  if (predicate.op === 'is_not_empty') return '不为空'
  if (predicate.op === 'date_within_days') {
    const base = predicate.days === 0 ? '是今天' : predicate.days === 1 ? '不早于昨天' : `不早于 ${predicate.days} 天前`
    return `${base}（按${predicate.timezone === DEFAULT_TABLE_TIMEZONE ? '北京时间' : predicate.timezone}的运行当天算${predicate.allowFuture ? '，允许晚于今天' : ''}）`
  }
  const v = (predicate as { value: string | number | boolean }).value
  if (typeof predicate.op === 'string' && predicate.op.startsWith('date_')) return `${PREDICATE_OP_TEXT[predicate.op]} ${v}`
  // 状态语义的取值是英文代号，给人看时换成中文
  const tone = typeof v === 'string' && (TABLE_STATUS_TONES as readonly string[]).includes(v) ? TABLE_STATUS_TONE_LABEL[v as TableStatusTone] : null
  const shown = tone ? `「${tone}」` : typeof v === 'string' ? `「${v}」` : String(v)
  if (predicate.op === 'starts_with') return `以${shown}开头`
  if (predicate.op === 'ends_with') return `以${shown}结尾`
  return `${PREDICATE_OP_TEXT[predicate.op] ?? predicate.op}${typeof v === 'string' ? '' : ' '}${shown}`
}

function conditionsText(conds: readonly TableCondition[], nameOf: (key: string) => string): string {
  return conds.map((c) => `「${nameOf(c.column)}」${describeTablePredicate(c.predicate)}`).join('，并且')
}

/** 最长公共子串长度，用来给“找不到”时挑最接近的名称。 */
function commonSubstringLength(a: string, b: string): number {
  let best = 0
  const prev = new Array<number>(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    let diagonal = 0
    for (let j = 1; j <= b.length; j++) {
      const keep = prev[j] ?? 0
      prev[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : 0
      if ((prev[j] ?? 0) > best) best = prev[j] ?? 0
      diagonal = keep
    }
  }
  return best
}

/** 最接近目标文字的值（仅展示用，不参与判定）：公共片段占比 ≥ 0.4，最多 3 个，去重。 */
export function closestTexts(target: string, candidates: readonly string[], limit = 3): string[] {
  const t = target.trim()
  if (!t) return []
  const seen = new Set<string>()
  const scored: Array<{ text: string; score: number }> = []
  for (const raw of candidates) {
    const text = raw.trim()
    if (!text || text === t || seen.has(text)) continue
    seen.add(text)
    const score = commonSubstringLength(t, text) / Math.max(t.length, text.length)
    if (score >= 0.4) scored.push({ text, score })
  }
  return scored.sort((x, y) => y.score - x.score).slice(0, limit).map((x) => x.text)
}

function lookupDetails(
  sample: TableSample,
  coverage: TableOutcomeDetails['coverage'],
  lookup: NonNullable<TableOutcomeDetails['lookup']>,
  violating: TableViolatingRowPreview[],
  matchedCount: number,
): TableOutcomeDetails {
  return {
    protocol: TABLE_OUTCOME_PROTOCOL,
    totalRowsChecked: sample.rows.length,
    matchedRows: matchedCount,
    violatingRowsCount: violating.length,
    violatingRows: violating.slice(0, 5),
    presentation: { truncated: violating.length > 5, omittedViolatingRows: Math.max(0, violating.length - 5), truncatedFields: false },
    coverage,
    lookup,
  }
}

function evaluateRowLookup(
  sample: TableSample,
  rule: LookupRule,
  coverage: TableOutcomeDetails['coverage'],
): TableEvaluationResult {
  const nameOf = (key: string): string => sample.columns.find((c) => c.key === key)?.name ?? key
  const whereText = conditionsText(rule.where, nameOf)
  const expectText = conditionsText(rule.expect, nameOf)
  const textOfField = (field: TableRowField | undefined): string => {
    if (!field || field.status === 'missing') return '（空）'
    if (field.status === 'masked') return '（已遮蔽）'
    if (field.status === 'error') return field.rawText ?? '（读不出）'
    return String(field.rawText ?? field.value ?? '（空）').slice(0, 128)
  }
  const usedColumns = Array.from(new Set([...rule.where, ...rule.expect].map((c) => c.column))).slice(0, 8)
  const previewOf = (i: number) => ({
    rowIndex: i,
    cells: usedColumns.map((column) => ({ column: nameOf(column), text: textOf(sample.rows[i]?.[column]) })),
  })
  const textOf = textOfField

  const matched: number[] = []
  const undetermined: number[] = []
  sample.rows.forEach((row, i) => {
    const results = rule.where.map((c) => checkTablePredicate(row[c.column], c.predicate, { sampledAt: sample.source.sampledAt }))
    if (results.some((r) => r.status === 'fail')) return
    if (results.some((r) => r.status === 'unknown')) undetermined.push(i)
    else matched.push(i)
  })
  const rowsText = (rows: number[]): string => `第 ${rows.slice(0, 5).map((r) => r + 1).join('、')} 行${rows.length > 5 ? `等 ${rows.length} 行` : ''}`

  if (matched.length === 0) {
    if (undetermined.length > 0) {
      return unknownResult(
        sample,
        'TABLE_LOOKUP_UNDETERMINED',
        `有 ${undetermined.length} 行（${rowsText(undetermined)}）的值读不出或已遮蔽，无法确认其中有没有${whereText}的行`,
      )
    }
    const first = rule.where[0]
    const target = first && 'value' in first.predicate && typeof first.predicate.value === 'string' ? first.predicate.value : ''
    const closest =
      first && target
        ? closestTexts(
            target,
            sample.rows.map((r) => {
              const f = r[first.column]
              return f && f.status === 'ok' && f.value !== null ? String(f.value) : ''
            }),
          )
        : []
    const missingText = `没有找到${whereText}的行（共读取 ${sample.rows.length} 行）`
    const lookup = { summary: missingText.slice(0, 512), matched: [], closest }
    if (rule.onMissing === 'pass') return { passed: true, details: lookupDetails(sample, coverage, lookup, [], 0) }
    // 表有分页时只读了本页：本页没有不等于没有——不能判“不通过”，只能说无法确认
    if (sample.coverage.clues?.includes('pagination_present')) {
      return unknownResult(
        sample,
        'ROW_NOT_FOUND_PAGED',
        `${missingText}。这张表还有分页，只读了本页，不能确认其他页里有没有这一行`,
      )
    }
    if (rule.onMissing === 'unknown') return unknownResult(sample, 'ROW_NOT_FOUND', missingText)
    return {
      passed: false,
      reasonCode: 'ROW_NOT_FOUND',
      reasonMessage: missingText,
      details: lookupDetails(sample, coverage, lookup, [], 0),
    }
  }

  // 找到了：逐个命中行判断 expect
  type RowVerdict = { index: number; status: 'pass' | 'fail' | 'unknown'; reason: string }
  const verdicts: RowVerdict[] = matched.map((i) => {
    const row = sample.rows[i] as Record<string, TableRowField>
    const failed: string[] = []
    const unknowns: string[] = []
    for (const c of rule.expect) {
      const r = checkTablePredicate(row[c.column], c.predicate, { sampledAt: sample.source.sampledAt })
      const label = `「${nameOf(c.column)}」`
      if (r.status === 'fail') failed.push(`${label}是 ${textOf(row[c.column])}，不满足${describeTablePredicate(c.predicate)}`)
      else if (r.status === 'unknown') unknowns.push(`${label}${r.reasonSummary ?? '读不出'}`)
    }
    if (failed.length > 0) return { index: i, status: 'fail', reason: failed.join('；') }
    if (unknowns.length > 0) return { index: i, status: 'unknown', reason: unknowns.join('；') }
    return { index: i, status: 'pass', reason: '' }
  })
  const failedRows = verdicts.filter((v) => v.status === 'fail')
  const unknownRows = verdicts.filter((v) => v.status === 'unknown')
  const passedRows = verdicts.filter((v) => v.status === 'pass')
  const foundText = `找到 ${matched.length} 行（${rowsText(matched)}）`
  const valuesText = (rows: number[]): string =>
    rows
      .slice(0, 3)
      .map((i) => rule.expect.map((c) => `「${nameOf(c.column)}」是 ${textOf(sample.rows[i]?.[c.column])}`).join('，'))
      .join('；')
  const lookup = (summary: string) => ({ summary: summary.slice(0, 512), matched: matched.slice(0, 5).map(previewOf), closest: [] as string[] })
  const violating = (rows: RowVerdict[]): TableViolatingRowPreview[] =>
    rows.map((v) => rowPreview(v.index, v.reason, undefined, 'LOOKUP_EXPECT_FAILED', `第 ${v.index + 1} 行${v.reason}`))

  const doneFail = (rows: RowVerdict[]): TableEvaluationResult => {
    const msg = `${foundText}，${rows[0]?.reason ?? '不满足条件'}`
    return {
      passed: false,
      reasonCode: 'LOOKUP_EXPECT_FAILED',
      reasonMessage: msg,
      details: lookupDetails(sample, coverage, lookup(msg), violating(rows), matched.length - rows.length),
    }
  }
  const donePass = (): TableEvaluationResult => ({
    passed: true,
    details: lookupDetails(sample, coverage, lookup(`${foundText}，${valuesText(passedRows.map((v) => v.index))}`), [], passedRows.length),
  })

  if (rule.onMultiple === 'any') {
    if (passedRows.length > 0) return donePass()
    if (unknownRows.length > 0) return unknownResult(sample, 'TABLE_LOOKUP_UNDETERMINED', `${foundText}，${unknownRows[0]?.reason ?? '读不出'}，无法确认`)
    return doneFail(failedRows)
  }
  // all：任一命中行不满足即不通过（确定的反例优先）；其次有读不出的行 → 无法确认
  if (failedRows.length > 0) return doneFail(failedRows)
  if (unknownRows.length > 0) return unknownResult(sample, 'TABLE_LOOKUP_UNDETERMINED', `${foundText}，${unknownRows[0]?.reason ?? '读不出'}，无法确认`)
  if (undetermined.length > 0) {
    return unknownResult(
      sample,
      'TABLE_LOOKUP_UNDETERMINED',
      `另有 ${undetermined.length} 行（${rowsText(undetermined)}）的值读不出，无法确认它们是不是也要满足条件`,
    )
  }
  return donePass()
}

/**
 * 求值前置门：要求范围非 complete 时一律 UNKNOWN，不利用部分样本给全表结论。
 */
export function evaluateTableExpectation(
  sample: TableSample,
  rule: TableExpectRule,
  /** other：record_sets_match 要比对的另一份记录集（由调用方按 otherKey 从上下文取来并加载全量）。 */
  options: { allowPreview?: boolean; other?: TableSample } = {},
): TableEvaluationResult {
  const coverageComplete = sample.coverage.status === 'complete'
  const coverageDetails = coverageDetailsOf(sample)
  const colName = (key: string): string => sample.columns.find((c) => c.key === key)?.name ?? key

  // 总条数读自分页条（或接口的总数字段），与行有没有读全无关：只在读取本身无法确认时不判
  if (rule.rule === 'page_total') return evaluatePageTotal(sample, rule, coverageDetails)

  // 外置记录集：rows 只是预览。只有编写期预览显式允许时才按预览算，正式检查必须先加载全量
  if (isTablePreviewOnly(sample) && !options.allowPreview) {
    return unknownResult(sample, 'TABLE_FULLSET_NOT_LOADED', '只有预览行，完整数据没有加载，无法确认全表事实')
  }

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
      const predRes = checkTablePredicate(field, rule.predicate, { sampledAt: sample.source.sampledAt })
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
      const predRes = checkTablePredicate(field, rule.predicate, { sampledAt: sample.source.sampledAt })
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

  // 3b'. 树形：父行等于子行之和
  if (rule.rule === 'tree_rollup_match') return evaluateTreeRollup(sample, rule, coverageDetails)

  // 3b''. 交叉表：合计 / 小计格等于明细之和
  if (rule.rule === 'crosstab_total_match') return evaluateCrosstabTotals(sample, rule, coverageDetails)

  // 3c. 本页行数与分页一致
  if (rule.rule === 'page_consistency') return evaluatePageConsistency(sample, coverageDetails)

  // 3c'. 与另一份数据逐行一致
  if (rule.rule === 'record_sets_match') return evaluateRecordSetsMatch(sample, rule, options.other, coverageDetails, options)

  // 3d. 找到某一行，再检查它
  if (rule.rule === 'row_lookup') {
    return evaluateRowLookup(sample, rule, coverageDetails)
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

/** 某一列上的谓词是否与列类型对得上（all_rows / any_row / row_lookup 共用）。 */
function validatePredicateOnColumn(
  columnKey: string,
  predicate: TablePredicate,
  columns: TableColumnSpec[],
): { valid: true } | { valid: false; code: string; message: string } {
    const col = columns.find((c) => c.key === columnKey)
    if (!col) {
      return {
        valid: false,
        code: 'TABLE_COLUMN_NOT_DECLARED',
        message: `规则引用了读取计划未声明的列 "${columnKey}"`,
      }
    }
    const pred = predicate
    // 状态语义列：只能等于 / 不等于某个语义，或判空
    if (col.read === 'tone') {
      if (pred.op === 'is_empty' || pred.op === 'is_not_empty') return { valid: true }
      if ((pred.op !== 'eq' && pred.op !== 'neq') || !(TABLE_STATUS_TONES as readonly unknown[]).includes(pred.value)) {
        return { valid: false, code: 'TABLE_TONE_PREDICATE_INVALID', message: `「${col.label ?? col.name}」是状态语义，只能选成功 / 警告 / 错误 / 信息 / 进行中 / 默认` }
      }
      return { valid: true }
    }
    if ('numericPolicy' in pred && pred.numericPolicy && col.valueType !== 'number') {
      return {
        valid: false,
        code: 'TABLE_NUMERIC_POLICY_ON_NON_NUMBER',
        message: `列 "${col.key}" 不是数字列，不能声明数值精度策略`,
      }
    }
    if (pred.op.startsWith('date_')) {
      if (col.valueType !== 'date') {
        return {
          valid: false,
          code: 'TABLE_DATE_COLUMN_REQUIRED',
          message: `日期比较只接受日期列，列 "${col.key}" 是 ${col.valueType}`,
        }
      }
      return { valid: true }
    }
    if (pred.op === 'gt' || pred.op === 'gte' || pred.op === 'lt' || pred.op === 'lte') {
      if (col.valueType === 'date') {
        return {
          valid: false,
          code: 'TABLE_DATE_COLUMN_NUMERIC_COMPARE',
          message: `列 "${col.key}" 是日期列，不能做数字大小比较，请改用“早于 / 晚于 / 不早于”`,
        }
      }
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

export function validateTableExpectRuleAgainstPlan(
  rule: TableExpectRule,
  columns: TableColumnSpec[],
): { valid: true } | { valid: false; code: string; message: string } {
  if (rule.rule === 'row_count' || rule.rule === 'page_total' || rule.rule === 'page_consistency' || rule.rule === 'crosstab_total_match') return { valid: true }

  // 另一份数据的列由编译期按对方的读取计划另行核对
  if (rule.rule === 'record_sets_match') {
    for (const key of [rule.key.column, ...rule.columns.map((c) => c.column)]) {
      if (!columns.some((c) => c.key === key)) {
        return { valid: false, code: 'TABLE_COLUMN_NOT_DECLARED', message: `规则引用了读取计划未声明的列 "${key}"` }
      }
    }
    return { valid: true }
  }

  if (rule.rule === 'tree_rollup_match') {
    const col = columns.find((c) => c.key === rule.column)
    if (!col) return { valid: false, code: 'TABLE_COLUMN_NOT_DECLARED', message: `规则引用了读取计划未声明的列 "${rule.column}"` }
    if (col.valueType !== 'number') return { valid: false, code: 'TABLE_NUMBER_COLUMN_REQUIRED', message: `父行与子行之和核对只接受数字列，列 "${col.key}" 是 ${col.valueType}` }
    return { valid: true }
  }

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

  if (rule.rule === 'row_lookup') {
    for (const cond of [...rule.where, ...rule.expect]) {
      const checked = validatePredicateOnColumn(cond.column, cond.predicate, columns)
      if (!checked.valid) return checked
    }
    return { valid: true }
  }

  if (rule.rule === 'all_rows' || rule.rule === 'any_row') {
    return validatePredicateOnColumn(rule.column, rule.predicate, columns)
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



// ---------------------------------------------------------------------------
// 外置记录集（大记录集只在上下文里留预览，完整行写成运行对象）
// ---------------------------------------------------------------------------

/** 记录集是否只带了预览（完整行在外置对象里、尚未加载）。 */
export function isTablePreviewOnly(sample: Pick<TableSample, 'rows' | 'storage'>): boolean {
  return Boolean(sample.storage) && sample.rows.length < (sample.storage?.rowCount ?? 0)
}

const tableRecordSetHeaderSchema = z.strictObject({
  protocol: z.literal(TABLE_RECORDSET_PROTOCOL),
  columns: z.array(z.string()),
  rowCount: z.number().int().nonnegative(),
  summaryRows: z.array(z.record(z.string(), tableRowFieldSchema)).max(5).optional(),
})

/** 编码为 JSON 行：首行头，之后每行一条记录。 */
export function encodeTableRecordSet(input: {
  columns: readonly string[]
  rows: ReadonlyArray<Record<string, TableRowField>>
  summaryRows?: ReadonlyArray<Record<string, TableRowField>>
}): string {
  const header = {
    protocol: TABLE_RECORDSET_PROTOCOL,
    columns: [...input.columns],
    rowCount: input.rows.length,
    ...(input.summaryRows && input.summaryRows.length > 0 ? { summaryRows: input.summaryRows.slice(0, 5) } : {}),
  }
  const lines = [JSON.stringify(header)]
  for (const row of input.rows) lines.push(JSON.stringify(row))
  return `${lines.join('\n')}\n`
}

export type DecodedTableRecordSet = {
  columns: string[]
  rows: Array<Record<string, TableRowField>>
  summaryRows: Array<Record<string, TableRowField>>
}

/** 解码外置记录集；格式不对或行数与头不符时抛错（调用方按“无法确认”处理）。 */
export function decodeTableRecordSet(text: string): DecodedTableRecordSet {
  const lines = text.split('\n').filter((line) => line.length > 0)
  if (lines.length === 0) throw new Error('记录集为空')
  const header = tableRecordSetHeaderSchema.parse(JSON.parse(lines[0] as string))
  const rows = lines.slice(1).map((line) => z.record(z.string(), tableRowFieldSchema).parse(JSON.parse(line)))
  if (rows.length !== header.rowCount) throw new Error(`记录集行数不符：头里写 ${header.rowCount} 行，实际 ${rows.length} 行`)
  return { columns: header.columns, rows, summaryRows: header.summaryRows ?? [] }
}


// ---------------------------------------------------------------------------
// 分页元信息检查
// ---------------------------------------------------------------------------

const COMPARE_TEXT = { eq: '等于', neq: '不等于', gt: '大于', gte: '大于等于', lt: '小于', lte: '小于等于' } as const

function compareInt(actual: number, op: keyof typeof COMPARE_TEXT, value: number): boolean {
  if (op === 'eq') return actual === value
  if (op === 'neq') return actual !== value
  if (op === 'gt') return actual > value
  if (op === 'gte') return actual >= value
  if (op === 'lt') return actual < value
  return actual <= value
}

function pageDetails(coverage: TableOutcomeDetails['coverage'], checked: number): TableOutcomeDetails {
  return {
    protocol: TABLE_OUTCOME_PROTOCOL,
    totalRowsChecked: checked,
    matchedRows: null,
    violatingRowsCount: null,
    violatingRows: [],
    presentation: { truncated: false, omittedViolatingRows: 0, truncatedFields: false },
    coverage,
  }
}

function evaluatePageTotal(
  sample: TableSample,
  rule: Extract<TableExpectRule, { rule: 'page_total' }>,
  coverage: TableOutcomeDetails['coverage'],
): TableEvaluationResult {
  if (sample.coverage.status === 'unknown') {
    return unknownResult(sample, 'TABLE_FACTS_UNAVAILABLE', '表格还没有就绪，分页信息不可信，无法确认总条数')
  }
  const total = sample.pageInfo?.totalRows
  if (total === undefined) {
    return unknownResult(sample, 'PAGE_INFO_UNAVAILABLE', '分页条上没有读到总条数，无法确认')
  }
  const passed = compareInt(total, rule.op, rule.value)
  return {
    passed,
    reasonCode: passed ? undefined : 'PAGE_TOTAL_MISMATCH',
    reasonMessage: passed ? undefined : `分页显示共 ${total} 条，不满足“${COMPARE_TEXT[rule.op]} ${rule.value}”`,
    details: pageDetails(coverage, 0),
  }
}

/** 本页应有多少行：优先用分页条显示的行区间；其次按每页条数、总条数、当前页算；再次“不是最后一页就应满页”。 */
export function expectedPageRows(info: TablePageInfo | undefined): { rows: number; basis: string } | null {
  if (!info) return null
  if (info.rowRange && info.rowRange.to >= info.rowRange.from) {
    return { rows: info.rowRange.to - info.rowRange.from + 1, basis: `分页显示第 ${info.rowRange.from}–${info.rowRange.to} 条` }
  }
  if (info.pageSize !== undefined && info.totalRows !== undefined && info.currentPage !== undefined) {
    const rows = Math.max(0, Math.min(info.pageSize, info.totalRows - (info.currentPage - 1) * info.pageSize))
    return { rows, basis: `共 ${info.totalRows} 条、每页 ${info.pageSize} 条、第 ${info.currentPage} 页` }
  }
  if (info.pageSize !== undefined && info.totalPages !== undefined && info.currentPage !== undefined && info.currentPage < info.totalPages) {
    return { rows: info.pageSize, basis: `第 ${info.currentPage} / ${info.totalPages} 页不是最后一页，每页 ${info.pageSize} 条` }
  }
  return null
}

function evaluatePageConsistency(sample: TableSample, coverage: TableOutcomeDetails['coverage']): TableEvaluationResult {
  const expected = expectedPageRows(sample.pageInfo)
  if (!expected) {
    return unknownResult(sample, 'PAGE_INFO_INSUFFICIENT', '分页条上读到的信息不够（需要显示的行区间，或每页条数 + 总条数 + 当前页），无法确认本页应有多少行')
  }
  const actual = sample.rows.length
  const passed = actual === expected.rows
  return {
    passed,
    reasonCode: passed ? undefined : 'PAGE_ROWS_MISMATCH',
    reasonMessage: passed ? undefined : `本页读到 ${actual} 行，但${expected.basis}，应有 ${expected.rows} 行`,
    details: pageDetails(coverage, actual),
  }
}

// ---------------------------------------------------------------------------
// 与另一份数据一致（record_sets_match）
// ---------------------------------------------------------------------------

type RecordSetsRule = Extract<TableExpectRule, { rule: 'record_sets_match' }>

const NUMERIC_TEXT = /^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$|^-?\d+(?:\.\d+)?$/

/** 一格的可比较值：数字→精确十进制；像数字的文字（含千分位）也按数字比；其余按去空白的文字比。 */
type Comparable = { kind: 'empty' } | { kind: 'number'; value: ScaledDecimal } | { kind: 'text'; value: string } | { kind: 'unreadable'; why: string }

function comparableOf(field: TableRowField | undefined): Comparable {
  if (!field || field.status === 'missing') return { kind: 'empty' }
  if (field.status === 'masked') return { kind: 'unreadable', why: '已打码' }
  if (field.status === 'error') return { kind: 'unreadable', why: '读不出' }
  const v = field.value
  if (v === null || v === '') return { kind: 'empty' }
  if (typeof v === 'number') {
    const scaled = toScaledDecimal(field.decimalValue, v)
    return scaled ? { kind: 'number', value: scaled } : { kind: 'unreadable', why: '读不出' }
  }
  if (typeof v === 'boolean') return { kind: 'text', value: String(v) }
  const text = String(typeof v === 'object' ? JSON.stringify(v) : v).replace(/\s+/g, ' ').trim()
  if (NUMERIC_TEXT.test(text)) {
    const scaled = parseScaledDecimal(text.replace(/,/g, ''))
    if (scaled) return { kind: 'number', value: scaled }
  }
  return text === '' ? { kind: 'empty' } : { kind: 'text', value: text }
}

function comparableText(c: Comparable): string {
  if (c.kind === 'number') return scaledToString(c.value)
  if (c.kind === 'text') return c.value
  if (c.kind === 'empty') return '（空）'
  return `（${c.why}）`
}

/** 两格是否一致：数字 display 精度按两边较少的小数位比较；一边是数字一边是文字算不一致。 */
function sameValue(a: Comparable, b: Comparable, precision: 'display' | 'exact'): boolean {
  if (a.kind === 'empty' || b.kind === 'empty') return a.kind === b.kind
  if (a.kind === 'number' && b.kind === 'number') {
    if (precision === 'exact') return compareScaled(a.value, b.value) === 0
    const scale = Math.min(a.value.scale, b.value.scale)
    return compareScaled(roundScaled(a.value, scale), roundScaled(b.value, scale)) === 0
  }
  return a.kind === 'text' && b.kind === 'text' && a.value === b.value
}

function keyIndex(sample: TableSample, column: string): { ok: true; byKey: Map<string, number> } | { ok: false; code: string; message: string } {
  const label = sample.columns.find((c) => c.key === column)?.name ?? column
  const byKey = new Map<string, number>()
  for (let i = 0; i < sample.rows.length; i++) {
    const c = comparableOf(sample.rows[i]![column])
    if (c.kind === 'empty' || c.kind === 'unreadable') {
      return { ok: false, code: 'TABLE_COMPARE_KEY_MISSING', message: `第 ${i + 1} 行的键「${label}」为空或读不出，不能逐行比对` }
    }
    const key = comparableText(c)
    if (byKey.has(key)) {
      return { ok: false, code: 'TABLE_COMPARE_KEY_NOT_UNIQUE', message: `键「${label}」有重复值「${key}」，不能逐行比对；请换一个每行都不同的列作键` }
    }
    byKey.set(key, i)
  }
  return { ok: true, byKey }
}

function evaluateRecordSetsMatch(
  sample: TableSample,
  rule: RecordSetsRule,
  other: TableSample | undefined,
  coverage: TableOutcomeDetails['coverage'],
  options: { allowPreview?: boolean },
): TableEvaluationResult {
  if (!other) return unknownResult(sample, 'TABLE_COMPARE_OTHER_MISSING', `没有读到要比对的另一份数据「${rule.otherKey}」，无法确认`)
  if (isTablePreviewOnly(other) && !options.allowPreview) {
    return unknownResult(sample, 'TABLE_FULLSET_NOT_LOADED', `另一份数据「${rule.otherKey}」只有预览行，完整数据没有加载，无法确认`)
  }
  if (other.coverage.status !== 'complete') {
    return unknownResult(sample, 'TABLE_FACTS_UNAVAILABLE', `另一份数据「${rule.otherKey}」没有读全，无法逐行比对`)
  }
  const label = (s: TableSample, key: string) => s.columns.find((c) => c.key === key)?.name ?? key
  for (const [s, key] of [
    [sample, rule.key.column],
    [other, rule.key.otherColumn],
    ...rule.columns.flatMap((c) => [[sample, c.column], [other, c.otherColumn]] as const),
  ] as const) {
    if (!s.columns.some((c) => c.key === key)) {
      return unknownResult(sample, 'TABLE_COLUMN_NOT_DECLARED', `${s === sample ? '本表' : `另一份数据「${rule.otherKey}」`}没有列「${key}」，无法比对`)
    }
  }
  const mine = keyIndex(sample, rule.key.column)
  if (!mine.ok) return unknownResult(sample, mine.code, mine.message)
  const theirs = keyIndex(other, rule.key.otherColumn)
  if (!theirs.ok) return unknownResult(sample, theirs.code, `另一份数据：${theirs.message}`)

  const keyLabel = label(sample, rule.key.column)
  const violating: TableViolatingRowPreview[] = []
  let mismatched = 0
  let extra = 0
  let matched = 0
  for (const [key, i] of mine.byKey) {
    const j = theirs.byKey.get(key)
    if (j === undefined) {
      extra++
      violating.push(rowPreview(i, key, null, 'RECORD_EXTRA', `${keyLabel} ${key}：本表有，另一份没有`))
      continue
    }
    const diffs: string[] = []
    for (const col of rule.columns) {
      const a = comparableOf(sample.rows[i]![col.column])
      const b = comparableOf(other.rows[j]![col.otherColumn])
      if (a.kind === 'unreadable' || b.kind === 'unreadable') {
        return unknownResult(sample, 'TABLE_FIELD_UNAVAILABLE', `${keyLabel} ${key} 的「${label(sample, col.column)}」${a.kind === 'unreadable' ? a.why : (b as { why: string }).why}，无法比对`)
      }
      if (!sameValue(a, b, col.precision)) diffs.push(`${label(sample, col.column)} 本表 ${comparableText(a)}，另一份 ${comparableText(b)}`)
    }
    if (diffs.length > 0) {
      mismatched++
      violating.push(rowPreview(i, sample.rows[i]![rule.columns[0]!.column]?.value ?? null, other.rows[j]![rule.columns[0]!.otherColumn]?.value ?? null, 'RECORD_VALUE_MISMATCH', `${keyLabel} ${key}：${diffs.join('；')}`))
    } else matched++
  }
  let missing = 0
  for (const [key, j] of theirs.byKey) {
    if (mine.byKey.has(key)) continue
    missing++
    violating.push(rowPreview(j, null, key, 'RECORD_MISSING', `${keyLabel} ${key}：另一份有，本表没有`))
  }
  const passed = missing === 0 && extra === 0 && mismatched === 0
  const parts = [missing ? `缺 ${missing} 行` : '', extra ? `多 ${extra} 行` : '', mismatched ? `${mismatched} 行值不一致` : ''].filter(Boolean)
  const summary = passed
    ? `与「${rule.otherKey}」逐行一致（${matched} 行）`
    : `与「${rule.otherKey}」比对：${matched} 行一致；${parts.join('、')}`
  const count = missing + extra + mismatched
  return {
    passed,
    reasonCode: passed ? undefined : 'RECORD_SETS_MISMATCH',
    reasonMessage: passed ? undefined : summary,
    details: {
      ...detailsOf(sample, coverage, { matchedRows: matched, violatingRowsCount: count, violatingRows: violating }),
      compare: { summary: truncateUtf8Bytes(summary, 512).text, otherRowCount: other.rows.length, missing, extra, mismatched },
    },
  }
}

// ---------------------------------------------------------------------------
// 树形：父行等于子行之和（tree_rollup_match）
// ---------------------------------------------------------------------------

function evaluateTreeRollup(
  sample: TableSample,
  rule: Extract<TableExpectRule, { rule: 'tree_rollup_match' }>,
  coverage: TableOutcomeDetails['coverage'],
): TableEvaluationResult {
  const meta = sample.rowMeta
  if (!meta || meta.length !== sample.rows.length) {
    return unknownResult(sample, 'TABLE_TREE_LEVELS_MISSING', '这次不是按树形读取的，没有父子关系，无法核对；请把读法改为“树形”')
  }
  const label = sample.columns.find((c) => c.key === rule.column)?.name ?? rule.column
  const children = new Map<number, number[]>()
  meta.forEach((m, i) => {
    if (m.parentIndex !== undefined) children.set(m.parentIndex, [...(children.get(m.parentIndex) ?? []), i])
  })
  if (children.size === 0) {
    return unknownResult(sample, 'TABLE_TREE_NO_PARENTS', '没有读到带子行的父行（只取顶层或最底层时没有父子行可比），无法核对')
  }
  const nameOf = (i: number): string => {
    const path = sample.rows[i]?.[TABLE_TREE_PATH_KEY]?.value
    return typeof path === 'string' && path ? path : `第 ${i + 1} 行`
  }
  const valueOf = (i: number): ScaledDecimal | null => {
    const f = sample.rows[i]?.[rule.column]
    if (!f || f.status !== 'ok' || typeof f.value !== 'number') return null
    return toScaledDecimal(f.decimalValue, f.value)
  }
  const violating: TableViolatingRowPreview[] = []
  let checked = 0
  for (const [p, kids] of [...children].sort((a, b) => a[0] - b[0])) {
    const own = valueOf(p)
    const parts = kids.map(valueOf)
    if (!own || parts.some((x) => !x)) {
      return unknownResult(sample, 'TABLE_FIELD_UNAVAILABLE', `「${nameOf(p)}」或它的子行「${label}」读不出数字，无法核对`)
    }
    checked++
    const sum = sumScaled(parts as ScaledDecimal[])
    const compared = rule.precision === 'display' ? roundScaled(sum, own.scale) : sum
    if (compareScaled(compared, own) !== 0) {
      violating.push(
        rowPreview(p, scaledToString(sum), scaledToString(own), 'TREE_ROLLUP_MISMATCH', `「${nameOf(p)}」的${label}：子行相加 ${scaledToString(sum)}，本行 ${scaledToString(own)}`),
      )
    }
  }
  const passed = violating.length === 0
  return {
    passed,
    reasonCode: passed ? undefined : 'TREE_ROLLUP_MISMATCH',
    reasonMessage: passed ? undefined : `${violating.length} 个父行的「${label}」与子行之和不一致：${violating[0]!.reasonSummary}`,
    details: detailsOf(sample, coverage, { matchedRows: checked - violating.length, violatingRowsCount: violating.length, violatingRows: violating }),
  }
}

// ---------------------------------------------------------------------------
// 交叉表：合计 / 小计格等于它汇总范围内明细格之和（crosstab_total_match）
// ---------------------------------------------------------------------------

/** 维度格的比较文字：原文优先；与逆透视时写进合计格 dims 的口径一致。空格返回 null。 */
export function crosstabDimText(field: TableRowField | undefined): string | null {
  if (!field || field.status === 'missing') return null
  const v = field.rawText ?? field.value
  if (v === null || v === undefined) return null
  const text = String(typeof v === 'object' ? JSON.stringify(v) : v).trim()
  return text === '' ? null : text
}

/** 合计格的显示名：「行维度 / …」×「列维度 / …」（只取到汇总那一层为止的文字）。 */
export function crosstabTotalName(total: { rowLevel: number; colLevel: number; dims: ReadonlyArray<string | null> }, rowDimCount: number): string {
  const part = (dims: ReadonlyArray<string | null>) => dims.filter((d): d is string => Boolean(d)).join(' / ') || '全部'
  return `「${part(total.dims.slice(0, rowDimCount))}」×「${part(total.dims.slice(rowDimCount))}」`
}

type CrosstabValue = { kind: 'number'; value: ScaledDecimal } | { kind: 'unreadable'; why: string }

/** 数值格：空当 0（报表里空着 / “-” 就是没有）；读不出 / 打码则无法核对。 */
function crosstabValueOf(field: TableRowField | undefined): CrosstabValue {
  if (!field || field.status === 'missing' || (field.status === 'ok' && (field.value === null || field.value === ''))) return { kind: 'number', value: { int: 0n, scale: 0 } }
  if (field.status === 'masked') return { kind: 'unreadable', why: '已打码' }
  if (field.status !== 'ok' || typeof field.value !== 'number') return { kind: 'unreadable', why: `读不出数字（${field.rawText ?? String(field.value)}）` }
  const scaled = toScaledDecimal(field.decimalValue, field.value)
  return scaled ? { kind: 'number', value: scaled } : { kind: 'unreadable', why: '读不出数字' }
}

function evaluateCrosstabTotals(
  sample: TableSample,
  rule: Extract<TableExpectRule, { rule: 'crosstab_total_match' }>,
  coverage: TableOutcomeDetails['coverage'],
): TableEvaluationResult {
  const x = sample.crosstab
  if (!x) return unknownResult(sample, 'TABLE_CROSSTAB_MISSING', '这次不是按交叉表读取的，没有合计格可核对；请把读法改为“交叉表”')
  if (x.totals.length === 0) return unknownResult(sample, 'TABLE_CROSSTAB_NO_TOTALS', '没有读到“合计 / 小计”行或列，无法核对')
  if (x.totalsTruncated) {
    return unknownResult(sample, 'TABLE_CROSSTAB_TOTALS_TRUNCATED', `合计格太多，只保存了前 ${x.totals.length} 个，无法确认全部合计`)
  }
  const R = x.rowDims.length
  const keys = [...x.rowDims, ...x.colDims]
  const cells = sample.rows.map((row) => ({ dims: keys.map((k) => crosstabDimText(row[k])), value: crosstabValueOf(row[x.valueKey]) }))
  const violating: TableViolatingRowPreview[] = []
  const unknown: string[] = []
  let checked = 0
  x.totals.forEach((total, t) => {
    const name = crosstabTotalName(total, R)
    const shown = crosstabValueOf(total.value)
    if (shown.kind === 'unreadable') {
      unknown.push(`${name}${shown.why}`)
      return
    }
    // 汇总范围：前 rowLevel 个行维度、前 colLevel 层列维度与合计格相同
    const covered = cells.filter((c) => {
      for (let i = 0; i < total.rowLevel; i++) if (c.dims[i] !== total.dims[i]) return false
      for (let j = 0; j < total.colLevel; j++) if (c.dims[R + j] !== total.dims[R + j]) return false
      return true
    })
    if (covered.length === 0) {
      unknown.push(`${name}找不到它汇总的明细格`)
      return
    }
    const bad = covered.find((c) => c.value.kind === 'unreadable')
    if (bad) {
      unknown.push(`${name}汇总的明细里有格${(bad.value as { why: string }).why}`)
      return
    }
    checked++
    const sum = sumScaled(covered.map((c) => (c.value as { value: ScaledDecimal }).value))
    const compared = rule.precision === 'display' ? roundScaled(sum, shown.value.scale) : sum
    if (compareScaled(compared, shown.value) !== 0) {
      violating.push(
        rowPreview(t, scaledToString(sum), scaledToString(shown.value), 'CROSSTAB_TOTAL_MISMATCH', `${name}：明细相加 ${scaledToString(sum)}，合计格 ${scaledToString(shown.value)}`),
      )
    }
  })
  if (violating.length > 0) {
    return {
      passed: false,
      reasonCode: 'CROSSTAB_TOTAL_MISMATCH',
      reasonMessage: `${violating.length} 个合计格与明细之和不一致：${violating[0]!.reasonSummary}`,
      details: detailsOf(sample, coverage, { matchedRows: checked - violating.length, violatingRowsCount: violating.length, violatingRows: violating }),
    }
  }
  if (unknown.length > 0) {
    return unknownResult(sample, 'TABLE_FIELD_UNAVAILABLE', `${unknown.length} 个合计格无法核对：${unknown[0]}`)
  }
  return { passed: true, details: detailsOf(sample, coverage, { matchedRows: checked, violatingRowsCount: 0 }) }
}
