import { newUuid } from '@/lib/uuid'
import { DEFAULT_TABLE_TIMEZONE, TABLE_STATUS_TONES, TABLE_STATUS_TONE_LABEL, describeTablePredicate, expectedPageRows, type OutcomeContract, type TableCondition, type TableExpectRule, type TablePageInfo, type TablePredicate } from '@cairn/shared'

export type { TableExpectRule }

/** tone＝状态语义列（读的是标签 / 进度等组件的语义，取值是固定的几种）。 */
export type ColumnType = 'text' | 'number' | 'date' | 'boolean' | 'tone'
export type CheckColumn = {
  key: string
  label: string
  numeric: boolean
  valueType?: ColumnType
  numericKind?: 'integer' | 'decimal' | 'float'
  /** 已设为敏感（打码）的列不能用于条件 */
  sensitive?: boolean
}
export const columnTypeOf = (col: Pick<CheckColumn, 'numeric' | 'valueType'> | undefined): ColumnType =>
  col?.valueType ?? (col?.numeric ? 'number' : 'text')
export type CheckKind = 'table' | 'cards' | 'keyvalue' | 'status'

/** 各形态下的叫法：表格是“行”，卡片是“张”，键值信息只有一行、不说“每一行”。 */
export function everyPrefix(kind: CheckKind): string {
  return kind === 'cards' ? '每张卡片的' : kind === 'keyvalue' ? '' : kind === 'status' ? '每一项的' : '每一行的'
}
export function anyPrefix(kind: CheckKind): string {
  return kind === 'cards' ? '至少有一张卡片的' : kind === 'keyvalue' ? '' : kind === 'status' ? '至少有一项的' : '至少有一行的'
}
export function countNoun(kind: CheckKind): { subject: string; unit: string } {
  return kind === 'cards' ? { subject: '卡片共有', unit: '张' } : kind === 'status' ? { subject: '状态共有', unit: '项' } : { subject: '表里共有的行数', unit: '行' }
}

/** 语义下拉的选项（不让用户手填英文代号）。 */
export const TONE_OPTIONS = TABLE_STATUS_TONES.map((t) => ({ value: t, label: TABLE_STATUS_TONE_LABEL[t] }))

export type CheckTemplate =
  | 'row_count'
  | 'all_rows'
  | 'any_row'
  | 'column_stat'
  | 'total_row_match'
  | 'column_unique'
  | 'row_lookup'
  | 'page_total'
  | 'page_consistency'
  | 'record_sets_match'
  | 'tree_rollup_match'
  | 'crosstab_total_match'

export type TemplateOption = { value: CheckTemplate; label: string; example: string }

export const TEMPLATE_OPTIONS: TemplateOption[] = [
  { value: 'row_count', label: '共有多少行', example: '例：表里至少有 1 行' },
  { value: 'all_rows', label: '每一行都满足', example: '例：每一行的「状态」都不是“失败”' },
  { value: 'any_row', label: '至少有一行满足', example: '例：至少有一行的「状态」是“成功”' },
  { value: 'row_lookup', label: '找到某一行，再检查它', example: '例：名称是“需求订单统计表”的行，最新数据不能为 0' },
  { value: 'column_stat', label: '某列的合计 / 平均 / 最大 / 最小', example: '例：收入合计大于 0' },
  { value: 'total_row_match', label: '各行相加等于合计行', example: '例：收入各行相加和合计行一致' },
  { value: 'column_unique', label: '某列没有重复值', example: '例：报表名称不重复' },
]

/** 分页检查模板：只有预览里读到了相应的分页信息才出现。 */
export const PAGE_TEMPLATE_OPTIONS: TemplateOption[] = [
  { value: 'page_total', label: '总条数（分页显示）', example: '例：分页显示的总条数大于 0' },
  { value: 'page_consistency', label: '本页条数与分页一致', example: '例：本页读到的行数与分页显示一致，发现漏行' },
]

/** 与另一份数据比对：只有本步之前还有别的“一组数据”提取步骤时出现。 */
export const COMPARE_TEMPLATE_OPTION: TemplateOption = {
  value: 'record_sets_match',
  label: '与另一份数据一致',
  example: '例：页面表格与接口返回按编号逐行一致',
}

/** 树形检查：只有读法是树形、读取范围是全部已展开的行时出现。 */
export const TREE_TEMPLATE_OPTION: TemplateOption = {
  value: 'tree_rollup_match',
  label: '父行等于子行之和',
  example: '例：每个区域的收入等于其下城市之和',
}

