import { describe, it, expect } from 'vitest'
import {
  roundHalfAwayFromZero,
  roundDecimalString,
  compareWithNumericPolicy,
  numericComparisonPolicySchema,
  tableReadPlanSchema,
  tableSampleSchema,
  tablePredicateSchema,
  tableExpectRuleSchema,
  tableOutcomeDetailsSchema,
  truncateUtf8Bytes,
  evaluateTableExpectation,
  validateTableExpectRuleAgainstPlan,
} from '../index.js'

describe('Numeric Policy & Precise Comparison', () => {
  it('half_away_from_zero 准确舍入 (包括浮点陷阱 1.005 / -1.005)', () => {
    // 1.005 在 2 位小数下应为 1.01，-1.005 应为 -1.01
    expect(roundDecimalString('1.005', 2)).toBe('1.01')
    expect(roundDecimalString('-1.005', 2)).toBe('-1.01')
    expect(roundHalfAwayFromZero(1.005, 2)).toBe(1.01)
    expect(roundHalfAwayFromZero(-1.005, 2)).toBe(-1.01)

    // 0.999 进位到 1.00
    expect(roundDecimalString('0.999', 2)).toBe('1.00')
    // 1.004 不进位
    expect(roundDecimalString('1.004', 2)).toBe('1.00')
    // 科学计数法
    expect(roundDecimalString('1.5e-3', 2)).toBe('0.00')
  })

  it('容差策略 (tolerance) 比较', () => {
    // 绝对容差
    const policy = { mode: 'tolerance' as const, numberDelta: 0.05 }
    expect(compareWithNumericPolicy(100.04, 100.0, 'eq', policy).matched).toBe(true)
    expect(compareWithNumericPolicy(100.06, 100.0, 'eq', policy).matched).toBe(false)
    expect(compareWithNumericPolicy(100.06, 100.0, 'neq', policy).matched).toBe(true)

    // 相对百分比容差 1%
    const percentPolicy = { mode: 'tolerance' as const, percentDelta: 1 }
    expect(compareWithNumericPolicy(100.9, 100.0, 'eq', percentPolicy).matched).toBe(true)
    expect(compareWithNumericPolicy(101.5, 100.0, 'eq', percentPolicy).matched).toBe(false)

    // 同时声明绝对与相对容差：取有效容差 max
    const combinedPolicy = { mode: 'tolerance' as const, numberDelta: 2, percentDelta: 1 }
    // expected = 100, 1% 是 1，但 numberDelta 是 2，有效容差取 2
    expect(compareWithNumericPolicy(101.8, 100.0, 'eq', combinedPolicy).matched).toBe(true)
    expect(compareWithNumericPolicy(102.5, 100.0, 'eq', combinedPolicy).matched).toBe(false)
  })

  it('定点策略 (fixed) 比较', () => {
    const fixedPolicy = { mode: 'fixed' as const, scale: 2, rounding: 'half_away_from_zero' as const }
    // 10.004 舍为 10.00，10.001 舍为 10.00 -> 相等
    expect(compareWithNumericPolicy(10.004, 10.001, 'eq', fixedPolicy).matched).toBe(true)
    // 10.005 舍为 10.01，10.004 舍为 10.00 -> 不相等
    expect(compareWithNumericPolicy(10.005, 10.004, 'eq', fixedPolicy).matched).toBe(false)
    expect(compareWithNumericPolicy(10.005, 10.004, 'gt', fixedPolicy).matched).toBe(true)
  })

  it('空容差被 Schema 拒绝', () => {
    expect(() =>
      numericComparisonPolicySchema.parse({
        mode: 'tolerance',
      }),
    ).toThrow()
  })
})

