/**
 * 文件来源读取（不需要浏览器）：文件由目标系统 tests/target-popup-portal 的导出模块真实生成
 * （xlsx 用 exceljs、GBK 用 iconv-lite），读取结果与同一份数据的标准答案逐行比对。
 * 门户依赖没装时明确失败：cd tests/target-popup-portal && pnpm install --ignore-workspace
 */
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zipSync } from 'fflate'
import { beforeAll, describe, expect, it } from 'vitest'
import { TABLE_FILE_PROTOCOL, tableFilePlanSchema, type TableFilePlan } from '@cairn/shared'
import { detectTableFile, readTableFile } from '../index.js'

type Row = { id: number; name: string; region: string; qty: number; amount: number; status: string; date: string }
type Lab = {
  exportFile: (p: unknown, o: unknown) => Promise<{ body: Buffer; filename: string } | null>
  exportOptions: (q: URLSearchParams) => unknown
  exportTruth: (p: unknown, o: unknown) => { rows: Row[]; summary?: { qty: number; amount: number } }
  parseParams: (q: URLSearchParams) => unknown
}

const PORTAL = fileURLToPath(new URL('../../../../tests/target-popup-portal/grids', import.meta.url))
let lab: Lab

beforeAll(async () => {
  const exp = await import(pathToFileURL(join(PORTAL, 'export.mjs')).href)
  const data = await import(pathToFileURL(join(PORTAL, 'data.mjs')).href)
  lab = { ...exp, parseParams: data.parseParams } as Lab
})

async function exported(query: string): Promise<{ bytes: Uint8Array; name: string; truth: ReturnType<Lab['exportTruth']> }> {
  const q = new URLSearchParams(query)
  const p = lab.parseParams(q)
  const o = lab.exportOptions(q)
  const out = await lab.exportFile(p, o)
  if (!out) throw new Error(`靶场不支持导出：${query}`)
  return { bytes: new Uint8Array(out.body), name: out.filename, truth: lab.exportTruth(p, o) }
}

const COLUMNS = [
  { key: 'id', name: '编号', valueType: 'number', numericKind: 'integer' },
  { key: 'name', name: '站点名称', valueType: 'text' },
  { key: 'region', name: '区域', valueType: 'text' },
  { key: 'qty', name: '数量', valueType: 'number', numericKind: 'integer' },
  { key: 'amount', name: '金额（元）', valueType: 'number', numericKind: 'decimal' },
  { key: 'date', name: '日期', valueType: 'date' },
]
const plan = (extra: Partial<TableFilePlan> = {}): TableFilePlan =>
  tableFilePlanSchema.parse({ protocol: TABLE_FILE_PROTOCOL, fromKey: 'exportFile', columns: COLUMNS, ...extra })

function expectMatchesTruth(rows: Array<Record<string, { value: unknown; decimalValue?: string }>>, truth: Row[]): void {
  expect(rows.length, '行数与真值不一致').toBe(truth.length)
  rows.forEach((r, i) => {
    const t = truth[i] as Row
    expect([r.id?.value, r.name?.value, r.region?.value, r.qty?.value, r.amount?.decimalValue, r.date?.value], `第 ${i + 1} 行`).toEqual([
      t.id,
      t.name,
      t.region,
      t.qty,
      t.amount.toFixed(2),
      t.date,
    ])
  })
}

