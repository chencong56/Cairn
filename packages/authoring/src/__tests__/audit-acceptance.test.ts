import { describe, expect, it } from 'vitest'
import {
  normalizeAuthoringDocument,
  type CompileDiagnostic,
  type ScenarioAuthoringDocumentV2,
} from '@cairn/shared'
import { auditAcceptance } from '../audit.js'

describe('auditAcceptance (验收体检规则)', () => {
  const stepId1 = '01912345-0000-7000-8000-000000000001'
  const stepId2 = '01912345-0000-7000-8000-000000000002'
  const stepId3 = '01912345-0000-7000-8000-000000000003'

  it('诊断 SCENARIO_NO_OUTCOME 时输出可达性与无错误建议', () => {
    const doc: ScenarioAuthoringDocumentV2 = normalizeAuthoringDocument({
      authoringSchemaVersion: 2,
      nodes: [
        {
          kind: 'step',
          step: {
            id: stepId1,
            name: '打开登录页',
            type: 'navigate',
            effectType: 'READ_ONLY',
            input: { url: 'https://example.com/login' },
          },
        },
        {
          kind: 'step',
          step: {
            id: stepId2,
            name: '点击提交',
            type: 'click',
            effectType: 'READ_ONLY',
            input: { target: { framePath: [], candidates: [{ by: 'css', value: 'button#submit' }] } },
          },
        },
      ],
    })

    const diags: CompileDiagnostic[] = [
      {
        code: 'SCENARIO_NO_OUTCOME',
        severity: 'warning',
        message: '场景没有任何成功条件',
      },
    ]

    const report = auditAcceptance(doc, diags)
    expect(report.kind).toBe('acceptance_audit_report')
    expect(report.findings.some((f) => f.code === 'SCENARIO_NO_OUTCOME')).toBe(true)

    // 应建议末页可达与末页无错误，且绑定最后一步浏览器步骤 stepId2
    const reachable = report.suggestedIntents.find((s) => s.intent.kind === 'page_reachable')
    expect(reachable).toBeDefined()
    expect(reachable?.intent).toMatchObject({ kind: 'page_reachable', stepId: stepId2 })

    const noError = report.suggestedIntents.find(
      (s) => s.intent.kind === 'text_present_or_absent' && s.intent.absent === true,
    )
    expect(noError).toBeDefined()
    expect(noError?.intent).toMatchObject({ kind: 'text_present_or_absent', stepId: stepId2 })
  })

  it('诊断 SCENARIO_SIDE_EFFECT_WITHOUT_OUTCOME 时输出写操作验证建议', () => {
    const doc: ScenarioAuthoringDocumentV2 = normalizeAuthoringDocument({
      authoringSchemaVersion: 2,
      nodes: [
        {
          kind: 'step',
          step: {
            id: stepId1,
            name: '提交表单',
            type: 'click',
            effectType: 'SIDE_EFFECT',
            input: { target: { framePath: [], candidates: [{ by: 'css', value: 'button#save' }] } },
          },
        },
      ],
    })

    const diags: CompileDiagnostic[] = [
      {
        code: 'SCENARIO_SIDE_EFFECT_WITHOUT_OUTCOME',
        severity: 'warning',
        stepId: stepId1,
        message: '写操作未配置条件',
      },
    ]

    const report = auditAcceptance(doc, diags)
    const sideEffectFinding = report.findings.find((f) => f.code === 'SCENARIO_SIDE_EFFECT_WITHOUT_OUTCOME')
    expect(sideEffectFinding).toBeDefined()
    expect(sideEffectFinding?.stepId).toBe(stepId1)

    const successSuggest = report.suggestedIntents.find(
      (s) => s.intent.kind === 'text_present_or_absent' && s.intent.text === '成功',
    )
    expect(successSuggest).toBeDefined()
    expect(successSuggest?.intent).toMatchObject({ kind: 'text_present_or_absent', stepId: stepId1 })
  })

  it('规则 UNREPORTED_EXTRACT: 提取变量未在报告中声明且未在下游引用时告警', () => {
    const doc: ScenarioAuthoringDocumentV2 = normalizeAuthoringDocument({
      authoringSchemaVersion: 2,
      nodes: [
        {
          kind: 'step',
          step: {
            id: stepId1,
            name: '提取订单金额',
            type: 'extract',
            effectType: 'READ_ONLY',
            outputKey: 'orderAmount',
            input: { as: 'text', target: { framePath: [], candidates: [{ by: 'css', value: '.amount' }] } },
          },
        },
      ],
    })

    const report = auditAcceptance(doc, [])
    const finding = report.findings.find((f) => f.code === 'UNREPORTED_EXTRACT')
    expect(finding).toBeDefined()
    expect(finding?.stepId).toBe(stepId1)

    const suggest = report.suggestedIntents.find((s) => s.intent.kind === 'extract_to_report')
    expect(suggest).toBeDefined()
    expect(suggest?.intent).toMatchObject({ kind: 'extract_to_report', stepId: stepId1 })
    expect(report.coverage.outputMetricCoverage).toBe(0)
    expect(report.coverage.outputsCount).toBe(1)
    expect(report.coverage.coveredOutputsCount).toBe(0)
  })

  it('规则 UNREPORTED_EXTRACT: 变量在下游 compute 或 metrics 中被引用时无告警', () => {
    const doc: ScenarioAuthoringDocumentV2 = normalizeAuthoringDocument({
      authoringSchemaVersion: 2,
      outputs: {
        metrics: [
          {
            key: 'metric_amount',
            name: '订单金额',
            fromContextKey: 'orderAmount',
          },
        ],
      },
      nodes: [
        {
          kind: 'step',
          step: {
            id: stepId1,
            name: '提取订单金额',
            type: 'extract',
            effectType: 'READ_ONLY',
            outputKey: 'orderAmount',
            input: { as: 'text', target: { framePath: [], candidates: [{ by: 'css', value: '.amount' }] } },
          },
        },
        {
          kind: 'step',
          step: {
            id: stepId2,
            name: '计算折扣后金额',
            type: 'compute',
            effectType: 'READ_ONLY',
            outputKey: 'discountedAmount',
            input: {
              expression: {
                kind: 'call',
                fn: 'diff',
                args: [
                  { kind: 'ref', key: 'orderAmount' },
                  { kind: 'literal', value: 10 },
                ],
              },
            },
          },
        },
      ],
    })

    // orderAmount 被 metrics 和 compute 引用，discountedAmount 未被引用
    const report = auditAcceptance(doc, [])
    const orderFinding = report.findings.find((f) => f.stepId === stepId1)
    expect(orderFinding).toBeUndefined()

    const discountFinding = report.findings.find((f) => f.stepId === stepId2)
    expect(discountFinding).toBeDefined()
    expect(report.coverage.outputsCount).toBe(2)
    expect(report.coverage.coveredOutputsCount).toBe(1)
    expect(report.coverage.outputMetricCoverage).toBe(0.5)
  })

  it('规则 MISSING_SUMMARY: 无结论模板时报告发现', () => {
    const doc: ScenarioAuthoringDocumentV2 = normalizeAuthoringDocument({
      authoringSchemaVersion: 2,
      nodes: [
        {
          kind: 'step',
          step: {
            id: stepId1,
            name: '打开页面',
            type: 'navigate',
            effectType: 'READ_ONLY',
            input: { url: 'https://example.com' },
          },
        },
      ],
    })

    const report = auditAcceptance(doc, [])
    expect(report.findings.some((f) => f.code === 'MISSING_SUMMARY')).toBe(true)

    const docWithSummary: ScenarioAuthoringDocumentV2 = normalizeAuthoringDocument({
      authoringSchemaVersion: 2,
      outputs: {
        summaryTemplate: '巡检完成',
      },
      nodes: [
        {
          kind: 'step',
          step: {
            id: stepId1,
            name: '打开页面',
            type: 'navigate',
            effectType: 'READ_ONLY',
            input: { url: 'https://example.com' },
          },
        },
      ],
    })
    const report2 = auditAcceptance(docWithSummary, [])
    expect(report2.findings.some((f) => f.code === 'MISSING_SUMMARY')).toBe(false)
  })

  it('规则 NO_DURATION_OBSERVATION: 无任何耗时条件或指标时建议全程耗时', () => {
    const doc: ScenarioAuthoringDocumentV2 = normalizeAuthoringDocument({
      authoringSchemaVersion: 2,
      nodes: [
        {
          kind: 'step',
          step: {
            id: stepId1,
            name: '打开页面',
            type: 'navigate',
            effectType: 'READ_ONLY',
            input: { url: 'https://example.com' },
          },
        },
      ],
    })

    const report = auditAcceptance(doc, [])
    expect(report.findings.some((f) => f.code === 'NO_DURATION_OBSERVATION')).toBe(true)
    const durationSuggest = report.suggestedIntents.find((s) => s.intent.kind === 'scenario_duration')
    expect(durationSuggest).toBeDefined()
    expect(durationSuggest?.intent).toMatchObject({ kind: 'scenario_duration', maxMs: 60_000 })

    // 配置了 scenarioOutcomes run_duration 后不再触发
    const docWithRunDuration: ScenarioAuthoringDocumentV2 = normalizeAuthoringDocument({
      authoringSchemaVersion: 2,
      scenarioOutcomes: [
        {
          id: '01912345-0000-7000-8000-000000000008',
          scope: 'scenario',
          meaning: '全程耗时不超过 30s',
          severity: 'MUST',
          onViolation: 'continue',
          provenance: 'manual',
          rule: {
            kind: 'run_duration',
            op: 'lte',
            valueMs: 30_000,
          },
        },
      ],
      nodes: [
        {
          kind: 'step',
          step: {
            id: stepId1,
            name: '打开页面',
            type: 'navigate',
            effectType: 'READ_ONLY',
            input: { url: 'https://example.com' },
          },
        },
      ],
    })
    const report2 = auditAcceptance(docWithRunDuration, [])
    expect(report2.findings.some((f) => f.code === 'NO_DURATION_OBSERVATION')).toBe(false)
  })

  it('计算浏览器步骤覆盖度', () => {
    const doc: ScenarioAuthoringDocumentV2 = normalizeAuthoringDocument({
      authoringSchemaVersion: 2,
      nodes: [
        {
          kind: 'step',
          step: {
            id: stepId1,
            name: '打开页面',
            type: 'navigate',
            effectType: 'READ_ONLY',
            input: { url: 'https://example.com' },
          },
          outcomes: [
            {
              id: '01912345-0000-7000-8000-000000000009',
              scope: 'step',
              meaning: '必须可达',
              severity: 'MUST',
              onViolation: 'halt',
              provenance: 'manual',
              rule: { kind: 'step_duration', op: 'lte', valueMs: 5000 },
            },
          ],
        },
        {
          kind: 'step',
          step: {
            id: stepId2,
            name: '点击按钮',
            type: 'click',
            effectType: 'READ_ONLY',
            input: { target: { framePath: [], candidates: [{ by: 'css', value: '#btn' }] } },
          },
        },
      ],
    })

    const report = auditAcceptance(doc, [])
    expect(report.coverage.browserStepsCount).toBe(2)
    expect(report.coverage.coveredBrowserStepsCount).toBe(1)
    expect(report.coverage.browserStepCoverage).toBe(0.5)
  })
})
