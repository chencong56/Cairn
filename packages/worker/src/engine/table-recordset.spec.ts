import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  TABLE_RECORDSET_MAX_ROWS,
  resolveEvidencePolicy,
  tableSampleSchema,
  type EvidenceMetadata,
  type JsonValue,
  type Step,
  type TableRowField,
  type TableSample,
} from '@cairn/shared'
import { externalizeTableSample, loadFullTableSample, type RecordSetObjectPort } from './table-recordset.js'
import { FixtureStepExecutor } from './fixture-executor.js'
import { systemClock } from './clock.js'
import { testRunGrant, testRunSnapshot } from '../__tests__/harness.js'
import type { StepExecutionContext } from './step-executor.js'

const RUN = '11111111-1111-4111-8111-111111111111'
const num = (n: number): TableRowField => ({ value: n, rawText: String(n), status: 'ok' })

function fullSample(n: number): TableSample {
  return tableSampleSchema.parse({
    protocol: 'table.sample@1',
    source: { kind: 'file', runId: RUN, sampledAt: new Date().toISOString(), planDigest: 'a'.repeat(64) },
    columns: [{ key: 'n', name: '数量', valueType: 'number', numericKind: 'integer' }],
    rows: Array.from({ length: n }, (_, i) => ({ n: num(i + 1) })),
    rowCount: n,
    coverage: { status: 'complete' },
    presentation: { omitted: false, previewCount: Math.min(n, 20) },
  })
}

/** 内存对象存储：摘要与真实对象服务一致（sha256:hex）。 */
function memoryPort(maxBytes = 32 * 1024 * 1024) {
  const objects = new Map<string, Uint8Array>()
  let seq = 0
  const port: RecordSetObjectPort & { objects: Map<string, Uint8Array> } = {
    objects,
    objectMaxBytes: () => maxBytes,
    async putObjectEvidence(input) {
      const key = `v1/runs/${input.runId}/obj-${++seq}`
      objects.set(key, input.body)
      return {
        schemaVersion: 1,
        id: `0193${String(seq).padStart(4, '0')}-0000-7000-8000-000000000000`,
        runId: input.runId,
        type: 'file',
        status: 'available',
        objectKey: key,
        byteSize: input.body.byteLength,
        digest: `sha256:${createHash('sha256').update(input.body).digest('hex')}`,
        createdAt: new Date().toISOString(),
      } as unknown as EvidenceMetadata
    },
    async getObject(key) {
      const body = objects.get(key)
      if (!body) throw new Error('对象不存在')
      return { head: { digest: `sha256:${createHash('sha256').update(body).digest('hex')}` }, body }
    },
  }
  return port
}

