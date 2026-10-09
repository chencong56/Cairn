import {
  DEFAULT_BROWSER_AI_HANG_WAIT_MS,
  FACTORY_PLATFORM_CONFIG,
  MAP_JOB_EVIDENCE_POLICY,
  RUNTIME_SCHEMA_VERSION,
  CONTROL_FLOW_PROTOCOL,
  assertAiRequestTimeoutFitsSteps,
  freezeExecutorVersions,
  resolveAiTaskEvidence,
  frozenTargetAuthSchema,
  effectiveAccountSessionCap,
  frozenLocatorResolutionSchema,
  LOCATOR_RESOLUTION_PROTOCOL,
  resolveLocatorPlansForSteps,
  parseTargetResolutionPolicy,
  loginScopeFromTargetUrl,
  resolveAiExecutionFromPlatform,
  resolveMapCapturePolicy,
  resolvePlatformEvidencePolicy,
  resolvePlatformExecutionPolicy,
  resolvePlatformSessionPolicy,
  runSnapshotSchema,
  targetSessionPolicyOverrideSchema,
  type AiExecutionConfig,
  type EvidencePolicy,
  type ExecutionPolicy,
  type FrozenAuthVerification,
  type FrozenMapConsumption,
  type FrozenMapJob,
  type FrozenTargetAccessPolicy,
  type JsonValue,
  type MapCapturePolicyOverride,
  type ModuleManifest,
  type OutcomeManifest,
  type RuntimeInvariantManifest,
  type ControlFlowManifest,
  type PlatformConfigDocument,
  type LocatorPlan,
  type LocatorResolution,
  type LocatorRoute,
  type RunSnapshot,
  type RunAs,
  type AccountSource,
  type ScenarioOutputDecl,
  type ServiceDeliveryPolicy,
  type SessionPolicyOverride,
  type Step,
  type SuiteAdmissionSnapshot,
  type ValidationSubject,
} from '@cairn/shared'
import { computeSnapshotDigest } from './digest.js'

export class AssembleRunSnapshotError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'AssembleRunSnapshotError'
  }
}

function parseTargetSessionPolicyOverride(value: unknown) {
  if (value == null) return null
  return targetSessionPolicyOverrideSchema.parse(value)
}

export function resolveAssembledAiExecution(input: {
  steps: readonly Step[]
  platformDocument: PlatformConfigDocument
  platformRevision?: number
  aiExecution?: AiExecutionConfig
  hangWaitMs?: number
  executionPolicyOverride?: ExecutionPolicy
  locatorPlans?: Readonly<Record<string, LocatorResolution>>
}): AiExecutionConfig | undefined {
  const document = input.platformDocument ?? FACTORY_PLATFORM_CONFIG
  const policy = resolvePlatformExecutionPolicy(input.executionPolicyOverride, document.execution)
  const requiredLocatorRoutes = input.locatorPlans
    ? [...new Set(Object.values(input.locatorPlans).flatMap((plan) => plan.actual))] as LocatorRoute[]
    : undefined
  const needsAi = input.steps.some((step) => !step.disabled && (step.type === 'ai_action' || step.type === 'ai_extract' || step.type === 'ai_assert')) ||
    requiredLocatorRoutes?.some((route) => route !== 'rule') === true
  if (!needsAi) return undefined
  let aiExecution = input.aiExecution
  if (!aiExecution) {
    try {
      aiExecution = resolveAiExecutionFromPlatform(input.steps, document, {
        revision: input.platformRevision ?? 1,
        hangWaitMs: input.hangWaitMs ?? DEFAULT_BROWSER_AI_HANG_WAIT_MS,
        policy,
        requiredLocatorRoutes,
      })
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error ? String(error.code) : 'AI_CONFIG_INVALID'
      throw new AssembleRunSnapshotError(code, error instanceof Error ? error.message : '浏览器仿真 AI 配置无效')
    }
  }
  if (!aiExecution) {
    throw new AssembleRunSnapshotError('AI_CONFIG_INVALID', '含 AI 步骤或 AI 解析档位的运行必须冻结 AI 执行配置')
  }
  try {
    assertAiRequestTimeoutFitsSteps(input.steps, policy, aiExecution.requestTimeoutMs)
  } catch (error) {
    throw new AssembleRunSnapshotError(
      'AI_CONFIG_INVALID',
      error instanceof Error ? error.message : 'AI 请求超时配置无效',
    )
  }
  return aiExecution
}

