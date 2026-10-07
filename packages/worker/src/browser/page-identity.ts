import { randomUUID } from 'node:crypto'
import type { Dialog, Frame, Page, Request } from 'playwright'
import type { PageRef } from '@cairn/shared'

export type ManagedPageKind = 'base' | 'run' | 'popup'

export type ManagedPageEntry = {
  pageId: string
  documentEpoch: number
  page: Page
  runId: string
  kind: ManagedPageKind
  /** 由会话级页发现登记、尚未被执行显式接管的新标签页；可被上限淘汰与 Run 结束清理。 */
  discovered?: boolean
  lastNavigationMethod?: string
  retarget?: Promise<void>
  onNavigate?: () => void
  dispose?: () => void
}

export function createManagedPage(input: {
  page: Page
  runId: string
  kind: ManagedPageKind
  lastNavigationMethod?: string
  onNavigate?: () => void
  dispose?: () => void
}): ManagedPageEntry {
  const entry: ManagedPageEntry = {
    pageId: randomUUID(),
    documentEpoch: 0,
    page: input.page,
    runId: input.runId,
    kind: input.kind,
    onNavigate: input.onNavigate,
  }
  if (typeof input.page.on === 'function') {
    const onRequest = (request: Request) => {
      if (request.isNavigationRequest() && request.frame() === input.page.mainFrame()) {
        let source: Request | null = request
        let method = 'GET'
        while (source) { if (source.method() !== 'GET') method = source.method(); source = source.redirectedFrom() }
        entry.lastNavigationMethod = method
      }
    }
    const onNavigation = (frame: Frame) => {
      if (typeof input.page.mainFrame === 'function' && frame === input.page.mainFrame()) {
        entry.documentEpoch += 1
        entry.onNavigate?.()
      }
    }
    const onDialog = (dialog: Dialog) => {
      dialog.accept().catch(() => {})
    }
    input.page.on('request', onRequest)
    input.page.on('framenavigated', onNavigation)
    input.page.on('dialog', onDialog)
    entry.dispose = () => {
      input.page.off?.('request', onRequest)
      input.page.off?.('framenavigated', onNavigation)
      input.page.off?.('dialog', onDialog)
    }
  }
  return entry
}

export function pageRefFor(
  sessionId: string,
  sessionGeneration: number,
  entry: ManagedPageEntry,
): PageRef {
  return {
    sessionId,
    sessionGeneration,
    pageId: entry.pageId,
    documentEpoch: entry.documentEpoch,
  }
}

export function pickPopupHandoff(
  candidates: Array<{ page: Page; url: string }>,
):
  | { ok: true; page: Page }
  | { ok: false; code: 'PAGE_HANDOFF_NO_POPUP' | 'PAGE_HANDOFF_AMBIGUOUS' | 'PAGE_HANDOFF_CLOSED' } {
  const open = candidates.filter((item) => !item.page.isClosed())
  if (open.length === 0) return { ok: false, code: 'PAGE_HANDOFF_NO_POPUP' }
  if (open.length > 1) return { ok: false, code: 'PAGE_HANDOFF_AMBIGUOUS' }
  const chosen = open[0]!
  if (chosen.page.isClosed()) return { ok: false, code: 'PAGE_HANDOFF_CLOSED' }
  return { ok: true, page: chosen.page }
}