describe('文件来源：各种格式读出与真值一致', () => {
  for (const format of ['csv', 'csv-bom', 'csv-gbk', 'tsv', 'xlsx', 'html-xls', 'html-xls-gbk']) {
    it(`${format}：明细与合计行`, async () => {
      const f = await exported(`format=${format}&rows=12&summary=1`)
      const r = readTableFile({ bytes: f.bytes, name: f.name, plan: plan() })
      if (!r.ok) throw new Error(`${r.code}：${r.message}`)
      expect(r.body.coverage.status).toBe('complete')
      expectMatchesTruth(r.body.rows, f.truth.rows)
      expect(r.body.summaryRows?.[0]?.qty?.value).toBe(f.truth.summary?.qty)
      if (format.endsWith('gbk')) expect(r.body.file.encoding).toBe('gb18030')
      // 结果直接持久化为 JSON 值：不能带 undefined 属性（合计行的空格子曾带出 rawText: undefined）
      expect(r.body).toStrictEqual(JSON.parse(JSON.stringify(r.body)))
    })
  }

  for (const format of ['csv', 'xlsx', 'html-xls']) {
    it(`${format}：标题行 + 两级合并表头 + 区域纵向合并`, async () => {
      const f = await exported(`format=${format}&rows=10&title=1&merged=1&summary=1`)
      const r = readTableFile({ bytes: f.bytes, name: f.name, plan: plan() })
      if (!r.ok) throw new Error(`${r.code}：${r.message}`)
      expectMatchesTruth(r.body.rows, f.truth.rows)
      expect(r.body).toStrictEqual(JSON.parse(JSON.stringify(r.body)))
      // 按“上级 / 列名”也能取
      const byPath = readTableFile({ bytes: f.bytes, name: f.name, plan: plan({ columns: [{ key: 'q', name: '业务数据 / 数量', valueType: 'number', numericKind: 'integer' }] }) })
      if (!byPath.ok) throw new Error(byPath.message)
      expect(byPath.body.rows.map((x) => x.q?.value)).toEqual(f.truth.rows.map((x) => x.qty))
      if (format !== 'csv') expect(r.body.coverage.clues).toContain('merged_cells_filled')
    })
  }

  it('xlsx：公式取缓存值、日期按格式换算、多工作表按名称选', async () => {
    const f = await exported('format=xlsx&rows=6&summary=1&formula=1&sheets=2')
    const r = readTableFile({ bytes: f.bytes, name: f.name, plan: plan() })
    if (!r.ok) throw new Error(r.message)
    expect(r.body.file.sheet).toBe('站点明细')
    expectMatchesTruth(r.body.rows, f.truth.rows)
    expect(r.body.summaryRows?.[0]?.amount?.decimalValue).toBe(f.truth.summary?.amount.toFixed(2))
    const second = readTableFile({
      bytes: f.bytes,
      name: f.name,
      plan: plan({ sheet: { name: '汇总' }, columns: [{ key: 'g', name: '区域', valueType: 'text' }, { key: 'n', name: '站点数', valueType: 'number', numericKind: 'integer' }] }),
    })
    if (!second.ok) throw new Error(second.message)
    expect(second.body.rows.map((x) => x.g?.value)).toEqual(['华南', '华东', '华北', '西南'])
    const missing = readTableFile({ bytes: f.bytes, name: f.name, plan: plan({ sheet: { name: '不存在' } }) })
    expect(!missing.ok && missing.code).toBe('TABLE_FILE_SHEET_NOT_FOUND')
  })

  it('5000 行 xlsx：全量读出，3 秒内', async () => {
    const f = await exported('format=xlsx&rows=5000')
    const started = Date.now()
    const r = readTableFile({ bytes: f.bytes, name: f.name, plan: plan() })
    const ms = Date.now() - started
    if (!r.ok) throw new Error(r.message)
    expect(r.body.rows).toHaveLength(5000)
    expect(r.body.rows[4999]?.id?.value).toBe(f.truth.rows[4999]?.id)
    expect(ms).toBeLessThan(3000)
  })
})

