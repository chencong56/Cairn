import { afterEach, describe, expect, it } from 'vitest'
import {
  authoringDocumentDigest,
  scenarioDocumentDigest,
  toAuthoringDocumentV2,
  canonicalJson,
  sha256Hex,
  syncSha256,
  type ScenarioDocument,
  type Step,
} from '../index.js'

/**
 * 私有化交付的控制台跑在局域网明文 HTTP（非安全上下文）时，`crypto.subtle`
 * 是 undefined。助手采纳校验与草稿一致性比对都依赖 sha256Hex，若直接调用
 * subtle.digest 会抛 TypeError，前端表现为「点击采纳后毫无反应」。
 * 这里模拟无 subtle 的环境，断言兜底路径可用且输出与 SubtleCrypto 一致。
 */

const originalCrypto = globalThis.crypto

function stubInsecureContext(): void {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: { getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto) },
  })
}

function restoreCrypto(): void {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: originalCrypto })
}

afterEach(() => {
  restoreCrypto()
})

const fillStep: Step = {
  id: '11111111-1111-4111-8111-111111111111',
  name: '填写金额',
  type: 'fill',
  effectType: 'SIDE_EFFECT',
  input: { target: { framePath: [], candidates: [{ by: 'css', value: '#amount' }] }, value: '12.00' },
}

describe('SHA-256 摘要非安全上下文兜底', () => {
  it('sha256Hex 与纯 TS 同步实现输出一致', async () => {
    const samples = ['', '{}', '{"a":1}', '中文内容🔒', canonicalJson({ nested: { list: [1, 2, 3] } })]
    for (const raw of samples) {
      await expect(sha256Hex(raw)).resolves.toBe(syncSha256(raw))
    }
  })

  it('crypto.subtle 不可用时 sha256Hex 走同步兜底且结果不变', async () => {
    const raw = canonicalJson({ scenario: '测试场景1', steps: [{ id: 's1', kind: 'navigate' }] })
    const expected = await sha256Hex(raw)
    stubInsecureContext()
    await expect(sha256Hex(raw)).resolves.toBe(expected)
  })

  it('非安全上下文下 authoringDocumentDigest 可用且与安全上下文一致', async () => {
    const document = toAuthoringDocumentV2({ schemaVersion: 1, inputs: [], steps: [fillStep] })
    const expected = await authoringDocumentDigest(document)
    stubInsecureContext()
    await expect(authoringDocumentDigest(document)).resolves.toBe(expected)
  })

  it('非安全上下文下 scenarioDocumentDigest 可用且与安全上下文一致', async () => {
    const document: ScenarioDocument = { schemaVersion: 1, inputs: [], steps: [fillStep] }
    const expected = await scenarioDocumentDigest(document)
    stubInsecureContext()
    await expect(scenarioDocumentDigest(document)).resolves.toBe(expected)
  })
})