/** 交叉表检查：只有读法是交叉表时出现（合计格 / 小计格已从数据行里分离出来）。 */
export const CROSSTAB_TEMPLATE_OPTION: TemplateOption = {
  value: 'crosstab_total_match',
  label: '合计格等于明细之和',
  example: '例：华东小计等于各城市之和，总计等于各小计之和',
}

/** 本步之前、可以拿来比对的另一份数据（另一个读取一组数据的提取步骤）。 */
export type OtherRecordSet = { key: string; stepId: string; stepName: string; columns: CheckColumn[] }

/**
 * 该形态下可选的检查模板。键值信息只有一条记录：只给“某项满足条件”。
 * 分页检查只在表格、且预览里读到了总条数（或足以算出本页应有行数）时出现；
 * “与另一份数据一致”只在本步之前还有别的一组数据时出现。
 */
export function templatesFor(
  kind: CheckKind,
  pageInfo?: TablePageInfo | null,
  others: readonly OtherRecordSet[] = [],
  /** 读法是树形且读取范围是全部已展开的行。 */
  tree = false,
  /** 读法是交叉表。 */
  crosstab = false,
): TemplateOption[] {
  const paging =
    kind === 'table' && pageInfo
      ? PAGE_TEMPLATE_OPTIONS.filter((t) => (t.value === 'page_total' ? pageInfo.totalRows !== undefined : expectedPageRows(pageInfo) !== null))
      : []
  const compare = kind !== 'keyvalue' && others.length > 0 ? [COMPARE_TEMPLATE_OPTION] : []
  const rollup = kind === 'table' && tree ? [TREE_TEMPLATE_OPTION] : []
  const cross = kind === 'table' && crosstab ? [CROSSTAB_TEMPLATE_OPTION] : []
  return [...baseTemplatesFor(kind), ...cross, ...paging, ...rollup, ...compare]
}

/** 列名配对用的规整：去空白、括号里的单位、大小写；常见字段名（英文整词、中文按结尾，如“站点名称”）视为同一个。 */
const SYNONYMS: Array<RegExp> = [
  /^(id|no|code)$|(编号|代码|编码)$/,
  /^(name|title)$|(名称|标题)$/,
  /^(qty|quantity|count|num)$|(数量|个数)$/,
  /^(amount|money|price)$|金额$/,
  /^(status|state)$|状态$/,
  /^(date|day|time)$|(日期|时间)$/,
  /^(region|area)$|(区域|地区)$/,
]
function normName(label: string): string {
  const base = label.toLowerCase().replace(/[（(][^）)]*[）)]/g, '').replace(/[\s_\-:：]/g, '')
  const i = SYNONYMS.findIndex((re) => re.test(base))
  return i >= 0 ? `#${i}` : base
}

/** 按列名把本表的列与另一份的列配对（规整后相同才配）。 */
export function pairColumns(mine: readonly CheckColumn[], theirs: readonly CheckColumn[]): Array<{ column: string; otherColumn: string }> {
  const used = new Set<string>()
  const pairs: Array<{ column: string; otherColumn: string }> = []
  for (const c of mine) {
    const match = theirs.find((o) => !used.has(o.key) && (normName(o.label) === normName(c.label) || normName(o.key) === normName(c.label)))
    if (match) {
      used.add(match.key)
      pairs.push({ column: c.key, otherColumn: match.key })
    }
  }
  return pairs
}

/** 新建“与另一份数据一致”的默认规则：第一对配上的列作键，其余配上的列都比对。 */
export function defaultCompareRule(columns: readonly CheckColumn[], other: OtherRecordSet): TableExpectRule | null {
  const mine = columns.filter((c) => !c.sensitive)
  const theirs = other.columns.filter((c) => !c.sensitive)
  if (mine.length === 0 || theirs.length === 0) return null
  const pairs = pairColumns(mine, theirs)
  const key = pairs[0] ?? { column: mine[0]!.key, otherColumn: theirs[0]!.key }
  const rest = pairs.filter((p) => p.column !== key.column)
  const compare = rest.length > 0 ? rest : [{ column: (mine.find((c) => c.key !== key.column) ?? mine[0]!).key, otherColumn: (theirs.find((c) => c.key !== key.otherColumn) ?? theirs[0]!).key }]
  return {
    rule: 'record_sets_match',
    otherKey: other.key,
    key,
    columns: compare.map((p) => ({ ...p, precision: 'display' as const })),
  }
}

