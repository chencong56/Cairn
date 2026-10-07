import { describe, it, expect } from 'vitest'
import {
  roundHalfAwayFromZero,
  roundDecimalString,
  compareWithNumericPolicy,
  numericComparisonPolicySchema,
  tableReadPlanSchema,
  isTableReadPlanV2,
  TABLE_READ_PROTOCOL_V2,
  TABLE_READ_DEFAULT_MAX_BYTES,
  stepSchema,
  tableSampleSchema,
  tablePredicateSchema,
  tableExpectRuleSchema,
  tableOutcomeDetailsSchema,
  truncateUtf8Bytes,
  evaluateTableExpectation,
  validateTableExpectRuleAgainstPlan,
  closestTexts,
  describeTablePredicate,
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

describe('table.read@2 读取计划契约', () => {
  const target = { framePath: [], candidates: [{ by: 'css' as const, value: '#report' }] }

  it('显式带 protocol 的走 v2；缺省 protocol 的旧计划仍按 v1 解析', () => {
    const v2 = tableReadPlanSchema.parse({
      protocol: TABLE_READ_PROTOCOL_V2,
      target,
      columns: [{ key: 'region', name: '区域', valueType: 'text' }],
    })
    expect(v2.protocol).toBe(TABLE_READ_PROTOCOL_V2)
    if (isTableReadPlanV2(v2)) {
      expect(v2.rows).toEqual({ excludeHeader: true, header: 'auto' })
      expect(v2.limits.maxBytes).toBe(TABLE_READ_DEFAULT_MAX_BYTES)
    }
    const v1 = tableReadPlanSchema.parse({
      target,
      columns: [{ key: 'region', name: '区域', valueType: 'text' }],
    })
    expect(v1.protocol).toBe('table.read@1')
    expect(isTableReadPlanV2(v1)).toBe(false)
  })

  it('按序号取列必须给出 index；数字列必须声明 numericKind；输出预算有上限', () => {
    const base = { protocol: TABLE_READ_PROTOCOL_V2, target }
    expect(tableReadPlanSchema.safeParse({ ...base, columns: [{ key: 'a', name: 'A', valueType: 'text', source: 'index' }] }).success).toBe(false)
    expect(tableReadPlanSchema.safeParse({ ...base, columns: [{ key: 'a', name: 'A', valueType: 'text', source: 'index', index: 2 }] }).success).toBe(true)
    expect(tableReadPlanSchema.safeParse({ ...base, columns: [{ key: 'a', name: 'A', valueType: 'number' }] }).success).toBe(false)
    expect(
      tableReadPlanSchema.safeParse({
        ...base,
        columns: [{ key: 'a', name: 'A', valueType: 'text' }],
        limits: { maxRows: 10, maxCols: 5, maxBytes: 10 * 1024 * 1024 },
      }).success,
    ).toBe(false)
  })
})


describe('列聚合 / 合计行核对 / 列唯一', () => {
  type Cell = { value: string | number | null; rawText?: string; decimalValue?: string; status: 'ok' | 'missing' | 'parse_error' }
  const num = (text: string): Cell => ({ value: Number(text), rawText: text, decimalValue: text, status: 'ok' })
  const sampleOf = (amounts: Cell[], summary?: Cell, names?: string[]) => ({
    protocol: 'table.sample@1' as const,
    source: { runId: '11111111-1111-4111-8111-111111111111', sampledAt: new Date().toISOString(), planDigest: 'a'.repeat(64) },
    columns: [
      { key: 'name', name: '名称', valueType: 'text' as const },
      { key: 'amount', name: '金额', valueType: 'number' as const, numericKind: 'decimal' as const },
    ],
    rows: amounts.map((a, i) => ({
      name: { value: names?.[i] ?? `N${i}`, rawText: names?.[i] ?? `N${i}`, status: 'ok' as const },
      amount: a,
    })),
    ...(summary ? { summaryRows: [{ name: { value: '合计', rawText: '合计', status: 'ok' as const }, amount: summary }] } : {}),
    rowCount: amounts.length,
    coverage: { requestedScope: 'current_page' as const, observedScope: 'current_page' as const, status: 'complete' as const },
    presentation: { omitted: false, previewCount: 20 },
  })
  const parseRule = (r: unknown) => tableExpectRuleSchema.parse(r)

  it('column_stat 用精确十进制：0.1+0.2 等于 0.3', () => {
    const s = sampleOf([num('0.1'), num('0.2')])
    const r = evaluateTableExpectation(s as never, parseRule({ rule: 'column_stat', column: 'amount', stat: 'sum', op: 'eq', value: 0.3 }))
    expect(r.passed).toBe(true)
  })

  it('column_stat 不满足时给出实际值', () => {
    const s = sampleOf([num('10'), num('20')])
    const r = evaluateTableExpectation(s as never, parseRule({ rule: 'column_stat', column: 'amount', stat: 'max', op: 'lt', value: 15 }))
    expect(r.passed).toBe(false)
    expect(r.reasonMessage).toContain('20')
  })

  it('column_stat avg / min', () => {
    const s = sampleOf([num('1'), num('2'), num('4')])
    expect(evaluateTableExpectation(s as never, parseRule({ rule: 'column_stat', column: 'amount', stat: 'min', op: 'eq', value: 1 })).passed).toBe(true)
    expect(evaluateTableExpectation(s as never, parseRule({ rule: 'column_stat', column: 'amount', stat: 'avg', op: 'gt', value: 2.3 })).passed).toBe(true)
  })

  it('column_stat 空值默认无法确认，勾选忽略后可判定', () => {
    const s = sampleOf([num('10'), { value: null, rawText: '', status: 'ok' }])
    const strict = evaluateTableExpectation(s as never, parseRule({ rule: 'column_stat', column: 'amount', stat: 'sum', op: 'eq', value: 10 }))
    expect(strict.factsUnavailable).toBe(true)
    const lax = evaluateTableExpectation(s as never, parseRule({ rule: 'column_stat', column: 'amount', stat: 'sum', op: 'eq', value: 10, ignoreEmpty: true }))
    expect(lax.passed).toBe(true)
  })

  it('column_stat 有读不出的数字 → 无法确认；空表 sum=0，avg 无法确认', () => {
    const bad = sampleOf([num('1'), { value: null, rawText: 'abc', status: 'parse_error' }])
    expect(evaluateTableExpectation(bad as never, parseRule({ rule: 'column_stat', column: 'amount', stat: 'sum', op: 'eq', value: 1 })).factsUnavailable).toBe(true)
    const empty = sampleOf([])
    expect(evaluateTableExpectation(empty as never, parseRule({ rule: 'column_stat', column: 'amount', stat: 'sum', op: 'eq', value: 0 })).passed).toBe(true)
    expect(evaluateTableExpectation(empty as never, parseRule({ rule: 'column_stat', column: 'amount', stat: 'avg', op: 'eq', value: 0 })).factsUnavailable).toBe(true)
  })

  it('total_row_match：一致 / 不一致 / 无合计行', () => {
    const ok = sampleOf([num('10.50'), num('20.25')], num('30.75'))
    expect(evaluateTableExpectation(ok as never, parseRule({ rule: 'total_row_match', column: 'amount' })).passed).toBe(true)
    const bad = sampleOf([num('10.50'), num('20.25')], num('31.00'))
    const r = evaluateTableExpectation(bad as never, parseRule({ rule: 'total_row_match', column: 'amount' }))
    expect(r.passed).toBe(false)
    expect(r.reasonCode).toBe('TOTAL_ROW_MISMATCH')
    const none = sampleOf([num('1')])
    expect(evaluateTableExpectation(none as never, parseRule({ rule: 'total_row_match', column: 'amount' })).factsUnavailable).toBe(true)
  })

  it('total_row_match：display 按合计行小数位舍入，exact 不舍入', () => {
    const s = sampleOf([num('1.004'), num('2.004')], num('3.01'))
    expect(evaluateTableExpectation(s as never, parseRule({ rule: 'total_row_match', column: 'amount', precision: 'display' })).passed).toBe(true)
    expect(evaluateTableExpectation(s as never, parseRule({ rule: 'total_row_match', column: 'amount', precision: 'exact' })).passed).toBe(false)
  })

  it('column_unique：重复 → 不通过；空值不参与', () => {
    const dup = sampleOf([num('1'), num('2'), num('3')], undefined, ['A', ' A ', 'B'])
    const r = evaluateTableExpectation(dup as never, parseRule({ rule: 'column_unique', column: 'name' }))
    expect(r.passed).toBe(false)
    expect(r.reasonCode).toBe('COLUMN_NOT_UNIQUE')
    const ok = sampleOf([num('1'), num('2')], undefined, ['A', 'B'])
    expect(evaluateTableExpectation(ok as never, parseRule({ rule: 'column_unique', column: 'name' })).passed).toBe(true)
  })

  it('覆盖不完整时一律无法确认', () => {
    const s = { ...sampleOf([num('1')]), coverage: { requestedScope: 'current_page' as const, observedScope: 'current_page' as const, status: 'partial' as const, reasonCode: 'TABLE_VIRTUAL_SCROLL', reasonMessage: 'x' } }
    expect(evaluateTableExpectation(s as never, parseRule({ rule: 'column_unique', column: 'name' })).factsUnavailable).toBe(true)
  })

  it('编译期校验：未声明列 / 非数字列', () => {
    const cols = [
      { key: 'name', name: '名称', valueType: 'text' as const },
      { key: 'amount', name: '金额', valueType: 'number' as const, numericKind: 'decimal' as const },
    ]
    const v = (rule: unknown) => validateTableExpectRuleAgainstPlan(parseRule(rule), cols)
    expect(v({ rule: 'column_unique', column: 'name' }).valid).toBe(true)
    expect(v({ rule: 'column_unique', column: 'zzz' }).valid).toBe(false)
    expect(v({ rule: 'column_stat', column: 'name', stat: 'sum', op: 'eq', value: 1 }).valid).toBe(false)
    expect(v({ rule: 'total_row_match', column: 'amount' }).valid).toBe(true)
  })
})

describe('table.read@2 读取形态 kind', () => {
  const base = {
    protocol: TABLE_READ_PROTOCOL_V2,
    target: { framePath: [], candidates: [{ by: 'css', value: '#board' }] },
    columns: [{ key: 'col_1', name: '标题', valueType: 'text' }],
  }
  it('cards / keyvalue 合法；缺省不带 kind（旧计划形状不变）', () => {
    for (const kind of ['table', 'cards', 'keyvalue'] as const) {
      expect(tableReadPlanSchema.safeParse({ ...base, kind }).success, kind).toBe(true)
    }
    const parsed = tableReadPlanSchema.parse(base)
    expect('kind' in parsed).toBe(false)
  })
  it('未知形态拒绝', () => {
    expect(tableReadPlanSchema.safeParse({ ...base, kind: 'tree' }).success).toBe(false)
  })
})

describe('找到某一行，再检查它（row_lookup）', () => {
  type Cell = { value: string | number | null; rawText?: string; decimalValue?: string; status: 'ok' | 'missing' | 'error' | 'masked' }
  const text = (v: string): Cell => ({ value: v, rawText: v, status: 'ok' })
  const num = (v: string): Cell => ({ value: Number(v), rawText: v, decimalValue: v, status: 'ok' })
  const rows = (items: Array<[Cell, Cell, Cell?]>) =>
    items.map(([name, data, cycle]) => ({ name, data, ...(cycle ? { cycle } : {}) }))
  const sampleOf = (items: Array<[Cell, Cell, Cell?]>, status: 'complete' | 'partial' = 'complete') =>
    ({
      protocol: 'table.sample@1',
      source: { runId: '11111111-1111-4111-8111-111111111111', sampledAt: new Date().toISOString(), planDigest: 'a'.repeat(64) },
      columns: [
        { key: 'name', name: '报表名称', valueType: 'text' },
        { key: 'data', name: '最新数据', valueType: 'number', numericKind: 'decimal' },
        { key: 'cycle', name: '更新周期', valueType: 'text' },
      ],
      rows: rows(items),
      rowCount: items.length,
      coverage: { requestedScope: 'current_page', observedScope: 'current_page', status, ...(status === 'partial' ? { reasonCode: 'TABLE_VIRTUAL_SCROLL', reasonMessage: 'x' } : {}) },
      presentation: { omitted: false, previewCount: items.length },
    }) as never
  const fixed = { mode: 'fixed', scale: 8, rounding: 'half_away_from_zero' } as const
  const nameIs = (v: string) => ({ column: 'name', predicate: { op: 'eq', value: v } }) as const
  const dataNot0 = { column: 'data', predicate: { op: 'neq', value: 0, numericPolicy: fixed } } as const
  const parse = (r: unknown) => tableExpectRuleSchema.parse(r)
  const lookup = (extra: Record<string, unknown> = {}) =>
    parse({ rule: 'row_lookup', where: [nameIs('需求订单统计表')], expect: [dataNot0], ...extra })

  const base = sampleOf([
    [text('存量收入和成本统计表'), num('20251122')],
    [text('需求订单统计表'), num('20251222')],
    [text('楼宇覆盖面积统计表'), num('0')],
  ])

  it('契约默认：找不到记为不通过、多行要求每一行都满足；条件最多 3 个', () => {
    const rule = lookup()
    expect(rule.rule === 'row_lookup' && rule.onMissing).toBe('fail')
    expect(rule.rule === 'row_lookup' && rule.onMultiple).toBe('all')
    expect(tableExpectRuleSchema.safeParse({ rule: 'row_lookup', where: [], expect: [dataNot0] }).success).toBe(false)
    const four = [nameIs('a'), nameIs('b'), nameIs('c'), nameIs('d')]
    expect(tableExpectRuleSchema.safeParse({ rule: 'row_lookup', where: four, expect: [dataNot0] }).success).toBe(false)
  })

  it('找到且满足：通过，并给出命中行与一句人话', () => {
    const r = evaluateTableExpectation(base, lookup())
    expect(r.passed).toBe(true)
    expect(r.details.lookup?.summary).toContain('找到 1 行（第 2 行）')
    expect(r.details.lookup?.summary).toContain('20251222')
    expect(r.details.lookup?.matched[0]?.cells.map((c) => c.text)).toEqual(['需求订单统计表', '20251222'])
  })

  it('找到但不满足：业务不通过，说清是哪一行哪一列', () => {
    const zero = sampleOf([[text('需求订单统计表'), num('0.00')]])
    const r = evaluateTableExpectation(zero, lookup())
    expect(r.passed).toBe(false)
    expect(r.factsUnavailable).toBeUndefined()
    expect(r.reasonCode).toBe('LOOKUP_EXPECT_FAILED')
    expect(r.reasonMessage).toContain('第 1 行')
    expect(r.reasonMessage).toContain('「最新数据」是 0.00')
    expect(r.details.violatingRows).toHaveLength(1)
  })

  it('找不到：默认不通过并给最接近的名称；onMissing 可改为无法确认 / 通过', () => {
    const s = sampleOf([[text('需求订单统计报表'), num('1')], [text('需求订单明细表'), num('2')], [text('收入汇总'), num('3')]])
    const miss = evaluateTableExpectation(s, lookup())
    expect(miss.passed).toBe(false)
    expect(miss.reasonCode).toBe('ROW_NOT_FOUND')
    expect(miss.reasonMessage).toContain('共读取 3 行')
    expect(miss.details.lookup?.closest).toEqual(['需求订单统计报表', '需求订单明细表'])
    expect(evaluateTableExpectation(s, lookup({ onMissing: 'unknown' })).factsUnavailable).toBe(true)
    expect(evaluateTableExpectation(s, lookup({ onMissing: 'pass' })).passed).toBe(true)
  })

  it('找到多行：all 要求每一行都满足，any 只要有一行满足', () => {
    const dup = sampleOf([[text('需求订单统计表'), num('0')], [text('需求订单统计表'), num('5')]])
    expect(evaluateTableExpectation(dup, lookup()).passed).toBe(false)
    expect(evaluateTableExpectation(dup, lookup({ onMultiple: 'any' })).passed).toBe(true)
  })

  it('多个条件是“并且”：名称相同但更新周期不同的行不算命中', () => {
    const s = sampleOf([
      [text('需求订单统计表'), num('0'), text('每月')],
      [text('需求订单统计表'), num('7'), text('每日')],
    ])
    const rule = parse({ rule: 'row_lookup', where: [nameIs('需求订单统计表'), { column: 'cycle', predicate: { op: 'eq', value: '每日' } }], expect: [dataNot0] })
    const r = evaluateTableExpectation(s, rule)
    expect(r.passed).toBe(true)
    expect(r.details.lookup?.summary).toContain('第 2 行')
  })

  it('找行的列读不出：不能说“找不到”，而是无法确认并说明行号', () => {
    const s = sampleOf([[{ value: null, status: 'error', rawText: '??' }, num('1')], [text('别的表'), num('2')]])
    const r = evaluateTableExpectation(s, lookup())
    expect(r.factsUnavailable).toBe(true)
    expect(r.reasonMessage).toContain('第 1 行')
  })

  it('找到的行里要检查的值是空：默认无法确认，不当成 0', () => {
    const s = sampleOf([[text('需求订单统计表'), { value: null, status: 'missing' }]])
    expect(evaluateTableExpectation(s, lookup()).factsUnavailable).toBe(true)
  })

  it('读不全（范围不完整）时一律无法确认', () => {
    const s = sampleOf([[text('需求订单统计表'), num('1')]], 'partial')
    expect(evaluateTableExpectation(s, lookup()).factsUnavailable).toBe(true)
  })

  it('编译校验：列要已声明；大小比较只接受数字列；小数列的相等比较要带精度策略', () => {
    const cols = [
      { key: 'name', name: '报表名称', valueType: 'text' as const },
      { key: 'data', name: '最新数据', valueType: 'number' as const, numericKind: 'decimal' as const },
    ]
    const v = (r: unknown) => validateTableExpectRuleAgainstPlan(parse(r), cols)
    expect(v({ rule: 'row_lookup', where: [nameIs('x')], expect: [dataNot0] }).valid).toBe(true)
    expect(v({ rule: 'row_lookup', where: [{ column: 'zzz', predicate: { op: 'eq', value: 'x' } }], expect: [dataNot0] }).valid).toBe(false)
    expect(v({ rule: 'row_lookup', where: [nameIs('x')], expect: [{ column: 'name', predicate: { op: 'gt', value: 1 } }] }).valid).toBe(false)
    expect(v({ rule: 'row_lookup', where: [nameIs('x')], expect: [{ column: 'data', predicate: { op: 'neq', value: 0 } }] }).valid).toBe(false)
  })

  it('closestTexts：只展示接近的，去重，最多 3 个', () => {
    expect(closestTexts('需求订单统计表', ['需求订单统计报表', '需求订单统计报表', '完全无关', '订单明细'])).toEqual(['需求订单统计报表'])
    expect(closestTexts('', ['a'])).toEqual([])
  })
})

describe('条件行检查：分页表上的“找不到”不能判不通过', () => {
  const sample = (clues?: string[]) =>
    ({
      protocol: 'table.sample@1',
      source: { runId: '11111111-1111-4111-8111-111111111111', sampledAt: new Date().toISOString(), planDigest: 'a'.repeat(64) },
      columns: [
        { key: 'name', name: '报表名称', valueType: 'text' },
        { key: 'n', name: '次数', valueType: 'number', numericKind: 'integer' },
      ],
      rows: [{ name: { value: '甲', rawText: '甲', status: 'ok' }, n: { value: 1, rawText: '1', status: 'ok' } }],
      rowCount: 1,
      coverage: { requestedScope: 'current_page', observedScope: 'current_page', status: 'complete', ...(clues ? { clues } : {}) },
      presentation: { omitted: false, previewCount: 1 },
    }) as never
  const rule = (onMissing: 'fail' | 'unknown' | 'pass') =>
    tableExpectRuleSchema.parse({ rule: 'row_lookup', where: [{ column: 'name', predicate: { op: 'eq', value: '乙' } }], expect: [{ column: 'n', predicate: { op: 'gt', value: 0 } }], onMissing })

  it('有分页：本页没找到 → 无法确认（说明只读了本页），不是业务不通过', () => {
    const r = evaluateTableExpectation(sample(['pagination_present']), rule('fail'))
    expect(r.factsUnavailable).toBe(true)
    expect(r.reasonCode).toBe('ROW_NOT_FOUND_PAGED')
    expect(r.reasonMessage).toContain('只读了本页')
  })
  it('没有分页：找不到仍是业务不通过；选“当作通过”不受分页影响', () => {
    expect(evaluateTableExpectation(sample(), rule('fail')).reasonCode).toBe('ROW_NOT_FOUND')
    expect(evaluateTableExpectation(sample(['pagination_present']), rule('pass')).passed).toBe(true)
  })
  it('有分页但本页找到了：照常判定', () => {
    const found = tableExpectRuleSchema.parse({ rule: 'row_lookup', where: [{ column: 'name', predicate: { op: 'eq', value: '甲' } }], expect: [{ column: 'n', predicate: { op: 'gt', value: 0 } }] })
    expect(evaluateTableExpectation(sample(['pagination_present']), found).passed).toBe(true)
  })
})

describe('宽表：一次最多读 100 列，识别结果最多返回 128 列', () => {
  const target = { framePath: [], candidates: [{ by: 'css', value: '#t' }] }
  const cols = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `col_${i + 1}`, name: `列${i + 1}`, valueType: 'text' }))
  it('读取计划 100 列合法、101 列不合法；默认上限是 100', () => {
    expect(tableReadPlanSchema.safeParse({ protocol: TABLE_READ_PROTOCOL_V2, target, columns: cols(100) }).success).toBe(true)
    expect(tableReadPlanSchema.safeParse({ protocol: TABLE_READ_PROTOCOL_V2, target, columns: cols(101) }).success).toBe(false)
    const parsed = tableReadPlanSchema.parse({ protocol: TABLE_READ_PROTOCOL_V2, target, columns: cols(3) })
    expect('limits' in parsed && parsed.limits.maxCols).toBe(100)
  })
})

