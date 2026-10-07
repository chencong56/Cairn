import { describe, expect, it } from 'vitest'
import {
  TABLE_READ_PROTOCOL_V2,
  tableReadPlanSchema,
  type TableDetectedColumn,
  type TableReadPlanV2,
  type TableSample,
} from '@cairn/shared'
import {
  columnLabel,
  coverageSummary,
  createPlaceholderTablePlan,
  foundSummary,
  kindNoun,
  planKind,
  renameColumn,
  scopeAlternatives,
  setColumnSensitive,
  setColumnSource,
  setColumnType,
  setEmptyMeansNone,
  setHeaderMode,
  setMaxRows,
  setTotalRow,
  totalRowsSummary,
  setRootSelector,
  tablePlanState,
  tableSampleOf,
  toggleColumn,
} from './table-plan-edit'

const detectedColumns: TableDetectedColumn[] = [
  { key: 'col_1', name: '', excludedReason: 'checkbox', valueType: 'text', source: 'index', index: 0 },
  { key: 'col_2', name: '区域', valueType: 'text', source: 'header', index: 1 },
  { key: 'col_3', name: '收入', valueType: 'number', numericKind: 'decimal', source: 'header', index: 2 },
  { key: 'col_4', name: '操作', excludedReason: 'action', valueType: 'text', source: 'header', index: 3 },
]

function plan(): TableReadPlanV2 {
  return tableReadPlanSchema.parse({
    protocol: TABLE_READ_PROTOCOL_V2,
    target: { framePath: [], candidates: [{ by: 'css', value: '#report' }] },
    columns: [
      { key: 'col_2', name: '区域', valueType: 'text' },
      { key: 'col_3', name: '收入', valueType: 'number', numericKind: 'decimal' },
    ],
  }) as TableReadPlanV2
}

function sample(overrides: Partial<TableSample> = {}): TableSample {
  return {
    protocol: 'table.sample@1',
    source: { runId: '00000000-0000-4000-8000-000000000001', sampledAt: new Date().toISOString(), planDigest: 'x' },
    columns: [{ key: 'col_2', name: '区域', valueType: 'text' }],
    rows: [{ col_2: { value: '辽宁', status: 'ok' } }],
    rowCount: 1,
    coverage: { requestedScope: 'current_page', observedScope: 'current_page', status: 'complete' },
    presentation: { omitted: false, previewCount: 1 },
    ...overrides,
  }
}

