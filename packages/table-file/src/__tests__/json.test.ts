import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { TABLE_NETWORK_PROTOCOL, tableNetworkPlanSchema, type TableNetworkPlan } from '@cairn/shared'
import { outlineJson, readJsonTable, resolveJsonPath, suggestJsonTables } from '../index.js'

type Lab = {
  parseParams: (q: URLSearchParams) => unknown
  sitesResponse: (p: unknown) => { data: { total: number; list: Array<Record<string, unknown>> } }
  seriesResponse: (p: unknown) => unknown
  truthOf: (view: string, p: unknown) => { rows: Array<Record<string, unknown>>; total: number }
}

const PORTAL = fileURLToPath(new URL('../../../../tests/target-popup-portal/grids', import.meta.url))
let lab: Lab
beforeAll(async () => {
  lab = (await import(pathToFileURL(join(PORTAL, 'data.mjs')).href)) as Lab
})
const params = (q: string) => lab.parseParams(new URLSearchParams(q))
const plan = (extra: Partial<TableNetworkPlan>): TableNetworkPlan =>
  tableNetworkPlanSchema.parse({ protocol: TABLE_NETWORK_PROTOCOL, match: { url: '/grids/api/sites' }, ...extra })

describe('接口来源：建议与读取与真值一致', () => {
  it('对象数组：建议 data.list 作为数据行、data.total 作为总条数，读出与真值逐行一致', () => {
    const body = lab.sitesResponse(params('rows=12'))
    const [best] = suggestJsonTables(body)
    expect(best).toMatchObject({ layout: 'rows', rowsPath: 'data.list', totalPath: 'data.total', rowCount: 12 })
    const types = Object.fromEntries(best!.columns.map((c) => [c.path, c.numericKind ?? c.valueType]))
    expect(types).toMatchObject({ id: 'integer', name: 'text', qty: 'integer', amount: 'decimal', date: 'date' })
    const read = readJsonTable(body, plan({ rowsPath: best!.rowsPath, totalPath: best!.totalPath, columns: best!.columns }))
    if (!read.ok) throw new Error(read.message)
    const truth = lab.truthOf('sites', params('rows=12'))
    expect(read.body.rows.map((r) => [r.id?.value, r.name?.value, r.qty?.value, r.amount?.value, r.date?.value])).toEqual(
      truth.rows.map((r) => [r.id, r.name, r.qty, r.amount, r.date]),
    )
    expect(read.body.pageInfo?.totalRows).toBe(12)
    expect(read.body.coverage.status).toBe('complete')
    // 结果直接持久化为 JSON 值：不能带 undefined 属性
    expect(read.body).toStrictEqual(JSON.parse(JSON.stringify(read.body)))
  })

  it('图表列式数据：等长数组按下标拼行，列名取 series 的 name；长度不一致明确报错', () => {
    const body = lab.seriesResponse(params('months=6'))
    const [best] = suggestJsonTables(body)
    expect(best).toMatchObject({ layout: 'columns', rowCount: 6 })
    expect(best!.columns.map((c) => c.name)).toEqual(['months', '收入', '支出'])
    const read = readJsonTable(body, plan({ layout: 'columns', columns: best!.columns }))
    if (!read.ok) throw new Error(read.message)
    const truth = lab.truthOf('series', params('months=6'))
    expect(read.body.rows.map((r) => Object.values(r).map((f) => f.value))).toEqual(truth.rows.map((r) => [r.month, r.income, r.expense]))

    const ragged = readJsonTable(lab.seriesResponse(params('months=6&ragged=1')), plan({ layout: 'columns', columns: best!.columns }))
    expect(ragged).toMatchObject({ ok: false, code: 'TABLE_NETWORK_COLUMNS_LENGTH_MISMATCH' })
  })
})

