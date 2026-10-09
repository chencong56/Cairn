import {
  isPageLevelAssertExpect,
  COMPILER_VERSION,
  EXECUTABLE_STEP_TYPES,
  FACTORY_COMPILE_RESOLUTION,
  FACTORY_PLATFORM_CONFIG,
  FORBIDDEN_CONTEXT_KEYS,
  LOCATOR_ROUTE_LABELS,
  LOCATOR_SKIP_LABELS,
  ScenarioValidationError,
  WAIT_KINDS_AVAILABLE_NOW,
  assertNoForwardFrom,
  locatorReadiness,
  resolveLocatorPlansForSteps,
  outputShapeForStep,
  stepUsesBrowser,
  type CompileContext,
  type CompileDiagnostic,
  type CompileDiagnosticCode,
  type CompileResult,
  type OutcomeManifest,
  type OutcomeManifestEntry,
  type PlatformConfigDocument,
  type ScenarioDocument,
  type Step,
  type TargetDescriptor,
  isTablePlanUnconfigured,
  validateTableExpectRuleAgainstPlan,
} from '@cairn/shared'
import { parse as parseYaml } from 'yaml'

export function validateAriaSnapshotTemplate(template: string): { valid: boolean; error?: string } {
  if (!template || template.trim().length === 0) {
    return { valid: false, error: '模板内容不能为空' }
  }
  try {
    const parsed = parseYaml(template)
    if (!Array.isArray(parsed)) {
      return { valid: false, error: 'aria_snapshot 模板根节点必须是列表（以 - 开头）' }
    }
    return { valid: true }
  } catch (err) {
    return {
      valid: false,
      error: `YAML 语法错误：${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

type StepFromRef = {
  from: string
  fromField?: string
  fieldPath: string[]
}

function stepFromRefs(step: Step): StepFromRef[] {
  const refs: StepFromRef[] = []
  if (step.type === 'ai_action' && 'operation' in step.input && step.input.operation === 'input') {
    if (step.input.from) refs.push({ from: step.input.from, fromField: step.input.fromField, fieldPath: ['input', 'from'] })
  } else if (step.type === 'echo' || step.type === 'fill' || step.type === 'select') {
    if (step.input.from) refs.push({ from: step.input.from, fromField: step.input.fromField, fieldPath: ['input', 'from'] })
  } else if (step.type === 'upload') {
    for (const [idx, f] of step.input.files.entries()) {
      if (f.source === 'context') {
        const from = (f as any).from ?? (f as any).contextKey
        if (from) refs.push({ from, fromField: f.fromField, fieldPath: ['input', 'files', String(idx), 'from'] })
      }
    }
  }
  if (step.fieldRefs) {
    for (const [targetField, ref] of Object.entries(step.fieldRefs)) {
      refs.push({ from: ref.from, fromField: ref.fromField, fieldPath: ['fieldRefs', targetField] })
    }
  }
  return refs
}

function add(
  diagnostics: CompileDiagnostic[],
  code: CompileDiagnosticCode,
  severity: CompileDiagnostic['severity'],
  message: string,
  extra?: Pick<CompileDiagnostic, 'stepId' | 'inputKey' | 'fieldPath'>,
): void {
  diagnostics.push({ code, severity, message, ...extra })
}

function locatorSteps(step: Step): Extract<Step, { input: { target?: unknown } }>[] {
  if (step.disabled) return []
  if (
    step.type === 'click' ||
    step.type === 'fill' ||
    (step.type === 'extract' && !('source' in step.input && step.input.source === 'file')) ||
    step.type === 'assert' ||
    step.type === 'select' ||
    step.type === 'keyboard' ||
    step.type === 'wait' ||
    step.type === 'upload'
  ) {
    return [step as Extract<Step, { input: { target?: unknown } }>]
  }
  if (step.type === 'download' && step.input.target) {
    return [step as Extract<Step, { input: { target?: unknown } }>]
  }
  return []
}

export function compileScenarioDocument(document: ScenarioDocument, ctx: CompileContext): CompileResult {
  const diagnostics: CompileDiagnostic[] = []
  const executable = ctx.executableTypes ?? EXECUTABLE_STEP_TYPES
  const release = ctx.mode === 'release'
  const resolution = {
    ...FACTORY_COMPILE_RESOLUTION,
    ...ctx.resolution,
    // 计划解析用的平台文档：未显式给时按出厂配置（模型未配置即只剩规则路线）。
    // AI 就绪诊断只看显式传入的 locatorDocument，独立编译不额外报模型未就绪；
    // 出厂默认文档下的路线跳过提示同属噪音，一并静音。
    planDocument: ctx.resolution?.locatorDocument ?? FACTORY_PLATFORM_CONFIG,
    muteLocatorSkips: ctx.resolution?.locatorDocument === undefined,
    documentLocatorPlan: ctx.resolution?.documentLocatorPlan ?? document.locatorPlan,
    waitKindsAvailable: ctx.resolution?.waitKindsAvailable ?? WAIT_KINDS_AVAILABLE_NOW,
  }

  if (document.steps.length === 0) {
    add(diagnostics, 'SCENARIO_EMPTY', 'error', '场景至少需要一步')
  } else if (document.steps.every((step) => step.disabled)) {
    // 没有一步会执行，也就没有一步能成功：放行只会建出一条永远收不了尾的 Run。
    add(diagnostics, 'SCENARIO_ALL_STEPS_DISABLED', 'error', '所有步骤都已停用，至少启用一步才能试跑或发布')
  }

  const declared = new Set(document.inputs.map((input) => input.key))
  const usedInputs = new Set<string>()
  const available = new Set(declared)
  const outputShapes = new Map<string, ReturnType<typeof outputShapeForStep>>()
  const seenInputKeys = new Set<string>()
  const seenStepIds = new Set<string>()
  const seenOutputKeys = new Set<string>()
  const disabledOutputKeys = new Set<string>()

  for (const input of document.inputs) {
    if (seenInputKeys.has(input.key)) {
      add(diagnostics, 'SCENARIO_INPUT_KEY_DUPLICATE', 'error', `输入键「${input.key}」重复`, {
        inputKey: input.key,
      })
    }
    seenInputKeys.add(input.key)
    if ((FORBIDDEN_CONTEXT_KEYS as readonly string[]).includes(input.key)) {
      add(diagnostics, 'SCENARIO_INPUT_KEY_FORBIDDEN', 'error', `输入键「${input.key}」不得使用对象保留名`, {
        inputKey: input.key,
      })
    }
  }

  for (const step of document.steps) {
    if (step.disabled && step.outputKey) {
      disabledOutputKeys.add(step.outputKey)
    }
    if (seenStepIds.has(step.id)) {
      add(diagnostics, 'SCENARIO_STEP_ID_DUPLICATE', 'error', `步骤「${step.name}」的 id 与另一步重复`, {
        stepId: step.id,
      })
    }
    seenStepIds.add(step.id)
    if (step.outputKey) {
      if (seenOutputKeys.has(step.outputKey)) {
        add(diagnostics, 'SCENARIO_OUTPUT_KEY_DUPLICATE', 'error', `输出名称「${step.outputKey}」重复`, {
          stepId: step.id,
        })
      }
      seenOutputKeys.add(step.outputKey)
    }
    const requiresVisualModel = step.type === 'ai_action' || step.type === 'ai_extract' || step.type === 'ai_assert'
    if (requiresVisualModel && resolution.locatorDocument && !locatorReadiness(resolution.locatorDocument).visionReady) {
      add(diagnostics, 'SCENARIO_AI_UNAVAILABLE', release ? 'error' : 'warning',
        `步骤「${step.name}」${step.type === 'ai_action' ? '是视觉操作' : '可能回退到视觉模型'}，请先在平台配置中启用并完善浏览器 AI 视觉模型及绑定密钥`,
        { stepId: step.id, fieldPath: ['type'] })
    } else if (!(executable as readonly string[]).includes(step.type)) {
      add(diagnostics, 'SCENARIO_UNKNOWN_STEP_TYPE', 'error', `步骤「${step.name}」的类型尚未开放`, {
        stepId: step.id,
      })
    }

    const refs = stepFromRefs(step)
    for (const { from, fromField, fieldPath } of refs) {
      if (declared.has(from)) usedInputs.add(from)
      if (!step.disabled && disabledOutputKeys.has(from)) {
        add(
          diagnostics,
          'SCENARIO_DISABLED_STEP_OUTPUT_REFERENCED',
          'warning',
          `步骤「${step.name}」引用的输出变量「${from}」来自已被禁用的步骤`,
          { stepId: step.id, inputKey: from, fieldPath },
        )
      }
      if (!available.has(from)) {
        add(
          diagnostics,
          'SCENARIO_UNRESOLVED_REF',
          release ? 'error' : 'warning',
          `步骤「${step.name}」的 from=${from} 不是已声明输入或更早步骤的 outputKey`,
          { stepId: step.id, inputKey: from, fieldPath },
        )
      } else {
        const shape = outputShapes.get(from)
        if (shape?.kind === 'list') {
          add(
            diagnostics,
            'SCENARIO_FROM_LIST_NOT_TEXT',
            'error',
            `步骤「${step.name}」引用的输出「${from}」是列表，不能直接作为文本使用`,
            { stepId: step.id, inputKey: from, fieldPath },
          )
        }
        if (shape?.kind === 'object' && !fromField) {
          add(
            diagnostics,
            'SCENARIO_FROM_FIELD_MISSING',
            'error',
            `步骤「${step.name}」的 from=${from} 是对象输出，必须指定 fromField`,
            { stepId: step.id, inputKey: from, fieldPath: [...fieldPath.slice(0, -1), 'fromField'] },
          )
        }
        if (fromField) {
          if (shape?.kind === 'object') {
            if (!shape.fields.some((field) => field.name === fromField)) {
              add(
                diagnostics,
                'SCENARIO_FROM_FIELD_UNKNOWN',
                'error',
                `步骤「${step.name}」的 fromField=${fromField} 不在 ${from} 的输出字段中`,
                { stepId: step.id, inputKey: from, fieldPath: [...fieldPath.slice(0, -1), 'fromField'] },
              )
            }
          } else if (shape && shape.kind !== 'unknown') {
            add(
              diagnostics,
              'SCENARIO_FROM_FIELD_UNKNOWN',
              'error',
              `步骤「${step.name}」的 from=${from} 不是对象，不能使用 fromField`,
              { stepId: step.id, inputKey: from, fieldPath: [...fieldPath.slice(0, -1), 'fromField'] },
            )
          }
        }
      }
    }
    if (step.outputKey) {
      available.add(step.outputKey)
      outputShapes.set(step.outputKey, outputShapeForStep(step))
    }
    if (step.type === 'loop') {
      const loopInput = step.input as any
      if (loopInput?.control?.type === 'for_each') {
        if (loopInput.control.as) {
          available.add(loopInput.control.as)
          outputShapes.set(loopInput.control.as, { kind: 'unknown' })
        }
        if (loopInput.control.indexAs) {
          available.add(loopInput.control.indexAs)
          outputShapes.set(loopInput.control.indexAs, { kind: 'scalar', type: 'number' })
        }
      }
      for (const rule of loopInput?.collect ?? []) {
        if (rule.into) {
          available.add(rule.into)
          outputShapes.set(rule.into, { kind: 'list', item: { kind: 'scalar', type: 'json' } })
        }
      }
    }

    if ((step.type === 'extract' || step.type === 'ai_extract') && !step.outputKey) {
      add(diagnostics, 'SCENARIO_EXTRACT_NO_OUTPUT_KEY', 'warning', `提取步骤「${step.name}」没有 outputKey，后续步骤无法引用`, {
        stepId: step.id,
      })
    }
    if (step.type === 'ai_action' && (step.policy?.retryLimit ?? 0) > 0) {
      add(diagnostics, 'SCENARIO_AI_RETRY_FORBIDDEN', 'error', `步骤「${step.name}」是视觉操作，不允许自动重试`, {
        stepId: step.id,
        fieldPath: ['policy', 'retryLimit'],
      })
    }

    if (
      (step.type === 'ai_action' || step.type === 'ai_extract' || step.type === 'ai_assert') &&
      'contextBindings' in step &&
      Array.isArray((step as any).contextBindings)
    ) {
      const bindings = (step as any).contextBindings
      const seenBindingNames = new Set<string>()
      const RESERVED_NAMES = new Set([
        '__proto__',
        'constructor',
        'prototype',
        'context',
        'steps',
        'input',
        'scenario',
        'document',
        'window',
        'env',
      ])

      for (const binding of bindings) {
        if (!binding.name || typeof binding.name !== 'string') {
          add(diagnostics, 'SCENARIO_AI_CONTEXT_BINDING_INVALID', 'error', `步骤「${step.name}」的 contextBindings 缺少有效绑定名`, {
            stepId: step.id,
          })
          continue
        }
        if (seenBindingNames.has(binding.name)) {
          add(
            diagnostics,
            'SCENARIO_AI_CONTEXT_BINDING_INVALID',
            'error',
            `步骤「${step.name}」的 contextBindings 包含重复的绑定名「${binding.name}」`,
            { stepId: step.id },
          )
        }
        seenBindingNames.add(binding.name)

        if (RESERVED_NAMES.has(binding.name)) {
          add(
            diagnostics,
            'SCENARIO_AI_CONTEXT_BINDING_INVALID',
            'error',
            `步骤「${step.name}」的绑定名「${binding.name}」与系统保留字段冲突`,
            { stepId: step.id },
          )
        }

        if (
          binding.path &&
          (binding.path.includes('__proto__') ||
            binding.path.includes('constructor') ||
            binding.path.includes('prototype'))
        ) {
          add(
            diagnostics,
            'SCENARIO_AI_CONTEXT_BINDING_INVALID',
            'error',
            `步骤「${step.name}」的绑定「${binding.name}」path 包含非法的原型属性`,
            { stepId: step.id },
          )
        }

        const source = binding.source
        if (typeof source !== 'string') {
          add(diagnostics, 'SCENARIO_AI_CONTEXT_BINDING_INVALID', 'error', `步骤「${step.name}」的绑定「${binding.name}」缺少有效 source`, {
            stepId: step.id,
          })
          continue
        }

        if (source.startsWith('input.')) {
          const inputKey = source.slice('input.'.length).split('.')[0]
          if (!inputKey || (declared.size > 0 && !declared.has(inputKey))) {
            add(
              diagnostics,
              'SCENARIO_AI_CONTEXT_BINDING_UNRESOLVED',
              release ? 'error' : 'warning',
              `步骤「${step.name}」的 contextBindings 引用了未定义的场景输入「${inputKey ?? ''}」`,
              { stepId: step.id },
            )
          } else {
            usedInputs.add(inputKey)
          }
        } else if (source.startsWith('steps.')) {
          const parts = source.slice('steps.'.length).split('.')
          const targetStepId = parts[0]
          // seenStepIds contains previous steps up to and including current step, so check targetStepId !== step.id
          if (!targetStepId || !seenStepIds.has(targetStepId) || targetStepId === step.id) {
            add(
              diagnostics,
              'SCENARIO_AI_CONTEXT_BINDING_UNRESOLVED',
              release ? 'error' : 'warning',
              `步骤「${step.name}」的 contextBindings 引用了不存在或后置的步骤「${targetStepId ?? ''}」`,
              { stepId: step.id },
            )
          }
        } else {
          add(
            diagnostics,
            'SCENARIO_AI_CONTEXT_BINDING_INVALID',
            'error',
            `步骤「${step.name}」的绑定「${binding.name}」source 格式非法，须以 input. 或 steps. 开头`,
            { stepId: step.id },
          )
        }
      }
    }

    if (step.type === 'wait' && step.input.kind === 'semantic') {
      const available = resolution.waitKindsAvailable ?? WAIT_KINDS_AVAILABLE_NOW
      if (!available.includes('semantic')) {
        add(
          diagnostics,
          'SCENARIO_WAIT_KIND_UNAVAILABLE',
          release ? 'error' : 'warning',
          `步骤「${step.name}」的语义等待尚未开放运行时`,
          { stepId: step.id, fieldPath: ['input', 'kind'] },
        )
      }
    }

    if (step.type === 'assert' && step.input.expect.kind === 'aria_snapshot') {
      const res = validateAriaSnapshotTemplate(step.input.expect.template)
      if (!res.valid) {
        add(
          diagnostics,
          'SCENARIO_ASSERT_TEMPLATE_INVALID',
          'error',
          `步骤「${step.name}」的 ${res.error}`,
          { stepId: step.id, fieldPath: ['input', 'expect', 'template'] },
        )
      }
    }

    for (const located of locatorSteps(step)) {
      const target = 'target' in located.input ? located.input.target : undefined
      addTargetResolutionDiagnostics(diagnostics, located, target, resolution, release)
    }
  }

  try {
    assertNoForwardFrom(document.steps)
  } catch (error) {
    if (error instanceof ScenarioValidationError) {
      const step = document.steps.find((item) => error.message.includes(`「${item.name}」`))
      add(diagnostics, 'SCENARIO_FORWARD_REF', 'error', error.message, step ? { stepId: step.id } : undefined)
    } else {
      throw error
    }
  }

  const unusedReported = new Set<string>()
  for (const input of document.inputs) {
    if (!usedInputs.has(input.key) && !unusedReported.has(input.key)) {
      unusedReported.add(input.key)
      add(diagnostics, 'SCENARIO_INPUT_UNUSED', 'warning', `声明的输入「${input.label}」没有被任何步骤引用`, {
        inputKey: input.key,
      })
    }
  }

  if (document.outputs) {
    const docStepIds = new Set(document.steps.map((s) => s.id))
    if (document.outputs.metrics) {
      for (const m of document.outputs.metrics) {
        if (m.fromContextKey) {
          if (!available.has(m.fromContextKey)) {
            add(
              diagnostics,
              'OUTPUT_VARIABLE_UNRESOLVED',
              'warning',
              `业务输出指标「${m.name}」引用的变量「${m.fromContextKey}」未在输入或任何步骤的 outputKey 中定义`,
              { fieldPath: ['outputs', 'metrics', m.key, 'fromContextKey'] },
            )
          }
        } else if (m.fromStepDuration) {
          if (!docStepIds.has(m.fromStepDuration.stepId)) {
            add(
              diagnostics,
              'OUTPUT_VARIABLE_UNRESOLVED',
              'warning',
              `业务输出指标「${m.name}」引用的步骤「${m.fromStepDuration.stepId}」不存在`,
              { fieldPath: ['outputs', 'metrics', m.key, 'fromStepDuration', 'stepId'] },
            )
          }
        }
      }
    }
    if (document.outputs.dataRowFields) {
      for (const f of document.outputs.dataRowFields) {
        if (!available.has(f.fromContextKey)) {
          add(
            diagnostics,
            'OUTPUT_VARIABLE_UNRESOLVED',
            'warning',
            `业务输出数据列「${f.columnHeader}」引用的变量「${f.fromContextKey}」未在输入或任何步骤的 outputKey 中定义`,
            { fieldPath: ['outputs', 'dataRowFields', f.columnKey, 'fromContextKey'] },
          )
        }
      }
    }
    if (document.outputs.summaryFromContextKey && !available.has(document.outputs.summaryFromContextKey)) {
      add(
        diagnostics,
        'OUTPUT_VARIABLE_UNRESOLVED',
        'warning',
        `业务输出结论引用的变量「${document.outputs.summaryFromContextKey}」未在输入或任何步骤的 outputKey 中定义`,
        { fieldPath: ['outputs', 'summaryFromContextKey'] },
      )
    }
    if (document.outputs.summaryTemplate) {
      const summaryKeys = new Set([...available, ...(document.outputs.metrics ?? []).map((metric) => metric.key)])
      const matches = document.outputs.summaryTemplate.matchAll(/\$\{([^}]+)\}/g)
      for (const match of matches) {
        const token = match[1]
        if (!token || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(token)) {
          add(
            diagnostics,
            'OUTPUT_VARIABLE_UNRESOLVED',
            release ? 'error' : 'warning',
            `业务输出结论模板包含非法的变量插值「\${${token}}」`,
            { fieldPath: ['outputs', 'summaryTemplate'] },
          )
        } else if (!summaryKeys.has(token)) {
          add(
            diagnostics,
            'OUTPUT_VARIABLE_UNRESOLVED',
            release ? 'error' : 'warning',
            `业务输出结论模板引用的变量「${token}」未在输入、步骤输出或业务指标中定义`,
            { fieldPath: ['outputs', 'summaryTemplate'] },
          )
        }
      }
    }
  }

  addOutcomeCoverageDiagnostics(diagnostics, document, ctx.outcomeManifest, release)
  addTableCheckDiagnostics(diagnostics, document, ctx.outcomeManifest, release)
  addTableFileSourceDiagnostics(diagnostics, document, release)

  if (ctx.target) {
    if (!ctx.target.exists) {
      add(diagnostics, 'SCENARIO_TARGET_MISSING', 'error', '绑定的目标系统不存在')
    } else if (ctx.target.status === 'disabled') {
      add(diagnostics, 'SCENARIO_TARGET_DISABLED', release ? 'error' : 'warning', '绑定的目标系统已停用')
    }
  }

  return {
    ok: diagnostics.every((item) => item.severity !== 'error'),
    compilerVersion: COMPILER_VERSION,
    definition: document,
    diagnostics,
  }
}

/**
 * 文件来源的提取必须指向本步之前、未停用的下载步骤输出；否则运行时拿不到文件。
 */
function addTableFileSourceDiagnostics(diagnostics: CompileDiagnostic[], document: ScenarioDocument, release: boolean): void {
  document.steps.forEach((step, index) => {
    if (step.disabled || step.type !== 'extract' || !('source' in step.input) || step.input.source !== 'file') return
    const fromKey = step.input.table.fromKey
    const source = document.steps.slice(0, index).find((s) => !s.disabled && s.type === 'download' && s.outputKey === fromKey)
    if (!source) {
      add(
        diagnostics,
        'SCENARIO_TABLE_FILE_SOURCE_INVALID',
        release ? 'error' : 'warning',
        `「${step.name}」要读的文件「${fromKey}」不是本步之前某个下载步骤的输出，请先加下载步骤并填写输出名`,
        { stepId: step.id },
      )
    }
  })
}

/**
 * 表格数据检查必须和读取计划对得上：引用的列要存在、聚合只用数字列、卡片 / 键值没有“合计行”。
 * 否则重新点选换了表之后，旧检查会在运行时悄悄变成“无法确认”。
 */
function addTableCheckDiagnostics(
  diagnostics: CompileDiagnostic[],
  document: ScenarioDocument,
  manifest: OutcomeManifest | null | undefined,
  release: boolean,
): void {
  for (const entry of manifest?.entries ?? []) {
    if (entry.rule.kind !== 'context' || entry.rule.expect.kind !== 'table') continue
    const key = entry.rule.key
    const source = document.steps.find(
      (step) => !step.disabled && step.type === 'extract' && step.input.as === 'table' && step.outputKey === key,
    )
    if (!source || source.type !== 'extract' || source.input.as !== 'table') continue
    const plan = source.input.table
    const rule = entry.rule.expect.rule
    const kind = plan.protocol === 'table.read@2' ? plan.kind : undefined
    let message: string | null = null
    if (rule.rule === 'total_row_match' && (kind === 'cards' || kind === 'keyvalue')) {
      message = '卡片和详情信息没有合计行，不能做“各行相加等于合计行”'
    } else if ((rule.rule === 'page_total' || rule.rule === 'page_consistency') && kind === 'keyvalue') {
      message = '详情信息没有分页，不能做分页检查'
    } else {
      const checked = validateTableExpectRuleAgainstPlan(rule, plan.columns)
      if (!checked.valid) message = checked.message
    }
    if (message) {
      add(
        diagnostics,
        'SCENARIO_TABLE_CHECK_INVALID',
        release ? 'error' : 'warning',
        `数据检查「${entry.meaning}」与读取的数据对不上：${message}。请修改或删除这条检查`,
        { stepId: source.id },
      )
    }
  }
}

function synthesizedOutcomeEntries(document: ScenarioDocument): OutcomeManifestEntry[] {
  return document.steps
    .filter((step) => !step.disabled)
    .filter((step) => step.type === 'assert' || step.type === 'ai_assert')
    .map((step) => ({
      contractId: step.id,
      scope: 'step' as const,
      meaning: step.name,
      severity: 'MUST' as const,
      onViolation: 'halt' as const,
      provenance: 'legacy_assert' as const,
      stepId: step.id,
      rule:
        step.type === 'assert'
          ? {
              kind: 'deterministic' as const,
              ...(step.input.target ? { target: step.input.target } : {}),
              expect: step.input.expect,
            }
          : { kind: 'ai' as const, instruction: step.input.instruction },
    }))
}

function addOutcomeTargetMissingDiagnostics(
  diagnostics: CompileDiagnostic[],
  entries: OutcomeManifestEntry[],
  release: boolean,
): void {
  for (const entry of entries) {
    if (entry.rule.kind !== 'deterministic') continue
    if (isPageLevelAssertExpect(entry.rule.expect)) continue
    if (entry.rule.target) continue
    add(
      diagnostics,
      'OUTCOME_RULE_TARGET_MISSING',
      release ? 'error' : 'warning',
      `成功条件「${entry.meaning}」还没有从页面选择要检查的对象`,
      { stepId: entry.sourceStepId ?? entry.stepId },
    )
  }
}

function addOutcomeCoverageDiagnostics(
  diagnostics: CompileDiagnostic[],
  document: ScenarioDocument,
  manifest: OutcomeManifest | null | undefined,
  release: boolean,
): void {
  const hasBrowser = document.steps.some((step) => stepUsesBrowser(step.type))
  if (!hasBrowser) return

  if (manifest?.entries) {
    addOutcomeTargetMissingDiagnostics(diagnostics, manifest.entries, release)
  }
  const entries = manifest?.entries ?? synthesizedOutcomeEntries(document)
  if (entries.length === 0) {
    add(diagnostics, 'SCENARIO_NO_OUTCOME', 'warning', '含浏览器步骤的场景没有成功条件')
    return
  }

  const active = entries.filter((entry) => entry.severity !== 'INFO')
  if (active.length === 0) {
    add(diagnostics, 'SCENARIO_OUTCOME_INFO_ONLY', 'warning', '场景只有提示级成功条件，没有必须或应当成立的条件')
  }

  if (active.some((entry) => entry.scope === 'scenario')) return

  const indexByStepId = new Map(document.steps.map((step, index) => [step.id, index]))
  const coveringIndexes = active
    .map((entry) => {
      const source = entry.sourceStepId ? indexByStepId.get(entry.sourceStepId) : undefined
      const bound = indexByStepId.get(entry.stepId)
      if (source !== undefined && bound !== undefined) return Math.min(source, bound)
      return source ?? bound
    })
    .filter((index): index is number => index !== undefined)
  const lastCover = coveringIndexes.length > 0 ? Math.max(...coveringIndexes) : -1

  for (const [index, step] of document.steps.entries()) {
    if (step.disabled || !stepUsesBrowser(step.type) || step.effectType !== 'SIDE_EFFECT') continue
    if (lastCover < index) {
      add(
        diagnostics,
        'SCENARIO_SIDE_EFFECT_WITHOUT_OUTCOME',
        'warning',
        `步骤「${step.name}」会改动页面，其后没有成功条件`,
        { stepId: step.id },
      )
    }
  }
}

function addTargetResolutionDiagnostics(
  diagnostics: CompileDiagnostic[],
  step: Step,
  target: TargetDescriptor | undefined,
  resolution: NonNullable<CompileContext['resolution']> & {
    planDocument: PlatformConfigDocument
    muteLocatorSkips?: boolean
    waitKindsAvailable?: readonly string[]
  },
  release: boolean,
): void {
  if (!target) return
  // 结构化数据读取（表格 / 列表）：表根由读取计划自己解析、只用规则，不走定位阶梯；
  // 没点选过表格的占位计划在发布时拦截，草稿里给出提醒。
  if (step.type === 'extract' && step.input.as === 'table') {
    if (isTablePlanUnconfigured(step.input.table)) {
      add(diagnostics, 'SCENARIO_TABLE_UNCONFIGURED', release ? 'error' : 'warning',
        `步骤「${step.name}」还没有选择要读取的表格，请在受管画面上点一下表格`,
        { stepId: step.id, fieldPath: ['input', 'table'] })
    }
    return
  }
  if (step.type === 'assert') {
    if (target.candidates.length === 0) add(diagnostics, 'SCENARIO_TARGET_EMPTY', release ? 'error' : 'warning',
      `步骤「${step.name}」的成功条件只使用规则判定，请提供规则候选`,
      { stepId: step.id, fieldPath: ['input', 'target', 'candidates'] })
    return
  }
  let plan
  try {
    plan = resolveLocatorPlansForSteps({
      steps: [step],
      document: resolution.planDocument,
      target: resolution.locatorTarget,
      scenarioPlan: resolution.documentLocatorPlan,
    })[step.id]!
  } catch (error) {
    add(diagnostics, 'SCENARIO_LOCATOR_UNAVAILABLE', release ? 'error' : 'warning',
      `步骤「${step.name}」定位方式不可用：${error instanceof Error ? error.message : '请检查模型配置'}`,
      { stepId: step.id, fieldPath: ['policy', 'locatorPlan'] })
    return
  }
  if (!resolution.muteLocatorSkips) {
    for (const skipped of plan.skipped) {
      add(diagnostics, 'SCENARIO_LOCATOR_SKIPPED', 'warning',
        `步骤「${step.name}」继承的${LOCATOR_ROUTE_LABELS[skipped.route]}定位路线已跳过：${LOCATOR_SKIP_LABELS[skipped.reason]}`,
        { stepId: step.id, fieldPath: ['policy', 'locatorPlan'] })
    }
  }
  const usesModel = plan.actual.some((route) => route !== 'rule')
  const hasRules = target.candidates.length > 0
  if (plan.actual.includes('rule') && !hasRules) {
    add(diagnostics, 'SCENARIO_TARGET_EMPTY', release ? 'error' : 'warning',
      `步骤「${step.name}」的定位顺序包含规则，但没有规则定位候选`,
      { stepId: step.id, fieldPath: ['input', 'target', 'candidates'] })
  }
  if (usesModel && !target.semantic?.trim() && (!hasRules || target.candidates.every((candidate) => candidate.by === 'css'))) {
    // 纯模型路线下 CSS 无法喂给模型，必失败，保持硬阻断；
    // 含规则路线时规则仍可命中，模型兜底缺描述只是退化，提示即可。
    const pureModel = !plan.actual.includes('rule')
    add(diagnostics, 'SCENARIO_MODEL_DESCRIPTION_REQUIRED', pureModel ? 'error' : 'warning',
      pureModel
        ? `步骤「${step.name}」请填写「要找的页面元素」；仅有 CSS 无法作为模型目标描述`
        : `步骤「${step.name}」只有 CSS 候选且缺少「要找的页面元素」，规则未命中时模型兜底不可用`,
      { stepId: step.id, fieldPath: ['input', 'target', 'semantic'] })
  }
  if (usesModel && (step.effectType === 'SIDE_EFFECT' || step.effectType === 'IDEMPOTENT')) {
    const identity = target.candidates.some((candidate) =>
      candidate.by === 'role' ? Boolean(candidate.name?.trim())
        : candidate.by === 'label' || candidate.by === 'text' || candidate.by === 'title' ? Boolean(candidate.value.trim()) : false)
    const pureModel = Boolean(step.policy?.locatorPlan && step.policy.locatorPlan.order.every((route) => route !== 'rule'))
    if (!identity) add(diagnostics, 'SCENARIO_MODEL_WRITE_IDENTITY_REQUIRED', pureModel ? 'warning' : release ? 'error' : 'warning',
      pureModel
        ? `步骤「${step.name}」显式选择纯模型写操作，缺少独立身份核对；请填写明确目标描述并检查运行证据`
        : `步骤「${step.name}」缺少可核对的角色名称或可见文字，模型定位后会阻止写操作`,
      { stepId: step.id, fieldPath: ['input', 'target', 'candidates'] })
  }
  const hasSemanticLocator = target.candidates.some((candidate) => candidate.by !== 'css')
  if (target.candidates.length > 0 && !hasSemanticLocator) {
    add(
      diagnostics,
      'SCENARIO_WEAK_LOCATOR',
      'warning',
      `步骤「${step.name}」只用 CSS 定位，缺少 role / label / text 等语义候选`,
      { stepId: step.id },
    )
  }
}
