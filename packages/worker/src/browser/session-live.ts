import type { AuthControlInputReceipt, ObserveGrant, RunSnapshot, SessionErrorCode, SessionGrant } from '@cairn/shared'
import type { BrowserHandle, openRunPage } from './runtime.js'
import type { ManagedPageEntry } from './page-identity.js'
import type { ScreencastHandle } from './screencast.js'
import type { BrowserSessionManager } from './session-manager.js'

export type BrowserSessionManagerOptions = {
  workerId: string
  profileRoot: string
  headless: boolean
  maxSessions: number
  executablePath?: string
  defaultLeaseTtlSeconds: number
  /** 仅兼容旧测试夹具；缺字段的历史快照回落代码默认，不读当前进程 env。 */
  defaultAuthWaitSeconds: number
  heartbeatMs: number
  workerInstanceId?: string
  poolMaxContextsPerHost?: number
  poolHostMaxAgeSeconds?: number
  poolHostRssHighWatermarkMb?: number
  poolTargetSpread?: 'strict' | 'prefer'
  poolMaxSharedHosts?: number
  browserMemoryBudgetMb?: number
}

export type SessionAcquireResult =
  | { ok: true; grant: SessionGrant }
  | { ok: false; code: SessionErrorCode; message: string; waitingForAuth?: boolean }

export { SessionLeaseError } from './session-error.js'

export type LiveHandle = {
  handle: BrowserHandle
  sessionId: string
  generation: number
  hostId?: string | null
  runPageIds: Set<string>
  runPages: Map<string, Awaited<ReturnType<typeof openRunPage>>>
  lastPage?: Awaited<ReturnType<typeof openRunPage>>
  pages: Map<string, ManagedPageEntry>
  currentPageIdByLease: Map<string, string>
  currentPageIdByRun: Map<string, string>
  autoInputClosed: boolean
  inputAccepting: boolean
  serial: Promise<void>
  receipts: Map<string, AuthControlInputReceipt>
  lastSeq: number
  controlEpoch: number
  screencasts: Map<string, ScreencastHandle>
  screencastObservers: Map<string, number>
  /** 页登记表与当前页的变更序号，随画面帧下发，Web 据此重取页列表。 */
  pagesRevision: number
  pageDiscovery?: { dispose: () => void }
  authObserver?: { dispose: () => void }
  /** 编写期“选择接口”对话框打开后临时捕获本会话的接口响应；空闲自动停止。 */
  networkCapture?: import('./network-capture.js').NetworkCapture
}

export type RunAuthState = {
  snapshot?: RunSnapshot
  observer?: { inspect: () => Promise<void> }
  pendingSignal?: boolean
  transient?: boolean
}

export type ObserveGrantEntry = { grant: ObserveGrant; expiresAt: number }

/** 进程内唯一状态源就是经理类本身，禁止复制 Map。 */
export type SessionManagerContext = BrowserSessionManager

export function emptyLive(
  handle: BrowserHandle,
  sessionId: string,
  generation = 1,
  hostId: string | null = handle.hostId,
): LiveHandle {
  return {
    handle,
    sessionId,
    generation,
    hostId: hostId ?? handle.hostId ?? null,
    runPageIds: new Set(),
    runPages: new Map(),
    pages: new Map(),
    currentPageIdByLease: new Map(),
    currentPageIdByRun: new Map(),
    autoInputClosed: false,
    inputAccepting: false,
    serial: Promise.resolve(),
    receipts: new Map(),
    lastSeq: 0,
    controlEpoch: 0,
    screencasts: new Map(),
    screencastObservers: new Map(),
    pagesRevision: 0,
  }
}