describe('大记录集外置', () => {
  it('预览放得下：不外置，原样返回', async () => {
    const r = await externalizeTableSample({ sample: fullSample(30), runId: RUN, objects: memoryPort() })
    expect(r.ok && r.sample.storage).toBeUndefined()
    expect(r.ok && r.sample.rows).toHaveLength(30)
  })

  it('超过预览：上下文只留预览 + 句柄，全量可按句柄还原', async () => {
    const port = memoryPort()
    const r = await externalizeTableSample({ sample: fullSample(1200), runId: RUN, attemptId: 'att-1', objects: port })
    if (!r.ok) throw new Error(r.error.safeMessage)
    expect(r.sample.rows).toHaveLength(200)
    expect(r.sample.rowCount).toBe(1200)
    expect(r.sample.storage?.rowCount).toBe(1200)
    expect(r.sample.coverage.status).toBe('complete')
    const loaded = await loadFullTableSample(r.sample, port)
    expect(loaded.ok && loaded.sample.rows).toHaveLength(1200)
    expect(loaded.ok && loaded.sample.rows[1199]!.n!.value).toBe(1200)
  })

  it('预览还受字节预算约束', async () => {
    const r = await externalizeTableSample({ sample: fullSample(100), runId: RUN, objects: memoryPort(), previewLimit: { rows: 200, bytes: 500 } })
    if (!r.ok) throw new Error(r.error.safeMessage)
    expect(r.sample.rows.length).toBeLessThan(100)
    expect(r.sample.storage?.rowCount).toBe(100)
  })

  it('超过行数上限：截断并标为部分，不宣称完整', async () => {
    const r = await externalizeTableSample({ sample: fullSample(TABLE_RECORDSET_MAX_ROWS + 5), runId: RUN, objects: memoryPort() })
    if (!r.ok) throw new Error(r.error.safeMessage)
    expect(r.sample.rowCount).toBe(TABLE_RECORDSET_MAX_ROWS)
    expect(r.sample.coverage.status).toBe('partial')
    expect(r.sample.coverage.reasonCode).toBe('TABLE_ROW_LIMIT_TRUNCATED')
  })

  it('超过对象体积上限：截断到放得下的行数并标为部分', async () => {
    const r = await externalizeTableSample({ sample: fullSample(5000), runId: RUN, objects: memoryPort(20_000) })
    if (!r.ok) throw new Error(r.error.safeMessage)
    expect(r.sample.coverage.status).toBe('partial')
    expect(r.sample.storage!.rowCount).toBeLessThan(5000)
    expect(r.sample.storage!.byteSize).toBeLessThanOrEqual(20_000)
  })

  it('需要外置但没有对象存储：明确报错，不悄悄只留预览', async () => {
    const r = await externalizeTableSample({ sample: fullSample(500), runId: RUN })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error.code).toBe('RECORDSET_STORE_UNAVAILABLE')
  })

  it('摘要不符 / 对象缺失：加载失败给出原因', async () => {
    const port = memoryPort()
    const r = await externalizeTableSample({ sample: fullSample(300), runId: RUN, objects: port })
    if (!r.ok) throw new Error(r.error.safeMessage)
    const key = r.sample.storage!.objectKey
    port.objects.set(key, new TextEncoder().encode('tampered'))
    const bad = await loadFullTableSample(r.sample, port)
    expect(bad.ok).toBe(false)
    expect(!bad.ok && bad.message).toContain('摘要')
    port.objects.delete(key)
    expect((await loadFullTableSample(r.sample, port)).ok).toBe(false)
    expect((await loadFullTableSample(r.sample)).ok).toBe(false)
  })
})

describe('check_context × 外置记录集', () => {
  const checkStep = (rule: unknown): Step =>
    ({ id: '01912345-6789-7abc-def0-1234567890ab', name: '检查', type: 'check_context', effectType: 'READ_ONLY', input: { key: 'rows', expect: { kind: 'table', rule } } }) as Step
  const ctx = (step: Step, context: Record<string, JsonValue>): StepExecutionContext => ({
    runId: RUN,
    stepRunId: 'sr-1',
    attemptId: 'att-1',
    targetId: 't-1',
    step,
    input: step.input as JsonValue,
    context,
    signal: new AbortController().signal,
    clock: systemClock,
    evidencePolicy: resolveEvidencePolicy({}),
    grant: testRunGrant(),
    snapshot: testRunSnapshot(),
  })

  it('按全量检查：1200 行的合计只有全量才对得上', async () => {
    const port = memoryPort()
    const r = await externalizeTableSample({ sample: fullSample(1200), runId: RUN, objects: port })
    if (!r.ok) throw new Error(r.error.safeMessage)
    const step = checkStep({ rule: 'column_stat', column: 'n', stat: 'sum', op: 'eq', value: (1200 * 1201) / 2 })
    const outcome = await new FixtureStepExecutor(port).execute(ctx(step, { rows: r.sample as unknown as JsonValue }))
    expect(outcome.kind).toBe('success')
  })

  it('执行器读不了对象存储：判无法确认，不拿预览下结论', async () => {
    const port = memoryPort()
    const r = await externalizeTableSample({ sample: fullSample(1200), runId: RUN, objects: port })
    if (!r.ok) throw new Error(r.error.safeMessage)
    const step = checkStep({ rule: 'row_count', op: 'eq', value: 200 })
    const outcome = await new FixtureStepExecutor().execute(ctx(step, { rows: r.sample as unknown as JsonValue }))
    expect(outcome.kind).toBe('failed')
    expect(outcome.kind === 'failed' && outcome.error.code).toBe('TABLE_FACTS_UNAVAILABLE')
  })
})
