import { Inject, Injectable, Optional } from '@nestjs/common'
import { authorizeTargetRequest, conflict, getRun, getScenario, listRuns, notFound, type DbHandle } from '@cairn/db'
import {
  TABLE_FILE_MAX_BYTES,
  TABLE_SAMPLE_PROTOCOL,
  asRunFileHandle,
  canonicalJson,
  stepRunsOf,
  syncSha256,
  type TableFilePlan,
  type TableFilePreviewRequest,
  type TableFilePreviewResponse,
} from '@cairn/shared'
import type { ObjectStore } from '@cairn/storage'
import { detectTableFile, readTableFile } from '@cairn/table-file'
import { DB_HANDLE } from '../db/db.module'
import { OBJECT_STORE } from '../objects/object-store.token'
import { rethrowDomain } from '../common/domain-error'

/** 预览只回传前 200 行，完整解析结果不留存。 */
const PREVIEW_ROWS = 200
/** 往前找最近多少次运行。 */
const RECENT_RUNS = 20

/**
 * 文件来源的编写期预览：在 API 内存里解析“最近一次运行里该下载步骤产出的文件”或用户上传的样例，
 * 不保存上传内容、不执行场景；解析用与 Worker 执行相同的 @cairn/table-file，口径一致。
 */
@Injectable()
export class TableFilePreviewService {
  constructor(
    @Inject(DB_HANDLE) private readonly db: DbHandle,
    @Optional() @Inject(OBJECT_STORE) private readonly store?: ObjectStore,
  ) {}

  async preview(scenarioId: string, body: TableFilePreviewRequest, actorId: string): Promise<TableFilePreviewResponse> {
    try {
      const scenario = await getScenario(this.db, scenarioId)
      if (!scenario) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
      await authorizeTargetRequest(this.db, actorId, { scenarioId, permissions: ['workflow:read'] })
      const file = body.source.kind === 'upload' ? this.fromUpload(body.source) : await this.fromLatestRun(scenarioId, body.downloadStepId, actorId)
      const detected = detectTableFile({ bytes: file.bytes, name: file.name, fromKey: body.fromKey, hints: body.hints })
      if (!detected.ok) throw conflict(detected.code, detected.message)
      const det = detected.detection
      const plan: TableFilePlan = body.plan ? { ...body.plan, fromKey: body.fromKey } : det.plan
      const read = readTableFile({ bytes: file.bytes, name: file.name, plan })
      if (!read.ok) throw conflict(read.code, read.message)
      const { file: fileMeta, ...sampleBody } = read.body
      return {
        source: { kind: body.source.kind, ...(file.runId ? { runId: file.runId } : {}), at: file.at },
        file: { ...fileMeta, byteSize: file.bytes.byteLength },
        ...(det.sheets ? { sheets: det.sheets } : {}),
        headerRow: det.headerRow,
        headerRows: det.headerRows,
        dataRows: det.dataRows,
        columns: det.columns.map((c) => ({
          key: c.key,
          name: c.name,
          ...(c.groupPath ? { groupPath: c.groupPath } : {}),
          ...(c.excludedReason ? { excludedReason: c.excludedReason } : {}),
          valueType: c.valueType,
          ...(c.numericKind ? { numericKind: c.numericKind } : {}),
          source: c.source,
          index: c.index,
          ...(c.indexOnly ? { indexOnly: true } : {}),
        })),
        plan,
        sample: {
          protocol: TABLE_SAMPLE_PROTOCOL,
          source: {
            kind: 'file',
            file: fileMeta,
            runId: file.runId ?? '00000000-0000-4000-8000-000000000000',
            sampledAt: new Date().toISOString(),
            planDigest: syncSha256(canonicalJson(plan)),
          },
          ...sampleBody,
          rows: sampleBody.rows.slice(0, PREVIEW_ROWS),
          presentation: { omitted: sampleBody.rows.length > PREVIEW_ROWS, previewCount: Math.min(PREVIEW_ROWS, sampleBody.rows.length) },
        },
      }
    } catch (error) {
      rethrowDomain(error)
    }
  }

  private fromUpload(source: Extract<TableFilePreviewRequest['source'], { kind: 'upload' }>): { bytes: Uint8Array; name: string; at: string; runId?: string } {
    const bytes = new Uint8Array(Buffer.from(source.base64, 'base64'))
    if (bytes.byteLength > TABLE_FILE_MAX_BYTES) throw conflict('TABLE_FILE_TOO_LARGE', `样例文件超过 ${TABLE_FILE_MAX_BYTES / 1024 / 1024} MB`)
    return { bytes, name: source.name, at: new Date().toISOString() }
  }

  /** 最近的运行里，该下载步骤成功产出的文件。 */
  private async fromLatestRun(scenarioId: string, downloadStepId: string, actorId: string): Promise<{ bytes: Uint8Array; name: string; at: string; runId: string }> {
    const runs = await listRuns(this.db, { scenarioId, limit: RECENT_RUNS }, actorId)
    for (const item of runs.items) {
      const detail = await getRun(this.db, item.id, actorId)
      // 循环 / 分支里同一个下载步骤可能执行多次：取所有执行里最后一次成功的产出
      const attempts = detail ? stepRunsOf(detail.stepRuns, downloadStepId).flatMap((sr) => sr.attempts) : []
      const attempt = [...attempts].reverse().find((a) => a.status === 'SUCCEEDED' && asRunFileHandle(a.output))
      const handle = asRunFileHandle(attempt?.output)
      if (!detail || !handle || handle.runId !== detail.id) continue
      if (!this.store) throw conflict('FILE_OBJECT_UNAVAILABLE', '对象存储不可用，无法读取运行里下载的文件')
      if (handle.byteSize > TABLE_FILE_MAX_BYTES) throw conflict('TABLE_FILE_TOO_LARGE', `文件「${handle.name}」超过读取上限`)
      const got = await this.store.get(handle.objectKey)
      return { bytes: got.body, name: handle.name, at: handle.createdAt, runId: detail.id }
    }
    throw notFound('TABLE_FILE_NO_RUN_FILE', '最近的运行里没有这个下载步骤产出的文件：先调试运行到下载步骤，或上传一个样例文件')
  }
}
