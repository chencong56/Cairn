import {
  TABLE_NETWORK_METHODS,
  TABLE_NETWORK_PROTOCOL,
  tableNetworkPlanSchema,
  type JsonOutlineNodeDto,
  type NetworkCapturedEntry,
  type NetworkTableSuggestion,
  type TableColumnSpec,
  type TableNetworkPlan,
} from '@cairn/shared'

/** “选择接口”对话框里正在搭的读取方式：数据在哪、取哪些字段、总条数在哪。 */
export type PickerColumn = Pick<TableColumnSpec, 'key' | 'name' | 'valueType' | 'numericKind'> & { path: string }
export type PickerDraft = {
  layout: 'rows' | 'columns'
  rowsPath?: string
  totalPath?: string
  columns: PickerColumn[]
}

/** 默认勾选的字段数：接口常有几十个字段，先勾前 10 个，需要再勾。 */
export const DEFAULT_PICKED_FIELDS = 10

const toColumn = (c: NetworkTableSuggestion['columns'][number]): PickerColumn => ({
  key: c.key,
  name: c.name,
  path: c.path ?? c.key,
  valueType: c.valueType,
  ...(c.numericKind ? { numericKind: c.numericKind } : {}),
})

export function draftFromSuggestion(s: NetworkTableSuggestion): PickerDraft {
  return {
    layout: s.layout,
    ...(s.rowsPath ? { rowsPath: s.rowsPath } : {}),
    ...(s.totalPath ? { totalPath: s.totalPath } : {}),
    columns: s.columns.slice(0, DEFAULT_PICKED_FIELDS).map(toColumn),
  }
}

/** 列 key：路径能当标识符就用它，否则按序号；不与已有的重复。 */
export function columnKeyFor(path: string, existing: readonly { key: string }[]): string {
  const base = path.replace(/\./g, '_')
  let key = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(base) ? base : `col_${existing.length + 1}`
  let n = 2
  while (existing.some((c) => c.key === key)) key = `${base.replace(/[^A-Za-z0-9_]/g, '') || 'col'}_${n++}`.replace(/^(\d)/, 'c$1').slice(0, 64)
  return key
}

/** 由结构树的叶子推一个列定义（没有建议可用时）。 */
function columnFromNode(node: JsonOutlineNodeDto, path: string, existing: readonly PickerColumn[], name?: string): PickerColumn {
  const integer = node.preview !== undefined && /^-?\d+$/.test(node.preview)
  const valueType = node.type === 'number' ? 'number' : node.type === 'boolean' ? 'boolean' : 'text'
  return {
    key: columnKeyFor(path, existing),
    name: (name ?? path).slice(0, 64),
    path,
    valueType,
    ...(valueType === 'number' ? { numericKind: integer ? ('integer' as const) : ('decimal' as const) } : {}),
  }
}

/** 某个对象数组可选的字段：优先用建议里推断好的类型；数组第 0 项下的基本值叶子都可选。 */
export function rowFieldsOf(nodes: readonly JsonOutlineNodeDto[], rowsPath: string, suggestions: readonly NetworkTableSuggestion[]): PickerColumn[] {
  const s = suggestions.find((x) => x.layout === 'rows' && x.rowsPath === rowsPath)
  if (s) return s.columns.map(toColumn)
  const prefix = `${rowsPath}.0.`
  const out: PickerColumn[] = []
  for (const n of nodes) {
    if (!n.path.startsWith(prefix) || n.type === 'object' || n.type === 'array') continue
    const rel = n.path.slice(prefix.length)
    if (rel.split('.').length > 2) continue
    out.push(columnFromNode(n, rel, out))
  }
  return out
}

/** 用作数据行：换成这个数组，按建议勾选前若干个字段，保留已设的总条数。 */
export function asRowsDraft(draft: PickerDraft | null, nodes: readonly JsonOutlineNodeDto[], rowsPath: string, suggestions: readonly NetworkTableSuggestion[]): PickerDraft {
  const s = suggestions.find((x) => x.layout === 'rows' && x.rowsPath === rowsPath)
  const totalPath = s?.totalPath ?? draft?.totalPath
  return {
    layout: 'rows',
    rowsPath,
    ...(totalPath ? { totalPath } : {}),
    columns: rowFieldsOf(nodes, rowsPath, suggestions).slice(0, DEFAULT_PICKED_FIELDS),
  }
}

