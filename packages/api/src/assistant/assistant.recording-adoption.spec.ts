import { beforeEach, describe, expect, it, vi } from 'vitest'
import { packAssistantResultEnvelope, unpackAssistantResultEnvelope, type AssistantRecordingProposalResult } from '@cairn/shared'
import * as db from '@cairn/db'
import { AssistantService } from './assistant.service'
import { AssistantController } from './assistant.controller'
import type { RequestAccount } from '../common/request-account'
vi.mock('@cairn/db', async (original) => ({ ...await original<typeof import('@cairn/db')>(), getAssistantTurnRecord: vi.fn(), getAssistantRecordingProposalFacts: vi.fn(), createCompletedAssistantTurn: vi.fn(), previewAssistantRecordingAdoption: vi.fn(), adoptAssistantRecordingProposal: vi.fn(), assertTargetPermission: vi.fn(), authorizeTargetRequest: vi.fn() }))
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const conversationId = id(1), turnId = id(2)
const actor: RequestAccount = { id: id(3), displayName: 'Author', email: 'test@example.test', status: 'active', roles: [], permissions: ['ai:assist', 'workflow:write', 'target:read'] }
const proposal: AssistantRecordingProposalResult = { kind: 'recording_proposal', proposalId: id(4), proposalFamilyId: id(4), protocolVersion: 'script@1', recordingId: id(5), targetId: id(6), recordingDigest: 'source', adapterVersion: 'adapter', proposalSummary: '2 steps', candidateDigest: 'proposal-digest', decisions: [{ itemId: 'one', action: 'keep', reason: 'ready' }, { itemId: 'two', action: 'keep', reason: 'ready' }, { itemId: 'excluded', action: 'exclude', reason: 'excluded' }], excludedItemIds: ['excluded'], diagnostics: [], missingConfirmations: [], applicable: true, sourceManifest: { version: '1.0', asOf: new Date().toISOString(), scope: {}, sources: [], digest: 'manifest' } }
const service = () => new AssistantService({} as never, {} as never, { getTarget: vi.fn(async () => ({ id: id(6) })) } as never, {} as never, {} as never)
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(db.previewAssistantRecordingAdoption).mockResolvedValue({} as never)
  vi.mocked(db.adoptAssistantRecordingProposal).mockResolvedValue({} as never)
  vi.mocked(db.authorizeTargetRequest).mockResolvedValue(undefined as never)
  vi.mocked(db.getAssistantTurnRecord).mockResolvedValue({ turn: { id: turnId, conversationId, result: packAssistantResultEnvelope(proposal) } } as never)
  vi.mocked(db.getAssistantRecordingProposalFacts).mockResolvedValue({ recordingDigest: 'source' } as never)
  vi.mocked(db.createCompletedAssistantTurn).mockResolvedValue({ id: id(7) } as never)
})
describe('recording service boundaries', () => {
  it('presents validation failures as actionable client errors, not HTTP 500', async () => {
    const controller = new AssistantController({ confirmRecordingOutcome: vi.fn(async () => { throw new db.DomainError('bad_request', 'RECORDING_OUTCOME_VAGUE', '请填写具体的页面预期') }) } as never)
    await expect(controller.confirmRecordingOutcome(conversationId, turnId, { proposalDigest: 'proposal-digest', outcome: { kind: 'custom', afterItemId: 'one', expectedOutcome: '操作成功' } }, actor)).rejects.toMatchObject({ status: 400, response: { message: '请填写具体的页面预期' } })
  })
  it('persists a selected child turn without changing proposal family', async () => {
    const result = await service().createRecordingSelection(actor, conversationId, turnId, { proposalDigest: 'proposal-digest', selectedItemIds: ['two'] })
    expect(result.turnId).toBe(id(7)); expect(result.proposalFamilyId).toBe(proposal.proposalFamilyId)
    const call = vi.mocked(db.createCompletedAssistantTurn).mock.calls[0]![1]
    const child = unpackAssistantResultEnvelope(call.result)
    expect(child).toMatchObject({ kind: 'recording_proposal', decisions: [{ itemId: 'two' }], proposalFamilyId: proposal.proposalFamilyId, recordingDigest: 'source' })
  })
  it.each([['unknown'], ['excluded'], ['one', 'one'], []])('rejects invalid selection %j', async (...args) => {
    const selectedItemIds = args as string[]
    await expect(service().createRecordingSelection(actor, conversationId, turnId, { proposalDigest: 'proposal-digest', selectedItemIds })).rejects.toThrow()
    expect(db.createCompletedAssistantTurn).not.toHaveBeenCalled()
  })
  it('rejects the old proposal-id digest bypass and source revisions that changed', async () => {
    await expect(service().createRecordingSelection(actor, conversationId, turnId, { proposalDigest: proposal.proposalId, selectedItemIds: ['one'] })).rejects.toThrow()
    vi.mocked(db.getAssistantRecordingProposalFacts).mockResolvedValue({ recordingDigest: 'changed' } as never)
    await expect(service().createRecordingSelection(actor, conversationId, turnId, { proposalDigest: 'proposal-digest', selectedItemIds: ['one'] })).rejects.toThrow()
  })
  it('previews exactly the stored selection and validates the insertion anchor', async () => {
    const anchor = { kind: 'after', stepId: id(8) }
    await service().getRecordingPreview(actor, conversationId, turnId, { destinationScenarioId: id(9), insertAnchor: JSON.stringify(anchor) })
    expect(db.previewAssistantRecordingAdoption).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ recordingId: proposal.recordingId, recordingDigest: 'source', selectedItemIds: ['one', 'two'], insertAnchor: anchor }), actor.id)
    await expect(service().getRecordingPreview(actor, conversationId, turnId, { insertAnchor: '{broken' })).rejects.toThrow()
  })
  it('passes immutable source, selection and draft preconditions to the domain transaction', async () => {
    await service().adoptRecordingProposal(actor, conversationId, turnId, { proposalDigest: 'proposal-digest', candidateDigest: 'preview-digest', idempotencyKey: 'request-123', destinationScenarioId: id(9), expectedRevision: 2, expectedDigest: 'baseline', insertAnchor: { kind: 'start' } })
    expect(db.adoptAssistantRecordingProposal).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ recordingDigest: 'source', selectedItemIds: ['one', 'two'], candidateDigest: 'preview-digest', expectedRevision: 2, expectedDigest: 'baseline', insertAnchor: { kind: 'start' } }), { id: actor.id })
  })
  it('rejects another conversation and missing permissions before adoption', async () => {
    const body = { proposalDigest: 'proposal-digest', candidateDigest: 'preview', idempotencyKey: 'request-123' }
    await expect(service().adoptRecordingProposal(actor, id(99), turnId, body)).rejects.toThrow()
    await expect(service().adoptRecordingProposal({ ...actor, permissions: ['ai:assist'] }, conversationId, turnId, body)).rejects.toThrow()
    expect(db.adoptAssistantRecordingProposal).not.toHaveBeenCalled()
  })
  it('requires a separate human confirmation turn before an outcome can be selected or adopted', async () => {
    const pending = { ...proposal, intent: 'outcome' as const, needsOutcomeConfirmation: true, applicable: false, outcomeOptions: [] }
    vi.mocked(db.getAssistantTurnRecord).mockResolvedValue({ turn: { id: turnId, conversationId, result: packAssistantResultEnvelope(pending) } } as never)
    vi.mocked(db.getAssistantRecordingProposalFacts).mockResolvedValue({ recordingDigest: 'source', decisions: proposal.decisions, outcomeOptions: [] } as never)
    await expect(service().createRecordingSelection(actor, conversationId, turnId, { proposalDigest: 'proposal-digest', selectedItemIds: ['one'] })).rejects.toThrow('确认')
    await expect(service().adoptRecordingProposal(actor, conversationId, turnId, { proposalDigest: 'proposal-digest', candidateDigest: 'preview', idempotencyKey: 'request-123' })).rejects.toThrow('确认')
    const confirmed = await service().confirmRecordingOutcome(actor, conversationId, turnId, { proposalDigest: 'proposal-digest', outcome: { kind: 'custom', afterItemId: 'two', expectedOutcome: '页面显示查询结果列表' } })
    expect(confirmed.proposal).toMatchObject({ needsOutcomeConfirmation: false, applicable: true, proposalFamilyId: proposal.proposalFamilyId })
    expect(confirmed.proposal.decisions.at(-1)).toMatchObject({ action: 'modify', change: { sourceItemId: 'two', confirmedBy: actor.id, rule: { kind: 'ai', instruction: '页面显示查询结果列表' } } })
    expect(db.adoptAssistantRecordingProposal).not.toHaveBeenCalled()
    expect(db.createCompletedAssistantTurn).toHaveBeenCalledOnce()
    await expect(service().confirmRecordingOutcome(actor, conversationId, turnId, { proposalDigest: 'proposal-digest', outcome: { kind: 'custom', afterItemId: 'two', expectedOutcome: '操作成功' } })).rejects.toThrow('具体结果')
    await expect(service().confirmRecordingOutcome(actor, conversationId, turnId, { proposalDigest: 'proposal-digest', outcome: { kind: 'custom', afterItemId: 'excluded', expectedOutcome: '页面显示查询结果' } })).rejects.toThrow('前序')
  })
  it('keeps modification dependencies in the immutable child and rejects an orphaned change', async () => {
    const change = { itemId: 'change', action: 'modify' as const, reason: '确认', change: { kind: 'outcome' as const, sourceItemId: 'two', meaning: '页面显示结果', rule: { kind: 'ai' as const, instruction: '页面显示结果' }, confirmedBy: actor.id } }
    vi.mocked(db.getAssistantTurnRecord).mockResolvedValue({ turn: { id: turnId, conversationId, result: packAssistantResultEnvelope({ ...proposal, decisions: [...proposal.decisions, change] }) } } as never)
    await expect(service().createRecordingSelection(actor, conversationId, turnId, { proposalDigest: 'proposal-digest', selectedItemIds: ['one', 'change'] })).rejects.toThrow('对应的录制动作')
    await service().createRecordingSelection(actor, conversationId, turnId, { proposalDigest: 'proposal-digest', selectedItemIds: ['two', 'change'] })
    const child = unpackAssistantResultEnvelope(vi.mocked(db.createCompletedAssistantTurn).mock.calls[0]![1].result)
    expect(child).toMatchObject({ decisions: [{ itemId: 'two' }, change] })
  })
  it('preserves a short recorded success label when its actual assertion is concrete', async () => {
    const option = { itemId: 'assertion', afterItemId: 'two', meaning: '成功', rule: { kind: 'deterministic' as const, expect: { kind: 'text_equals' as const, value: '成功' }, target: { framePath: [], candidates: [{ by: 'role' as const, value: 'status' }] } } }
    const pending = { ...proposal, intent: 'outcome' as const, needsOutcomeConfirmation: true, applicable: false, outcomeOptions: [option] }
    vi.mocked(db.getAssistantTurnRecord).mockResolvedValue({ turn: { id: turnId, conversationId, result: packAssistantResultEnvelope(pending) } } as never)
    vi.mocked(db.getAssistantRecordingProposalFacts).mockResolvedValue({ recordingDigest: 'source', decisions: proposal.decisions, outcomeOptions: [option] } as never)
    await service().confirmRecordingOutcome(actor, conversationId, turnId, { proposalDigest: 'proposal-digest', outcome: { kind: 'recorded', itemId: option.itemId } })
    const stored = unpackAssistantResultEnvelope(vi.mocked(db.createCompletedAssistantTurn).mock.calls[0]![1].result)
    expect(stored).toMatchObject({ decisions: expect.arrayContaining([expect.objectContaining({ change: expect.objectContaining({ meaning: '成功', rule: option.rule, recordedItemId: option.itemId }) })]) })
  })
})
