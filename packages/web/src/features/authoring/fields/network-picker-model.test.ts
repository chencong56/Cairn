import { describe, expect, it } from 'vitest'
import type { JsonOutlineNodeDto, NetworkTableSuggestion } from '@cairn/shared'
import { asRowsDraft, draftFromSuggestion, matchFromEntry, planFromDraft, rowFieldsOf, setTotalPath, toggleRowField, toggleSeries } from './network-picker-model'

const nodes: JsonOutlineNodeDto[] = [
  { path: '', key: '', depth: 0, type: 'object' },
  { path: 'data', key: 'data', depth: 1, type: 'object' },
  { path: 'data.total', key: 'total', depth: 2, type: 'number', preview: '45', numeric: true },
  { path: 'data.list', key: 'list', depth: 2, type: 'array', length: 45, rows: true },
  { path: 'data.list.0', key: '0', depth: 3, type: 'object' },
  { path: 'data.list.0.id', key: 'id', depth: 4, type: 'number', preview: '1000', numeric: true },
  { path: 'data.list.0.amount', key: 'amount', depth: 4, type: 'number', preview: '1234.56', numeric: true },
  { path: 'data.list.0.region', key: 'region', depth: 4, type: 'object' },
  { path: 'data.list.0.region.name', key: 'name', depth: 5, type: 'string', preview: '华南' },
  { path: 'data.months', key: 'months', depth: 2, type: 'array', length: 6, series: true },
  { path: 'data.series.0.data', key: 'data', depth: 4, type: 'array', length: 6, series: true },
]
const rowsSuggestion: NetworkTableSuggestion = {
  layout: 'rows',
  rowsPath: 'data.list',
  totalPath: 'data.total',
  rowCount: 45,
  score: 100,
  columns: [
    { key: 'id', name: 'id', path: 'id', valueType: 'number', numericKind: 'integer' },
    { key: 'amount', name: 'amount', path: 'amount', valueType: 'number', numericKind: 'decimal' },
  ],
}
const seriesSuggestion: NetworkTableSuggestion = {
  layout: 'columns',
  rowCount: 6,
  score: 30,
  columns: [{ key: 'data_series_0_data', name: '收入', path: 'data.series.0.data', valueType: 'number', numericKind: 'decimal' }],
}
const entry = { url: 'http://127.0.0.1:4183/grids/api/sites', method: 'POST' }

describe('选择接口：草稿与读取计划', () => {
  it('按建议起草：数据行、总条数、字段；生成的计划按地址路径 + 方法匹配', () => {
    const draft = draftFromSuggestion(rowsSuggestion)
    const plan = planFromDraft(entry, draft)
    expect(plan).toMatchObject({ match: { url: '/grids/api/sites', method: 'POST' }, layout: 'rows', rowsPath: 'data.list', totalPath: 'data.total' })
    expect(plan?.columns.map((c) => c.path)).toEqual(['id', 'amount'])
    expect(matchFromEntry({ url: 'not a url', method: 'TRACE' })).toEqual({ url: 'not a url' })
  })

  it('没有建议的数组：从结构树推字段（含一层嵌套），类型按样例值', () => {
    const fields = rowFieldsOf(nodes, 'data.list', [])
    expect(fields.map((f) => [f.path, f.valueType, f.numericKind])).toEqual([
      ['id', 'number', 'integer'],
      ['amount', 'number', 'decimal'],
      ['region.name', 'text', undefined],
    ])
    const draft = asRowsDraft(null, nodes, 'data.list', [])
    expect(planFromDraft(entry, draft)?.columns.find((c) => c.path === 'region.name')?.key).toBe('region_name')
  })

  it('勾 / 取消字段；字段全取消后不能生成计划', () => {
    let draft = draftFromSuggestion(rowsSuggestion)
    draft = toggleRowField(draft, { key: 'id', name: 'id', path: 'id', valueType: 'number', numericKind: 'integer' }, false)
    draft = toggleRowField(draft, { key: 'amount', name: 'amount', path: 'amount', valueType: 'number', numericKind: 'decimal' }, false)
    expect(planFromDraft(entry, draft)).toBeNull()
    draft = toggleRowField(draft, { key: 'x', name: '区域', path: 'region.name', valueType: 'text' }, true)
    expect(planFromDraft(entry, draft)?.columns).toHaveLength(1)
  })

  it('按下标拼成行：切到列式，列名取建议里 series 的 name；可设 / 取消总条数', () => {
    let draft = toggleSeries(draftFromSuggestion(rowsSuggestion), nodes.find((n) => n.path === 'data.months')!, true, [seriesSuggestion])
    draft = toggleSeries(draft, nodes.find((n) => n.path === 'data.series.0.data')!, true, [seriesSuggestion])
    expect(draft.layout).toBe('columns')
    expect(draft.columns.map((c) => c.name)).toEqual(['months', '收入'])
    const plan = planFromDraft(entry, draft)
    expect(plan).toMatchObject({ layout: 'columns' })
    expect(plan?.rowsPath).toBeUndefined()
    expect(setTotalPath(draft, undefined)?.totalPath).toBeUndefined()
    expect(setTotalPath(draft, 'data.total')?.totalPath).toBe('data.total')
  })
})
