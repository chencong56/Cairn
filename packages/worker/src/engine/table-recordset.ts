import {
  TABLE_READ_DEFAULT_MAX_BYTES,
  TABLE_RECORDSET_CONTENT_TYPE,
  TABLE_RECORDSET_MAX_BYTES,
  TABLE_RECORDSET_MAX_ROWS,
  TABLE_RECORDSET_PROTOCOL,
  TABLE_SAMPLE_PREVIEW_ROWS,
  decodeTableRecordSet,
  encodeTableRecordSet,
  isTablePreviewOnly,
  type EvidenceMetadata,
  type ExecutionError,
  type TableRowField,
  type TableSample,
} from '@cairn/shared'

/**
 * 大记录集外置（文件 / 接口来源）：完整行写成运行对象，上下文只留预览与句柄；
 * 数据检查前按句柄加载全量。页面来源不经过这里。
 */
export type RecordSetObjectPort = {
  putObjectEvidence(input: {
    type: 'file'
    runId: string
    stepRunId?: string
    attemptId?: string
    artifactKey?: string
    body: Uint8Array
    contentType: string
  }): Promise<EvidenceMetadata>
  getObject(objectKey: string): Promise<{ head: { digest: string }; body: Uint8Array }>
  objectMaxBytes(): number
}

type RowRecord = Record<string, TableRowField>

const encoder = new TextEncoder()
const byteLengthOf = (value: unknown): number => encoder.encode(JSON.stringify(value)).byteLength

/** 在行数与字节预算内能放进上下文的前若干行。 */
function previewRows(rows: readonly RowRecord[], maxRows: number, maxBytes: number): RowRecord[] {
  const out: RowRecord[] = []
  let bytes = 0
  for (const row of rows) {
    if (out.length >= maxRows) break
    const size = byteLengthOf(row)
    if (bytes + size > maxBytes) break
    bytes += size
    out.push(row)
  }
  return out
}

/**
 * 输入是带全量行的记录集；超出预览（行数或字节）就外置。
 * 超过 TABLE_RECORDSET_MAX_ROWS 或对象上限的部分截断，覆盖标为 partial，不宣称完整。
 */