describe('接口来源：诚实性与取值口径', () => {
  const cols = [
    { key: 'name', name: '名称', path: 'name', valueType: 'text' as const },
    { key: 'amount', name: '金额', path: 'amount', valueType: 'number' as const, numericKind: 'decimal' as const },
  ]

  it('路径不存在 / 不是数组 / 总条数不是整数：各自明确报错，不当成空表', () => {
    const body = { data: { list: [{ name: '甲', amount: 1 }], total: 'abc', obj: {} } }
    expect(readJsonTable(body, plan({ rowsPath: 'data.rows', columns: cols }))).toMatchObject({ ok: false, code: 'TABLE_NETWORK_PATH_NOT_FOUND' })
    expect(readJsonTable(body, plan({ rowsPath: 'data.obj', columns: cols }))).toMatchObject({ ok: false, code: 'TABLE_NETWORK_PATH_NOT_ARRAY' })
    expect(readJsonTable(body, plan({ rowsPath: 'data.list', totalPath: 'data.total', columns: cols }))).toMatchObject({ ok: false, code: 'TABLE_NETWORK_TOTAL_INVALID' })
  })

  it('接口给的空数组：确实为空（complete，0 行）', () => {
    const read = readJsonTable({ data: { list: [] } }, plan({ rowsPath: 'data.list', columns: cols }))
    expect(read).toMatchObject({ ok: true, body: { rowCount: 0, coverage: { status: 'complete' } } })
  })

  it('超过最多行数：截断并标为部分', () => {
    const list = Array.from({ length: 30 }, (_, i) => ({ name: `n${i}`, amount: i }))
    const read = readJsonTable({ list }, plan({ rowsPath: 'list', columns: cols, limits: { maxRows: 10 } }))
    expect(read).toMatchObject({ ok: true, body: { rowCount: 10, coverage: { status: 'partial', reasonCode: 'TABLE_ROW_LIMIT_TRUNCATED' } } })
  })

  it('文字形式的数字、嵌套字段、敏感列、对象值', () => {
    const body = { list: [{ name: '甲', amount: '1,234.50', region: { name: '华南' }, card: '6222 0000', extra: { a: 1 } }] }
    const read = readJsonTable(
      body,
      plan({
        rowsPath: 'list',
        columns: [
          ...cols,
          { key: 'region', name: '区域', path: 'region.name', valueType: 'text' },
          { key: 'card', name: '卡号', path: 'card', valueType: 'text', sensitive: true },
          { key: 'extra', name: '附加', path: 'extra', valueType: 'text' },
        ],
      }),
    )
    if (!read.ok) throw new Error(read.message)
    const row = read.body.rows[0]!
    expect(row.amount).toMatchObject({ value: 1234.5, decimalValue: '1234.50', status: 'ok' })
    expect(row.region).toEqual({ value: '华南', status: 'ok' })
    expect(row.card).toEqual({ value: null, status: 'masked' })
    expect(row.extra?.status).toBe('error')
  })

  it('结构概览：对象数组可作数据行、基本值数组可按下标拼行、数字可作总条数；超出节点上限截断', () => {
    const body = lab.seriesResponse(params('months=6'))
    const { nodes } = outlineJson(body)
    expect(nodes.find((n) => n.path === 'data.series')).toMatchObject({ type: 'array', length: 2, rows: true })
    expect(nodes.find((n) => n.path === 'data.months')).toMatchObject({ series: true, length: 6 })
    expect(nodes.find((n) => n.path === 'code')).toMatchObject({ numeric: true })
    // 每条序列的数组都在树里，可以单独选
    expect(nodes.filter((n) => n.series).map((n) => n.path)).toEqual(['data.months', 'data.series.0.data', 'data.series.1.data'])
    // 普通的数据行数组仍只展开第 0 项
    const sites = outlineJson(lab.sitesResponse(params('rows=12'))).nodes
    expect(sites.some((n) => n.path.startsWith('data.list.1'))).toBe(false)
    const big = { list: Array.from({ length: 5 }, () => Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${i}`, i]))) }
    expect(outlineJson(big, { maxNodes: 20 }).truncated).toBe(true)
    expect(resolveJsonPath(body, 'data.series.1.name')).toBe('支出')
    expect(resolveJsonPath(body, 'data.series.x')).toBeUndefined()
  })
})
