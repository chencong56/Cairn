import { describe, expect, it } from 'vitest'
import { createManagedPage, pickPopupHandoff } from './page-identity'

describe('popup handoff selection', () => {
  const page = { isClosed: () => false } as import('playwright').Page
  const closed = { isClosed: () => true } as import('playwright').Page

  it('拒绝零个、多个弹窗，不取最后一个猜测', () => {
    expect(pickPopupHandoff([]).ok).toBe(false)
    expect(
      pickPopupHandoff([
        { page, url: 'https://app.example/a' },
        { page, url: 'https://app.example/b' },
      ]),
    ).toMatchObject({ ok: false, code: 'PAGE_HANDOFF_AMBIGUOUS' })
    expect(pickPopupHandoff([{ page: closed, url: 'https://app.example' }])).toMatchObject({
      ok: false,
      code: 'PAGE_HANDOFF_NO_POPUP',
    })
  })

  it('唯一弹窗则收养，不论来源域', () => {
    expect(pickPopupHandoff([{ page, url: 'https://app.example/ok' }])).toEqual({ ok: true, page })
    expect(pickPopupHandoff([{ page, url: 'https://sso.other.example/cb' }])).toEqual({ ok: true, page })
  })

  it('VE06 主框导航增加 documentEpoch，子框导航不改轨道', () => {
    const listeners = new Map<string, (...args: unknown[]) => void>()
    const main = { id: 'main' }
    const child = { id: 'child' }
    const page = {
      isClosed: () => false,
      mainFrame: () => main,
      on: (event: string, fn: (...args: unknown[]) => void) => {
        listeners.set(event, fn)
      },
      off: (event: string) => {
        listeners.delete(event)
      },
    } as unknown as import('playwright').Page
    const entry = createManagedPage({
      page,
      runId: '00000000-0000-4000-8000-000000000099',
      kind: 'run',
    })
    expect(entry.documentEpoch).toBe(0)
    listeners.get('framenavigated')?.(main)
    expect(entry.documentEpoch).toBe(1)
    listeners.get('framenavigated')?.(child)
    expect(entry.documentEpoch).toBe(1)
    listeners.get('framenavigated')?.(main)
    expect(entry.documentEpoch).toBe(2)
    expect(entry.pageId).toBe(entry.pageId)
  })

  it('没有 Playwright 事件接口时仍能建立 PageRef', () => {
    const page = { isClosed: () => false } as import('playwright').Page
    const entry = createManagedPage({ page, runId: '00000000-0000-4000-8000-000000000099', kind: 'base' })
    expect(entry.documentEpoch).toBe(0)
    expect(entry.page).toBe(page)
  })
})
