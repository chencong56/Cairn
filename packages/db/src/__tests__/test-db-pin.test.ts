import { describe, expect, it } from 'vitest'
import { applyTestDbPin } from '../testing.js'

describe('applyTestDbPin', () => {
  it('非 CI 把 host 钉到本机测试库，不沿用远端 CAIRN_DB_HOST', () => {
    const env: NodeJS.ProcessEnv = {
      CAIRN_DB_HOST: '100.64.0.4',
      CAIRN_DB_PORT: '5432',
      CAIRN_TEST_DB_HOST: '127.0.0.1',
      CAIRN_TEST_DB_PORT: '5442',
    }
    applyTestDbPin(env, { ci: false })
    expect(env.CAIRN_DB_HOST).toBe('127.0.0.1')
    expect(env.CAIRN_DB_PORT).toBe('5442')
    expect(env.CAIRN_TEST_DB_PINNED).toBe('1')
  })

  it('测试库与开发库同一地址则拒绝', () => {
    expect(() =>
      applyTestDbPin(
        {
          CAIRN_DB_HOST: '127.0.0.1',
          CAIRN_DB_PORT: '5442',
          CAIRN_TEST_DB_PORT: '5442',
        },
        { ci: false },
      ),
    ).toThrow(/写进开发库/)
  })
})