function baseTemplatesFor(kind: CheckKind): TemplateOption[] {
  if (kind === 'keyvalue') return [{ value: 'all_rows', label: '某一项满足条件', example: '例：「状态」是“运行中”' }]
  if (kind === 'status') {
    return [
      { value: 'row_count', label: '共有多少项', example: '例：至少有 1 项' },
      { value: 'all_rows', label: '每一项都满足', example: '例：每一项的「语义」都不是“错误”' },
      { value: 'any_row', label: '至少有一项满足', example: '例：至少有一项的「语义」是“进行中”' },
      { value: 'row_lookup', label: '找到某一项，再检查它', example: '例：文字是“财务复核”的那一步，语义是“成功”' },
    ]
  }
  if (kind === 'cards') {
    return TEMPLATE_OPTIONS.filter((t) => t.value !== 'total_row_match').map((t) =>
      t.value === 'row_count'
        ? { ...t, label: '共有多少张卡片', example: '例：至少有 1 张卡片' }
        : t.value === 'all_rows'
          ? { ...t, label: '每张卡片都满足', example: '例：每张卡片的「告警数」都是 0' }
          : t.value === 'any_row'
            ? { ...t, label: '至少有一张卡片满足', example: '例：至少有一张卡片的「状态」是“正常”' }
            : t.value === 'row_lookup'
              ? { ...t, label: '找到某一张卡片，再检查它', example: '例：标题是“服务器A”的卡片，告警数不能大于 0' }
              : t,
    )
  }
  return TEMPLATE_OPTIONS
}

export const COMPARE_LABEL = {
  eq: '等于',
  neq: '不等于',
  gt: '大于',
  gte: '大于等于',
  lt: '小于',
  lte: '小于等于',
} as const
export type CompareOp = keyof typeof COMPARE_LABEL

export const STAT_LABEL = { sum: '合计', avg: '平均值', min: '最小值', max: '最大值' } as const

const PREDICATE_TEXT: Record<string, string> = {
  ...COMPARE_LABEL,
  contains: '包含',
  starts_with: '以…开头',
  ends_with: '以…结尾',
  is_empty: '为空',
  is_not_empty: '不为空',
}

export const ROW_PREDICATE_OPS = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'is_empty',
  'is_not_empty',
] as const

function predicateText(p: { op: string; value?: unknown }): string {
  if (p.op.startsWith('date_')) return describeTablePredicate(p as TablePredicate)
  if (typeof p.value === 'string' && (TABLE_STATUS_TONES as readonly string[]).includes(p.value)) {
    return `${p.op === 'neq' ? '不是' : '是'}「${TABLE_STATUS_TONE_LABEL[p.value as (typeof TABLE_STATUS_TONES)[number]]}」`
  }
  if (p.op === 'is_empty' || p.op === 'is_not_empty') return PREDICATE_TEXT[p.op] ?? p.op
  if (p.op === 'starts_with') return `以「${String(p.value)}」开头`
  if (p.op === 'ends_with') return `以「${String(p.value)}」结尾`
  const v = typeof p.value === 'string' ? `「${p.value}」` : String(p.value)
  return `${PREDICATE_TEXT[p.op] ?? p.op} ${v}`
}


export type DateMode =
  | 'today'
  | 'yesterday'
  | 'days_n'
  | 'date_before'
  | 'date_after'
  | 'date_on_or_before'
  | 'date_on_or_after'
  | 'date_on'
  | 'is_empty'
  | 'is_not_empty'

export const DATE_MODE_OPTIONS: Array<{ mode: DateMode; label: string }> = [
  { mode: 'today', label: '是今天' },
  { mode: 'yesterday', label: '不早于昨天' },
  { mode: 'days_n', label: '不早于 N 天前' },
  { mode: 'date_on', label: '等于某个日期' },
  { mode: 'date_before', label: '早于某个日期' },
  { mode: 'date_after', label: '晚于某个日期' },
  { mode: 'date_on_or_before', label: '不晚于某个日期' },
  { mode: 'date_on_or_after', label: '不早于某个日期' },
  { mode: 'is_empty', label: '为空' },
  { mode: 'is_not_empty', label: '不为空' },
]