export function toggleRowField(draft: PickerDraft, field: PickerColumn, checked: boolean): PickerDraft {
  const present = draft.columns.some((c) => c.path === field.path)
  if (checked === present) return draft
  if (!checked) return { ...draft, columns: draft.columns.filter((c) => c.path !== field.path) }
  return { ...draft, columns: [...draft.columns, { ...field, key: columnKeyFor(field.path, draft.columns) }] }
}

/** 按下标拼成行（图表列式数据）：勾选一个基本值数组作为一列。名字优先用建议里的（series 的 name）。 */
export function toggleSeries(
  draft: PickerDraft | null,
  node: JsonOutlineNodeDto,
  checked: boolean,
  suggestions: readonly NetworkTableSuggestion[],
): PickerDraft {
  const base: PickerDraft = draft?.layout === 'columns' ? draft : { layout: 'columns', ...(draft?.totalPath ? { totalPath: draft.totalPath } : {}), columns: [] }
  const present = base.columns.some((c) => c.path === node.path)
  if (checked === present) return base
  if (!checked) return { ...base, columns: base.columns.filter((c) => c.path !== node.path) }
  const known = suggestions.flatMap((s) => (s.layout === 'columns' ? s.columns : [])).find((c) => c.path === node.path)
  const key = columnKeyFor(node.path, base.columns)
  const col: PickerColumn = known ? { ...toColumn(known), key } : { key, name: node.key.slice(0, 64), path: node.path, valueType: 'text' }
  return { ...base, columns: [...base.columns, col] }
}

export function setTotalPath(draft: PickerDraft | null, path: string | undefined): PickerDraft | null {
  if (!draft) return draft
  const { totalPath: _old, ...rest } = draft
  return path ? { ...rest, totalPath: path } : rest
}

/** 匹配规则：去掉 origin 的地址路径 + 方法（查询串本来就不在去敏地址里）。 */
export function matchFromEntry(entry: Pick<NetworkCapturedEntry, 'url' | 'method'>): TableNetworkPlan['match'] {
  let path = entry.url
  try {
    path = new URL(entry.url).pathname
  } catch {
    // 不是完整地址就原样用
  }
  const method = entry.method.toUpperCase()
  return { url: path, ...((TABLE_NETWORK_METHODS as readonly string[]).includes(method) ? { method: method as TableNetworkPlan['match']['method'] } : {}) }
}

/** 草稿 → 读取计划；草稿还不完整（没有列、按行读却没选数组）时返回 null。 */
export function planFromDraft(
  entry: Pick<NetworkCapturedEntry, 'url' | 'method'>,
  draft: PickerDraft | null,
  base?: Pick<TableNetworkPlan, 'pick' | 'window' | 'limits'> | null,
): TableNetworkPlan | null {
  if (!draft || draft.columns.length === 0) return null
  if (draft.layout === 'rows' && !draft.rowsPath) return null
  const parsed = tableNetworkPlanSchema.safeParse({
    protocol: TABLE_NETWORK_PROTOCOL,
    match: matchFromEntry(entry),
    ...(base ? { pick: base.pick, window: base.window, limits: base.limits } : {}),
    layout: draft.layout,
    ...(draft.layout === 'rows' ? { rowsPath: draft.rowsPath } : {}),
    ...(draft.totalPath ? { totalPath: draft.totalPath } : {}),
    columns: draft.columns.map((c) => ({
      key: c.key,
      name: c.name,
      path: c.path,
      valueType: c.valueType,
      ...(c.valueType === 'number' ? { numericKind: c.numericKind ?? 'decimal' } : {}),
    })),
  })
  return parsed.success ? parsed.data : null
}

/** 已有计划 → 草稿（重新打开对话框时沿用）。 */
export function draftFromPlan(plan: TableNetworkPlan): PickerDraft {
  return {
    layout: plan.layout,
    ...(plan.rowsPath ? { rowsPath: plan.rowsPath } : {}),
    ...(plan.totalPath ? { totalPath: plan.totalPath } : {}),
    columns: plan.columns.map((c) => ({
      key: c.key,
      name: c.name,
      path: c.path ?? c.key,
      valueType: c.valueType,
      ...(c.numericKind ? { numericKind: c.numericKind } : {}),
    })),
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
