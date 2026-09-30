import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import type { AssistantRecordingProposalResult } from '@cairn/shared'
import * as api from '@/lib/assistant-api'
import { RecordingProposal } from './recording-proposal'

vi.mock('@/lib/assistant-api', () => ({ confirmRecordingOutcome: vi.fn(), adoptRecordingProposal: vi.fn(), fetchRecordingAdoptions: vi.fn(async () => []), previewRecordingProposal: vi.fn(), revertRecordingAdoption: vi.fn(), selectRecordingProposal: vi.fn() }))
vi.mock('@/lib/scenarios-api', () => ({ fetchScenarios: vi.fn(async () => ({ items: [] })), fetchScenario: vi.fn() }))
const id = '00000000-0000-4000-8000-000000000001'
const base: AssistantRecordingProposalResult = { kind: 'recording_proposal', proposalId: id, proposalFamilyId: id, recordingId: id, targetId: id, protocolVersion: 'script@1', recordingDigest: 'source', adapterVersion: '3', candidateDigest: 'proposal', proposalSummary: '请确认成功条件', decisions: [{ itemId: 'save', label: '点击保存', action: 'keep', reason: '录制动作' }], excludedItemIds: [], diagnostics: [], missingConfirmations: [], applicable: true, sourceManifest: { version: '1.0', asOf: '2026-09-30T00:00:00Z', sources: [], scope: {}, digest: 'source' } }
const change = { itemId: 'outcome', label: '成功条件：显示保存成功', action: 'modify' as const, reason: '用户确认', change: { kind: 'outcome' as const, sourceItemId: 'save', meaning: '显示保存成功', rule: { kind: 'ai' as const, instruction: '显示保存成功' }, confirmedBy: id } }
function mount(result: AssistantRecordingProposalResult) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><RecordingProposal result={result} conversationId={id} turnId={id} go={vi.fn()} /></QueryClientProvider>)
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.fetchRecordingAdoptions).mockResolvedValue([])
  vi.mocked(api.confirmRecordingOutcome).mockResolvedValue({ turnId: 'confirmed-turn', proposal: { ...base, intent: 'outcome', needsOutcomeConfirmation: false, decisions: [...base.decisions, change] } })
  vi.mocked(api.selectRecordingProposal).mockResolvedValue({ turnId: 'selected-turn', proposalId: 'selected', proposalFamilyId: id, proposalDigest: 'selected-digest', selectionSummary: '已选择' })
  vi.mocked(api.previewRecordingProposal).mockResolvedValue({ candidateDigest: 'compiled', sourceDigest: 'source', proposedStepCount: 1, proposedSteps: [{ name: '点击保存', type: 'click' }], proposedChanges: [{ label: '成功条件', detail: '显示保存成功；必须满足，失败时停止。未执行验证。' }], diagnostics: [], changesSummary: '1 个步骤，1 项修改' })
})
describe('recording proposal control', () => {
  it('requires explicit expectation confirmation and preview before adoption', async () => {
    const screen = await mount({ ...base, intent: 'outcome', needsOutcomeConfirmation: true, applicable: false })
    await expect.element(screen.getByRole('button', { name: '确认预期并生成提案' })).toBeDisabled()
    await screen.getByRole('combobox', { name: '检查位置' }).click()
    await screen.getByRole('option', { name: '第 1 项 · 点击保存' }).click()
    await screen.getByRole('textbox', { name: '应该看到什么结果' }).fill('显示保存成功')
    await screen.getByRole('button', { name: '确认预期并生成提案' }).click()
    await expect.element(screen.getByText('预期来源：用户补充并确认 · 必须满足，失败时停止')).toBeVisible()
    expect(api.confirmRecordingOutcome).toHaveBeenCalledWith(id, id, { proposalDigest: 'proposal', outcome: { kind: 'custom', afterItemId: 'save', expectedOutcome: '显示保存成功' } })
    expect(api.adoptRecordingProposal).not.toHaveBeenCalled()
    await screen.getByRole('button', { name: '预览所选内容' }).click()
    await expect.element(screen.getByText('1 个步骤，1 项修改')).toBeVisible()
    expect(api.selectRecordingProposal).toHaveBeenCalledWith(id, 'confirmed-turn', { proposalDigest: 'proposal', selectedItemIds: ['save', 'outcome'] })
    await screen.getByRole('button', { name: '确认采纳到草稿' }).click()
    expect(api.adoptRecordingProposal).toHaveBeenCalledWith(id, 'selected-turn', expect.objectContaining({ candidateDigest: 'compiled', proposalDigest: 'selected-digest' }))
  })
  it('cannot move a condition to another step by deselecting its source and invalidates a prior preview', async () => {
    const screen = await mount({ ...base, decisions: [...base.decisions, change] })
    await screen.getByRole('button', { name: '预览所选内容' }).click()
    await expect.element(screen.getByText('1 个步骤，1 项修改')).toBeVisible()
    await screen.getByRole('checkbox', { name: '导入第 1 项' }).click()
    await expect.element(screen.getByRole('alert')).toHaveTextContent('需要同时保留对应的录制动作')
    await expect.element(screen.getByRole('button', { name: '预览所选内容' })).toBeDisabled()
    await expect.element(screen.getByRole('button', { name: '确认采纳到草稿' })).not.toBeInTheDocument()
  })
  it('shows both locator versions and their source and allows omitting only the replacement', async () => {
    const screen = await mount({ ...base, decisions: [...base.decisions, { itemId: 'locator', label: '改进定位', action: 'modify', reason: '待试跑', change: { kind: 'locator', sourceItemId: 'save', before: { framePath: [], candidates: [{ by: 'css', value: '#save' }] }, after: { framePath: [], candidates: [{ by: 'role', value: 'button', name: '保存' }] } } }] })
    await expect.element(screen.getByText('修改前：CSS：#save')).toBeVisible()
    await expect.element(screen.getByText('修改后：角色：button（保存）')).toBeVisible()
    await expect.element(screen.getByText('来源：本录制「点击保存」的定位观察')).toBeVisible()
    await screen.getByRole('checkbox', { name: '导入第 2 项' }).click()
    await screen.getByRole('button', { name: '预览所选内容' }).click()
    await expect.element(screen.getByText('1 个步骤，1 项修改')).toBeVisible()
    expect(api.selectRecordingProposal).toHaveBeenCalledWith(id, id, expect.objectContaining({ selectedItemIds: ['save'] }))
  })
  it('clears an old input error when switching to a recorded assertion and shows its exact comparator', async () => {
    vi.mocked(api.confirmRecordingOutcome).mockRejectedValueOnce(new Error('请填写具体的页面预期'))
    const screen = await mount({ ...base, intent: 'outcome', needsOutcomeConfirmation: true, applicable: false, outcomeOptions: [{ itemId: 'recorded-count', afterItemId: 'save', meaning: '数量', rule: { kind: 'deterministic', expect: { kind: 'number_compare', op: 'gte', value: 2 }, target: { framePath: [], candidates: [{ by: 'label', value: '记录数' }] } } }] })
    await screen.getByRole('combobox', { name: '检查位置' }).click()
    await screen.getByRole('option', { name: '第 1 项 · 点击保存' }).click()
    await screen.getByRole('textbox', { name: '应该看到什么结果' }).fill('操作成功')
    await screen.getByRole('button', { name: '确认预期并生成提案' }).click()
    await expect.element(screen.getByRole('alert')).toHaveTextContent('请填写具体的页面预期')
    await expect.element(screen.getByRole('textbox', { name: '应该看到什么结果' })).toHaveValue('操作成功')
    await screen.getByRole('combobox', { name: '预期来源' }).click()
    await screen.getByRole('option', { name: '录制中已有：数量' }).click()
    await expect.element(screen.getByRole('alert')).not.toBeInTheDocument()
    await expect.element(screen.getByText('沿用录制规则：数值比较大于等于 2；标签：记录数')).toBeVisible()
    await screen.getByRole('button', { name: '确认预期并生成提案' }).click()
    expect(api.confirmRecordingOutcome).toHaveBeenLastCalledWith(id, id, { proposalDigest: 'proposal', outcome: { kind: 'recorded', itemId: 'recorded-count' } })
  })
})
