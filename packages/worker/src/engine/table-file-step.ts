import type { DbHandle } from '@cairn/db'
import {
  TABLE_FILE_MAX_BYTES,
  TABLE_SAMPLE_PROTOCOL,
  asRunFileHandle,
  canonicalJson,
  syncSha256,
  type TableFilePlan,
  type TableSample,
} from '@cairn/shared'
import type { ObjectService } from '../objects/object.service.js'
import { readTableFile } from '@cairn/table-file'
import type { StepExecutionContext, StepExecutionOutcome } from './step-executor.js'
import { externalizeTableSample } from './table-recordset.js'
import { authorizeRunHandle } from './upload-object.js'

/** 与页面读取一致：结果展示默认先显示前 20 行（Engine 不引用浏览器层，这里单独声明）。 */
const TABLE_PREVIEW_ROWS = 20

const failed = (code: string, safeMessage: string, category: 'VALIDATION' | 'INFRASTRUCTURE' | 'EXECUTOR' = 'VALIDATION', retryable = false): StepExecutionOutcome => ({
  kind: 'failed',
  error: { code, category, retryable, safeMessage },
  timedOut: false,
  aborted: false,
})

/**
 * 文件来源的表格提取：上下文里的下载文件句柄 → 校验属于本次运行 → 读对象 → 解析成记录集 → 超出预览就外置。
 * 解析在 Worker 的 Node 里完成，不打开浏览器、不执行文件里的任何内容；API 不碰文件内容。
 */
export async function executeTableFileStep(
  ctx: StepExecutionContext,
  plan: TableFilePlan,
  deps: { handle: DbHandle; objects?: ObjectService },
): Promise<StepExecutionOutcome> {
  const file = asRunFileHandle(ctx.context[plan.fromKey])
  if (!file) {
    return failed('TABLE_FILE_SOURCE_MISSING', `上下文里没有文件「${plan.fromKey}」：前面的下载步骤没有成功，或输出名不一致`)
  }
  if (!deps.objects) return failed('FILE_OBJECT_UNAVAILABLE', '对象存储不可用，无法读取下载的文件', 'INFRASTRUCTURE', true)
  if (file.byteSize > TABLE_FILE_MAX_BYTES) {
    return failed('TABLE_FILE_TOO_LARGE', `文件「${file.name}」${Math.round(file.byteSize / 1024 / 1024)} MB，超过读取上限 ${TABLE_FILE_MAX_BYTES / 1024 / 1024} MB`)
  }
  const authorized = await authorizeRunHandle(deps.handle, { runId: ctx.runId, file })
  if (!authorized.ok) return { kind: 'failed', error: authorized.error, timedOut: false, aborted: false }
  let bytes: Uint8Array
  try {
    bytes = (await deps.objects.getObject(authorized.blob.objectKey)).body
  } catch (error) {
    return failed('FILE_OBJECT_UNAVAILABLE', `读取下载的文件失败：${error instanceof Error ? error.message : String(error)}`, 'INFRASTRUCTURE', true)
  }
  const read = readTableFile({ bytes, name: file.name, plan })
  if (!read.ok) return failed(read.code, read.message)
  const { file: fileMeta, ...body } = read.body
  const sample: TableSample = {
    protocol: TABLE_SAMPLE_PROTOCOL,
    source: {
      kind: 'file',
      file: fileMeta,
      runId: ctx.runId,
      stepRunId: ctx.stepRunId,
      attemptId: ctx.attemptId,
      sampledAt: new Date().toISOString(),
      planDigest: syncSha256(canonicalJson(plan)),
    },
    ...body,
    presentation: { omitted: false, previewCount: Math.min(TABLE_PREVIEW_ROWS, body.rows.length) },
  }
  const out = await externalizeTableSample({ sample, runId: ctx.runId, stepRunId: ctx.stepRunId, attemptId: ctx.attemptId, objects: deps.objects })
  if (!out.ok) return { kind: 'failed', error: out.error, timedOut: false, aborted: false }
  return { kind: 'success', output: { value: out.sample } as never }
}
