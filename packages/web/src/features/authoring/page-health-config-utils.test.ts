import { describe, expect, it } from 'vitest'
import { formatSlowRules, parseSlowRules } from './page-health-config-utils'

describe('耗时阈值文本', () => {
  it('解析方法、地址与阈值，忽略写错的行，并能原样写回', () => {
    const rules = parseSlowRules('POST /api/v1/checkout 800\n/api/list 1500\nbad line\nGET /x abc\n  \n')
    expect(rules).toEqual([
      { match: '/api/v1/checkout', method: 'POST', maxMs: 800 },
      { match: '/api/list', maxMs: 1500 },
    ])
    expect(parseSlowRules(formatSlowRules(rules))).toEqual(rules)
  })
})