describe('表格计划编辑', () => {
  it('占位计划、旧版计划与就绪计划被区分', () => {
    expect(tablePlanState(createPlaceholderTablePlan())).toBe('unconfigured')
    expect(tablePlanState(plan())).toBe('ready')
    const legacy = tableReadPlanSchema.parse({
      target: { framePath: [], candidates: [{ by: 'css', value: 'table' }] },
      columns: [{ key: 'a', name: 'A', valueType: 'text' }],
    })
    expect(tablePlanState(legacy)).toBe('legacy')
  })

  it('勾回被排除的列时按 DOM 列序插入，取消勾选至少保留一列', () => {
    const base = plan()
    const withAction = toggleColumn(base, detectedColumns, 'col_4', true)
    expect(withAction.columns.map((c) => c.key)).toEqual(['col_2', 'col_3', 'col_4'])
    const withCheckbox = toggleColumn(base, detectedColumns, 'col_1', true)
    expect(withCheckbox.columns.map((c) => c.key)).toEqual(['col_1', 'col_2', 'col_3'])
    expect(withCheckbox.columns[0]).toMatchObject({ source: 'index', index: 0 })
    const one = toggleColumn(base, detectedColumns, 'col_3', false)
    expect(one.columns.map((c) => c.key)).toEqual(['col_2'])
    expect(toggleColumn(one, detectedColumns, 'col_2', false)).toBe(one)
  })

  it('改显示名不改取数用的列名；留空或与列名相同则恢复', () => {
    const renamed = renameColumn(plan(), 'col_2', '地区')
    expect(renamed.columns[0]).toMatchObject({ name: '区域', label: '地区' })
    expect(columnLabel(renamed.columns[0]!)).toBe('地区')
    expect(renameColumn(renamed, 'col_2', '  ').columns[0]).not.toHaveProperty('label')
    expect(renameColumn(renamed, 'col_2', '区域').columns[0]).not.toHaveProperty('label')
  })

  it('敏感、类型、取列方式、表头位置、空表确认、行数上限、表根', () => {
    let p = setColumnSensitive(plan(), 'col_2', true)
    expect(p.columns[0]!.sensitive).toBe(true)
    p = setColumnSensitive(p, 'col_2', false)
    expect(p.columns[0]).not.toHaveProperty('sensitive')

    p = setColumnType(p, 'col_2', 'number')
    expect(p.columns[0]).toMatchObject({ valueType: 'number', numericKind: 'decimal' })
    p = setColumnType(p, 'col_2', 'text')
    expect(p.columns[0]).not.toHaveProperty('numericKind')

    p = setColumnSource(p, 'col_2', 'index', 1)
    expect(p.columns[0]).toMatchObject({ source: 'index', index: 1 })
    p = setColumnSource(p, 'col_2', 'header', 1)
    expect(p.columns[0]).not.toHaveProperty('source')

    expect(setHeaderMode(p, 'none').rows.header).toBe('none')
    expect(setEmptyMeansNone(p, true).readiness?.emptyMeansNone).toBe(true)
    expect(setEmptyMeansNone(setEmptyMeansNone(p, true), false).readiness).not.toHaveProperty('emptyMeansNone')
    expect(setMaxRows(p, 9999).limits.maxRows).toBe(200)
    expect(setMaxRows(p, 0).limits.maxRows).toBe(1)
    expect(setRootSelector(p, ' #other ').target.candidates).toEqual([{ by: 'css', value: '#other' }])
    expect(setRootSelector(p, '   ')).toBe(p)
    // 改完仍是合法计划
    expect(tableReadPlanSchema.safeParse(setColumnType(setColumnSource(p, 'col_3', 'index', 2), 'col_3', 'number')).success).toBe(true)
  })

  it('合计行：手工指定、取消；识别到的合计行给出一句说明', () => {
    const p = setTotalRow(plan(), 'col_2', ' 本页统计 ')
    expect(p.rows.totalRow).toEqual({ columnKey: 'col_2', equals: '本页统计' })
    expect(setTotalRow(p, null, '').rows).not.toHaveProperty('totalRow')
    expect(setTotalRow(p, 'col_2', '  ').rows).not.toHaveProperty('totalRow')
    expect(totalRowsSummary(null)).toBeNull()
    expect(totalRowsSummary(sample())).toBeNull()
    const withTotals = sample({ summaryRows: [{ col_2: { value: '合计', status: 'ok' } }] })
    expect(totalRowsSummary(withTotals)).toBe('识别到 1 行合计 / 页脚（合计），不计入数据行')
    expect(setColumnType(plan(), 'col_2', 'date').columns[0]).toMatchObject({ valueType: 'date' })
  })

  it('范围说明：读全 / 只检查本页 / 不完整', () => {
    expect(coverageSummary(null)).toBeNull()
    expect(coverageSummary(sample())).toEqual({ tone: 'ok', text: '已读取全部 1 行' })
    expect(coverageSummary(sample({ coverage: { requestedScope: 'current_page', observedScope: 'current_page', status: 'complete', clues: ['pagination_present'] } }))?.tone).toBe('warn')
    const partial = coverageSummary(sample({ coverage: { requestedScope: 'current_page', observedScope: 'current_page', status: 'partial', reasonMessage: '数据量超出单步输出上限' } }))
    expect(partial?.tone).toBe('warn')
    expect(partial?.text).toContain('无法确认')
    expect(coverageSummary(sample({ rowCount: 0, rows: [] }))?.text).toContain('现在没有数据')
  })

  it('取最近的外层 / 内层范围', () => {
    const alt = (selector: string, level: 'inner' | 'outer') => ({ selector, level, rowCount: 1, colCount: 1, selectorQuality: 'stable' as const })
    const picked = scopeAlternatives({ alternatives: [alt('#a', 'inner'), alt('#b', 'inner'), alt('#c', 'outer'), alt('#d', 'outer')] } as never)
    expect(picked.outer?.selector).toBe('#c')
    expect(picked.inner?.selector).toBe('#b')
  })

  it('从步骤输出取表格读取结果', () => {
    expect(tableSampleOf({ value: sample() })?.rowCount).toBe(1)
    expect(tableSampleOf(sample())?.rowCount).toBe(1)
    expect(tableSampleOf({ value: '文本' })).toBeNull()
    expect(tableSampleOf(null)).toBeNull()
  })
})

describe('卡片 / 键值的说法', () => {
  const base = createPlaceholderTablePlan()
  it('一行结论按形态说人话', () => {
    expect(foundSummary({ rowCount: 3, colCount: 2, plan: base })).toBe('找到一张表格，3 行 × 2 列')
    expect(foundSummary({ rowCount: 4, colCount: 3, plan: { ...base, kind: 'cards' } })).toBe('找到一组卡片，4 张，每张 3 项')
    expect(foundSummary({ rowCount: 1, colCount: 5, plan: { ...base, kind: 'keyvalue' } })).toBe('找到一块详情信息，共 5 项')
  })
  it('缺省 kind 当表格；旧计划也当表格', () => {
    expect(planKind(base)).toBe('table')
    expect(planKind({ ...base, kind: 'cards' })).toBe('cards')
    expect(kindNoun('keyvalue')).toBe('详情信息')
  })
  it('修改列时保留形态', () => {
    const plan: TableReadPlanV2 = { ...base, kind: 'cards' }
    expect(renameColumn(plan, 'col_1', '指标').kind).toBe('cards')
  })
})
