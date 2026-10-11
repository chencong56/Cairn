import {
  TABLE_FILE_PROTOCOL,
  TABLE_NETWORK_PROTOCOL,
  TABLE_PLACEHOLDER_COLUMN_NAME,
  TABLE_READ_MAX_COLS,
  TABLE_READ_PROTOCOL_V2,
  isTablePlanUnconfigured,
  isTableReadPlanV2,
  type TableDetected,
  type TableDetectedColumn,
  type TableReadPlan,
  tableFilePlanSchema,
  tableNetworkPlanSchema,
  tableSampleSchema,
  type TableFilePlan,
  type TableNetworkPlan,
  type TableReadPlanV2,
  type TableSample,
} from '@cairn/shared'

type PlanColumn = TableReadPlanV2['columns'][number]
/** 列编辑对页面计划与文件计划通用：两者的 columns 同形。 */
type ColumnPlan = { columns: PlanColumn[] }

/** 切到“表格 / 列表数据”时的占位计划：还没点选过表格，运行前必须被真实计划替换。 */
export function createPlaceholderTablePlan(): TableReadPlanV2 {
  return {
    protocol: TABLE_READ_PROTOCOL_V2,
    target: { framePath: [], candidates: [{ by: 'css', value: 'table' }] },
    scope: 'current_page',
    rows: { excludeHeader: true, header: 'auto' },
    columns: [{ key: 'col_1', name: TABLE_PLACEHOLDER_COLUMN_NAME, valueType: 'text' }],
    limits: { maxRows: 200, maxCols: TABLE_READ_MAX_COLS, maxBytes: 192 * 1024 },
  }
}

/** 切到“下载文件里的数据”时的占位计划（还没选文件 / 没预览过）；列为占位列，运行前必须被真实计划替换。 */
export function createPlaceholderFilePlan(fromKey: string): TableFilePlan {
  return tableFilePlanSchema.parse({
    protocol: TABLE_FILE_PROTOCOL,
    fromKey: /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(fromKey) ? fromKey : 'downloadFile',
    columns: [{ key: 'col_1', name: TABLE_PLACEHOLDER_COLUMN_NAME, valueType: 'text' }],
  })
}

/** 切到“接口返回的数据”时的占位计划（还没选接口）；列为占位列，运行前必须被真实计划替换。 */
export function createPlaceholderNetworkPlan(): TableNetworkPlan {
  return tableNetworkPlanSchema.parse({
    protocol: TABLE_NETWORK_PROTOCOL,
    match: { url: '/' },
    rowsPath: 'data',
    columns: [{ key: 'col_1', name: TABLE_PLACEHOLDER_COLUMN_NAME, path: 'col_1', valueType: 'text' }],
  })
}

export type ReadKind = 'table' | 'cards' | 'keyvalue' | 'status'

export function planKind(plan: TableReadPlan | null | undefined): ReadKind {
  return plan && isTableReadPlanV2(plan) && plan.kind ? plan.kind : 'table'
}

export function kindNoun(kind: ReadKind): string {
  return kind === 'cards' ? '卡片' : kind === 'keyvalue' ? '详情信息' : kind === 'status' ? '状态' : '表格'
}

/** 识别结果的一行结论：表格 N 行 × M 列 / 卡片 N 张 / 详情信息 N 项。 */
export function foundSummary(detected: Pick<TableDetected, 'rowCount' | 'colCount' | 'plan'>): string {
  const kind = planKind(detected.plan)
  if (kind === 'cards') return `找到一组卡片，${detected.rowCount} 张，每张 ${detected.colCount} 项`
  if (kind === 'keyvalue') return `找到一块详情信息，共 ${detected.colCount} 项`
  if (kind === 'status') return `找到一组状态，${detected.rowCount} 项`
  return `找到一张表格，${detected.rowCount} 行 × ${detected.colCount} 列`
}

export type TablePlanState = 'unconfigured' | 'legacy' | 'ready'

/** 计划所处状态：没点选过 / 旧版计划（table.read@1） / 已就绪。 */
export function tablePlanState(plan: TableReadPlan): TablePlanState {
  if (isTablePlanUnconfigured(plan)) return 'unconfigured'
  return isTableReadPlanV2(plan) ? 'ready' : 'legacy'
}

export function columnLabel(column: Pick<PlanColumn, 'name' | 'label'>): string {
  return column.label ?? column.name
}

