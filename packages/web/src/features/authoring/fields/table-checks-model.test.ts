import { describe, expect, it } from 'vitest'
import { outcomeContractSchema } from '@cairn/shared'
import {
  buildTableCheck,
  defaultRule,
  sentenceOf,
  splitTableChecks,
  templatesFor,
  normalizeRule,
  predicateOptionsFor,
  lookupIncomplete,
  EXACT_NUMBER_POLICY,
  defaultPredicate,
  dateModeOf,
  predicateFromDateMode,
  withRule,
  withSeverity,
  type CheckColumn,
} from './table-checks-model'

const columns: CheckColumn[] = [
  { key: 'name', label: '区域', numeric: false },
  { key: 'amount', label: '收入', numeric: true },
]
const labelOf = (k: string) => columns.find((c) => c.key === k)?.label ?? k

describe('表格数据检查模型', () => {
  it('每个模板都能生成合法的业务结果合约', () => {
    for (const t of ['row_count', 'all_rows', 'any_row', 'column_stat', 'total_row_match', 'column_unique'] as const) {
      const rule = defaultRule(t, columns)!
      const c = buildTableCheck('report', rule, labelOf)
      expect(outcomeContractSchema.safeParse(c).success, t).toBe(true)
      expect(c.onViolation).toBe('continue')
      expect(c.meaning).toBe(sentenceOf(rule, labelOf))
    }
  })

  it('没有数字列时聚合模板不可用', () => {
    expect(defaultRule('column_stat', [columns[0]!])).toBeNull()
    expect(defaultRule('total_row_match', [])).toBeNull()
  })

  it('句子完整可读', () => {
    expect(sentenceOf({ rule: 'column_stat', column: 'amount', stat: 'sum', op: 'gt', value: 0, ignoreEmpty: true }, labelOf)).toBe(
      '「收入」的合计大于 0（忽略空值）',
    )
    expect(sentenceOf({ rule: 'total_row_match', column: 'amount', precision: 'display' }, labelOf)).toBe('「收入」各行相加等于合计行')
    expect(sentenceOf({ rule: 'column_unique', column: 'name' }, labelOf)).toBe('「区域」没有重复值')
  })

  it('改规则保留 id，meaning 随句子刷新；只提醒改为 SHOULD 且合法', () => {
    const c = buildTableCheck('report', { rule: 'column_unique', column: 'name' }, labelOf)
    const next = withRule(c, { rule: 'column_unique', column: 'amount' }, labelOf)
    expect(next.id).toBe(c.id)
    expect(next.meaning).toContain('收入')
    const soft = withSeverity(next, 'SHOULD', labelOf)
    expect(soft.severity).toBe('SHOULD')
    expect(outcomeContractSchema.safeParse(soft).success).toBe(true)
  })

  it('拆分表格检查与其它成功条件', () => {
    const check = buildTableCheck('report', { rule: 'row_count', op: 'gte', value: 1 }, labelOf)
    const other = {
      id: '22222222-2222-4222-8222-222222222222',
      scope: 'step' as const,
      meaning: '按钮已点击',
      severity: 'MUST' as const,
      onViolation: 'halt' as const,
      provenance: 'manual' as const,
      rule: { kind: 'deterministic' as const, expect: { kind: 'exists' as const } },
    }
    const { checks, others } = splitTableChecks([other as never, check])
    expect(checks).toHaveLength(1)
    expect(others).toHaveLength(1)
  })

  it('卡片与键值信息有自己的叫法和可用模板', () => {
    expect(templatesFor('keyvalue').map((t) => t.value)).toEqual(['all_rows'])
    expect(templatesFor('cards').map((t) => t.value)).not.toContain('total_row_match')
    expect(templatesFor('table').map((t) => t.value)).toContain('total_row_match')
    const eq = { rule: 'all_rows', column: 'name', predicate: { op: 'eq', value: '运行中' }, allowEmpty: false } as const
    expect(sentenceOf(eq, labelOf, 'keyvalue')).toBe('「区域」等于 「运行中」')
    expect(sentenceOf(eq, labelOf, 'cards')).toBe('每张卡片的「区域」都等于 「运行中」')
    expect(sentenceOf({ rule: 'row_count', op: 'gte', value: 3 }, labelOf, 'cards')).toBe('卡片共有大于等于 3 张')
    const c = buildTableCheck('card', eq, labelOf, 'MUST', undefined, 'keyvalue')
    expect(c.meaning).toBe('「区域」等于 「运行中」')
    expect(outcomeContractSchema.safeParse(c).success).toBe(true)
  })

  describe('找到某一行，再检查它', () => {
    const cols: CheckColumn[] = [
      { key: 'name', label: '报表名称', numeric: false, valueType: 'text' },
      { key: 'data', label: '最新数据', numeric: true, valueType: 'number', numericKind: 'decimal' },
      { key: 'phone', label: '电话', numeric: false, valueType: 'text', sensitive: true },
    ]
    const lbl = (k: string) => cols.find((c) => c.key === k)?.label ?? k

    it('默认规则合法：找行用第一个可用列，检查用数字列，小数列自动补精确精度策略', () => {
      const rule = defaultRule('row_lookup', cols)!
      expect(rule.rule).toBe('row_lookup')
      if (rule.rule !== 'row_lookup') return
      expect(rule.where[0]?.column).toBe('name')
      expect(rule.expect[0]?.column).toBe('data')
      expect(rule.expect[0]?.predicate).toEqual({ op: 'neq', value: 0, numericPolicy: EXACT_NUMBER_POLICY })
      expect(rule.onMissing).toBe('fail')
      const c = buildTableCheck('report', rule, lbl)
      expect(outcomeContractSchema.safeParse(c).success).toBe(true)
    })

    it('整句：多个条件用“并且”，找不到怎么办写在句尾；卡片说“卡片”', () => {
      const rule = normalizeRule(
        { rule: 'row_lookup', where: [{ column: 'name', predicate: { op: 'eq', value: '需求订单统计表' } }], expect: [{ column: 'data', predicate: { op: 'neq', value: 0 } }], onMissing: 'unknown', onMultiple: 'any' },
        cols,
      )
      expect(sentenceOf(rule, lbl)).toBe('找到「报表名称」等于「需求订单统计表」的行，它的「最新数据」不等于 0；找到多行时只要有一行满足即可；找不到这一行记为无法确认')
      expect(sentenceOf(rule, lbl, 'cards')).toContain('的卡片')
    })

    it('精度策略随列类型补齐 / 去掉：整数列和文字列不带', () => {
      const intCols: CheckColumn[] = [{ key: 'n', label: '数量', numeric: true, valueType: 'number', numericKind: 'integer' }]
      const r = normalizeRule({ rule: 'all_rows', column: 'n', predicate: { op: 'eq', value: 3, numericPolicy: EXACT_NUMBER_POLICY }, allowEmpty: false }, intCols)
      expect(r.rule === 'all_rows' && 'numericPolicy' in r.predicate).toBe(false)
    })

    it('条件选项随列类型变化：找行不给“为空”，检查才给；数字列才有大小比较', () => {
      expect(predicateOptionsFor('text', 'where').map((o) => o.op)).toEqual(['eq', 'neq', 'contains', 'starts_with'])
      expect(predicateOptionsFor('text', 'expect').map((o) => o.op)).toContain('is_empty')
      expect(predicateOptionsFor('number', 'where').map((o) => o.op)).toContain('gt')
      expect(predicateOptionsFor('boolean', 'where').map((o) => o.op)).toEqual(['eq', 'neq'])
    })

    it('找行的值还是空时提醒“请填写要找的内容”', () => {
      const rule = defaultRule('row_lookup', cols)!
      expect(lookupIncomplete(rule)).toBe('请填写要找的内容')
    })

    it('菜单：表格、卡片有，键值没有；每项带例子', () => {
      expect(templatesFor('table').map((t) => t.value)).toContain('row_lookup')
      expect(templatesFor('cards').find((t) => t.value === 'row_lookup')?.label).toBe('找到某一张卡片，再检查它')
      expect(templatesFor('keyvalue').map((t) => t.value)).not.toContain('row_lookup')
      expect(templatesFor('table').every((t) => t.example.startsWith('例：'))).toBe(true)
    })
  })
})

