import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright'
import { detectTable, type DetectDeps } from './table-read-v2.js'

describe('table.read@2 识别时限', () => {
  it('页面一直不响应时，到时限就放弃并给出人话说明，不拖到网关超时', async () => {
    const never = new Promise(() => undefined)
    const page = { mainFrame: () => ({ evaluateHandle: () => never }) } as unknown as Page
    const deps = { locate: (() => never) as never, pick: (() => never) as never } as DetectDeps
    const started = Date.now()
    const result = await detectTable(page, { kind: 'point', x: 10, y: 10 }, deps, undefined, 150)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(result.outcome).toBe('NOT_FOUND')
    if (result.outcome !== 'NOT_FOUND') return
    expect(result.reason.code).toBe('TABLE_DETECT_TIMEOUT')
    expect(result.reason.message).toContain('已放弃')
  })
})
