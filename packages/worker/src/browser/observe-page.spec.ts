import { describe, expect, it, vi } from 'vitest'

vi.mock('@cairn/db', async (original) => ({
  ...(await original<typeof import('@cairn/db')>()),
  loadRunDetail: vi.fn(async () => null),
  appendRunEvents: vi.fn(async () => undefined),
}))

import { BrowserSessionManager } from './session-manager.js'

const sessionId = '00000000-0000-4000-8000-000000000021'
const actorId = '00000000-0000-4000-8000-000000000022'
const basePageId = '00000000-0000-4000-8000-000000000023'
const popupPageId = '00000000-0000-4000-8000-000000000024'
const foreignPageId = '00000000-0000-4000-8000-000000000025'

function fakePage(url: string) {
  return { isClosed: () => false, url: () => url, title: async () => url }
}

/** 编排会话：底页是当前页，另有一张手动打开的新页和一张别的归属的页。 */
function authoringManager() {
  const live = {
    sessionId,
    pages: new Map([
      [basePageId, { pageId: basePageId, runId: sessionId, documentEpoch: 1, page: fakePage('https://portal.example/index'), kind: 'base' }],
      [popupPageId, { pageId: popupPageId, runId: sessionId, documentEpoch: 3, page: fakePage('https://sub.example/app'), kind: 'popup', discovered: true }],
      [foreignPageId, { pageId: foreignPageId, runId: 'other-run', documentEpoch: 1, page: fakePage('https://sub.example/x'), kind: 'popup' }],
    ]),
    currentPageIdByRun: new Map([[sessionId, basePageId]]),
    currentPageIdByLease: new Map(),
    runPages: new Map(),
    handle: { basePage: fakePage('https://portal.example/index') },
  }
  const manager = Object.create(BrowserSessionManager.prototype) as BrowserSessionManager
  Object.assign(manager, {
    dbHandle: {},
    observeGrants: new Map(),
    requireLiveAuthSession: async () => ({
      session: { id: sessionId, generation: 1, status: 'OPEN' },
      live,
      run: { id: sessionId, status: 'RUNNING' },
    }),
  })
  return manager
}

describe('指认作用于所看的页', () => {
  it('不带 pageId 时作用于当前页（保持原行为）', async () => {
    const manager = authoringManager()
    const observed = await manager.observeRun({ runId: sessionId, actorId, op: { op: 'highlight' } })
    expect('page' in observed && observed.page?.pageRef?.pageId).toBe(basePageId)
  })

  it('带 pageId 时作用于该页，观察授权也绑定该页', async () => {
    const manager = authoringManager()
    const observed = await manager.observeRun({ runId: sessionId, actorId, op: { op: 'highlight', pageId: popupPageId } })
    expect('page' in observed && observed.page?.pageRef).toMatchObject({ pageId: popupPageId, documentEpoch: 3 })
  })

  it('pageId 指向别的归属的页时拒绝，不回落到当前页', async () => {
    const manager = authoringManager()
    await expect(
      manager.observeRun({ runId: sessionId, actorId, op: { op: 'highlight', pageId: foreignPageId } }),
    ).rejects.toMatchObject({ code: 'PAGE_STALE' })
  })
})