describe('日期列条件模型', () => {
  const dateCol = { key: 'd', label: '最新数据', numeric: false, valueType: 'date' as const }
  it('默认条件：检查侧不早于昨天；找行侧等于某个日期', () => {
    expect(defaultPredicate(dateCol, 'expect')).toMatchObject({ op: 'date_within_days', days: 1, allowFuture: false, timezone: 'Asia/Shanghai' })
    expect(defaultPredicate(dateCol, 'where')).toMatchObject({ op: 'date_on' })
  })
  it('模式与谓词互转：天数 0 / 1 / N、固定日期沿用已填值', () => {
    expect(dateModeOf({ op: 'date_within_days', days: 0, allowFuture: false, timezone: 'UTC' })).toBe('today')
    expect(dateModeOf({ op: 'date_within_days', days: 7, allowFuture: false, timezone: 'UTC' })).toBe('days_n')
    expect(predicateFromDateMode('days_n', { op: 'date_within_days', days: 7, allowFuture: true, timezone: 'UTC' })).toEqual({ op: 'date_within_days', days: 7, allowFuture: true, timezone: 'UTC' })
    expect(predicateFromDateMode('date_before', { op: 'date_on', value: '2025-12-01' })).toEqual({ op: 'date_before', value: '2025-12-01' })
    expect(predicateFromDateMode('is_empty', { op: 'date_on', value: '2025-12-01' })).toEqual({ op: 'is_empty' })
  })
  it('整句里说清口径', () => {
    const labelOf = () => '最新数据'
    expect(sentenceOf({ rule: 'all_rows', column: 'd', predicate: { op: 'date_within_days', days: 1, allowFuture: false, timezone: 'Asia/Shanghai' }, allowEmpty: false }, labelOf)).toBe(
      '每一行的「最新数据」都不早于昨天（按北京时间的运行当天算）',
    )
  })
})

