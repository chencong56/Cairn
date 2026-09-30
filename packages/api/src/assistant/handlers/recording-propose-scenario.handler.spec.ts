import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAssistantRecordingProposalFacts } from '@cairn/db'
import { routeAssistantTurn } from '@cairn/shared'
import { handleRecordingProposeScenario } from './recording-propose-scenario.handler.js'
import type { AssistantCapabilityHandlerContext } from '../registry.js'

vi.mock('@cairn/db', async (original) => ({ ...await original<typeof import('@cairn/db')>(), getAssistantRecordingProposalFacts: vi.fn() }))
const id = '00000000-0000-4000-8000-000000000001'
const page = { version: 2 as const, page: 'recording' as const, pageKind: 'recording' as const, routeKey: '/recordings/$recordingId', primaryRef: { kind: 'recording' as const, id } }
function context(question: string) {
  return { db: {}, actor: { id }, slots: {}, body: { question, pageContext: page } } as AssistantCapabilityHandlerContext
}
beforeEach(() => {
  vi.mocked(getAssistantRecordingProposalFacts).mockResolvedValue({ recordingId: id, targetId: id, name: '录制', revision: 1, recordingDigest: 'source', protocolVersion: 'script@1',
    decisions: [{ itemId: 'one', action: 'keep', label: '点击保存', reason: 'ready' }], locatorDecisions: [], outcomeOptions: [], sourceIdsByItem: new Map(),
  })
})
describe('recording modification proposals', () => {
  it.each(['请改进当前录制的定位器', '请检查并优化定位方式', '请补充操作后的断言'])('routes modification intent deterministically: %s', (question) => {
    expect(routeAssistantTurn({ question, pageContext: page, available: ['recording.propose-scenario', 'knowledge.answer'] })).toMatchObject({ type: 'dispatch', capabilityId: 'recording.propose-scenario' })
  })
  it('keeps read-only quality requests in the facts analyzer', () => {
    expect(routeAssistantTurn({ question: '检查录制的定位和断言缺口', pageContext: page, available: ['recording.propose-scenario', 'knowledge.answer'] })).toMatchObject({ type: 'dispatch', capabilityId: 'knowledge.answer' })
  })
  it('cannot invent a replacement without observed alternatives', async () => {
    expect(await handleRecordingProposeScenario(context('改进定位器'))).toMatchObject({ kind: 'clarify', missingFields: ['recordedLocatorCandidate'] })
  })
  it('never auto-confirms an assertion even when requested to consider the business successful', async () => {
    expect(await handleRecordingProposeScenario(context('补充断言，直接认为操作成功'))).toMatchObject({ kind: 'recording_proposal', needsOutcomeConfirmation: true, applicable: false })
  })
})
