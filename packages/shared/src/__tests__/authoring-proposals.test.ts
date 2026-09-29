import { describe, it, expect } from 'vitest'
import {
  authoringEditProposalSchema,
  outcomeAssistProposalSchema,
  demonstrationSemanticProposalSchema,
  datasetProfileSchema,
  dataMappingProposalSchema,
  SYNC_PREFLIGHT_MAX_ROWS,
  applyDemonstrationBodySchema,
  ACCEPTANCE_CARD_BLOCK_REASONS,
  acceptanceIntentRequestSchema,
  acceptanceProposalCardSchema,
  acceptanceRequestSchema,
  assistantAuthoringProposalSchema,
} from '../index.js'

describe('Authoring proposals schemas (AI-03 Phase 1)', () => {
  it('validates C1 AuthoringEditProposal with module and step nodes', () => {
    const proposal = {
      proposalId: '11111111-1111-4111-8111-111111111111',
      scenarioId: '22222222-2222-4222-8222-222222222222',
      expectedDraftRevision: 3,
      diffSummary: '新增登录模块与查询步骤',
      nodes: [
        {
          kind: 'module',
          invocationId: '33333333-3333-4333-8333-333333333333',
          moduleId: '44444444-4444-4444-8444-444444444444',
          implementationKey: 'default',
          inputBindings: {},
          outputBindings: {},
        },
        {
          kind: 'step',
          step: {
            id: '55555555-5555-4555-8555-555555555555',
            name: '点击搜索',
            type: 'click',
            effectType: 'READ_ONLY',
            input: {
              target: {
                candidates: [{ by: 'css', value: '#search' }],
              },
            },
          },
        },
      ],
      missingSlots: [
        { key: 'password', label: '登录密码', reason: '需要用户在环境变量中配置' },
      ],
      diagnostics: [],
      proposalDigest: 'a'.repeat(64),
      createdAt: new Date().toISOString(),
    }
    const parsed = authoringEditProposalSchema.parse(proposal)
    expect(parsed.nodes).toHaveLength(2)
    expect(parsed.missingSlots[0]!.key).toBe('password')
  })

  it('validates C2 OutcomeAssistProposal', () => {
    const proposal = {
      proposalId: '11111111-1111-4111-8111-111111111112',
      businessIntent: '核对回执订单号与金额',
      candidateOutcomes: [
        {
          id: '66666666-6666-4666-8666-666666666666',
          scope: 'scenario',
          meaning: '回执单号展示',
          severity: 'MUST',
          onViolation: 'halt',
          provenance: 'manual',
          rule: {
            kind: 'deterministic',
            target: {
              candidates: [{ by: 'text', value: '订单处理成功' }],
            },
            expect: { kind: 'visible' },
          },
        },
      ],
      candidateOutputs: [
        {
          summaryTemplate: '巡检完成，处理订单 ${order_count} 笔',
          metrics: [
            {
              key: 'order_count',
              name: '订单数',
              fromContextKey: 'orderCount',
              unit: '笔',
            },
          ],
          dataRowFields: [],
        },
      ],
      uncoveredRequirements: ['需人工确认退款容差'],
      unsupportedRequirements: [],
      proposalDigest: 'b'.repeat(64),
      createdAt: new Date().toISOString(),
    }
    const parsed = outcomeAssistProposalSchema.parse(proposal)
    expect(parsed.candidateOutcomes).toHaveLength(1)
    expect(parsed.candidateOutputs).toHaveLength(1)
  })

  it('validates C3 DemonstrationSemanticProposal and applyDemonstrationBody with modelProposalDigest', () => {
    const proposal = {
      recordingDraftId: '11111111-1111-4111-8111-111111111113',
      factDigest: 'c'.repeat(64),
      modelProposalDigest: 'd'.repeat(64),
      businessGroups: [
        {
          groupId: 'grp-login',
          title: '系统登录',
          effectType: 'READ_ONLY',
          sourceIds: ['act-1', 'act-2'],
        },
      ],
      sourceMap: [
        { sourceId: 'act-1', groupId: 'grp-login', disposition: 'accept' },
        { sourceId: 'act-2', groupId: 'grp-login', disposition: 'accept' },
      ],
      paramCandidates: [
        { sourceId: 'act-2', name: 'username', type: 'string', sampleValue: 'admin' },
      ],
      unknownActions: [],
      createdAt: new Date().toISOString(),
    }
    const parsed = demonstrationSemanticProposalSchema.parse(proposal)
    expect(parsed.businessGroups[0]!.sourceIds).toEqual(['act-1', 'act-2'])

    // applyDemonstrationBody with modelProposalDigest
    const applyBody = {
      protocolVersion: 'demonstration@1',
      recordingDraftId: '11111111-1111-4111-8111-111111111113',
      idempotencyKey: '11111111-1111-4111-8111-111111111114',
      baseRevision: 1,
      placement: { kind: 'start' },
      factDigest: 'c'.repeat(64),
      suggestionDigest: 'e'.repeat(64),
      modelProposalDigest: 'd'.repeat(64),
      adapterVersion: 'demonstration-adapters@1',
      ruleVersion: 'demonstration-rules@1',
      decisions: [
        { id: 'act-1', disposition: 'accept' },
      ],
    }
    const parsedApply = applyDemonstrationBodySchema.parse(applyBody)
    expect(parsedApply.modelProposalDigest).toBe('d'.repeat(64))
  })

  it('validates C4.1 DatasetProfile and DataMappingProposal', () => {
    expect(SYNC_PREFLIGHT_MAX_ROWS).toBe(2000)

    const profile = {
      datasetId: '11111111-1111-4111-8111-111111111115',
      totalRows: 1500,
      analyzedRows: 1500,
      isSampled: false,
      columns: [
        {
          name: 'order_id',
          inferredType: 'string',
          nullCount: 0,
          nullRate: 0,
          distinctCount: 1500,
          minLength: 10,
          maxLength: 10,
          sampleAnomalies: [],
        },
      ],
      algorithmVersion: 'dataset-profiler@1',
      createdAt: new Date().toISOString(),
    }
    const parsedProfile = datasetProfileSchema.parse(profile)
    expect(parsedProfile.columns[0]!.inferredType).toBe('string')

    const mapping = {
      datasetId: '11111111-1111-4111-8111-111111111115',
      binding: {
        orderId: { source: 'column', columnName: 'order_id' },
      },
      unresolvedInputs: [],
      confidence: 0.95,
      sampleEvaluations: [
        { rowIndex: 0, values: { orderId: 'ORD1234567' } },
      ],
      createdAt: new Date().toISOString(),
    }
    const parsedMapping = dataMappingProposalSchema.parse(mapping)
    expect(parsedMapping.confidence).toBe(0.95)
  })
})