export type AssembleRunSnapshotInput = {
  runId: string
  createdAt: Date
  deadlineAt?: Date
  targetId: string
  targetAccountId?: string
  /** 由所选账号身份类型推出；访客运行不带凭据与认证核验。 */
  runAs?: RunAs
  accountSource?: AccountSource
  secretRef?: RunSnapshot['secretRef']
  credentialBinding?: RunSnapshot['credentialBinding']
  scenarioId: string
  scenarioVersionId: string
  steps: readonly Step[]
  moduleManifest?: ModuleManifest | null
  outcomeManifest?: OutcomeManifest | null
  runtimeInvariantManifest?: RuntimeInvariantManifest | null
  controlFlow?: ControlFlowManifest | null
  input: Record<string, JsonValue>
  sessionPolicyOverride?: SessionPolicyOverride | null
  evidencePolicyOverride?: EvidencePolicy | null
  executionPolicyOverride?: ExecutionPolicy
  mapCapturePolicyOverride?: MapCapturePolicyOverride | null
  mapJob?: FrozenMapJob
  target: {
    entryUrl: string
    loginUrl: string | null
    authMethod: string
    captchaMode: string
    loginFields: unknown
    captcha?: unknown
    sessionPolicy: unknown
    resolutionPolicy?: unknown
    sensitiveSelectors?: string[] | null
    /** Target 级 AI 动作采集开关：'inherit' 沿用平台配置，'off' 关闭。 */
    aiActionTrace?: string | null
  }
  maxConcurrentSessions?: number
  platformDocument: PlatformConfigDocument
  platformRevision?: number
  aiExecution?: AiExecutionConfig
  hangWaitMs?: number
  /** 访客运行不冻结认证核验。 */
  authVerification?: FrozenAuthVerification
  accessPolicy: FrozenTargetAccessPolicy
  mapConsumption: FrozenMapConsumption
  suiteAdmission?: SuiteAdmissionSnapshot
  documentLocatorPlan?: LocatorPlan
  outputs?: ScenarioOutputDecl
  serviceDelivery?: ServiceDeliveryPolicy
  pauseBeforeStepId?: string
  validationSubject?: ValidationSubject
  captureStructure?: boolean
}

