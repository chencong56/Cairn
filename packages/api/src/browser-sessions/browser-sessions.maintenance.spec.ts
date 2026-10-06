import { EventEmitter } from 'node:events'
import { BadRequestException } from '@nestjs/common'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as db from '@cairn/db'
import { DomainError } from '@cairn/db'
import { BrowserSessionsService } from './browser-sessions.service'
vi.mock('@cairn/db', async (load) => ({
  ...(await load<typeof import('@cairn/db')>()),
  getSessionOperation: vi.fn(),
  getRunSessionOwner: vi.fn(),
  getSessionById: vi.fn(),
  findAuthWaitLeaseForRun: vi.fn(),
  listSessionEventsAfter: vi.fn(),
  listAccountSessionOverview: vi.fn(),
  listSessionSystemOverview: vi.fn(),
  assertTargetPermission: vi.fn(),
}))
let service: BrowserSessionsService
let request: ReturnType<typeof vi.fn>
let account: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.clearAllMocks()
  request = vi.fn(async () => ({ ok: true }))
  account = vi.fn(async () => ({ id: 'actor', status: 'active', permissions: ['session:read'] }))
  service = new BrowserSessionsService(
    {} as never,
    { requestJson: request } as never,
    { decode: () => ({ exp: Date.now() / 1000 + 3600 }) } as never,
    { resolveAccount: account } as never,
  )
})
afterEach(() => vi.useRealTimers())
it('复用 Run 的完成认证保留令牌并解析真实 Run owner', async () => {
  vi.mocked(db.getSessionOperation).mockResolvedValue({
    id: 'op',
    kindParams: { reusedRunId: 'run' },
  } as never)
  vi.mocked(db.getRunSessionOwner).mockResolvedValue({ status: 'WAITING_FOR_AUTH', sessionId: null } as never)
  vi.mocked(db.findAuthWaitLeaseForRun).mockResolvedValue({ sessionId: 's' } as never)
  vi.mocked(db.getSessionById).mockResolvedValue({ id: 's', generation: 3, ownerWorkerId: 'w' } as never)
  ;(service as any).withWorker = async (session: unknown, status: string, ownerId: string) => ({
    session,
    status,
    ownerId,
    worker: { instanceId: 'i' },
    endpoint: 'http://worker',
  })
  await service.completeAuth('op', { id: 'actor', permissions: ['run:execute'] } as never, { token: 'secret-control-token' })
  expect(request).toHaveBeenCalledWith(
    expect.objectContaining({
      runId: 'run',
      body: JSON.stringify({ token: 'secret-control-token' }),
      path: '/internal/managed-browser/resume-auth',
    }),
  )
})
it('总览 SSE 按账号保存补读水位，撤权立即结束连接', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  class Response extends EventEmitter {
    writableEnded = false
    write = vi.fn()
    status() {
      return this
    }
    setHeader() {}
    flushHeaders() {}
    end() {
      this.writableEnded = true
      this.emit('close')
    }
  }
  const response = new Response()
  // Do not re-emit close recursively in the mock.
  response.end = () => {
    response.writableEnded = true
  }
  vi.mocked(db.listSessionEventsAfter).mockResolvedValueOnce([
    { targetAccountId: 'a', seq: 50 },
    { targetAccountId: 'b', seq: 1 },
  ] as never)
  await service.streamObserve({
    query: {},
    account: { id: 'actor' } as never,
    authorization: 'Bearer test',
    response: response as never,
    signal: controller.signal,
  })
  const records = response.write.mock.calls
    .map((call) => String(call[0]))
    .filter((text) => text.startsWith('id: '))
  const cursor = records[1]!.split('\n')[0]!.slice(4)
  expect(JSON.parse(Buffer.from(cursor, 'base64url').toString())).toEqual({ a: 50, b: 1 })
  account.mockResolvedValueOnce({ id: 'actor', status: 'active', permissions: [] })
  await vi.advanceTimersByTimeAsync(1000)
  expect(response.writableEnded).toBe(true)
  expect(db.listSessionEventsAfter).toHaveBeenCalledTimes(1)
  controller.abort()
})

it('overview 把 db 层的 bad_request DomainError 转成 400，不让它变成裸的 500', async () => {
  vi.mocked(db.listAccountSessionOverview).mockRejectedValueOnce(
    new DomainError('bad_request', 'INVALID_FILTER_COMBINATION', '筛选条件与所选状态分类不匹配'),
  )
  await expect(service.overview({ bucket: 'ready', filter: 'needs_login' } as never)).rejects.toBeInstanceOf(
    BadRequestException,
  )
})

it('systemOverview 同样把 db 层的 DomainError 转成对应的 HTTP 异常', async () => {
  vi.mocked(db.listSessionSystemOverview).mockRejectedValueOnce(
    new DomainError('bad_request', 'SOME_CODE', '参数不合法'),
  )
  await expect(service.systemOverview({} as never)).rejects.toBeInstanceOf(BadRequestException)
})

it('overview 正常路径不受 try/catch 包裹影响，原样返回 db 层结果', async () => {
  const payload = { items: [], nextCursor: null, summary: {}, asOf: '2026-09-27T00:00:00.000Z' }
  vi.mocked(db.listAccountSessionOverview).mockResolvedValueOnce(payload as never)
  await expect(service.overview({} as never)).resolves.toBe(payload)
})

const metaPayload = {
  runId: '66666666-6666-4666-8666-666666666666',
  runStatus: 'WAITING_FOR_AUTH',
  sessionId: '77777777-7777-4777-8777-777777777777',
  sessionGeneration: 1,
  ownerWorkerId: 'w',
  framesAvailable: true,
  viewingOtherPage: false,
  currentPage: null,
  pages: [],
  authHold: null,
  authControl: null,
  capabilities: { screencast: 'open', authInput: 'open', popupHandoff: 'open', chineseInsertText: 'open' },
  degradedReason: null,
  viewMode: 'readonly',
}

function stubOwner() {
  ;(service as any).resolveOwner = async () => ({
    ownerId: 'op',
    status: 'WAITING_FOR_AUTH',
    session: { id: 's', targetId: 't', generation: 1, ownerWorkerId: 'w' },
    worker: { instanceId: 'i' },
    endpoint: 'http://worker',
  })
  request.mockResolvedValue(metaPayload)
}

it('认证等待只读观看：有 session:control 且在目标范围内才向 Worker 声明 control=1', async () => {
  stubOwner()
  vi.mocked(db.assertTargetPermission).mockResolvedValue(undefined as never)
  await service.browserMeta('op', { id: 'actor', permissions: ['session:read', 'session:view', 'session:control'] } as never)
  expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ query: { pageId: undefined, control: '1' } }))
  expect(db.assertTargetPermission).toHaveBeenCalledWith(expect.anything(), 'actor', 't', 'session:control')
})

it('认证等待只读观看：缺 session:control 或目标范围不含时不声明 control', async () => {
  stubOwner()
  await service.browserMeta('op', { id: 'actor', permissions: ['session:read', 'session:view'] } as never)
  expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ query: { pageId: undefined, control: undefined } }))
  vi.mocked(db.assertTargetPermission).mockRejectedValue(new DomainError('forbidden', 'FORBIDDEN', '无权'))
  await service.browserMeta('op', { id: 'actor', permissions: ['session:control'] } as never)
  expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ query: { pageId: undefined, control: undefined } }))
})
