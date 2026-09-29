import {
  stepUsesBrowser,
  walkAuthoringNodes,
  type AcceptanceAuditReportFinding,
  type AcceptanceAuditSuggestedIntent,
  type AssistantAcceptanceAuditReport,
  type AuthoringStepNode,
  type CompileDiagnostic,
  type ScenarioAuthoringDocumentV2,
  type Step,
} from '@cairn/shared'

/**
 * 纯函数：根据场景草稿与编译诊断，执行验收体检，输出结构化发现与建议意图。
 * 无模型时该函数全量可用，输出确定性发现与无需定位的起步建议。
 */
export function auditAcceptance(
  document: ScenarioAuthoringDocumentV2,
  compileDiagnostics: readonly CompileDiagnostic[] = [],
  scenarioId?: string,
): AssistantAcceptanceAuditReport {
  const findings: AcceptanceAuditReportFinding[] = []
  const suggestedIntents: AcceptanceAuditSuggestedIntent[] = []

  const walked = walkAuthoringNodes(document)
  const stepNodes: AuthoringStepNode[] = walked
    .map((entry) => entry.node)
    .filter((node): node is AuthoringStepNode => node.kind === 'step')
  const steps: Step[] = stepNodes.map((node) => node.step)
  const stepById = new Map<string, Step>(steps.map((s) => [s.id, s]))
  const nodeByStepId = new Map<string, AuthoringStepNode>(stepNodes.map((node) => [node.step.id, node]))

  const browserSteps = steps.filter((s) => !s.disabled && stepUsesBrowser(s.type))
  const lastBrowserStep = browserSteps.length > 0 ? browserSteps[browserSteps.length - 1] : undefined

  // 1. 编译诊断汇总与业务语言翻译
  const hasNoOutcomeDiag = compileDiagnostics.some((d) => d.code === 'SCENARIO_NO_OUTCOME')
  const hasInfoOnlyDiag = compileDiagnostics.some((d) => d.code === 'SCENARIO_OUTCOME_INFO_ONLY')

  if (hasNoOutcomeDiag) {
    findings.push({
      id: 'finding-no-outcome',
      source: 'compiler',
      code: 'SCENARIO_NO_OUTCOME',
      severity: 'warning',
      message: '场景没有任何成功条件，跑完只能看执行成败',
      rationale: '未配置任何成功条件时，只要浏览器动作不抛出异常就视为成功，无法确认页面数据与业务结果。',
    })

    if (lastBrowserStep) {
      suggestedIntents.push({
        id: 'suggest-reachable',
        intent: {
          key: 'acc_audit_reachable',
          kind: 'page_reachable',
          stepId: lastBrowserStep.id,
          severity: 'MUST',
        },
        label: `末页页面可达（${lastBrowserStep.name}）`,
        rationale: '确保场景执行能顺利到达末尾业务页面',
        needsTarget: false,
        source: 'deterministic',
      })
      suggestedIntents.push({
        id: 'suggest-no-error',
        intent: {
          key: 'acc_audit_no_error',
          kind: 'text_present_or_absent',
          stepId: lastBrowserStep.id,
          text: '错误',
          absent: true,
          severity: 'MUST',
        },
        label: `末页不能出现错误提示（${lastBrowserStep.name}）`,
        rationale: '检查末页不出现通用系统或业务错误提示',
        needsTarget: false,
        source: 'deterministic',
      })
    }
  } else if (hasInfoOnlyDiag) {
    findings.push({
      id: 'finding-info-only',
      source: 'compiler',
      code: 'SCENARIO_OUTCOME_INFO_ONLY',
      severity: 'warning',
      message: '只有提示级条件，没有必须成立的条件',
      rationale: '提示级（INFO）成功条件不满足时不会影响运行结果状态，建议补充必须或应当成立的条件。',
    })
  }

  for (const diag of compileDiagnostics) {
    if (diag.code === 'SCENARIO_SIDE_EFFECT_WITHOUT_OUTCOME') {
      const step = diag.stepId ? stepById.get(diag.stepId) : undefined
      const stepName = step?.name ?? (diag.stepId ? `步骤 ${diag.stepId}` : '写操作')
      findings.push({
        id: `finding-side-effect-${diag.stepId ?? findings.length}`,
        source: 'compiler',
        code: 'SCENARIO_SIDE_EFFECT_WITHOUT_OUTCOME',
        severity: 'warning',
        stepId: diag.stepId,
        stepName: step?.name,
        message: `写操作步骤「${stepName}」之后没有验证改对了没有`,
        rationale: '写操作会改动目标系统状态，其后应核验是否保存成功或有无失败提示。',
      })
      if (diag.stepId) {
        suggestedIntents.push({
          id: `suggest-success-${diag.stepId}`,
          intent: {
            key: `acc_audit_success_${diag.stepId.slice(-6)}`,
            kind: 'text_present_or_absent',
            stepId: diag.stepId,
            text: '成功',
            absent: false,
            severity: 'SHOULD',
          },
          label: `「${stepName}」后验证出现成功提示`,
          rationale: '写操作后立即验证业务系统给出的成功反馈',
          needsTarget: false,
          source: 'deterministic',
        })
      }
    }
  }

  // 2. 体检新增规则 4：取数未进报告
  const outputs = document.outputs
  const declaredMetricKeys = new Set(outputs?.metrics?.map((m) => m.fromContextKey).filter((k): k is string => Boolean(k)))
  const declaredDataRowKeys = new Set(outputs?.dataRowFields?.map((d) => d.fromContextKey).filter((k): k is string => Boolean(k)))
  const summaryTemplate = outputs?.summaryTemplate ?? ''
  const summaryKey = outputs?.summaryFromContextKey

  // 收集各步骤（按文档顺序）表达式对上下文变量的引用；只统计提取步骤之后的引用，
  // 前置步骤引用该键在运行期本就解析失败，不能算作「已进报告」。
  const refsByStepIndex: Array<Set<string>> = steps.map((step) => {
    const refs = new Set<string>()
    if (step.type === 'compute' && step.input?.expression) {
      collectRefsFromExpr(step.input.expression, refs)
    }
    if (step.type === 'check_context' && step.input?.key) {
      refs.add(step.input.key)
    }
    return refs
  })

  const extractedKeys = new Set<string>()
  let totalOutputsCount = 0
  let coveredOutputsCount = 0

  for (const [stepIndex, step] of steps.entries()) {
    let outputKey: string | undefined
    if ((step.type === 'extract' || step.type === 'ai_extract') && step.outputKey) {
      outputKey = step.outputKey
    } else if (step.type === 'compute' && step.outputKey) {
      outputKey = step.outputKey
    }
    if (!outputKey) continue

    extractedKeys.add(outputKey)
    totalOutputsCount++

    const isUsedInMetrics = declaredMetricKeys.has(outputKey)
    const isUsedInDataRows = declaredDataRowKeys.has(outputKey)
    const isUsedInSummaryTemplate = summaryTemplate.includes(`\${${outputKey}}`)
    const isUsedInSummaryKey = summaryKey === outputKey
    const isUsedInLaterSteps = refsByStepIndex
      .slice(stepIndex + 1)
      .some((refs) => refs.has(outputKey))

    const isCovered = isUsedInMetrics || isUsedInDataRows || isUsedInSummaryTemplate || isUsedInSummaryKey || isUsedInLaterSteps
    if (isCovered) {
      coveredOutputsCount++
    } else {
      findings.push({
        id: `finding-unreported-extract-${step.id}`,
        source: 'audit',
        code: 'UNREPORTED_EXTRACT',
        severity: 'info',
        stepId: step.id,
        stepName: step.name,
        message: `步骤「${step.name}」提取了变量「${outputKey}」，但未在报告指标、宽表或结论中引用`,
        rationale: '提取的数据若不作为指标输出或下游引用，可能属于冗余步骤或遗漏了关键业务结果。',
      })
      suggestedIntents.push({
        id: `suggest-report-${step.id}`,
        intent: {
          key: `acc_audit_rep_${outputKey.slice(-6)}`,
          kind: 'extract_to_report',
          stepId: step.id,
          metricName: step.name.slice(0, 64),
          severity: 'SHOULD',
        },
        label: `将「${step.name}」提取的数值放入业务指标`,
        rationale: '复用已提取的数据，自动声明为场景报告对外呈现的业务指标',
        needsTarget: false,
        source: 'deterministic',
      })
    }
  }

  // 3. 体检新增规则 5：报告无结论
  const hasSummary = Boolean(summaryTemplate.trim() || summaryKey)
  if (!hasSummary) {
    findings.push({
      id: 'finding-missing-summary',
      source: 'audit',
      code: 'MISSING_SUMMARY',
      severity: 'info',
      message: '场景未配置业务结论模板，执行报告将缺少一句话业务结论',
      rationale: '配置业务结论模板可在巡检结束时直接生成简明扼要的业务摘要（如「巡检完成，在售商品 ${count} 件」）。',
    })
  }

  // 4. 体检新增规则 6：无任何耗时观测
  let hasDurationObservation = false
  for (const node of stepNodes) {
    if (node.outcomes?.some((o) => o.rule.kind === 'step_duration')) {
      hasDurationObservation = true
      break
    }
  }
  if (!hasDurationObservation && document.scenarioOutcomes?.some((o) => o.rule.kind === 'run_duration')) {
    hasDurationObservation = true
  }
  if (!hasDurationObservation && outputs?.metrics?.some((m) => m.fromStepDuration || m.fromRunDuration)) {
    hasDurationObservation = true
  }

  if (!hasDurationObservation) {
    findings.push({
      id: 'finding-no-duration',
      source: 'audit',
      code: 'NO_DURATION_OBSERVATION',
      severity: 'info',
      message: '场景未配置任何耗时成功条件或耗时指标',
      rationale: '全流程缺乏耗时观测可能导致响应变慢、接口超时未能及时预警，建议增加全程耗时监控。',
    })
    suggestedIntents.push({
      id: 'suggest-run-duration',
      intent: {
        key: 'acc_audit_run_duration',
        kind: 'scenario_duration',
        maxMs: 60_000,
        severity: 'SHOULD',
      },
      label: '全程耗时监控（默认 60 秒）',
      rationale: '监控整个场景从第一步执行到最后一步完成的耗时',
      needsTarget: false,
      source: 'deterministic',
    })
  }

  // 5. 覆盖度统计
  let coveredBrowserStepsCount = 0
  for (const step of browserSteps) {
    const node = nodeByStepId.get(step.id)
    if (node?.outcomes && node.outcomes.length > 0) {
      coveredBrowserStepsCount++
    }
  }
  // 如果有场景级条件，且包含浏览器步骤，也视作末尾有覆盖
  if ((document.scenarioOutcomes?.length ?? 0) > 0 && browserSteps.length > 0 && coveredBrowserStepsCount === 0) {
    coveredBrowserStepsCount = 1
  }

  const browserStepCoverage = browserSteps.length > 0 ? coveredBrowserStepsCount / browserSteps.length : 1
  const outputMetricCoverage = totalOutputsCount > 0 ? coveredOutputsCount / totalOutputsCount : 1

  return {
    kind: 'acceptance_audit_report',
    scenarioId: scenarioId ?? '00000000-0000-0000-0000-000000000000',
    findings,
    suggestedIntents,
    coverage: {
      browserStepCoverage,
      outputMetricCoverage,
      browserStepsCount: browserSteps.length,
      coveredBrowserStepsCount,
      outputsCount: totalOutputsCount,
      coveredOutputsCount,
    },
  }
}

function collectRefsFromExpr(expr: unknown, target: Set<string>): void {
  if (!expr || typeof expr !== 'object') return
  const e = expr as { kind?: string; key?: string; args?: unknown[]; left?: unknown; right?: unknown; arg?: unknown }
  if (e.kind === 'ref' && typeof e.key === 'string') {
    target.add(e.key)
  }
  if (Array.isArray(e.args)) {
    for (const a of e.args) collectRefsFromExpr(a, target)
  }
  if (e.left) collectRefsFromExpr(e.left, target)
  if (e.right) collectRefsFromExpr(e.right, target)
  if (e.arg) collectRefsFromExpr(e.arg, target)
}
