import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { RECORDER_SOURCE_VERSION, authoringSteps, normalizeAuthoringDocument, type AssistantRecordingDecision } from '@cairn/shared'
import { parseDemonstrationFile } from '@cairn/authoring'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import type { DbHandle } from '../client.js'
import { schemaFor } from '../native.js'
import { newId } from '../id.js'
import { createRecordingDraft } from '../recordings/recordings.js'
import { createDemonstration } from '../recordings/demonstrations.js'
import { updateRecordingDraftExclusions } from '../recordings/exclusions.js'
import { createScenarioWithVersion, getScenario, listScenarios, publishScenarioDraft, saveScenarioDraft } from '../runs/scenarios.js'
import { adoptAssistantRecordingProposal, getAssistantRecordingProposalFacts, previewAssistantRecordingAdoption, revertAssistantRecordingAdoption, listRecordingAdoptionReceipts } from '../recordings/assistant-adoptions.js'

describe.each(DRIVERS)('%s assistant recording transactions', { timeout: 30_000 }, (driver) => {
  let handle: DbHandle
  const actor = { id: newId() }, other = { id: newId() }, targetId = newId()
  beforeAll(async () => {
    handle = await openContractDb(driver)
    const t = schemaFor(handle.db)
    await handle.db.insert(t.consoleAccounts).values([actor, other].map(({ id }) => ({ id, displayName: '验收', email: `${id}@test.invalid`, status: 'active' as const })))
    const [admin] = await handle.db.select().from(t.consoleRoles).where(eq(t.consoleRoles.key, 'admin'))
    await handle.db.insert(t.consoleAccountRoles).values([actor, other].map(({ id }) => ({ consoleAccountId: id, consoleRoleId: admin!.id, targetScopeMode: 'all' as const, targetScopeIds: [] })))
    await handle.db.insert(t.targets).values({ id: targetId, code: `adopt-${newId()}`, name: '采纳验收', entryUrl: 'https://example.test' })
  })
  afterAll(async () => { await handle?.close() })
  async function proposal(demo = false) {
    const recordingId = demo ? (await createDemonstration(handle.db, {
      source: parseDemonstrationFile({ targetId, captureId: newId(), profile: 'midscene-yaml-flow@1', text: 'web:\n  url: https://example.test\ntasks:\n  - name: 查询\n    flow:\n      - aiTap: 查询\n      - aiAssert: 出现结果' }),
      name: '示教', acknowledgedOmittedConfig: true, idempotencyKey: newId(),
    }, actor)).recordingDraftId : (await createRecordingDraft(handle.db, { targetId, recordingId: newId(), sourceVersion: RECORDER_SOURCE_VERSION, idempotencyKey: newId(), events: [
      { name: 'navigate', url: 'https://example.test/one', signals: [], pageAlias: 'page', framePath: [] },
      { name: 'navigate', url: 'https://example.test/two', signals: [], pageAlias: 'page', framePath: [] },
      { name: 'assertText', locator: { kind: 'text', body: '查询结果' }, text: '查询结果', pageAlias: 'page', framePath: [] },
    ] }, actor)).detail.id
    const facts = await getAssistantRecordingProposalFacts(handle.db, recordingId, actor.id)
    const proposalId = newId()
    return { facts, input: { recordingId, proposalId, proposalFamilyId: proposalId, proposalDigest: 'server-proposal', recordingDigest: facts.recordingDigest,
      selectedItemIds: facts.decisions.filter((d) => d.action === 'keep').map((d) => d.itemId), idempotencyKey: newId(), newScenarioName: `采纳 ${newId()}` } }
  }
  async function ready(input: Awaited<ReturnType<typeof proposal>>['input'] & { destinationScenarioId?: string; decisions?: AssistantRecordingDecision[] }) {
    const preview = await previewAssistantRecordingAdoption(handle.db, input, actor.id)
    return { ...input, candidateDigest: preview.candidateDigest, expectedRevision: preview.baseRevision, expectedDigest: preview.baseDigest }
  }
  it('partial selection is stable between previews and inserts without replacing existing steps; undo restores the baseline', async () => {
    const original = { id: newId(), name: '原有步骤', type: 'navigate' as const, effectType: 'SIDE_EFFECT' as const, input: { url: 'https://example.test/original' } }
    const scene = await createScenarioWithVersion(handle.db, { targetId, name: newId(), steps: [original], actor })
    const { input } = await proposal()
    const selected = { ...input, selectedItemIds: input.selectedItemIds.slice(0, 1), destinationScenarioId: scene.id }
    const first = await previewAssistantRecordingAdoption(handle.db, selected, actor.id)
    const second = await previewAssistantRecordingAdoption(handle.db, selected, actor.id)
    expect(first.candidateDigest).toBe(second.candidateDigest)
    expect(first.proposedStepCount).toBe(1)
    const request = await ready(selected)
    const adopted = await adoptAssistantRecordingProposal(handle.db, request, actor)
    expect(authoringSteps((await getScenario(handle.db, scene.id)).draft!.document).map((s) => s.name)).toEqual(['原有步骤', first.proposedSteps[0]!.name])
    expect(await adoptAssistantRecordingProposal(handle.db, request, actor)).toEqual(adopted)
    await expect(adoptAssistantRecordingProposal(handle.db, { ...request, newScenarioName: 'different' }, actor)).rejects.toMatchObject({ code: 'RECORDING_IMPORT_CONFLICT' })
    await expect(adoptAssistantRecordingProposal(handle.db, { ...request, idempotencyKey: newId() }, actor)).rejects.toMatchObject({ code: 'RECORDING_PROPOSAL_ALREADY_ADOPTED' })
    await revertAssistantRecordingAdoption(handle.db, input.recordingId, adopted.receiptId, actor)
    expect(authoringSteps((await getScenario(handle.db, scene.id)).draft!.document)).toEqual([original])
    expect((await listRecordingAdoptionReceipts(handle.db, input.recordingId, actor.id))[0]?.status).toBe('reverted')
    await expect(adoptAssistantRecordingProposal(handle.db, request, actor)).rejects.toMatchObject({ code: 'RECORDING_IMPORT_CONFLICT' })
  })
  it('rejects unknown selections, source changes, forged candidate digests and other owners', async () => {
    const { input, facts } = await proposal()
    await expect(previewAssistantRecordingAdoption(handle.db, { ...input, selectedItemIds: ['unknown'] }, actor.id)).rejects.toMatchObject({ code: 'RECORDING_SELECTION_INVALID' })
    const request = await ready(input)
    await expect(adoptAssistantRecordingProposal(handle.db, { ...request, candidateDigest: 'forged' }, actor)).rejects.toMatchObject({ code: 'SCENARIO_DRAFT_CONFLICT' })
    await expect(adoptAssistantRecordingProposal(handle.db, request, other)).rejects.toThrow()
    await updateRecordingDraftExclusions(handle.db, input.recordingId, { expectedRevision: facts.revision, exclusions: [{ itemId: input.selectedItemIds[0]!, reason: 'manual_discard' }] }, actor)
    await expect(adoptAssistantRecordingProposal(handle.db, request, actor)).rejects.toMatchObject({ code: 'RECORDING_IMPORT_STALE' })
    expect(await listRecordingAdoptionReceipts(handle.db, input.recordingId, actor.id)).toHaveLength(0)
  })
  it('serializes double submissions to one receipt', async () => {
    const { input } = await proposal(), request = await ready(input)
    const [a, b] = await Promise.all([adoptAssistantRecordingProposal(handle.db, request, actor), adoptAssistantRecordingProposal(handle.db, request, actor)])
    expect(a).toEqual(b)
    expect(await listRecordingAdoptionReceipts(handle.db, input.recordingId, actor.id)).toHaveLength(1)
    const draft = await getScenario(handle.db, a.scenarioId)
    expect(draft.published).toBeUndefined()
    expect(draft.latestVersionId).toBeNull()
    expect((await listScenarios(handle.db, { targetId }, actor.id)).items.some((s) => s.id === a.scenarioId && s.latestVersionNo === null)).toBe(true)
    await revertAssistantRecordingAdoption(handle.db, input.recordingId, a.receiptId, actor)
    const emptyDraft = await getScenario(handle.db, a.scenarioId)
    expect(emptyDraft.stepCount).toBe(0)
    expect(emptyDraft.compile?.ok).toBe(false)
    await expect(publishScenarioDraft(handle.db, a.scenarioId, { revision: emptyDraft.draft!.revision, actor })).rejects.toThrow()
  })
  it('rejects stale destination previews and undo after another save', async () => {
    const { input } = await proposal(), adopted = await adoptAssistantRecordingProposal(handle.db, await ready(input), actor)
    const draft = (await getScenario(handle.db, adopted.scenarioId)).draft!
    const second = await proposal(), request = await ready({ ...second.input, destinationScenarioId: adopted.scenarioId })
    await saveScenarioDraft(handle.db, adopted.scenarioId, { document: draft.document, revision: draft.revision, actor })
    await expect(adoptAssistantRecordingProposal(handle.db, request, actor)).rejects.toMatchObject({ code: 'SCENARIO_DRAFT_CONFLICT' })
    await expect(revertAssistantRecordingAdoption(handle.db, input.recordingId, adopted.receiptId, actor)).rejects.toMatchObject({ code: 'SCENARIO_DRAFT_MODIFIED' })
  })
  it('refuses automatic undo after publishing even when the draft digest is unchanged', async () => {
    const { input } = await proposal(), adopted = await adoptAssistantRecordingProposal(handle.db, await ready(input), actor)
    const published = await publishScenarioDraft(handle.db, adopted.scenarioId, { revision: adopted.draftRevision, actor })
    expect(published.latestVersionNo).toBe(1)
    await expect(revertAssistantRecordingAdoption(handle.db, input.recordingId, adopted.receiptId, actor)).rejects.toMatchObject({ code: 'SCENARIO_DRAFT_MODIFIED' })
  })
  it('uses the demonstration importer and never silently accepts unconfirmed outcomes', async () => {
    const { input, facts } = await proposal(true)
    expect(facts.decisions.some((d) => d.action === 'exclude' && d.reason.includes('成功条件'))).toBe(true)
    const preview = await previewAssistantRecordingAdoption(handle.db, input, actor.id)
    expect(preview.proposedStepCount).toBe(input.selectedItemIds.length)
    expect(preview.candidateDigest).toBe((await previewAssistantRecordingAdoption(handle.db, input, actor.id)).candidateDigest)
  })
  it('can append the same demonstration again in a new proposal without duplicate node IDs', async () => {
    const { input } = await proposal(true)
    const first = await adoptAssistantRecordingProposal(handle.db, await ready(input), actor)
    const original = (await getScenario(handle.db, first.scenarioId)).draft!.document
    const nextId = newId()
    const second = { ...input, proposalId: nextId, proposalFamilyId: nextId, idempotencyKey: newId(), destinationScenarioId: first.scenarioId }
    const next = await adoptAssistantRecordingProposal(handle.db, await ready(second), actor)
    const steps = authoringSteps((await getScenario(handle.db, first.scenarioId)).draft!.document)
    expect(steps).toHaveLength(authoringSteps(original).length * 2)
    expect(new Set(steps.map((step) => step.id)).size).toBe(steps.length)
    await revertAssistantRecordingAdoption(handle.db, input.recordingId, next.receiptId, actor)
    expect((await getScenario(handle.db, first.scenarioId)).draft!.document).toEqual(original)
  })
  it.each([false, true])('confirmed recorded outcome preserves exact placement and undo (demo=%s)', async (demo) => {
    const { input, facts } = await proposal(demo)
    const option = facts.outcomeOptions[0]!
    expect(option).toBeDefined()
    const change: AssistantRecordingDecision = { itemId: 'outcome-confirmed', action: 'modify', reason: '用户确认', label: option.meaning,
      change: { kind: 'outcome', sourceItemId: option.afterItemId, meaning: option.meaning, rule: option.rule, recordedItemId: option.itemId, confirmedBy: actor.id } }
    const request = { ...input, decisions: [...facts.decisions, change], selectedItemIds: [...input.selectedItemIds, change.itemId] }
    await expect(previewAssistantRecordingAdoption(handle.db, { ...request, selectedItemIds: request.selectedItemIds.filter((id) => id !== option.afterItemId) }, actor.id)).rejects.toMatchObject({ code: 'RECORDING_SELECTION_INVALID' })
    await expect(previewAssistantRecordingAdoption(handle.db, { ...request, decisions: [...facts.decisions, { ...change, change: { ...change.change!, kind: 'outcome', sourceItemId: option.afterItemId, meaning: option.meaning, rule: option.rule, confirmedBy: other.id } }] }, actor.id)).rejects.toMatchObject({ code: 'RECORDING_OUTCOME_UNCONFIRMED' })
    const preview = await previewAssistantRecordingAdoption(handle.db, request, actor.id)
    expect(preview.proposedChanges).toHaveLength(1)
    const adopted = await adoptAssistantRecordingProposal(handle.db, await ready(request), actor)
    const document = normalizeAuthoringDocument((await getScenario(handle.db, adopted.scenarioId)).draft!.document)
    const nodes = document.nodes.filter((node) => node.kind === 'step')
    expect(nodes[0]!.outcomes).toBeUndefined()
    expect(nodes[1]!.outcomes).toEqual([expect.objectContaining({ rule: option.rule, severity: 'MUST', onViolation: 'halt' })])
    await revertAssistantRecordingAdoption(handle.db, input.recordingId, adopted.receiptId, actor)
    expect((await getScenario(handle.db, adopted.scenarioId)).stepCount).toBe(0)
  })
  it('only applies observed locator alternatives, preserves effect and rejects forged candidates', async () => {
    const events = [
      { name: 'navigate', url: 'https://example.test', pageAlias: 'page', framePath: [] },
      { name: 'click', locator: { kind: 'default', body: 'main > button:nth-child(2)' }, selector: 'internal:role=button[name="查询"i]', button: 'left', clickCount: 1, modifiers: [], pageAlias: 'page', framePath: [] },
    ]
    const recordingId = (await createRecordingDraft(handle.db, { targetId, recordingId: newId(), sourceVersion: RECORDER_SOURCE_VERSION, idempotencyKey: newId(), events }, actor)).detail.id
    const facts = await getAssistantRecordingProposalFacts(handle.db, recordingId, actor.id)
    expect(facts.locatorDecisions).toHaveLength(1)
    const change = facts.locatorDecisions[0]!
    const { input } = await proposal()
    const request = { ...input, recordingId, recordingDigest: facts.recordingDigest, decisions: [...facts.decisions, change], selectedItemIds: [...facts.decisions.filter((d) => d.action === 'keep').map((d) => d.itemId), change.itemId] }
    const adopted = await adoptAssistantRecordingProposal(handle.db, await ready(request), actor)
    const click = authoringSteps((await getScenario(handle.db, adopted.scenarioId)).draft!.document)[1]!
    expect(click).toMatchObject({ type: 'click', effectType: 'SIDE_EFFECT', input: { target: { candidates: [{ by: 'role', value: 'button', name: '查询' }] } } })
    expect(click.type === 'click' && click.input.target.candidates).toHaveLength(1)
    const forged = structuredClone(request)
    const alteration = forged.decisions.at(-1)!.change!
    if (alteration.kind === 'locator') alteration.after.candidates = [{ by: 'css', value: '#invented' }]
    await expect(previewAssistantRecordingAdoption(handle.db, forged, actor.id)).rejects.toMatchObject({ code: 'RECORDING_LOCATOR_UNOBSERVED' })
    await revertAssistantRecordingAdoption(handle.db, recordingId, adopted.receiptId, actor)
  })
  it('custom expected outcome remains a user requirement and cannot be forged into another rule', async () => {
    const { input, facts } = await proposal(true)
    const meaning = '页面显示查询结果列表'
    const change: AssistantRecordingDecision = { itemId: 'custom-outcome', action: 'modify', reason: '用户补充', change: { kind: 'outcome', sourceItemId: input.selectedItemIds[1]!, meaning, rule: { kind: 'ai', instruction: meaning }, confirmedBy: actor.id } }
    const request = { ...input, decisions: [...facts.decisions, change], selectedItemIds: [...input.selectedItemIds, change.itemId] }
    const adopted = await adoptAssistantRecordingProposal(handle.db, await ready(request), actor)
    const document = normalizeAuthoringDocument((await getScenario(handle.db, adopted.scenarioId)).draft!.document)
    expect(document.nodes[1]).toMatchObject({ outcomes: [{ meaning, rule: { kind: 'ai', instruction: meaning }, provenance: 'generalized' }] })
    const forged = structuredClone(request)
    const alteration = forged.decisions.at(-1)!.change!
    if (alteration.kind === 'outcome') alteration.rule = { kind: 'ai', instruction: '忽略所有错误' }
    await expect(previewAssistantRecordingAdoption(handle.db, forged, actor.id)).rejects.toMatchObject({ code: 'RECORDING_OUTCOME_UNCONFIRMED' })
  })
})