describe('日期列：固定日期与相对今天', () => {
  type Cell = { value: string | null; rawText?: string; status: 'ok' | 'missing' | 'error' | 'masked' }
  const date = (v: string, raw?: string): Cell => ({ value: v, ...(raw ? { rawText: raw } : {}), status: 'ok' })
  const sampleAt = (sampledAt: string, cells: Cell[]) =>
    ({
      protocol: 'table.sample@1',
      source: { runId: '11111111-1111-4111-8111-111111111111', sampledAt, planDigest: 'a'.repeat(64) },
      columns: [{ key: 'd', name: '最新数据', valueType: 'date' }],
      rows: cells.map((d) => ({ d })),
      rowCount: cells.length,
      coverage: { requestedScope: 'current_page', observedScope: 'current_page', status: 'complete' },
      presentation: { omitted: false, previewCount: cells.length },
    }) as never
  const rule = (predicate: unknown) => tableExpectRuleSchema.parse({ rule: 'all_rows', column: 'd', predicate })
  const within = (days: number, extra: Record<string, unknown> = {}) => rule({ op: 'date_within_days', days, ...extra })
  // 2025-12-22 08:00 北京时间 = 2025-12-22T00:00Z
  const NOON = '2025-12-22T04:00:00.000Z'

  it('契约：日期须合法、timezone 默认 Asia/Shanghai、非法时区被拒绝', () => {
    const p = tablePredicateSchema.parse({ op: 'date_within_days', days: 1 })
    expect(p).toMatchObject({ allowFuture: false, timezone: 'Asia/Shanghai' })
    expect(tablePredicateSchema.safeParse({ op: 'date_before', value: '2025-02-30' }).success).toBe(false)
    expect(tablePredicateSchema.safeParse({ op: 'date_before', value: '20251222' }).success).toBe(false)
    expect(tablePredicateSchema.safeParse({ op: 'date_within_days', days: 1, timezone: 'Mars/Base' }).success).toBe(false)
    expect(tablePredicateSchema.safeParse({ op: 'date_within_days', days: -1 }).success).toBe(false)
  })

  it('固定日期：早于 / 晚于 / 不早于 / 不晚于 / 是，带时分秒只比日期部分', () => {
    const s = sampleAt(NOON, [date('2025-12-22 23:59:59', '20251222235959')])
    const ok = (op: string, value: string) => evaluateTableExpectation(s, rule({ op, value })).passed
    expect(ok('date_on', '2025-12-22')).toBe(true)
    expect(ok('date_before', '2025-12-23')).toBe(true)
    expect(ok('date_before', '2025-12-22')).toBe(false)
    expect(ok('date_after', '2025-12-21')).toBe(true)
    expect(ok('date_on_or_before', '2025-12-22')).toBe(true)
    expect(ok('date_on_or_after', '2025-12-22')).toBe(true)
    expect(ok('date_on_or_after', '2025-12-23')).toBe(false)
  })

  it('相对今天：N=0 是今天，N=1 不早于昨天；默认不允许晚于今天，可放开', () => {
    const at = (d: string, r: ReturnType<typeof within>) => evaluateTableExpectation(sampleAt(NOON, [date(d)]), r)
    expect(at('2025-12-22', within(0)).passed).toBe(true)
    expect(at('2025-12-21', within(0)).passed).toBe(false)
    expect(at('2025-12-21', within(1)).passed).toBe(true)
    expect(at('2025-12-20', within(1)).passed).toBe(false)
    expect(at('2025-12-23', within(1)).passed).toBe(false)
    expect(at('2025-12-23', within(1, { allowFuture: true })).passed).toBe(true)
  })

  it('不通过时说清所用的“今天”与时区', () => {
    const r = evaluateTableExpectation(sampleAt(NOON, [date('2025-12-20')]), within(1))
    expect(r.passed).toBe(false)
    expect(r.factsUnavailable).toBeUndefined()
    expect(JSON.stringify(r.details)).toContain('2025-12-20，早于 2025-12-21')
    expect(JSON.stringify(r.details)).toContain('运行当天 2025-12-22')
    expect(JSON.stringify(r.details)).toContain('Asia/Shanghai')
  })

  it('边界：月末、闰年、年底跨年', () => {
    const at = (now: string, d: string, days: number) => evaluateTableExpectation(sampleAt(now, [date(d)]), within(days)).passed
    expect(at('2024-03-01T04:00:00.000Z', '2024-02-29', 1)).toBe(true) // 闰年 2/29 是 3/1 的前一天
    expect(at('2025-03-01T04:00:00.000Z', '2025-02-28', 1)).toBe(true)
    expect(at('2025-03-01T04:00:00.000Z', '2025-02-27', 1)).toBe(false)
    expect(at('2026-01-01T04:00:00.000Z', '2025-12-31', 1)).toBe(true)
    expect(at('2025-03-31T04:00:00.000Z', '2025-03-01', 30)).toBe(true)
  })

  it('跨零点的时区：同一采样时刻在不同时区“今天”不同，且重算恒定', () => {
    const now = '2025-12-21T17:00:00.000Z' // 北京已是 12-22 01:00；UTC 仍是 12-21
    const s = sampleAt(now, [date('2025-12-22')])
    expect(evaluateTableExpectation(s, within(0)).passed).toBe(true)
    expect(evaluateTableExpectation(s, within(0, { timezone: 'UTC' })).passed).toBe(false) // UTC 今天是 12-21，12-22 属未来
    expect(evaluateTableExpectation(s, within(0)).passed).toBe(evaluateTableExpectation(s, within(0)).passed)
  })

  it('空值 / 读不出 / 不是日期 → 无法确认，不当“很久以前”', () => {
    const miss: Cell = { value: null, status: 'missing' }
    const empty: Cell = { value: '', status: 'ok' }
    const bad: Cell = { value: '待定', rawText: '待定', status: 'ok' }
    for (const c of [miss, empty, bad]) {
      const r = evaluateTableExpectation(sampleAt(NOON, [c]), within(1))
      expect(r.passed).toBe(false)
      expect(r.factsUnavailable).toBe(true)
    }
  })

  it('条件行检查里也能用：找到某一行，其日期不早于 1 天前', () => {
    const s = sampleAt(NOON, [date('2025-12-21')])
    const r = tableExpectRuleSchema.parse({
      rule: 'row_lookup',
      where: [{ column: 'd', predicate: { op: 'is_not_empty' } }],
      expect: [{ column: 'd', predicate: { op: 'date_within_days', days: 1 } }],
    })
    expect(evaluateTableExpectation(s, r).passed).toBe(true)
  })

  it('编译期校验：日期谓词只用于日期列，日期列不能做数字大小比较', () => {
    const columns = [
      { key: 'd', name: '日期', valueType: 'date' as const },
      { key: 'n', name: '数量', valueType: 'text' as const },
    ]
    const v = (column: string, predicate: unknown) =>
      validateTableExpectRuleAgainstPlan({ rule: 'all_rows', column, predicate, allowEmpty: false } as never, columns)
    expect(v('d', { op: 'date_within_days', days: 1, allowFuture: false, timezone: 'Asia/Shanghai' }).valid).toBe(true)
    expect(v('n', { op: 'date_within_days', days: 1, allowFuture: false, timezone: 'Asia/Shanghai' })).toMatchObject({ valid: false, code: 'TABLE_DATE_COLUMN_REQUIRED' })
    expect(v('d', { op: 'gt', value: 1 })).toMatchObject({ valid: false, code: 'TABLE_DATE_COLUMN_NUMERIC_COMPARE' })
  })

  it('一句人话', () => {
    const d = (p: unknown) => describeTablePredicate(tablePredicateSchema.parse(p))
    expect(d({ op: 'date_within_days', days: 0 })).toBe('是今天（按北京时间的运行当天算）')
    expect(d({ op: 'date_within_days', days: 1 })).toContain('不早于昨天')
    expect(d({ op: 'date_within_days', days: 3 })).toContain('不早于 3 天前')
    expect(d({ op: 'date_before', value: '2025-12-01' })).toBe('早于 2025-12-01')
  })
})