/** 勾选 / 取消勾选一列。取消时至少保留一列；勾选时按 DOM 列序插回。 */
export function toggleColumn<P extends ColumnPlan>(
  plan: P,
  detectedColumns: readonly TableDetectedColumn[],
  key: string,
  checked: boolean,
): P {
  const present = plan.columns.some((c) => c.key === key)
  if (!checked) {
    if (!present || plan.columns.length <= 1) return plan
    return { ...plan, columns: plan.columns.filter((c) => c.key !== key) }
  }
  if (present) return plan
  const info = detectedColumns.find((c) => c.key === key)
  if (!info) return plan
  const path = (info as TableDetectedColumn & { path?: string }).path
  const spec: PlanColumn = {
    key: info.key,
    name: info.name,
    ...(info.label ? { label: info.label } : {}),
    ...(info.read ? { read: info.read } : {}),
    ...(path ? { path } : {}),
    ...(info.source === 'index' ? { source: 'index' as const, index: info.index } : {}),
    valueType: info.valueType,
    ...(info.valueType === 'number' ? { numericKind: info.numericKind ?? 'decimal' } : {}),
  }
  const order = (k: string) => detectedColumns.find((c) => c.key === k)?.index ?? Number.MAX_SAFE_INTEGER
  const columns = [...plan.columns, spec].sort((a, b) => order(a.key) - order(b.key))
  return { ...plan, columns }
}

function mapColumn<P extends ColumnPlan>(plan: P, key: string, patch: (column: PlanColumn) => PlanColumn): P {
  return { ...plan, columns: plan.columns.map((c) => (c.key === key ? patch(c) : c)) }
}

/** 改显示名：不影响取数（取数仍按表头里的列名）。留空则恢复为表头列名。 */
export function renameColumn<P extends ColumnPlan>(plan: P, key: string, label: string): P {
  const trimmed = label.trim()
  return mapColumn(plan, key, (c) => {
    const { label: _old, ...rest } = c
    return trimmed && trimmed !== c.name ? { ...rest, label: trimmed.slice(0, 64) } : rest
  })
}

export function setColumnSensitive<P extends ColumnPlan>(plan: P, key: string, sensitive: boolean): P {
  return mapColumn(plan, key, (c) => {
    const { sensitive: _old, ...rest } = c
    return sensitive ? { ...rest, sensitive: true } : rest
  })
}

export function setColumnType<P extends ColumnPlan>(
  plan: P,
  key: string,
  valueType: 'text' | 'number' | 'boolean' | 'date',
): P {
  return mapColumn(plan, key, (c) => {
    const { numericKind: _old, scaleUnits: _scale, ...rest } = c
    return valueType === 'number'
      ? { ...rest, valueType, numericKind: c.numericKind ?? 'decimal' }
      : { ...rest, valueType }
  })
}

/** 取列方式：按表头列名 / 按第几列（显式选择，不会隐式退回）。 */
export function setColumnSource<P extends ColumnPlan>(
  plan: P,
  key: string,
  source: 'header' | 'index',
  index: number,
): P {
  return mapColumn(plan, key, (c) => {
    const { source: _s, index: _i, ...rest } = c
    return source === 'index' ? { ...rest, source: 'index', index } : rest
  })
}

export function setHeaderMode(plan: TableReadPlanV2, header: 'auto' | 'first_row' | 'none'): TableReadPlanV2 {
  return { ...plan, rows: { ...plan.rows, header } }
}

export function setEmptyMeansNone(plan: TableReadPlanV2, value: boolean): TableReadPlanV2 {
  const readiness = { waitVisible: true, timeoutMs: 10_000, ...plan.readiness }
  const { emptyMeansNone: _old, ...rest } = readiness
  return { ...plan, readiness: value ? { ...rest, emptyMeansNone: true } : rest }
}

/** 手工指定合计行：某列等于某文字的行。传空列或空文字则取消（仍按“合计 / 总计 / 小计”自动识别）。 */
export function setTotalRow(plan: TableReadPlanV2, columnKey: string | null, equals: string): TableReadPlanV2 {
  const text = equals.trim()
  const { totalRow: _old, ...rows } = plan.rows
  return {
    ...plan,
    rows: columnKey && text ? { ...rows, totalRow: { columnKey, equals: text.slice(0, 128) } } : rows,
  }
}