export async function externalizeTableSample(input: {
  sample: TableSample
  runId: string
  stepRunId?: string
  attemptId?: string
  objects?: RecordSetObjectPort
  /** 测试用：覆盖预览预算。 */
  previewLimit?: { rows: number; bytes: number }
}): Promise<{ ok: true; sample: TableSample } | { ok: false; error: ExecutionError }> {
  const limit = input.previewLimit ?? { rows: TABLE_SAMPLE_PREVIEW_ROWS, bytes: TABLE_READ_DEFAULT_MAX_BYTES }
  let sample = input.sample
  let rows: RowRecord[] = sample.rows

  const truncate = (keep: number, message: string) => {
    rows = rows.slice(0, keep)
    sample = {
      ...sample,
      coverage: { ...sample.coverage, status: 'partial', reasonCode: 'TABLE_ROW_LIMIT_TRUNCATED', reasonMessage: message },
    }
  }
  if (rows.length > TABLE_RECORDSET_MAX_ROWS) {
    truncate(TABLE_RECORDSET_MAX_ROWS, `数据有 ${rows.length} 行，超过单个记录集上限 ${TABLE_RECORDSET_MAX_ROWS} 行，只保留了前 ${TABLE_RECORDSET_MAX_ROWS} 行`)
  }

  const preview = previewRows(rows, limit.rows, limit.bytes)
  if (preview.length === rows.length) {
    return { ok: true, sample: { ...sample, rows, rowCount: rows.length } }
  }
  if (!input.objects) {
    return {
      ok: false,
      error: { code: 'RECORDSET_STORE_UNAVAILABLE', category: 'INFRASTRUCTURE', retryable: true, safeMessage: '数据量超过单步输出上限，但对象存储不可用，无法保存完整数据' },
    }
  }

  // 对象正文上限：逐行累计，超出就截断到能放下的行数
  const maxBytes = Math.min(input.objects.objectMaxBytes(), TABLE_RECORDSET_MAX_BYTES)
  const summaryRows = sample.summaryRows ?? []
  let body = encoder.encode(encodeTableRecordSet({ columns: sample.columns.map((c) => c.key), rows, summaryRows }))
  if (body.byteLength > maxBytes) {
    let used = byteLengthOf({ protocol: TABLE_RECORDSET_PROTOCOL, columns: sample.columns.map((c) => c.key), rowCount: rows.length, summaryRows }) + 1
    let keep = 0
    for (const row of rows) {
      const size = byteLengthOf(row) + 1
      if (used + size > maxBytes) break
      used += size
      keep++
    }
    const total = rows.length
    truncate(keep, `数据有 ${total} 行，体积超过单个对象上限，只保留了前 ${keep} 行`)
    body = encoder.encode(encodeTableRecordSet({ columns: sample.columns.map((c) => c.key), rows, summaryRows }))
  }

  let meta: EvidenceMetadata
  try {
    meta = await input.objects.putObjectEvidence({
      type: 'file',
      runId: input.runId,
      stepRunId: input.stepRunId,
      attemptId: input.attemptId,
      artifactKey: `recordset:${input.attemptId ?? input.runId}`,
      body,
      contentType: TABLE_RECORDSET_CONTENT_TYPE,
    })
  } catch (error) {
    return {
      ok: false,
      error: { code: 'RECORDSET_STORE_FAILED', category: 'INFRASTRUCTURE', retryable: true, safeMessage: `保存完整数据失败：${error instanceof Error ? error.message : String(error)}` },
    }
  }
  if (meta.status !== 'available' || !meta.objectKey || !meta.digest) {
    return {
      ok: false,
      error: { code: 'RECORDSET_STORE_FAILED', category: 'INFRASTRUCTURE', retryable: true, safeMessage: `保存完整数据失败：${meta.missingReason ?? '对象不可用'}` },
    }
  }
  return {
    ok: true,
    sample: {
      ...sample,
      rows: preview,
      rowCount: rows.length,
      presentation: { omitted: true, previewCount: preview.length },
      storage: {
        protocol: TABLE_RECORDSET_PROTOCOL,
        objectKey: meta.objectKey,
        digest: meta.digest,
        rowCount: rows.length,
        byteSize: meta.byteSize ?? body.byteLength,
        evidenceId: meta.id,
      },
    },
  }
}

/** 数据检查前：只有预览的记录集按句柄加载全量；失败一律返回原因，由调用方判“无法确认”。 */
export async function loadFullTableSample(
  sample: TableSample,
  objects?: Pick<RecordSetObjectPort, 'getObject'>,
): Promise<{ ok: true; sample: TableSample } | { ok: false; message: string }> {
  if (!isTablePreviewOnly(sample)) return { ok: true, sample }
  const storage = sample.storage!
  if (!objects) return { ok: false, message: '完整数据保存在对象存储里，但当前执行器无法读取对象存储' }
  try {
    const got = await objects.getObject(storage.objectKey)
    if (got.head.digest !== storage.digest) return { ok: false, message: '完整数据的摘要与记录不一致，可能已被替换' }
    const decoded = decodeTableRecordSet(new TextDecoder().decode(got.body))
    if (decoded.rows.length !== storage.rowCount) {
      return { ok: false, message: `完整数据行数不符：记录 ${storage.rowCount} 行，读到 ${decoded.rows.length} 行` }
    }
    return {
      ok: true,
      sample: { ...sample, rows: decoded.rows, ...(decoded.summaryRows.length > 0 ? { summaryRows: decoded.summaryRows } : {}) },
    }
  } catch (error) {
    return { ok: false, message: `读取完整数据失败：${error instanceof Error ? error.message : String(error)}` }
  }
}