export function dateModeOf(pred: TablePredicate): DateMode {
  if (pred.op === 'date_within_days') return pred.days === 0 ? 'today' : pred.days === 1 ? 'yesterday' : 'days_n'
  if (pred.op === 'is_empty' || pred.op === 'is_not_empty') return pred.op
  if (pred.op.startsWith('date_')) return pred.op as DateMode
  return 'date_on'
}

export const localIsoDate = (d: Date = new Date()): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** 切换日期条件的“模式”，尽量沿用已填的天数 / 日期 / 时区设置。 */
export function predicateFromDateMode(mode: DateMode, prev: TablePredicate): TablePredicate {
  if (mode === 'is_empty' || mode === 'is_not_empty') return { op: mode }
  if (mode === 'today' || mode === 'yesterday' || mode === 'days_n') {
    const old = prev.op === 'date_within_days' ? prev : null
    const days = mode === 'today' ? 0 : mode === 'yesterday' ? 1 : old && old.days > 1 ? old.days : 3
    return { op: 'date_within_days', days, allowFuture: old?.allowFuture ?? false, timezone: old?.timezone ?? DEFAULT_TABLE_TIMEZONE }
  }
  const value = 'value' in prev && typeof prev.value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(prev.value) ? prev.value : localIsoDate()
  return { op: mode, value }
}

/** 小数 / 浮点列做“等于 / 不等于”时，编译要求显式精度策略：自动补一个精确到 8 位的，用户不用懂。 */
export const EXACT_NUMBER_POLICY = { mode: 'fixed', scale: 8, rounding: 'half_away_from_zero' } as const

const TEXT_WHERE_OPS = [
  { op: 'eq', label: '等于' },
  { op: 'neq', label: '不等于' },
  { op: 'contains', label: '包含' },
  { op: 'starts_with', label: '开头是' },
] as const
const NUMBER_OPS = [
  { op: 'eq', label: '等于' },
  { op: 'neq', label: '不等于' },
  { op: 'gt', label: '大于' },
  { op: 'gte', label: '大于等于' },
  { op: 'lt', label: '小于' },
  { op: 'lte', label: '小于等于' },
] as const
const EMPTY_OPS = [
  { op: 'is_empty', label: '为空' },
  { op: 'is_not_empty', label: '不为空' },
] as const

/** 某类列上可选的条件。找行（where）不提供“为空”，要检查（expect）才提供。 */
export function predicateOptionsFor(type: ColumnType, side: 'where' | 'expect'): Array<{ op: TablePredicate['op']; label: string }> {
  const base =
    type === 'tone'
      ? [{ op: 'eq', label: '是' } as const, { op: 'neq', label: '不是' } as const]
      : type === 'number'
      ? [...NUMBER_OPS]
      : type === 'boolean'
        ? [{ op: 'eq', label: '等于' } as const, { op: 'neq', label: '不等于' } as const]
        : [...TEXT_WHERE_OPS]
  return side === 'expect' ? [...base, ...EMPTY_OPS] : base
}

export function defaultPredicate(col: CheckColumn | undefined, side: 'where' | 'expect'): TablePredicate {
  const type = columnTypeOf(col)
  if (type === 'date') return side === 'expect' ? predicateFromDateMode('yesterday', { op: 'is_not_empty' }) : predicateFromDateMode('date_on', { op: 'is_not_empty' })
  if (type === 'number') return normalizePredicate({ op: side === 'expect' ? 'neq' : 'eq', value: 0 }, col)
  if (type === 'boolean') return { op: 'eq', value: true }
  if (type === 'tone') return { op: 'eq', value: 'success' }
  return side === 'expect' ? { op: 'is_not_empty' } : { op: 'eq', value: '' }
}

/** 按列类型补齐 / 去掉精度策略，保证保存后编译能过。 */
export function normalizePredicate(pred: TablePredicate, col: CheckColumn | undefined): TablePredicate {
  if (pred.op !== 'eq' && pred.op !== 'neq') return pred
  const { numericPolicy: _old, ...rest } = pred
  if (typeof pred.value === 'number' && columnTypeOf(col) === 'number' && (col?.numericKind ?? 'decimal') !== 'integer') {
    return { ...rest, numericPolicy: EXACT_NUMBER_POLICY } as TablePredicate
  }
  return rest as TablePredicate
}

export function emptyCondition(col: CheckColumn | undefined, side: 'where' | 'expect'): TableCondition {
  return { column: col?.key ?? '', predicate: defaultPredicate(col, side) }
}