describe('Table Read Plan & Sample Schemas', () => {
  it('正确解析合法的 TableReadPlan', () => {
    const plan = {
      target: { candidates: [{ by: 'css', value: '#orders-table' }] },
      scope: 'current_page',
      columns: [
        { key: 'orderId', name: '订单号', valueType: 'text' },
        { key: 'amount', name: '金额', valueType: 'number', numericKind: 'decimal' },
        { key: 'status', name: '状态', valueType: 'text' },
      ],
    }
    const parsed = tableReadPlanSchema.parse(plan)
    expect(parsed.columns).toHaveLength(3)
    expect(parsed.limits.maxRows).toBe(200)
  })

  it('数字列缺少 numericKind 时拒绝', () => {
    const plan = {
      target: { candidates: [{ by: 'css', value: '#table' }] },
      columns: [{ key: 'count', name: '数量', valueType: 'number' }],
    }
    expect(() => tableReadPlanSchema.parse(plan)).toThrow('numericKind')
  })

  it('TableSample 验证完整性与结构', () => {
    const sample = {
      source: {
        runId: '11111111-1111-4111-8111-111111111111',
        sampledAt: new Date().toISOString(),
        planDigest: 'a'.repeat(64),
      },
      columns: [
        { key: 'id', name: 'ID', valueType: 'text' },
      ],
      rows: [
        { id: { value: 'ORD-001', rawText: 'ORD-001', status: 'ok' } },
      ],
      rowCount: 1,
      coverage: {
        requestedScope: 'current_page',
        observedScope: 'current_page',
        status: 'complete',
      },
      presentation: {
        omitted: false,
        previewCount: 20,
      },
    }
    const parsed = tableSampleSchema.parse(sample)
    expect(parsed.rowCount).toBe(1)
    expect(parsed.coverage.status).toBe('complete')
  })
})

describe('Table Predicates & Rules', () => {
  it('单列谓词解析', () => {
    // 文本比较
    expect(tablePredicateSchema.parse({ op: 'eq', value: '已完成' })).toBeDefined()
    // 数字大小比较
    expect(tablePredicateSchema.parse({ op: 'gte', value: 100 })).toBeDefined()
    // 正则
    expect(tablePredicateSchema.parse({ op: 'matches', value: '^ORD-\\d+$' })).toBeDefined()
    // 空态
    expect(tablePredicateSchema.parse({ op: 'is_not_empty' })).toBeDefined()
  })

  it('单列规则 all_rows / any_row / row_count', () => {
    const rowCountRule = {
      rule: 'row_count',
      op: 'gt',
      value: 0,
    }
    expect(tableExpectRuleSchema.parse(rowCountRule)).toBeDefined()

    const allRowsRule = {
      rule: 'all_rows',
      column: 'status',
      predicate: { op: 'eq', value: '已完成' },
      allowEmpty: false,
    }
    expect(tableExpectRuleSchema.parse(allRowsRule)).toBeDefined()

    const anyRowRule = {
      rule: 'any_row',
      column: 'amount',
      predicate: { op: 'gt', value: 1000 },
    }
    expect(tableExpectRuleSchema.parse(anyRowRule)).toBeDefined()
  })

  it('any_row 规则不允许 allowEmpty', () => {
    expect(() =>
      tableExpectRuleSchema.parse({
        rule: 'row_expression',
        quantifier: 'any',
        allowEmpty: true,
        expression: { kind: 'literal', value: true },
      }),
    ).toThrow('any 不允许空表通过')
  })
})

describe('UTF-8 Truncation & Budget', () => {
  it('truncateUtf8Bytes 不切碎中文字符', () => {
    const chinese = '订单管理系统测试' // 8 个汉字，24 字节
    const res = truncateUtf8Bytes(chinese, 10)
    expect(res.truncated).toBe(true)
    expect(res.originalBytes).toBe(24)
    // 10 字节最多放 3 个汉字 (9 字节)
    expect(res.text).toBe('订单管')
    expect(new TextEncoder().encode(res.text).length).toBe(9)
  })
})