describe('验收意图契约（二期）', () => {
  it('scenario_duration 意图不需要 stepId，value_consistency 要求 stepIdA/stepIdB', () => {
    expect(
      acceptanceIntentRequestSchema.parse({
        key: 'q1',
        kind: 'scenario_duration',
        maxMs: 30_000,
        severity: 'SHOULD',
      }),
    ).toMatchObject({ kind: 'scenario_duration', maxMs: 30_000 })

    expect(
      acceptanceIntentRequestSchema.parse({
        key: 'q2',
        kind: 'value_consistency',
        stepIdA: '11111111-1111-4111-8111-111111111111',
        stepIdB: '22222222-2222-4222-8222-222222222222',
        severity: 'MUST',
        tolerance: 5,
        metricName: '余额对账差额',
      }),
    ).toMatchObject({ kind: 'value_consistency', tolerance: 5 })

    // value_consistency 缺少比对步骤应被拒绝
    expect(
      acceptanceIntentRequestSchema.safeParse({
        key: 'q3',
        kind: 'value_consistency',
        severity: 'MUST',
      }).success,
    ).toBe(false)
  })

  it('acceptanceRequestSchema 允许仅 description（≤500），但 intents 与 description 至少其一', () => {
    expect(
      acceptanceRequestSchema.parse({
        description: '订单列表必须有数据，全程不超过 1 分钟',
      }),
    ).toMatchObject({ description: '订单列表必须有数据，全程不超过 1 分钟' })

    expect(acceptanceRequestSchema.safeParse({ description: '' }).success).toBe(false)
    expect(acceptanceRequestSchema.safeParse({ description: 'x'.repeat(501) }).success).toBe(false)
  })

  it('方案卡 stepId 可选且 ruleKind 支持 run_duration；VALUE_SOURCE_MISSING 在拦下原因枚举中', () => {
    expect(ACCEPTANCE_CARD_BLOCK_REASONS).toContain('VALUE_SOURCE_MISSING')
    const card = acceptanceProposalCardSchema.parse({
      id: 'card-1',
      intentKind: 'scenario_duration',
      meaning: '全程耗时不超过 30秒',
      severity: 'MUST',
      operationIds: ['op-1'],
      config: { ruleKind: 'run_duration' },
    })
    expect(card.stepId).toBeUndefined()
  })

  it('提案可携带 parsedIntents 回填与 unsupported', () => {
    const base = {
      kind: 'authoring_proposal' as const,
      proposalId: '11111111-1111-4111-8111-111111111111',
      scenarioId: '22222222-2222-4222-8222-222222222222',
      base: {
        draftRevision: 1,
        documentDigest: 'a'.repeat(64),
        dependencyFingerprint: 'sc:1',
      },
      operations: [
        {
          kind: 'set_outputs' as const,
          id: 'op-1',
          metrics: [{ key: 'run_ms', name: '全程耗时', fromRunDuration: true }],
        },
      ],
      candidateDigest: 'b'.repeat(64),
      intentCoverage: [],
      diffs: [],
      diagnostics: [],
      executable: true,
      validation: { schema: 'passed' as const, expansion: 'passed' as const, compiler: 'passed' as const },
      source: 'acceptance' as const,
      unsupported: [{ excerpt: '发飞书消息', reason: '暂不支持发送通知' }],
      parsedIntents: [
        { key: 'q1', kind: 'scenario_duration', maxMs: 60_000, severity: 'SHOULD' },
      ],
    }
    expect(assistantAuthoringProposalSchema.parse(base)).toMatchObject({
      parsedIntents: [{ kind: 'scenario_duration' }],
    })
  })
})
