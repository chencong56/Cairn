import { describe, expect, it } from 'vitest'
import {
  accessPathMatches,
  accessPathMatchesExact,
  canonicalOrigin,
  isPublishedAccessPathPrefix,
  parseHttpUrl,
} from '../access-scope.js'

describe('路径与 origin 工具函数', () => {
  it('accessPathMatches 按路径段边界匹配', () => {
    expect(accessPathMatches('/orders', '/orders')).toBe(true)
    expect(accessPathMatches('/orders/1', '/orders')).toBe(true)
    expect(accessPathMatches('/orders-admin', '/orders')).toBe(false)
    expect(accessPathMatches('/anything', '/')).toBe(true)
    expect(accessPathMatches('/orders/1', '/orders/')).toBe(true)
  })

  it('accessPathMatchesExact 只匹配精确路径（容忍尾斜杠）', () => {
    expect(accessPathMatchesExact('/api/list', '/api/list')).toBe(true)
    expect(accessPathMatchesExact('/api/list/', '/api/list')).toBe(true)
    expect(accessPathMatchesExact('/api/list/1', '/api/list')).toBe(false)
    expect(accessPathMatchesExact('/', '/')).toBe(true)
    expect(accessPathMatchesExact('', '/')).toBe(true)
    expect(accessPathMatchesExact('/x', '/')).toBe(false)
  })

  it('isPublishedAccessPathPrefix 要求 / 开头且不含 query/hash', () => {
    expect(isPublishedAccessPathPrefix('/orders')).toBe(true)
    expect(isPublishedAccessPathPrefix('orders')).toBe(false)
    expect(isPublishedAccessPathPrefix('/orders?x=1')).toBe(false)
    expect(isPublishedAccessPathPrefix('/orders#a')).toBe(false)
    expect(isPublishedAccessPathPrefix(`/${'a'.repeat(512)}`)).toBe(false)
  })

  it('parseHttpUrl / canonicalOrigin 拒绝凭据 URL 与非 http(s)', () => {
    expect(parseHttpUrl('https://shop.example/a')?.pathname).toBe('/a')
    expect(parseHttpUrl('https://user:pass@shop.example/a')).toBeNull()
    expect(parseHttpUrl('ftp://shop.example/a')).toBeNull()
    expect(parseHttpUrl('not-a-url')).toBeNull()
    expect(canonicalOrigin('https://shop.example/orders?x=1')).toBe('https://shop.example')
    expect(canonicalOrigin('https://shop.example:443/')).toBe('https://shop.example')
    expect(canonicalOrigin('ftp://shop.example')).toBeNull()
  })
})
