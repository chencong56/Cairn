import { describe, expect, it } from 'vitest'
import {
  TABLE_RECORDSET_PROTOCOL,
  decodeTableRecordSet,
  encodeTableRecordSet,
  evaluateTableExpectation,
  isTablePreviewOnly,
  tableExpectRuleSchema,
  tableSampleSchema,
  type TableRowField,
  type TableSample,
} from '../index.js'

const num = (n: number): TableRowField => ({ value: n, rawText: String(n), status: 'ok' })
const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ n: num(i + 1) }))

function sample(rows: Array<Record<string, TableRowField>>, storageRows?: number): TableSample {
  return tableSampleSchema.parse({
    protocol: 'table.sample@1',
    source: { kind: 'file', runId: '11111111-1111-4111-8111-111111111111', sampledAt: new Date().toISOString(), planDigest: 'a'.repeat(64) },
    columns: [{ key: 'n', name: '数量', valueType: 'number', numericKind: 'integer' }],
    rows,
    rowCount: storageRows ?? rows.length,
    coverage: { status: 'complete' },
    presentation: { omitted: storageRows !== undefined, previewCount: rows.length },
    ...(storageRows !== undefined
      ? { storage: { protocol: TABLE_RECORDSET_PROTOCOL, objectKey: 'v1/runs/x/y', digest: 'sha256:abc', rowCount: storageRows, byteSize: 10 } }
      : {}),
  })
}

describe('外置记录集', () => {
  it('编码 / 解码往返：行与合计行原样还原', () => {
    const rows = rowsOf(3)
    const text = encodeTableRecordSet({ columns: ['n'], rows, summaryRows: [{ n: num(6) }] })
    const decoded = decodeTableRecordSet(text)
    expect(decoded.columns).toEqual(['n'])
    expect(decoded.rows).toEqual(rows)
    expect(decoded.summaryRows).toEqual([{ n: num(6) }])
  })

  it('行数与头不符、首行不是头：解码报错，不静默接受', () => {
    const text = encodeTableRecordSet({ columns: ['n'], rows: rowsOf(3) })
    const cut = text.split('\n').slice(0, 3).join('\n')
    expect(() => decodeTableRecordSet(cut)).toThrow('行数不符')
    expect(() => decodeTableRecordSet('{"n":1}\n')).toThrow()
    expect(() => decodeTableRecordSet('')).toThrow()
  })

  it('旧记录集（无 source.kind / storage）照常解析', () => {
    const old = sample(rowsOf(2))
    const { kind: _kind, ...source } = old.source
    expect(() => tableSampleSchema.parse({ ...old, source })).not.toThrow()
    expect(isTablePreviewOnly(old)).toBe(false)
  })

  it('只有预览、没加载全量：正式检查判无法确认，不拿预览下结论', () => {
    const preview = sample(rowsOf(200), 5000)
    expect(isTablePreviewOnly(preview)).toBe(true)
    const rule = tableExpectRuleSchema.parse({ rule: 'row_count', op: 'eq', value: 200 })
    const r = evaluateTableExpectation(preview, rule)
    expect(r.factsUnavailable).toBe(true)
    expect(r.reasonCode).toBe('TABLE_FULLSET_NOT_LOADED')
  })

  it('编写期预览显式允许时按预览算', () => {
    const preview = sample(rowsOf(200), 5000)
    const rule = tableExpectRuleSchema.parse({ rule: 'row_count', op: 'eq', value: 200 })
    expect(evaluateTableExpectation(preview, rule, { allowPreview: true }).passed).toBe(true)
  })

  it('全量已加载（rows 与 storage 行数一致）：照常判定', () => {
    const full = sample(rowsOf(300), 300)
    const rule = tableExpectRuleSchema.parse({ rule: 'column_stat', column: 'n', stat: 'sum', op: 'eq', value: (300 * 301) / 2 })
    expect(evaluateTableExpectation(full, rule).passed).toBe(true)
  })
})