describe('文件来源：诚实性与错误', () => {
  it('旧版二进制 xls：明确不支持，不猜', async () => {
    const f = await exported('format=xls-binary')
    const r = readTableFile({ bytes: f.bytes, name: f.name, plan: plan() })
    expect(!r.ok && r.code).toBe('TABLE_FILE_XLS_UNSUPPORTED')
  })

  it('损坏的 xlsx：明确报损坏', async () => {
    const f = await exported('format=xlsx&rows=20&corrupt=1')
    const r = readTableFile({ bytes: f.bytes, name: f.name, plan: plan() })
    expect(!r.ok && r.code).toBe('TABLE_FILE_CORRUPT')
  })

  it('解压后过大的 xlsx（压缩炸弹）：解压前就拒绝', () => {
    const bomb = zipSync({ 'xl/workbook.xml': new Uint8Array(151 * 1024 * 1024) }, { level: 1 })
    const r = readTableFile({ bytes: bomb, name: 'bomb.xlsx', plan: plan() })
    expect(!r.ok && r.code).toBe('TABLE_FILE_TOO_LARGE')
  })

  it('找不到列 / 列重名 / 指定的表头行超出：各自明确报错', async () => {
    const f = await exported('format=csv&rows=3')
    const notFound = readTableFile({ bytes: f.bytes, name: f.name, plan: plan({ columns: [{ key: 'x', name: '不存在的列', valueType: 'text' }] }) })
    expect(!notFound.ok && notFound.code).toBe('TABLE_COLUMN_NOT_FOUND')
    const dup = new TextEncoder().encode('名称,名称\n甲,乙\n')
    const ambiguous = readTableFile({ bytes: dup, name: 'dup.csv', plan: plan({ columns: [{ key: 'n', name: '名称', valueType: 'text' }] }) })
    expect(!ambiguous.ok && ambiguous.code).toBe('TABLE_COLUMN_AMBIGUOUS')
    const far = readTableFile({ bytes: f.bytes, name: f.name, plan: plan({ header: { row: 99, rows: 'auto' } }) })
    expect(!far.ok && far.code).toBe('TABLE_HEADER_NOT_FOUND')
  })

  it('只有表头没有数据：是文件给出的事实，判为确实为空', async () => {
    const f = await exported('format=xlsx&rows=0')
    const r = readTableFile({ bytes: f.bytes, name: f.name, plan: plan() })
    if (!r.ok) throw new Error(r.message)
    expect(r.body.rows).toHaveLength(0)
    expect(r.body.coverage.status).toBe('complete')
  })

  it('超过计划的最多行数：截断并标为部分', async () => {
    const f = await exported('format=csv&rows=30')
    const r = readTableFile({ bytes: f.bytes, name: f.name, plan: plan({ limits: { maxRows: 10 } }) })
    if (!r.ok) throw new Error(r.message)
    expect(r.body.rows).toHaveLength(10)
    expect(r.body.coverage.status).toBe('partial')
    expect(r.body.coverage.reasonCode).toBe('TABLE_ROW_LIMIT_TRUNCATED')
  })

  it('公式没有缓存值：该格读不出，并留线索', () => {
    const sheet = '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>名称</t></is></c><c r="B1" t="inlineStr"><is><t>金额</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>甲</t></is></c><c r="B2"><f>SUM(1,2)</f></c></row></sheetData></worksheet>'
    const workbook = '<workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>'
    const rels = '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'
    const enc = new TextEncoder()
    const bytes = zipSync({ 'xl/workbook.xml': enc.encode(workbook), 'xl/_rels/workbook.xml.rels': enc.encode(rels), 'xl/worksheets/sheet1.xml': enc.encode(sheet) })
    const r = readTableFile({ bytes, name: 'f.xlsx', plan: plan({ columns: [{ key: 'a', name: '金额', valueType: 'number', numericKind: 'decimal' }] }) })
    if (!r.ok) throw new Error(r.message)
    expect(r.body.rows[0]?.a?.status).toBe('missing')
    expect(r.body.coverage.clues).toContain('formula_without_cached_value')
  })
})

describe('编写期识别', () => {
  it('xlsx：工作表、表头位置（跳过标题行）、列名与类型、建议计划', async () => {
    const f = await exported('format=xlsx&rows=8&title=1&sheets=2')
    const d = detectTableFile({ bytes: f.bytes, name: f.name, fromKey: 'exportFile' })
    if (!d.ok) throw new Error(d.message)
    const det = d.detection
    expect(det.format).toBe('xlsx')
    expect(det.sheets?.map((s) => s.name)).toEqual(['站点明细', '汇总'])
    expect(det.headerRow).toBe(4)
    expect(det.dataRows).toBe(8)
    const types = Object.fromEntries(det.columns.map((c) => [c.name, c.numericKind ?? c.valueType]))
    expect(types).toMatchObject({ 编号: 'integer', 数量: 'integer', '金额（元）': 'decimal', 日期: 'date', 站点名称: 'text' })
    const read = readTableFile({ bytes: f.bytes, name: f.name, plan: det.plan })
    expect(read.ok && read.body.rows).toHaveLength(8)
  })

  it('序号列默认排除', () => {
    const bytes = new TextEncoder().encode('序号,名称,数量\n1,甲,3\n2,乙,4\n')
    const d = detectTableFile({ bytes, name: 'a.csv', fromKey: 'f' })
    if (!d.ok) throw new Error(d.message)
    expect(d.detection.columns.find((c) => c.name === '序号')?.excludedReason).toBe('index')
    expect(d.detection.plan.columns.map((c) => c.name)).toEqual(['名称', '数量'])
  })

  it('数据行数不含合计行，与读取出的明细行数一致', async () => {
    const f = await exported('format=xlsx&rows=12&title=1&merged=1&summary=1')
    const d = detectTableFile({ bytes: f.bytes, name: f.name, fromKey: 'exportFile' })
    if (!d.ok) throw new Error(d.message)
    expect(d.detection.dataRows).toBe(12)
    const read = readTableFile({ bytes: f.bytes, name: f.name, plan: d.detection.plan })
    expect(read.ok && [read.body.rowCount, read.body.summaryRows?.length]).toEqual([12, 1])
  })
})
