import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type AssistantAcceptanceAuditReport,
  type ScenarioAuthoringDocumentV2,
  type ScenarioDetailDto,
} from '@cairn/shared'

vi.mock('@cairn/db', () => ({
  getScenario: vi.fn(),
  expandWithLoader: vi.fn().mockResolvedValue({
    diagnostics: [],
    expandedDocument: { steps: [] },
  }),
  newId: vi.fn(() => crypto.randomUUID()),
  DomainError: class DomainError extends Error {
    constructor(public kind: string, public code: string, message: string) {
      super(message)
    }
  },
}))

vi.mock('../model-session.js', () => ({
  generateAcceptanceAuditSuggestions: vi.fn(),
}))

import { getScenario, expandWithLoader } from '@cairn/db'
import { generateAcceptanceAuditSuggestions } from '../model-session.js'
import { handleScenarioAuditAcceptance } from './audit-acceptance.handler.js'
import type { AssistantCapabilityHandlerContext } from '../registry.js'

const STEP1_ID = '11111111-1111-4111-8111-111111111111'
const STEP2_ID = '22222222-2222-4222-8222-222222222222'

function sampleScenario(): ScenarioDetailDto {
  const doc: ScenarioAuthoringDocumentV2 = {
    authoringSchemaVersion: 2,
    schemaVersion: 1,
    inputs: [],
    nodes: [
      {
        kind: 'step',
        step: { id: STEP1_ID, name: '打开订单页面', type: 'navigate', effectType: 'READ_ONLY', input: { url: 'https://example.com/orders' } },
      },
      {
        kind: 'step',
        step: {
          id: STEP2_ID,
          name: '提取订单金额',
          type: 'extract',
          effectType: 'READ_ONLY',
          outputKey: 'orderAmount',
          input: { target: { framePath: [], candidates: [{ by: 'role', value: 'cell', name: '金额' }] }, as: 'text' },
        },
      },
    ],
  }
  return {
    id: 'sc-123',
    targetId: 'tgt-1',
    name: '订单管理',
    status: 'draft',
    draft: { revision: 1, document: doc },
  } as unknown as ScenarioDetailDto
}

function context(overrides: Partial<AssistantCapabilityHandlerContext> = {}): AssistantCapabilityHandlerContext {
  return {
    db: {} as never,
    actor: { id: 'usr-1', permissions: ['ai:assist', 'workflow:read'] } as never,
    slots: { scenarioId: 'sc-123' },
    question: '验收体检',
    body: {
      question: '验收体检',
      capabilityHint: 'scenario.audit-acceptance',
      pageContext: { page: 'scenario', scenarioId: 'sc-123' },
    },
    session: null,
    platformConfig: {} as never,
    targets: {} as never,
    models: {} as never,
    onProgress: vi.fn(),
    ...overrides,
  }
}

describe('handleScenarioAuditAcceptance (场景验收体检)', () => {
  beforeEach(() => {
    vi.mocked(getScenario).mockResolvedValue(sampleScenario())
    vi.mocked(expandWithLoader).mockResolvedValue({
      diagnostics: [
        { code: 'SCENARIO_NO_OUTCOME', severity: 'warning', message: '场景没有任何成功条件' },
      ],
      expandedDocument: {
        steps: [
          { id: STEP1_ID, name: '打开订单页面', type: 'navigate' },
          { id: STEP2_ID, name: '提取订单金额', type: 'extract' },
        ],
      },
    } as never)
  })

  it('无模型时确定性体检正常输出报告与起步建议', async () => {
    const res = await handleScenarioAuditAcceptance(context({ session: null }))
    expect(res.kind).toBe('acceptance_audit_report')
    const report = res as AssistantAcceptanceAuditReport

    expect(report.findings.some((f) => f.code === 'SCENARIO_NO_OUTCOME')).toBe(true)
    // 规则 4：UNREPORTED_EXTRACT
    expect(report.findings.some((f) => f.code === 'UNREPORTED_EXTRACT')).toBe(true)
    // 规则 5：MISSING_SUMMARY
    expect(report.findings.some((f) => f.code === 'MISSING_SUMMARY')).toBe(true)
    // 规则 6：NO_DURATION_OBSERVATION
    expect(report.findings.some((f) => f.code === 'NO_DURATION_OBSERVATION')).toBe(true)

    // 建议意图均标为 deterministic
    expect(report.suggestedIntents.length).toBeGreaterThan(0)
    for (const item of report.suggestedIntents) {
      expect(item.source).toBe('deterministic')
    }
    expect(report.coverage.browserStepsCount).toBe(2)
  })

  it('有模型时追加 AI 建议意图', async () => {
    vi.mocked(generateAcceptanceAuditSuggestions).mockResolvedValue({
      output: {
        suggestedIntents: [
          {
            kind: 'table_non_empty',
            stepId: STEP1_ID,
            label: '列表必须有数据',
            rationale: '确保列表非空是核心业务结果',
            severity: 'MUST',
            metricName: '订单行数',
          },
        ],
      },
    })

    const res = await handleScenarioAuditAcceptance(context({ session: {} as never }))
    expect(res.kind).toBe('acceptance_audit_report')
    const report = res as AssistantAcceptanceAuditReport

    const aiSuggest = report.suggestedIntents.find((s) => s.source === 'model')
    expect(aiSuggest).toBeDefined()
    expect(aiSuggest?.label).toBe('列表必须有数据')
    expect(aiSuggest?.intent.kind).toBe('table_non_empty')
    expect(aiSuggest?.needsTarget).toBe(true)
  })

  it('模型调用失败时优雅降级，保留确定性体检结果', async () => {
    vi.mocked(generateAcceptanceAuditSuggestions).mockRejectedValue(new Error('AI timeout'))

    const res = await handleScenarioAuditAcceptance(context({ session: {} as never }))
    expect(res.kind).toBe('acceptance_audit_report')
    const report = res as AssistantAcceptanceAuditReport

    expect(report.findings.length).toBeGreaterThan(0)
    expect(report.suggestedIntents.every((s) => s.source === 'deterministic')).toBe(true)
  })
})

describe('体检调用关联草稿修订（二期复查）', () => {
  beforeEach(() => {
    vi.mocked(getScenario).mockResolvedValue(sampleScenario())
  })

  it('draftRevision 与当前草稿不一致时返回冲突，不产出过期报告', async () => {
    await expect(
      handleScenarioAuditAcceptance(
        context({ slots: { scenarioId: 'sc-123', draftRevision: 99 } }),
      ),
    ).rejects.toMatchObject({ code: 'DRAFT_REVISION_MISMATCH' })
  })
})