/** 读法：树形（带读取范围）或普通（记下“按普通读”，开关不消失）。 */
export function setTreeLayout(plan: TableReadPlanV2, scope: 'all' | 'top' | 'leaf' | null): TableReadPlanV2 {
  return { ...plan, layout: scope === null ? { mode: 'flat' } : { mode: 'tree', scope } }
}

export const TREE_SCOPE_LABEL: Record<'all' | 'top' | 'leaf', string> = {
  all: '全部已展开的行',
  top: '只取顶层',
  leaf: '只取最底层',
}

/** 切到交叉表时列维度层的默认名：一层叫“指标”，多层先占位，用户在配置里改。 */
export function crosstabLayerNames(depth: number): string[] {
  return depth <= 1 ? ['指标'] : Array.from({ length: Math.min(4, Math.max(1, depth)) }, (_, i) => `列头${i + 1}`)
}

/** 读法：交叉表（plan.columns 是行维度，其余可见列逆透视成长表）；null 改回普通。 */
export function setCrosstabLayout(
  plan: TableReadPlanV2,
  config: { columnDims: readonly string[]; valueName?: string; numericKind?: 'integer' | 'decimal' } | null,
): TableReadPlanV2 {
  if (!config) return { ...plan, layout: { mode: 'flat' } }
  const columnDims = config.columnDims.map((n) => n.trim().slice(0, 64)).filter(Boolean).slice(0, 4)
  if (columnDims.length === 0) return { ...plan, layout: { mode: 'flat' } }
  const name = (config.valueName ?? '').trim().slice(0, 64) || '值'
  return { ...plan, layout: { mode: 'crosstab', columnDims, value: { name, numericKind: config.numericKind ?? 'decimal' } } }
}

/** 交叉表的前几列是行维度：按识别到的列序把前 N 列写成 plan.columns。 */
export function setCrosstabRowDims(plan: TableReadPlanV2, detectedColumns: readonly TableDetectedColumn[], count: number): TableReadPlanV2 {
  const kept = detectedColumns.filter((c) => !c.excludedReason)
  const max = kept.length || plan.columns.length
  const n = Math.min(max, Math.max(1, Math.floor(count) || 1))
  const picked: PlanColumn[] = []
  for (const info of kept) {
    if (picked.length >= n) break
    const existing = plan.columns.find((c) => c.key === info.key)
    picked.push(
      existing ?? {
        key: info.key,
        name: info.name,
        ...(info.source === 'index' ? { source: 'index' as const, index: info.index } : {}),
        valueType: info.valueType,
        ...(info.valueType === 'number' ? { numericKind: info.numericKind ?? 'decimal' } : {}),
      },
    )
  }
  return { ...plan, columns: picked.length > 0 ? picked : plan.columns.slice(0, n) }
}

/** 改交叉表第 i 层列维度 / 数值列的名字。 */
export function setCrosstabColumnDim(plan: TableReadPlanV2, index: number, name: string): TableReadPlanV2 {
  if (plan.layout?.mode !== 'crosstab') return plan
  const columnDims = plan.layout.columnDims.map((n, i) => (i === index ? name.trim().slice(0, 64) || n : n))
  return { ...plan, layout: { ...plan.layout, columnDims } }
}

export function setCrosstabValueName(plan: TableReadPlanV2, name: string): TableReadPlanV2 {
  if (plan.layout?.mode !== 'crosstab') return plan
  const value = { ...plan.layout.value, name: name.trim().slice(0, 64) || plan.layout.value.name }
  return { ...plan, layout: { ...plan.layout, value } }
}

export function setMaxRows(plan: TableReadPlanV2, maxRows: number): TableReadPlanV2 {
  const value = Math.min(200, Math.max(1, Math.floor(maxRows) || 1))
  return { ...plan, limits: { ...plan.limits, maxRows: value } }
}

/** 手工指定表根（高级）：只替换第一个 css 候选，保留 frame 路径。 */
export function setRootSelector(plan: TableReadPlanV2, selector: string): TableReadPlanV2 {
  const value = selector.trim()
  if (!value) return plan
  return { ...plan, target: { ...plan.target, candidates: [{ by: 'css', value }] } }
}

export function rootSelectorOf(plan: TableReadPlanV2): string {
  return plan.target.candidates.find((c) => c.by === 'css')?.value ?? ''
}