describe('分页检查模板', () => {
  const labelOf = (key: string) => key
  it('预览里没有分页信息时不出现；读到总条数才有“总条数”，算得出本页应有行数才有“本页条数与分页一致”', () => {
    const values = (info?: Parameters<typeof templatesFor>[1]) => templatesFor('table', info).map((t) => t.value)
    expect(values()).not.toContain('page_total')
    expect(values({ totalRows: 45, rawText: '共 45 条' })).toContain('page_total')
    expect(values({ totalRows: 45, rawText: '共 45 条' })).not.toContain('page_consistency')
    expect(values({ rowRange: { from: 1, to: 20 }, totalRows: 45, rawText: '' })).toEqual(expect.arrayContaining(['page_total', 'page_consistency']))
    expect(templatesFor('cards', { totalRows: 45, rawText: '' }).map((t) => t.value)).not.toContain('page_total')
  })
  it('默认规则、句子与合约都合法', () => {
    for (const template of ['page_total', 'page_consistency'] as const) {
      const rule = defaultRule(template, [])!
      expect(rule).toBeTruthy()
      expect(() => outcomeContractSchema.parse(buildTableCheck('sites', rule, labelOf))).not.toThrow()
    }
    expect(sentenceOf({ rule: 'page_total', op: 'eq', value: 45 }, labelOf)).toBe('分页显示的总条数等于 45 条')
    expect(sentenceOf({ rule: 'page_consistency' }, labelOf)).toBe('本页读到的行数与分页显示一致')
  })
})
