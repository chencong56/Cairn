import type { Page } from 'playwright'
import { appendRunEvents } from '@cairn/db'
import { redactAuthUrl } from '@cairn/shared'
import { createManagedPage } from './page-identity.js'
import { closePage, isInternalPage } from './runtime.js'
import type { LiveHandle, SessionManagerContext } from './session-live.js'

/** 每个归属（Run 或会话）最多保留的页发现登记页；超出时淘汰最早的。 */
export const MAX_DISCOVERED_PAGES_PER_OWNER = 8

/**
 * 会话级页发现：站点新开的标签页（手动操作、认证等待或执行中自发打开）登记为受管 popup 页。
 * Worker 自建页经 openInternalPage 排除；执行页只由步骤 handoff 改变，这里不动 Run 的当前页。
 */
export function attachPageDiscovery(manager: SessionManagerContext, live: LiveHandle): void {
  if (live.pageDiscovery) return
  const context = live.handle.context
  if (typeof context?.on !== 'function') return
  const onPage = (page: Page) => {
    void discoverPage(manager, live, page).catch((error: unknown) => {
      manager.logger.warn(
        { sessionId: live.sessionId, message: error instanceof Error ? error.message : String(error) },
        'session.page_discovery_failed',
      )
    })
  }
  context.on('page', onPage)
  live.pageDiscovery = { dispose: () => context.off('page', onPage) }
}

/** 有活跃租约时归属该租约的 Run／维护作业；否则归属会话本身（编排会话手动操作）。 */
function discoveryOwner(manager: SessionManagerContext, live: LiveHandle): { ownerId: string; runLeaseId?: string; leased: boolean } {
  let owner: { ownerId: string; runLeaseId?: string; leased: boolean } = { ownerId: live.sessionId, leased: false }
  for (const [leaseId, sessionId] of manager.leaseToSession) {
    if (sessionId !== live.sessionId) continue
    const ownerId = manager.leaseToRun.get(leaseId)
    if (!ownerId) continue
    const grant = manager.guard.peek(leaseId)
    owner = { ownerId, leased: true, ...((grant?.ownerKind ?? 'RUN') === 'RUN' ? { runLeaseId: leaseId } : {}) }
  }
  return owner
}

function isRegistered(live: LiveHandle, page: Page): boolean {
  return [...live.pages.values()].some((entry) => entry.page === page)
}

function stillLive(manager: SessionManagerContext, live: LiveHandle, page: Page): boolean {
  return manager.lives.get(live.sessionId) === live && !page.isClosed()
}

export async function discoverPage(manager: SessionManagerContext, live: LiveHandle, page: Page): Promise<void> {
  if (await isInternalPage(page)) return
  if (!stillLive(manager, live, page) || isRegistered(live, page)) return
  const owner = discoveryOwner(manager, live)
  const opener = await page.opener().catch(() => null)
  if (!stillLive(manager, live, page) || isRegistered(live, page)) return
  const fromPageId = opener
    ? [...live.pages.values()].find((entry) => entry.page === opener && entry.runId === owner.ownerId)?.pageId ?? null
    : null
  const entry = createManagedPage({ page, runId: owner.ownerId, kind: 'popup' })
  entry.discovered = true
  live.pages.set(entry.pageId, entry)
  // 编排会话没有执行：手动操作打开的新页即接下来要看、要指认的页。
  if (!owner.leased && live.inputAccepting) live.currentPageIdByRun.set(owner.ownerId, entry.pageId)
  live.pagesRevision += 1
  page.once('close', () => forgetDiscoveredPage(live, page))
  manager.logger.log(
    {
      sessionId: live.sessionId,
      ownerId: owner.ownerId,
      pageId: entry.pageId,
      fromPageId,
      url: redactAuthUrl(page.url()),
      becameCurrent: live.currentPageIdByRun.get(owner.ownerId) === entry.pageId,
    },
    'session.page_discovered',
  )
  if (owner.runLeaseId) {
    await appendRunEvents(manager.dbHandle, owner.ownerId, [
      { type: 'run.page_discovered', payload: { fromPageId, toPageId: entry.pageId, reason: 'popup' } },
    ]).catch(() => undefined)
  }
  await enforceDiscoveredLimit(live, owner.ownerId)
}

/** 站点自行关闭（SSO 中转页常见）：只撤页发现登记的条目；执行已接管的页保持现有关闭语义。 */
function forgetDiscoveredPage(live: LiveHandle, page: Page): void {
  for (const [id, entry] of [...live.pages]) {
    if (entry.page !== page || !entry.discovered) continue
    entry.dispose?.()
    live.pages.delete(id)
    live.pagesRevision += 1
  }
}

async function enforceDiscoveredLimit(live: LiveHandle, ownerId: string): Promise<void> {
  const owned = [...live.pages.values()].filter(
    (entry) => entry.runId === ownerId && entry.discovered && !entry.page.isClosed(),
  )
  let excess = owned.length - MAX_DISCOVERED_PAGES_PER_OWNER
  if (excess <= 0) return
  const currentId = live.currentPageIdByRun.get(ownerId)
  for (const entry of owned) {
    if (excess <= 0) break
    if (entry.pageId === currentId || (live.screencastObservers.get(entry.pageId) ?? 0) > 0) continue
    forgetDiscoveredPage(live, entry.page)
    await closePage(entry.page)
    excess -= 1
  }
}

/** 认证等待恢复后，等待期间发现的新页（登录弹窗等）不再需要。 */
export async function closeDiscoveredPages(live: LiveHandle, ownerId: string): Promise<void> {
  for (const entry of [...live.pages.values()]) {
    if (entry.runId !== ownerId || !entry.discovered) continue
    forgetDiscoveredPage(live, entry.page)
    await closePage(entry.page)
  }
}