/** 合计行说明：识别到几行合计 / 页脚行，以及它们的首列文字。 */
export function totalRowsSummary(sample: TableSample | null | undefined): string | null {
  const rows = sample?.summaryRows
  if (!rows || rows.length === 0 || !sample) return null
  const first = sample.columns[0]
  const labels = rows
    .map((row) => (first ? String(row[first.key]?.rawText ?? row[first.key]?.value ?? '') : ''))
    .filter(Boolean)
  return `识别到 ${rows.length} 行合计 / 页脚${labels.length ? `（${labels.join('、')}）` : ''}，不计入数据行`
}

/** 分页条读数：只列出读到的项，例如“共 45 条 · 第 1 / 3 页 · 每页 20 条”。 */
export function pageInfoSummary(sample: TableSample | null | undefined): string | null {
  const info = sample?.pageInfo
  if (!info) return null
  // 接口来源的总条数读自接口字段，不是分页条
  if (sample?.source.kind === 'network') return info.totalRows !== undefined ? `接口给的总条数：${info.totalRows}` : null
  const parts: string[] = []
  if (info.totalRows !== undefined) parts.push(`共 ${info.totalRows} 条`)
  if (info.currentPage !== undefined) parts.push(info.totalPages !== undefined ? `第 ${info.currentPage} / ${info.totalPages} 页` : `第 ${info.currentPage} 页`)
  else if (info.totalPages !== undefined) parts.push(`共 ${info.totalPages} 页`)
  if (info.pageSize !== undefined) parts.push(`每页 ${info.pageSize} 条`)
  if (info.rowRange) parts.push(`显示第 ${info.rowRange.from}–${info.rowRange.to} 条`)
  return parts.length > 0 ? `分页显示：${parts.join(' · ')}` : null
}

/** 一行“范围说明”：读到了多少行、是否只读了当前页、是否能保证读全。 */
export function coverageSummary(sample: TableSample | null | undefined): { tone: 'ok' | 'warn' | 'bad'; text: string } | null {
  if (!sample) return null
  const total = sample.rowCount
  const clues = sample.coverage.clues ?? []
  const paged = clues.includes('pagination_present')
  const status = sample.coverage.status
  if (status === 'complete') {
    if (total === 0) return { tone: 'ok', text: '现在没有数据（页面上有“暂无数据”提示，或你已确认空表即没有数据）' }
    return paged
      ? {
          tone: 'warn',
          text:
            sample.pageInfo?.totalRows !== undefined
              ? `本页读到 ${total} 行（分页显示共 ${sample.pageInfo.totalRows} 条）；行检查只针对本页，总条数可用“总条数”检查核对`
              : `本页读到 ${total} 行；这张表还有分页，检查只针对本页`,
        }
      : { tone: 'ok', text: `已读取全部 ${total} 行` }
  }
  const reason = sample.coverage.reasonMessage ?? '读取结果不完整'
  return { tone: status === 'partial' ? 'warn' : 'bad', text: `${reason}；检查结果会是“无法确认”` }
}

export function excludedReasonText(reason: NonNullable<TableDetectedColumn['excludedReason']>): string {
  if (reason === 'derived') return '派生列，需要时勾选'
  return reason === 'checkbox' ? '复选框' : reason === 'index' ? '序号' : reason === 'hidden' ? '页面上隐藏' : '操作按钮'
}

/** 把一次识别结果整理成可直接写回步骤的输入。 */
export function tableInputFromDetected(detected: TableDetected): {
  target: TableReadPlanV2['target']
  as: 'table'
  table: TableReadPlanV2
} {
  return { target: detected.plan.target, as: 'table', table: detected.plan }
}

/** 范围切换候选：最近的外层 / 内层表格。 */
export function scopeAlternatives(detected: TableDetected): {
  outer?: TableDetected['alternatives'][number]
  inner?: TableDetected['alternatives'][number]
} {
  const outer = detected.alternatives.find((a) => a.level === 'outer')
  const inners = detected.alternatives.filter((a) => a.level === 'inner')
  return { outer, inner: inners[inners.length - 1] }
}

/** 从步骤输出里取出表格读取结果（`{ value: table.sample@1 }` 或直接是结果）。 */
export function tableSampleOf(output: unknown): TableSample | null {
  if (typeof output !== 'object' || output === null) return null
  const inner = (output as { value?: unknown }).value
  const candidate = typeof inner === 'object' && inner !== null ? inner : output
  const parsed = tableSampleSchema.safeParse(candidate)
  return parsed.success ? parsed.data : null
}