describe('evaluateTableExpectation', () => {
  const baseSample = {
    protocol: 'table.sample@1' as const,
    source: {
      runId: '11111111-1111-4111-8111-111111111111',
      sampledAt: new Date().toISOString(),
      planDigest: 'a'.repeat(64),
    },
    columns: [
      { key: 'orderId', name: '订单号', valueType: 'text' as const },
      { key: 'amount', name: '金额', valueType: 'number' as const, numericKind: 'decimal' as const },
      { key: 'quantity', name: '数量', valueType: 'number' as const, numericKind: 'integer' as const },
      { key: 'price', name: '单价', valueType: 'number' as const, numericKind: 'decimal' as const },
      { key: 'status', name: '状态', valueType: 'text' as const },
    ],
    rows: [
      {
        orderId: { value: 'ORD-001', rawText: 'ORD-001', status: 'ok' as const },
        amount: { value: 100, rawText: '100.00', status: 'ok' as const },
        quantity: { value: 2, rawText: '2', status: 'ok' as const },
        price: { value: 50, rawText: '50.00', status: 'ok' as const },
        status: { value: '已完成', rawText: '已完成', status: 'ok' as const },
      },
      {
        orderId: { value: 'ORD-002', rawText: 'ORD-002', status: 'ok' as const },
        amount: { value: 200, rawText: '200.00', status: 'ok' as const },
        quantity: { value: 4, rawText: '4', status: 'ok' as const },
        price: { value: 50, rawText: '50.00', status: 'ok' as const },
        status: { value: '已完成', rawText: '已完成', status: 'ok' as const },
      },
      {
        orderId: { value: 'ORD-003', rawText: 'ORD-003', status: 'ok' as const },
        amount: { value: 300, rawText: '300.00', status: 'ok' as const },
        quantity: { value: 3, rawText: '3', status: 'ok' as const },
        price: { value: 100, rawText: '100.00', status: 'ok' as const },
        status: { value: '处理中', rawText: '处理中', status: 'ok' as const },
      },
    ],
    rowCount: 3,
    coverage: {
      requestedScope: 'current_page' as const,
      observedScope: 'current_page' as const,
      status: 'complete' as const,
    },
    presentation: {
      omitted: false,
      previewCount: 20,
    },
  }

  it('row_count 规则正确判定', () => {
    const eq3 = evaluateTableExpectation(baseSample, { rule: 'row_count', op: 'eq', value: 3 })
    expect(eq3.passed).toBe(true)
    expect(eq3.details.totalRowsChecked).toBe(3)

    const gt5 = evaluateTableExpectation(baseSample, { rule: 'row_count', op: 'gt', value: 5 })
    expect(gt5.passed).toBe(false)
    expect(gt5.reasonCode).toBe('ROW_COUNT_MISMATCH')
  })

  it('all_rows 规则正确判定反例行并截断至最多 5 条', () => {
    const allDone = evaluateTableExpectation(baseSample, {
      rule: 'all_rows',
      column: 'status',
      predicate: { op: 'eq', value: '已完成' },
      allowEmpty: false,
    })
    expect(allDone.passed).toBe(false)
    expect(allDone.details.matchedRows).toBe(2)
    expect(allDone.details.violatingRowsCount).toBe(1)
    expect(allDone.details.violatingRows).toHaveLength(1)
    expect(allDone.details.violatingRows[0]!.rowIndex).toBe(2)
  })

  it('all_rows 支持数字容差比较', () => {
    const allGt50 = evaluateTableExpectation(baseSample, {
      rule: 'all_rows',
      column: 'amount',
      predicate: {
        op: 'gte',
        value: 100,
        numericPolicy: { mode: 'fixed', scale: 0, rounding: 'half_away_from_zero' },
      },
      allowEmpty: false,
    })
    expect(allGt50.passed).toBe(true)
  })

  it('any_row 规则在至少一行满足时通过', () => {
    const anyPending = evaluateTableExpectation(baseSample, {
      rule: 'any_row',
      column: 'status',
      predicate: { op: 'eq', value: '处理中' },
    })
    expect(anyPending.passed).toBe(true)
    expect(anyPending.details.matchedRows).toBe(1)

    const anyCancelled = evaluateTableExpectation(baseSample, {
      rule: 'any_row',
      column: 'status',
      predicate: { op: 'eq', value: '已取消' },
    })
    expect(anyCancelled.passed).toBe(false)
    expect(anyCancelled.reasonCode).toBe('NO_ROW_MATCHED')
  })

  it('row_expression 计算多列 (amount === quantity * price)', () => {
    const exprCheck = evaluateTableExpectation(baseSample, {
      rule: 'row_expression',
      quantifier: 'all',
      allowEmpty: false,
      expression: {
        kind: 'compare',
        op: 'eq',
        left: { kind: 'ref', key: 'row', field: 'amount' },
        right: {
          kind: 'call',
          fn: 'mul',
          args: [
            { kind: 'ref', key: 'row', field: 'quantity' },
            { kind: 'ref', key: 'row', field: 'price' },
          ],
        },
        numericPolicy: { mode: 'tolerance', numberDelta: 0.01 },
      },
    })
    expect(exprCheck.passed).toBe(true)
    expect(exprCheck.details.matchedRows).toBe(3)
    expect(exprCheck.details.violatingRowsCount).toBe(0)
  })

  it('非全量覆盖 (partial) 返回 TABLE_FACTS_UNAVAILABLE', () => {
    const partialSample = {
      ...baseSample,
      coverage: {
        requestedScope: 'current_page' as const,
        observedScope: 'current_page' as const,
        status: 'partial' as const,
        reasonCode: 'PAGINATION_PRESENT',
        reasonMessage: '发现存在分页组件，未全量抓取',
      },
    }
    const res = evaluateTableExpectation(partialSample, { rule: 'row_count', op: 'eq', value: 3 })
    expect(res.passed).toBe(false)
    expect(res.factsUnavailable).toBe(true)
    expect(res.reasonCode).toBe('TABLE_FACTS_UNAVAILABLE')
    expect(res.details.coverage.status).toBe('partial')
  })

  it('非完整覆盖下 any_row 即使有匹配行也返回 UNKNOWN（不利用部分样本给全表结论）', () => {
    const partialSample = {
      ...baseSample,
      coverage: {
        requestedScope: 'current_page' as const,
        observedScope: 'current_page' as const,
        status: 'partial' as const,
        reasonCode: 'TABLE_ROW_LIMIT_TRUNCATED',
        reasonMessage: '超出读取上限',
      },
    }
    const res = evaluateTableExpectation(partialSample, {
      rule: 'any_row',
      column: 'status',
      predicate: { op: 'eq', value: '处理中' },
    })
    expect(res.factsUnavailable).toBe(true)
    expect(res.reasonCode).toBe('TABLE_FACTS_UNAVAILABLE')
  })

  it('覆盖未知 + 空表时 any_row 返回 UNKNOWN 而非业务失败', () => {
    const unknownEmpty = {
      ...baseSample,
      rows: [],
      rowCount: 0,
      coverage: {
        requestedScope: 'current_page' as const,
        observedScope: 'current_page' as const,
        status: 'unknown' as const,
        reasonCode: 'TABLE_EMPTY_UNVERIFIED',
        reasonMessage: '零行且无可靠空态证据',
      },
    }
    const res = evaluateTableExpectation(unknownEmpty, {
      rule: 'any_row',
      column: 'status',
      predicate: { op: 'is_not_empty' },
    })
    expect(res.factsUnavailable).toBe(true)
    expect(res.reasonCode).toBe('TABLE_FACTS_UNAVAILABLE')
  })

  it('字段缺失/遮蔽不再被当作空值或隐式转换', () => {
    const maskedSample = {
      ...baseSample,
      rows: [
        {
          orderId: { value: 'ORD-001', rawText: 'ORD-001', status: 'ok' as const },
          amount: { value: null, rawText: '***', status: 'masked' as const },
          quantity: { value: 2, rawText: '2', status: 'ok' as const },
          price: { value: 50, rawText: '50.00', status: 'ok' as const },
          status: { value: '已完成', rawText: '已完成', status: 'ok' as const },
        },
      ],
      rowCount: 1,
    }
    // masked 字段不判空、不参与比较 → UNKNOWN
    const isEmpty = evaluateTableExpectation(maskedSample, {
      rule: 'all_rows',
      column: 'amount',
      predicate: { op: 'is_empty' },
      allowEmpty: false,
    })
    expect(isEmpty.factsUnavailable).toBe(true)

    // 缺失字段 + is_empty 不得视为空
    const missingSample = {
      ...baseSample,
      rows: [
        {
          orderId: { value: 'ORD-001', rawText: 'ORD-001', status: 'ok' as const },
          status: { value: '已完成', rawText: '已完成', status: 'ok' as const },
        },
      ],
      rowCount: 1,
    }
    const res = evaluateTableExpectation(missingSample, {
      rule: 'all_rows',
      column: 'amount',
      predicate: { op: 'is_empty' },
      allowEmpty: false,
    })
    expect(res.factsUnavailable).toBe(true)
  })

  it('数字谓词不做文本隐式转换', () => {
    const textNumberSample = {
      ...baseSample,
      rows: [
        {
          orderId: { value: 'ORD-001', rawText: 'ORD-001', status: 'ok' as const },
          amount: { value: '100 元', rawText: '100 元', status: 'ok' as const },
          quantity: { value: 2, rawText: '2', status: 'ok' as const },
          price: { value: 50, rawText: '50.00', status: 'ok' as const },
          status: { value: '已完成', rawText: '已完成', status: 'ok' as const },
        },
      ],
      rowCount: 1,
    }
    const res = evaluateTableExpectation(textNumberSample, {
      rule: 'all_rows',
      column: 'amount',
      predicate: { op: 'eq', value: 100 },
      allowEmpty: false,
    })
    expect(res.factsUnavailable).toBe(true)
  })

  it('行表达式不能读取外层键（作用域隔离）', () => {
    const res = evaluateTableExpectation(baseSample, {
      rule: 'row_expression',
      quantifier: 'all',
      allowEmpty: false,
      expression: {
        kind: 'compare',
        op: 'eq',
        left: { kind: 'ref', key: 'orderId' },
        right: { kind: 'literal', value: 'ORD-001' },
      },
    })
    // 顶层列键不可解析 → 每行无法判定 → UNKNOWN
    expect(res.factsUnavailable).toBe(true)
  })

  it('行表达式结果非布尔视为无法判定', () => {
    const res = evaluateTableExpectation(baseSample, {
      rule: 'row_expression',
      quantifier: 'all',
      allowEmpty: false,
      expression: { kind: 'ref', key: 'row', field: 'amount' },
    })
    expect(res.factsUnavailable).toBe(true)
  })
})