/** 编辑器每次改动后统一规整：条件里的精度策略随列类型补齐。 */
export function normalizeRule(rule: TableExpectRule, columns: readonly CheckColumn[]): TableExpectRule {
  const colOf = (key: string) => columns.find((c) => c.key === key)
  if (rule.rule === 'all_rows' || rule.rule === 'any_row') {
    return { ...rule, predicate: normalizePredicate(rule.predicate, colOf(rule.column)) }
  }
  if (rule.rule === 'row_lookup') {
    const fix = (c: TableCondition): TableCondition => ({ ...c, predicate: normalizePredicate(c.predicate, colOf(c.column)) })
    return { ...rule, where: rule.where.map(fix), expect: rule.expect.map(fix) }
  }
  return rule
}

/** 还没填完整（找行的值为空等）：编辑器提醒用户，不阻断保存。 */
export function lookupIncomplete(rule: TableExpectRule): string | null {
  if (rule.rule !== 'row_lookup') return null
  const blank = rule.where.some((c) => {
    const p = c.predicate
    return 'value' in p && typeof p.value === 'string' && p.value.trim() === ''
  })
  return blank ? '请填写要找的内容' : null
}

function conditionsSentence(conds: readonly TableCondition[], labelOf: (key: string) => string): string {
  return conds.map((c) => `「${labelOf(c.column)}」${describeTablePredicate(c.predicate)}`).join('，并且')
}

/** 规则 → 给人读的完整句子（同时作为合约的 meaning）。 */
export function sentenceOf(rule: TableExpectRule, labelOf: (key: string) => string, kind: CheckKind = 'table'): string {
  switch (rule.rule) {
    case 'row_count':
      return `${countNoun(kind).subject}${COMPARE_LABEL[rule.op as CompareOp] ?? rule.op} ${rule.value} ${countNoun(kind).unit}`
    case 'all_rows':
      return kind === 'keyvalue' ? `「${labelOf(rule.column)}」${predicateText(rule.predicate)}` : `${everyPrefix(kind)}「${labelOf(rule.column)}」都${predicateText(rule.predicate)}`
    case 'any_row':
      return `${anyPrefix(kind)}「${labelOf(rule.column)}」${predicateText(rule.predicate)}`
    case 'column_stat':
      return `「${labelOf(rule.column)}」的${STAT_LABEL[rule.stat]}${COMPARE_LABEL[rule.op]} ${rule.value}${rule.ignoreEmpty ? '（忽略空值）' : ''}`
    case 'total_row_match':
      return `「${labelOf(rule.column)}」各行相加等于合计行${rule.precision === 'exact' ? '（精确比较）' : ''}`
    case 'column_unique':
      return `「${labelOf(rule.column)}」没有重复值`
    case 'row_lookup': {
      const unit = kind === 'cards' ? '卡片' : '行'
      const missing = rule.onMissing === 'fail' ? '记为不通过' : rule.onMissing === 'unknown' ? '记为无法确认' : '当作通过'
      const multi = rule.onMultiple === 'any' ? `；找到多${kind === 'cards' ? '张' : '行'}时只要有一${kind === 'cards' ? '张' : '行'}满足即可` : ''
      return `找到${conditionsSentence(rule.where, labelOf)}的${unit}，它的${conditionsSentence(rule.expect, labelOf)}${multi}；找不到这${kind === 'cards' ? '张卡片' : '一行'}${missing}`
    }
    case 'page_total':
      return `分页显示的总条数${COMPARE_LABEL[rule.op]} ${rule.value} 条`
    case 'page_consistency':
      return '本页读到的行数与分页显示一致'
    case 'tree_rollup_match':
      return `每个父行的「${labelOf(rule.column)}」等于其下一级之和${rule.precision === 'exact' ? '（精确比较）' : ''}`
    case 'crosstab_total_match':
      return `每个合计 / 小计格等于它汇总范围内明细之和${rule.precision === 'exact' ? '（精确比较）' : ''}`
    case 'record_sets_match':
      return `与「${rule.otherKey}」按「${labelOf(rule.key.column)}」逐行一致（比对${rule.columns.map((c) => `「${labelOf(c.column)}」`).join('、')}）`
    case 'row_expression':
      return rule.quantifier === 'all' ? `${kind === 'cards' ? '每张卡片' : '每一行'}都满足自定义条件（高级）` : `至少有${kind === 'cards' ? '一张卡片' : '一行'}满足自定义条件（高级）`
  }
}

