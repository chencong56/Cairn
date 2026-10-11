import type { Page } from 'playwright'
import type {
  NetworkInspectObservation,
  NetworkListObservation,
  NetworkReadObservation,
  ObserveNetworkOperation,
  PageRef,
} from '@cairn/shared'
import { outlineJson, suggestJsonTables } from '@cairn/table-file'
import { NetworkCapture } from './network-capture.js'
import { describeCapturedEntry, readCapturedTable, readNetworkTable } from './network-table.js'
import { type LiveHandle, type SessionManagerContext } from './session-live.js'

/** 编写期临时捕获：15 分钟没人用就停止并清空。 */
const AUTHORING_CAPTURE_IDLE_MS = 15 * 60_000
/** 编写期按计划预览时最多等几秒（运行期按计划的 waitMs）。 */
const AUTHORING_READ_WAIT_MS = 3_000
const RELOAD_TIMEOUT_MS = 30_000

/** 调试挂起中的运行若本身在捕获（场景里有接口来源步骤），沿用它；否则用会话上的编写期捕获，没有就开一个。 */
function captureFor(ctx: SessionManagerContext, live: LiveHandle, runId: string, create: boolean): NetworkCapture | undefined {
  const leaseId = [...ctx.leaseToRun].find(([, mapped]) => mapped === runId)?.[0]
  const leased = leaseId ? ctx.networkCaptureByLease.get(leaseId) : undefined
  if (leased) return leased
  const context = live.handle.context
  if (live.networkCapture?.isBoundTo(context)) return live.networkCapture
  live.networkCapture?.dispose()
  live.networkCapture = undefined
  if (!create || typeof context.on !== 'function') return undefined
  const capture: NetworkCapture = new NetworkCapture(context as never, Date.now, {
    ms: AUTHORING_CAPTURE_IDLE_MS,
    onIdle: () => {
      if (live.networkCapture === capture) live.networkCapture = undefined
    },
  })
  capture.attach()
  live.networkCapture = capture
  return capture
}

function listEntries(capture: NetworkCapture, page: Page, pageInfo: NetworkListObservation['page']): NetworkListObservation {
  const described = capture.list(page).map(describeCapturedEntry)
  const top = described.reduce((max, e) => Math.max(max, e.score), 0)
  const entries = described
    .map(({ score, ...entry }) => (top > 0 && score === top ? { ...entry, best: true } : entry))
    .reverse()
  return {
    outcome: entries.length > 0 ? 'FOUND' : 'NOT_FOUND',
    page: pageInfo,
    capturingSince: new Date(capture.startedAt).toISOString(),
    entries,
  }
}

export async function observeNetwork(
  this: SessionManagerContext,
  input: { op: ObserveNetworkOperation; live: LiveHandle; page: Page; pageRef: PageRef; url: string; title?: string; runId: string },
): Promise<NetworkListObservation | NetworkInspectObservation | NetworkReadObservation> {
  const { op, live, page } = input
  const pageInfo = { pageRef: input.pageRef, url: input.url, ...(input.title ? { title: input.title } : {}) }

  if (op.subOp === 'list' || op.subOp === 'reload') {
    const capture = captureFor(this, live, input.runId, true)!
    if (op.subOp === 'reload') {
      await page.reload({ waitUntil: 'load', timeout: RELOAD_TIMEOUT_MS }).catch(() => undefined)
      // 页面加载后的查询接口常常稍晚才发出：给一个短暂的空闲窗口
      await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined)
      const title = await page.title().catch(() => undefined)
      return listEntries(capture, page, { ...pageInfo, url: page.url(), ...(title ? { title } : {}) })
    }
    return listEntries(capture, page, pageInfo)
  }

  const capture = captureFor(this, live, input.runId, false)
  const gone = { code: 'TABLE_NETWORK_CAPTURE_OFF', message: '还没有开始捕获接口，或捕获已因长时间未使用而停止；请重新打开“选择接口”' }

  if (op.subOp === 'inspect') {
    const entry = capture?.get(op.entryId)
    if (!entry) return { outcome: 'NOT_FOUND', nodes: [], truncated: false, suggestions: [], reason: capture ? { code: 'TABLE_NETWORK_ENTRY_GONE', message: '这个响应已不在捕获列表里（只保留最近 30 个），请刷新列表' } : gone }
    const { score: _score, ...described } = describeCapturedEntry(entry)
    if (entry.tooLarge) return { outcome: 'NOT_FOUND', entry: described, nodes: [], truncated: false, suggestions: [], reason: { code: 'TABLE_NETWORK_RESPONSE_TOO_LARGE', message: '这个接口响应太大，没有保留正文' } }
    if (!entry.json || entry.body === undefined) return { outcome: 'NOT_FOUND', entry: described, nodes: [], truncated: false, suggestions: [], reason: { code: 'TABLE_NETWORK_NOT_JSON', message: '这个接口返回的不是 JSON' } }
    const root = JSON.parse(entry.body) as unknown
    const outline = outlineJson(root)
    return { outcome: 'FOUND', entry: described, nodes: outline.nodes, truncated: outline.truncated, suggestions: suggestJsonTables(root) }
  }

  if (op.subOp !== 'read') return { outcome: 'NOT_FOUND', reason: { code: 'OBSERVE_OP_UNSUPPORTED', message: '不支持的接口操作' } }
  if (!capture) return { outcome: 'NOT_FOUND', reason: gone }
  const meta = { runId: input.runId, pageRef: input.pageRef }
  const read = op.entryId
    ? (() => {
        const entry = capture.get(op.entryId)
        return entry ? readCapturedTable(entry, op.plan, meta) : { ok: false as const, code: 'TABLE_NETWORK_ENTRY_GONE', message: '这个响应已不在捕获列表里，请刷新列表' }
      })()
    : await readNetworkTable(capture, page, { ...op.plan, window: { ...op.plan.window, waitMs: Math.min(op.plan.window.waitMs, AUTHORING_READ_WAIT_MS) } }, meta)
  const entry = read.entry ? (({ score: _s, ...rest }) => rest)(describeCapturedEntry(read.entry)) : undefined
  if (!read.ok) return { outcome: 'NOT_FOUND', ...(entry ? { entry } : {}), reason: { code: read.code, message: read.message } }
  return { outcome: 'FOUND', ...(entry ? { entry } : {}), sample: read.sample }
}