export function assembleRunSnapshot(input: AssembleRunSnapshotInput): RunSnapshot & { digest: string } {
  const document = input.platformDocument ?? FACTORY_PLATFORM_CONFIG
  const resolvedSessionPolicy = resolvePlatformSessionPolicy(
    input.sessionPolicyOverride,
    document.session,
    parseTargetSessionPolicyOverride(input.target.sessionPolicy),
  )
  // 访客没有「一个账号同时只能在线一个会话」的问题，并发上限取访客账号自己的设置；
  // 也没有登录态可探测，AUTH_DRIVEN 回收退回 IDLE。
  const sessionPolicy = input.runAs === 'visitor'
    ? {
        ...resolvedSessionPolicy,
        accountSessionMode: 'concurrent' as const,
        reclaim: resolvedSessionPolicy.reclaim === 'AUTH_DRIVEN' ? ('IDLE' as const) : resolvedSessionPolicy.reclaim,
      }
    : resolvedSessionPolicy
  const evidencePolicy = resolvePlatformEvidencePolicy(
    input.mapJob ? MAP_JOB_EVIDENCE_POLICY : input.evidencePolicyOverride,
    document.evidence,
  )
  const policy = resolvePlatformExecutionPolicy(input.executionPolicyOverride, document.execution)
  const targetResolution = parseTargetResolutionPolicy(input.target.resolutionPolicy)
  let locatorPlans: Record<string, LocatorResolution>
  try {
    locatorPlans = resolveLocatorPlansForSteps({
      steps: input.steps,
      document,
      target: targetResolution,
      scenarioPlan: input.documentLocatorPlan,
    })
  } catch (error) {
    throw new AssembleRunSnapshotError('LOCATOR_ROUTE_UNAVAILABLE', error instanceof Error ? error.message : '定位计划不可用')
  }
  const snapshotBase = {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    runId: input.runId,
    targetId: input.targetId,
    targetAccountId: input.targetAccountId,
    ...(input.runAs ? { runAs: input.runAs } : {}),
    ...(input.accountSource ? { accountSource: input.accountSource } : {}),
    secretRef: input.secretRef,
    ...(input.credentialBinding ? { credentialBinding: input.credentialBinding } : {}),
    scenarioId: input.scenarioId,
    scenarioVersionId: input.scenarioVersionId,
    steps: [...input.steps],
    moduleManifest: input.moduleManifest ?? undefined,
    ...(input.moduleManifest?.candidateGroups?.length
      ? { candidateGroups: { groups: input.moduleManifest.candidateGroups } }
      : {}),
    ...(input.outcomeManifest ? { outcomeManifest: input.outcomeManifest } : {}),
    ...(input.runtimeInvariantManifest
      ? { runtimeInvariantManifest: input.runtimeInvariantManifest }
      : {}),
    ...(input.controlFlow
      ? { controlFlow: input.controlFlow }
      : input.steps.some(
          (s) => s.type === 'decide' || s.type === 'probe' || s.type === 'compute' || Boolean(s.optional),
        )
        ? { controlFlow: { protocol: CONTROL_FLOW_PROTOCOL, blocks: [] } }
        : {}),
    ...(input.outputs ? { outputs: input.outputs } : {}),
    ...(input.serviceDelivery ? { serviceDelivery: input.serviceDelivery } : {}),
    ...(input.pauseBeforeStepId ? { pauseBeforeStepId: input.pauseBeforeStepId } : {}),
    ...(input.validationSubject ? { validationSubject: input.validationSubject } : {}),
    ...(input.captureStructure ? { captureStructure: true } : {}),
    input: input.input,
    createdAt: input.createdAt.toISOString(),
    ...(input.deadlineAt ? { deadlineAt: input.deadlineAt.toISOString() } : {}),
    policy,
    sessionPolicy,
    accountSessionEffectiveCap: effectiveAccountSessionCap({
      accountSessionMode: sessionPolicy.accountSessionMode,
      maxConcurrentSessions: input.maxConcurrentSessions,
    }),
    evidencePolicy: {
      ...evidencePolicy,
      captureContractVersion: 1 as const,
      screenshotViewport: evidencePolicy.screenshotViewport,
    },
    executorVersions: freezeExecutorVersions(input.steps.map((step) => step.type)),
    ...loginScopeFromTargetUrl(input.target.entryUrl, input.target.loginUrl),
    targetAuth: frozenTargetAuthSchema.parse({
      entryUrl: input.target.entryUrl,
      loginUrl: input.target.loginUrl,
      authMethod: input.target.authMethod,
      captchaMode: input.target.captchaMode,
      loginFields: input.target.loginFields ?? null,
      captcha: input.target.captcha ?? undefined,
      ...(input.target.sensitiveSelectors?.length
        ? { sensitiveSelectors: input.target.sensitiveSelectors }
        : {}),
    }),
    ...(input.authVerification ? { authVerification: input.authVerification } : {}),
    ...(input.platformRevision ? { platformConfigRevision: input.platformRevision } : {}),
    runAuthRecovery: document.runAuthRecovery,
    aiExecution: resolveAssembledAiExecution({
      steps: input.steps,
      platformDocument: document,
      platformRevision: input.platformRevision,
      aiExecution: input.aiExecution,
      hangWaitMs: input.hangWaitMs,
      executionPolicyOverride: input.executionPolicyOverride,
      locatorPlans,
    }),
    mapCapturePolicy: resolveMapCapturePolicy(
      input.mapJob ? { ...input.mapCapturePolicyOverride, enabled: true } : input.mapCapturePolicyOverride,
      document.mapCapture,
    ),
    ...(() => {
      // 关闭或无 ai_action 时不写字段：旧快照与未启用能力的 Run 的摘要逐字节不变
      const aiTaskEvidence = resolveAiTaskEvidence({
        platform: document.aiPathLearning,
        targetMode: (input.target.aiActionTrace as 'inherit' | 'off' | null | undefined) ?? null,
        steps: input.steps,
      })
      return aiTaskEvidence ? { aiTaskEvidence } : {}
    })(),
  }
  const allowed = [...new Set(Object.values(locatorPlans).flatMap((plan) => plan.allowed))]
  if (allowed.length === 0) allowed.push(...document.locator.limits.allowed)
  const frozenResolution = frozenLocatorResolutionSchema.parse({
    protocol: LOCATOR_RESOLUTION_PROTOCOL,
    allowed,
    steps: Object.fromEntries(Object.entries(locatorPlans).map(([id, plan]) => [id, {
      requested: plan.requested, actual: plan.actual, skipped: plan.skipped, source: plan.source,
    }])),
    ...(input.platformRevision ? { textConfigVersion: String(input.platformRevision), visionConfigVersion: String(input.platformRevision) } : {}),
  })
  const parsed = runSnapshotSchema.parse({
    ...snapshotBase,
    accessPolicy: input.accessPolicy,
    mapConsumption: input.mapConsumption,
    ...(input.mapJob ? { mapJob: input.mapJob } : {}),
    ...(input.suiteAdmission ? { suiteAdmission: input.suiteAdmission } : {}),
    resolution: frozenResolution,
  })
  const digest = computeSnapshotDigest(parsed)
  return runSnapshotSchema.parse({ ...parsed, digest }) as RunSnapshot & { digest: string }
}