/** 新建某个模板的默认规则；没有可用列时返回 null。 */
export function defaultRule(template: CheckTemplate, columns: readonly CheckColumn[]): TableExpectRule | null {
  const first = columns[0]
  const firstNumber = columns.find((c) => c.numeric)
  switch (template) {
    case 'row_count':
      return { rule: 'row_count', op: 'gte', value: 1 }
    case 'all_rows':
      return first ? { rule: 'all_rows', column: first.key, predicate: { op: 'is_not_empty' }, allowEmpty: false } : null
    case 'any_row':
      return first ? { rule: 'any_row', column: first.key, predicate: { op: 'is_not_empty' } } : null
    case 'column_stat':
      return firstNumber
        ? { rule: 'column_stat', column: firstNumber.key, stat: 'sum', op: 'gte', value: 0, ignoreEmpty: false }
        : null
    case 'total_row_match':
      return firstNumber ? { rule: 'total_row_match', column: firstNumber.key, precision: 'display' } : null
    case 'column_unique':
      return first ? { rule: 'column_unique', column: first.key } : null
    case 'page_total':
      return { rule: 'page_total', op: 'gt', value: 0 }
    case 'page_consistency':
      return { rule: 'page_consistency' }
    case 'record_sets_match':
      return null
    case 'tree_rollup_match':
      return firstNumber ? { rule: 'tree_rollup_match', column: firstNumber.key, precision: 'display' } : null
    case 'crosstab_total_match':
      return { rule: 'crosstab_total_match', precision: 'display' }
    case 'row_lookup': {
      if (!first) return null
      const usable = columns.filter((c) => !c.sensitive)
      const whereCol = usable[0] ?? first
      const expectCol = usable.find((c) => c.key !== whereCol.key && columnTypeOf(c) === 'number') ?? usable.find((c) => c.key !== whereCol.key) ?? whereCol
      return normalizeRule(
        { rule: 'row_lookup', where: [emptyCondition(whereCol, 'where')], expect: [emptyCondition(expectCol, 'expect')], onMissing: 'fail', onMultiple: 'all' },
        columns,
      )
    }
  }
}

export function templateOf(rule: TableExpectRule): CheckTemplate | 'row_expression' {
  return rule.rule
}

export type TableCheckContract = OutcomeContract & {
  rule: { kind: 'context'; key: string; expect: { kind: 'table'; rule: TableExpectRule } }
}

export function isTableCheck(contract: OutcomeContract): contract is TableCheckContract {
  return contract.rule.kind === 'context' && contract.rule.expect.kind === 'table'
}

export function buildTableCheck(
  outputKey: string,
  rule: TableExpectRule,
  labelOf: (key: string) => string,
  severity: 'MUST' | 'SHOULD' = 'MUST',
  id: string = newUuid(),
  kind: CheckKind = 'table',
): TableCheckContract {
  return {
    id,
    scope: 'step',
    meaning: sentenceOf(rule, labelOf, kind).slice(0, 512),
    severity,
    onViolation: 'continue',
    provenance: 'manual',
    rule: { kind: 'context', key: outputKey, expect: { kind: 'table', rule } },
  } as TableCheckContract
}

/** 改规则后重建合约（保留 id / 严重度，meaning 随句子刷新）。 */
export function withRule(
  contract: TableCheckContract,
  rule: TableExpectRule,
  labelOf: (key: string) => string,
  kind: CheckKind = 'table',
): TableCheckContract {
  return buildTableCheck(contract.rule.key, rule, labelOf, contract.severity === 'SHOULD' ? 'SHOULD' : 'MUST', contract.id, kind)
}

export function withSeverity(
  contract: TableCheckContract,
  severity: 'MUST' | 'SHOULD',
  labelOf: (key: string) => string,
  kind: CheckKind = 'table',
): TableCheckContract {
  return buildTableCheck(contract.rule.key, contract.rule.expect.rule, labelOf, severity, contract.id, kind)
}

/** 把表格数据检查和别的成功条件拆开：[检查, 其余]。 */
export function splitTableChecks(outcomes: readonly OutcomeContract[]): {
  checks: TableCheckContract[]
  others: OutcomeContract[]
} {
  const checks: TableCheckContract[] = []
  const others: OutcomeContract[] = []
  for (const c of outcomes) {
    if (isTableCheck(c)) checks.push(c)
    else others.push(c)
  }
  return { checks, others }
}
