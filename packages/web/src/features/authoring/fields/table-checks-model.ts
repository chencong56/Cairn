import { newUuid } from '@/lib/uuid'
import type { OutcomeContract, TableExpectRule } from '@cairn/shared'

export type { TableExpectRule }

export type CheckColumn = { key: string; label: string; numeric: boolean }
export type CheckKind = 'table' | 'cards' | 'keyvalue'

/** 各形态下的叫法：表格是“行”，卡片是“张”，键值信息只有一行、不说“每一行”。 */
export function everyPrefix(kind: CheckKind): string {
  return kind === 'cards' ? '每张卡片的' : kind === 'keyvalue' ? '' : '每一行的'
}
export function anyPrefix(kind: CheckKind): string {
  return kind === 'cards' ? '至少有一张卡片的' : kind === 'keyvalue' ? '' : '至少有一行的'
}
export function countNoun(kind: CheckKind): { subject: string; unit: string } {
  return kind === 'cards' ? { subject: '卡片共有', unit: '张' } : { subject: '表里共有的行数', unit: '行' }
}

export type CheckTemplate =
  | 'row_count'
  | 'all_rows'
  | 'any_row'
  | 'column_stat'
  | 'total_row_match'
  | 'column_unique'

export const TEMPLATE_OPTIONS: { value: CheckTemplate; label: string }[] = [
  { value: 'row_count', label: '共有多少行' },
  { value: 'all_rows', label: '每一行都满足' },
  { value: 'any_row', label: '至少有一行满足' },
  { value: 'column_stat', label: '某列的合计 / 平均 / 最大 / 最小' },
  { value: 'total_row_match', label: '各行相加等于合计行' },
  { value: 'column_unique', label: '某列没有重复值' },
]

/** 该形态下可选的检查模板。键值信息只有一条记录：只给“某项满足条件”。 */
export function templatesFor(kind: CheckKind): { value: CheckTemplate; label: string }[] {
  if (kind === 'keyvalue') return [{ value: 'all_rows', label: '某一项满足条件' }]
  if (kind === 'cards') {
    return TEMPLATE_OPTIONS.filter((t) => t.value !== 'total_row_match').map((t) =>
      t.value === 'row_count' ? { ...t, label: '共有多少张卡片' } : t.value === 'all_rows' ? { ...t, label: '每张卡片都满足' } : t.value === 'any_row' ? { ...t, label: '至少有一张卡片满足' } : t,
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
  if (p.op === 'is_empty' || p.op === 'is_not_empty') return PREDICATE_TEXT[p.op] ?? p.op
  if (p.op === 'starts_with') return `以「${String(p.value)}」开头`
  if (p.op === 'ends_with') return `以「${String(p.value)}」结尾`
  const v = typeof p.value === 'string' ? `「${p.value}」` : String(p.value)
  return `${PREDICATE_TEXT[p.op] ?? p.op} ${v}`
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