describe('validateTableExpectRuleAgainstPlan', () => {
  const planColumns = [
    { key: 'orderId', name: '订单号', valueType: 'text' as const },
    { key: 'amount', name: '金额', valueType: 'number' as const, numericKind: 'decimal' as const },
    { key: 'quantity', name: '数量', valueType: 'number' as const, numericKind: 'integer' as const },
    { key: 'status', name: '状态', valueType: 'text' as const },
    { key: 'active', name: '生效', valueType: 'boolean' as const },
  ]

  it('拒绝未声明列、类型不符与文本列数值策略', () => {
    expect(
      validateTableExpectRuleAgainstPlan(
        { rule: 'all_rows', column: 'nope', predicate: { op: 'is_not_empty' }, allowEmpty: false },
        planColumns,
      ),
    ).toMatchObject({ valid: false, code: 'TABLE_COLUMN_NOT_DECLARED' })

    expect(
      validateTableExpectRuleAgainstPlan(
        { rule: 'all_rows', column: 'status', predicate: { op: 'gt', value: 1 }, allowEmpty: false },
        planColumns,
      ),
    ).toMatchObject({ valid: false, code: 'TABLE_NUMBER_COLUMN_REQUIRED' })

    expect(
      validateTableExpectRuleAgainstPlan(
        {
          rule: 'all_rows',
          column: 'status',
          predicate: { op: 'eq', value: 1 },
          allowEmpty: false,
        },
        planColumns,
      ),
    ).toMatchObject({ valid: false, code: 'TABLE_VALUE_TYPE_MISMATCH' })

    expect(
      validateTableExpectRuleAgainstPlan(
        {
          rule: 'all_rows',
          column: 'status',
          predicate: { op: 'eq', value: 'x', numericPolicy: { mode: 'fixed', scale: 2, rounding: 'half_away_from_zero' } },
          allowEmpty: false,
        },
        planColumns,
      ),
    ).toMatchObject({ valid: false, code: 'TABLE_NUMERIC_POLICY_ON_NON_NUMBER' })

    expect(
      validateTableExpectRuleAgainstPlan(
        { rule: 'all_rows', column: 'active', predicate: { op: 'eq', value: true }, allowEmpty: false },
        planColumns,
      ),
    ).toMatchObject({ valid: true })
  })

  it('decimal 列 eq/neq 必须声明 numericPolicy；integer 安全整数可省略', () => {
    expect(
      validateTableExpectRuleAgainstPlan(
        { rule: 'any_row', column: 'amount', predicate: { op: 'eq', value: 100.5 } },
        planColumns,
      ),
    ).toMatchObject({ valid: false, code: 'TABLE_FLOAT_EQ_REQUIRES_POLICY' })

    expect(
      validateTableExpectRuleAgainstPlan(
        { rule: 'any_row', column: 'quantity', predicate: { op: 'eq', value: 3 } },
        planColumns,
      ),
    ).toMatchObject({ valid: true })

    expect(
      validateTableExpectRuleAgainstPlan(
        { rule: 'any_row', column: 'quantity', predicate: { op: 'eq', value: 3.5 } },
        planColumns,
      ),
    ).toMatchObject({ valid: false, code: 'TABLE_FLOAT_EQ_REQUIRES_POLICY' })
  })

  it('row_expression：只允许 row.field 引用、根必须布尔、浮点相等需策略、字面量位数受限', () => {
    expect(
      validateTableExpectRuleAgainstPlan(
        {
          rule: 'row_expression',
          quantifier: 'all',
          allowEmpty: false,
          expression: { kind: 'ref', key: 'row', field: 'amount' },
        },
        planColumns,
      ),
    ).toMatchObject({ valid: false, code: 'TABLE_EXPRESSION_ROOT_BOOLEAN' })

    expect(
      validateTableExpectRuleAgainstPlan(
        {
          rule: 'row_expression',
          quantifier: 'all',
          allowEmpty: false,
          expression: {
            kind: 'compare',
            op: 'eq',
            left: { kind: 'ref', key: 'row', field: 'undeclared' },
            right: { kind: 'literal', value: 1 },
          },
        },
        planColumns,
      ),
    ).toMatchObject({ valid: false, code: 'TABLE_COLUMN_NOT_DECLARED' })

    expect(
      validateTableExpectRuleAgainstPlan(
        {
          rule: 'row_expression',
          quantifier: 'all',
          allowEmpty: false,
          expression: {
            kind: 'compare',
            op: 'eq',
            left: { kind: 'ref', key: 'row', field: 'amount' },
            right: { kind: 'literal', value: 10 },
          },
        },
        planColumns,
      ),
    ).toMatchObject({ valid: false, code: 'TABLE_FLOAT_EQ_REQUIRES_POLICY' })

    expect(
      validateTableExpectRuleAgainstPlan(
        {
          rule: 'row_expression',
          quantifier: 'all',
          allowEmpty: false,
          expression: {
            kind: 'compare',
            op: 'eq',
            left: { kind: 'ref', key: 'row', field: 'amount' },
            right: { kind: 'literal', value: 10 },
            numericPolicy: { mode: 'tolerance', numberDelta: 0.01 },
          },
        },
        planColumns,
      ),
    ).toMatchObject({ valid: true })

    expect(
      validateTableExpectRuleAgainstPlan(
        {
          rule: 'row_expression',
          quantifier: 'all',
          allowEmpty: false,
          expression: {
            kind: 'compare',
            op: 'eq',
            left: { kind: 'literal', value: 0.1234567890123456 },
            right: { kind: 'literal', value: 1 },
          },
        },
        planColumns,
      ),
    ).toMatchObject({ valid: false, code: 'TABLE_LITERAL_PRECISION' })
  })
})

