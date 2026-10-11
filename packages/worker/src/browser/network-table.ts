import {
  TABLE_SAMPLE_PROTOCOL,
  canonicalJson,
  syncSha256,
  type NetworkCapturedEntry,
  type PageRef,
  type TableNetworkPlan,
  type TableSample,
} from '@cairn/shared'
import { readJsonTable, suggestJsonTables } from '@cairn/table-file'
import type { CapturedResponse, NetworkCapture } from './network-capture.js'

/** 与页面读取一致：结果展示默认先显示前 20 行。 */
const PREVIEW_ROWS = 20

export type NetworkTableRead =
  | { ok: true; sample: TableSample; entry: CapturedResponse }
  | { ok: false; code: string; message: string; entry?: CapturedResponse }

type SampleMeta = { runId: string; stepRunId?: string; attemptId?: string; pageRef?: PageRef }

/** 某个已捕获的响应按计划读成记录集（编写期指定了响应、或运行期 find 找到之后共用）。 */
export function readCapturedTable(entry: CapturedResponse, plan: TableNetworkPlan, meta: SampleMeta): NetworkTableRead {
  if (entry.tooLarge) return { ok: false, code: 'TABLE_NETWORK_RESPONSE_TOO_LARGE', message: '这个接口响应太大，没有保留正文', entry }
  if (!entry.json || entry.body === undefined) return { ok: false, code: 'TABLE_NETWORK_NOT_JSON', message: '这个接口返回的不是 JSON', entry }
  let root: unknown
  try {
    root = JSON.parse(entry.body)
  } catch {
    return { ok: false, code: 'TABLE_NETWORK_NOT_JSON', message: '这个接口返回的不是 JSON', entry }
  }
  const read = readJsonTable(root, plan)
  if (!read.ok) return { ...read, entry }
  const { pageInfo, ...body } = read.body
  const sample: TableSample = {
    protocol: TABLE_SAMPLE_PROTOCOL,
    source: {
      kind: 'network',
      request: {
        method: entry.method,
        url: entry.url.slice(0, 2048),
        status: entry.status,
        at: new Date(entry.at).toISOString(),
        byteSize: entry.byteSize,
        digest: entry.digest ?? 'sha256:unknown',
      },
      runId: meta.runId,
      ...(meta.stepRunId ? { stepRunId: meta.stepRunId } : {}),
      ...(meta.attemptId ? { attemptId: meta.attemptId } : {}),
      ...(meta.pageRef ? { pageRef: meta.pageRef } : {}),
      sampledAt: new Date().toISOString(),
      planDigest: syncSha256(canonicalJson(plan)),
    },
    ...body,
    ...(pageInfo ? { pageInfo } : {}),
    presentation: { omitted: false, previewCount: Math.min(PREVIEW_ROWS, body.rows.length) },
  }
  return { ok: true, sample, entry }
}

/** 运行期：按计划在本页的捕获里找响应（最多等 waitMs），再读成记录集。 */
export async function readNetworkTable(
  capture: NetworkCapture,
  page: object,
  plan: TableNetworkPlan,
  meta: SampleMeta,
  signal?: AbortSignal,
): Promise<NetworkTableRead> {
  const found = await capture.find(plan, page, signal)
  if (!found.ok) return found
  return readCapturedTable(found.entry, plan, meta)
}

/** 给编写期列表用的条目描述：不带正文，带“最像数据源”的提示。 */
export function describeCapturedEntry(entry: CapturedResponse): NetworkCapturedEntry & { score: number } {
  let score = 0
  let rowHint: number | undefined
  if (entry.json && entry.body !== undefined) {
    try {
      const [best] = suggestJsonTables(JSON.parse(entry.body))
      if (best) {
        score = best.score
        rowHint = best.rowCount
      }
    } catch {
      // 不是 JSON 就没有建议
    }
  }
  return {
    id: entry.id,
    at: new Date(entry.at).toISOString(),
    method: entry.method,
    url: entry.url.slice(0, 2048),
    status: entry.status,
    byteSize: entry.byteSize,
    ...(entry.contentType ? { contentType: entry.contentType } : {}),
    json: entry.json,
    ...(entry.tooLarge ? { tooLarge: true } : {}),
    ...(rowHint !== undefined ? { rowHint } : {}),
    score,
  }
}
