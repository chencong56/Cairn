import { afterEach, describe, expect, it, vi } from 'vitest'
import { newUuid } from './uuid'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('newUuid', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('安全上下文使用原生 randomUUID', () => {
    expect(newUuid()).toMatch(UUID_V4)
  })

  it('明文 HTTP（randomUUID 缺失）时回退到 getRandomValues，仍产出合法 v4 UUID', () => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) })
    const ids = new Set(Array.from({ length: 200 }, () => newUuid()))
    expect(ids.size).toBe(200)
    for (const id of ids) expect(id).toMatch(UUID_V4)
  })
})
