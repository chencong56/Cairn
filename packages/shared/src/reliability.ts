import { z } from 'zod'

export const RELIABILITY_SIGNAL_KINDS = [
  // v2 新增
  'step_failed',
  'step_retried',
  'locator_fallback',
  'latency_regression',
  'locator_drift_suspected',
  // 启用
  'session_fault',
  // v1 旧值只读保留
  'resolution_fallback',
  'resolution_slow',
  'resolution_drift',
  // 预留值
  'invariant_violation',
  'outcome_failure',
  'input_invalid',
  'structure_candidate',
] as const
export type ReliabilitySignalKind = (typeof RELIABILITY_SIGNAL_KINDS)[number]
export const reliabilitySignalKindSchema = z.enum(RELIABILITY_SIGNAL_KINDS)

export const RELIABILITY_SIGNAL_SEVERITIES = ['INFO', 'WARN', 'ERROR', 'CRITICAL'] as const
export type ReliabilitySignalSeverity = (typeof RELIABILITY_SIGNAL_SEVERITIES)[number]
export const reliabilitySignalSeveritySchema = z.enum(RELIABILITY_SIGNAL_SEVERITIES)

export interface ReliabilitySignalMeta {
  kind: ReliabilitySignalKind
  label: string
  severity: ReliabilitySignalSeverity
  description: string
  isLegacy?: boolean
}

export const RELIABILITY_SIGNAL_METAS: Record<ReliabilitySignalKind, ReliabilitySignalMeta> = {
  step_failed: {
    kind: 'step_failed',
    label: '步骤执行失败（原因待诊断）',
    severity: 'ERROR',
    description: 'StepRun 最终执行状态为失败，或最终有效 Attempt 失败且无后续成功结论。',
  },
  step_retried: {
    kind: 'step_retried',
    label: '步骤发生重试',
    severity: 'INFO',
    description: '同一 StepRun 存在尝试序号大于 1 的真实执行 Attempt。',
  },
  locator_fallback: {
    kind: 'locator_fallback',
    label: '定位使用备用路线',
    severity: 'WARN',
    description: '首选定位路线未命中或有歧义，由后续备用路线成功定位。',
  },
  latency_regression: {
    kind: 'latency_regression',
    label: '执行耗时异常上升',
    severity: 'WARN',
    description: '平滑观测耗时超过先前已就绪参考基线的 1.5 倍阈值。',
  },
  locator_drift_suspected: {
    kind: 'locator_drift_suspected',
    label: '疑似定位漂移',
    severity: 'WARN',
    description: '最终有效 Attempt 因白名单内定位未命中失败且无业务拒绝断言，怀疑目标页面结构发生变化。',
  },
  session_fault: {
    kind: 'session_fault',
    label: '会话或凭据不可恢复故障',
    severity: 'ERROR',
    description: '受管会话发生不可恢复的认证或凭据故障。',
  },
  resolution_fallback: {
    kind: 'resolution_fallback',
    label: '备用定位介入（旧规则）',
    severity: 'WARN',
    description: '历史旧规则记录的备用定位介入事实。',
    isLegacy: true,
  },
  resolution_slow: {
    kind: 'resolution_slow',
    label: '步骤发生重试（旧规则：耗时未判定）',
    severity: 'INFO',
    description: '历史旧规则将重试后成功记为变慢，实际耗时未独立判定。',
    isLegacy: true,
  },
  resolution_drift: {
    kind: 'resolution_drift',
    label: '旧规则记录的步骤异常（原因待核实）',
    severity: 'WARN',
    description: '历史旧规则记录的步骤异常，原因待核实。',
    isLegacy: true,
  },
  invariant_violation: {
    kind: 'invariant_violation',
    label: '断言或守卫违规',
    severity: 'ERROR',
    description: '执行期间发生运行时不变量破坏或守卫拒绝。',
  },
  outcome_failure: {
    kind: 'outcome_failure',
    label: '业务结果判定失败',
    severity: 'ERROR',
    description: '业务断言或输出验证失败。',
  },
  input_invalid: {
    kind: 'input_invalid',
    label: '输入数据非法',
    severity: 'ERROR',
    description: '步骤输入参数校验不通过。',
  },
  structure_candidate: {
    kind: 'structure_candidate',
    label: '结构变更候选',
    severity: 'INFO',
    description: '目标结构变更被作为候选提取。',
  },
}

export function getReliabilitySignalMeta(kind: string): ReliabilitySignalMeta {
  return (
    RELIABILITY_SIGNAL_METAS[kind as ReliabilitySignalKind] ?? {
      kind: kind as ReliabilitySignalKind,
      label: kind,
      severity: 'WARN',
      description: '未知信号类型',
    }
  )
}

/**
 * 错误族进入事件分组键（`err:` 段），必须限制在 `[A-Z0-9_]` 字符集内：
 * 冒号/空格等会破坏分组键的位置解析与窗口匹配。动态报错文本一律不作为错误族。
 */
function sanitizeErrorFamilyToken(raw: string): string {
  const token = raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32)
  return token || 'NONE'
}

export function normalizeErrorFamily(
  kind: ReliabilitySignalKind,
  rawError?: unknown,
  reasonCode?: string | null,
): string {
  if (kind !== 'step_failed' && kind !== 'locator_drift_suspected') {
    return 'NONE'
  }
  if (rawError && typeof rawError === 'object') {
    const rec = rawError as Record<string, unknown>
    if (typeof rec.code === 'string' && rec.code.trim()) {
      return sanitizeErrorFamilyToken(rec.code)
    }
    if (typeof rec.name === 'string' && rec.name.trim()) {
      return sanitizeErrorFamilyToken(rec.name)
    }
  }
  if (typeof rawError === 'string' && rawError.trim()) {
    return sanitizeErrorFamilyToken(rawError)
  }
  if (reasonCode && typeof reasonCode === 'string' && reasonCode.trim()) {
    return sanitizeErrorFamilyToken(`RES_${reasonCode}`)
  }
  return 'NONE'
}

export const reliabilitySignalDtoSchema = z.object({
  id: z.string(),
  targetId: z.string(),
  kind: reliabilitySignalKindSchema,
  severity: reliabilitySignalSeveritySchema,
  subjectRef: z.object({
    kind: z.enum(['map_object', 'module_step', 'scenario_step', 'run', 'outcome', 'account']),
    id: z.string(),
    objectId: z.string().optional(),
    stepId: z.string().optional(),
    moduleId: z.string().optional(),
    scenarioId: z.string().optional(),
    implementationKey: z.string().optional(),
    internalStepId: z.string().optional(),
    accountId: z.string().optional(),
  }),
  sourceRef: z.object({
    kind: z.enum(['run', 'attempt', 'step_run', 'window_sample', 'map_observation', 'validation', 'run_event']),
    id: z.string(),
    runId: z.string().optional(),
    attemptId: z.string().optional(),
    stepRunId: z.string().optional(),
    revision: z.string().optional(),
    baselineRevisionId: z.string().optional(),
    eventId: z.string().optional(),
  }),
  sourceKind: z.string().optional(),
  sourceId: z.string().optional(),
  errorFamily: z.string().optional(),
  occurredAt: z.string(),
  commitPosition: z.number().optional(),
  value: z.number().optional(),
  unit: z.string().optional(),
  scopeDigest: z.string(),
  groupingKey: z.string().optional(),
  availability: z.enum(['available', 'missing', 'truncated']),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string(),
})
export type ReliabilitySignalDto = z.infer<typeof reliabilitySignalDtoSchema>

export const FEATURE_WINDOW_TYPES = ['hourly', 'sliding_30_runs'] as const
export type FeatureWindowType = (typeof FEATURE_WINDOW_TYPES)[number]
export const featureWindowTypeSchema = z.enum(FEATURE_WINDOW_TYPES)

export const featureWindowDtoSchema = z.object({
  id: z.string(),
  targetId: z.string(),
  scopeDigest: z.string(),
  windowType: featureWindowTypeSchema,
  windowStart: z.string(),
  windowEnd: z.string(),
  metricVersion: z.string(),
  sampleCount: z.number(),
  primaryHitCount: z.number(),
  fallbackCount: z.number(),
  retryStepCount: z.number(),
  ewmaLatencyMs: z.number(),
  ewmaSuccessRate: z.number(),
  stats: z.record(z.string(), z.unknown()),
  updatedAt: z.string(),
})
export type FeatureWindowDto = z.infer<typeof featureWindowDtoSchema>

export const BASELINE_KINDS = ['structural', 'behavioral', 'business', 'input_quality'] as const
export type BaselineKind = (typeof BASELINE_KINDS)[number]
export const baselineKindSchema = z.enum(BASELINE_KINDS)

export const baselineRevisionDtoSchema = z.object({
  id: z.string(),
  targetId: z.string(),
  scopeDigest: z.string(),
  baselineKind: baselineKindSchema,
  algorithmVersion: z.string(),
  sampleFloor: z.number(),
  stats: z.record(z.string(), z.unknown()),
  status: z.enum(['ready', 'insufficient', 'unavailable']),
  excludedReasons: z.array(z.string()).optional(),
  createdAt: z.string(),
})
export type BaselineRevisionDto = z.infer<typeof baselineRevisionDtoSchema>

export const watermarkVectorSchema = z.object({
  runCompletedSeq: z.number(),
  mapCommittedSeq: z.number(),
  validationSeq: z.number(),
})
export type WatermarkVector = z.infer<typeof watermarkVectorSchema>

export const reliabilityEvaluationDtoSchema = z.object({
  id: z.string(),
  targetId: z.string(),
  scopeDigest: z.string(),
  watermarkVector: watermarkVectorSchema,
  generation: z.number(),
  rulesEvaluated: z.number(),
  breachesCount: z.number(),
  result: z.record(z.string(), z.unknown()),
  coverageGaps: z.array(z.string()),
  createdAt: z.string(),
})
export type ReliabilityEvaluationDto = z.infer<typeof reliabilityEvaluationDtoSchema>

export const MAP_CHANGE_CANDIDATE_STATUSES = ['pending', 'confirmed', 'rejected', 'inconclusive', 'superseded'] as const
export type MapChangeCandidateStatus = (typeof MAP_CHANGE_CANDIDATE_STATUSES)[number]
export const mapChangeCandidateStatusSchema = z.enum(MAP_CHANGE_CANDIDATE_STATUSES)

export const mapChangeCandidateDtoSchema = z.object({
  id: z.string(),
  targetId: z.string(),
  assetRef: z.record(z.string(), z.unknown()),
  beforeRef: z.record(z.string(), z.unknown()).optional(),
  afterRef: z.record(z.string(), z.unknown()).optional(),
  changeLevel: z.enum(['L1_structure', 'L2_object', 'L3_route']),
  conditions: z.record(z.string(), z.unknown()),
  observationsCount: z.number(),
  status: mapChangeCandidateStatusSchema,
  evidenceScore: z.number().optional(),
  counterEvidenceScore: z.number().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type MapChangeCandidateDto = z.infer<typeof mapChangeCandidateDtoSchema>

export const INCIDENT_STATUSES = [
  'DETECTED',
  'DIAGNOSING',
  'ACTION_REQUIRED',
  'VERIFYING',
  'OBSERVING',
  'RESOLVED',
  'DISMISSED',
] as const
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number]
export const incidentStatusSchema = z.enum(INCIDENT_STATUSES)

export const INCIDENT_SEVERITIES = ['P1', 'P2', 'P3', 'P4'] as const
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number]
export const incidentSeveritySchema = z.enum(INCIDENT_SEVERITIES)

export const evidenceScoresSchema = z.object({
  supportingScore: z.number(),
  counterScore: z.number(),
  supportingFactors: z.array(z.string()),
  counterFactors: z.array(z.string()),
})
export type EvidenceScores = z.infer<typeof evidenceScoresSchema>

export const incidentLineageSchema = z.object({
  mergedFrom: z.array(z.string()).optional(),
  splitFrom: z.string().optional(),
  parentIncidentId: z.string().optional(),
  targetId: z.string().optional(),
  targetName: z.string().optional(),
  scenarioId: z.string().optional(),
  scenarioName: z.string().optional(),
  stepId: z.string().optional(),
  stepName: z.string().optional(),
})
export type IncidentLineage = z.infer<typeof incidentLineageSchema>

export const reliabilityIncidentDtoSchema = z.object({
  id: z.string(),
  targetId: z.string(),
  groupingKey: z.string(),
  scopeDigest: z.string(),
  severity: incidentSeveritySchema,
  status: incidentStatusSchema,
  actionRequiredReason: z.string().optional(),
  memberCount: z.number(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  title: z.string(),
  summary: z.string(),
  rootCauseHypothesis: z.string().optional(),
  evidenceScores: evidenceScoresSchema,
  silencedUntil: z.string().optional(),
  dismissedReason: z.string().optional(),
  lineage: incidentLineageSchema.optional(),
  revision: z.number(),
  ruleVersion: z.number().default(1),
  assetKind: z.enum(['scenario', 'action_module']).nullable().optional(),
  assetId: z.string().nullable().optional(),
  stepId: z.string().nullable().optional(),
  implementationKey: z.string().nullable().optional(),
  accountId: z.string().nullable().optional(),
  observingStartedAt: z.string().nullable().optional(),
  observingStartedOrdinal: z.number().nullable().optional(),
  closedAt: z.string().nullable().optional(),
  closedEvaluationOrdinal: z.number().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type ReliabilityIncidentDto = z.infer<typeof reliabilityIncidentDtoSchema>

export const reliabilityIncidentMemberDtoSchema = z.object({
  id: z.string(),
  incidentId: z.string(),
  memberRef: z.string(),
  memberType: z.string(),
  joinedAt: z.string(),
})
export type ReliabilityIncidentMemberDto = z.infer<typeof reliabilityIncidentMemberDtoSchema>

export function formatScenarioIncidentGroupingKey(params: {
  targetId: string
  scenarioId: string
  stepId: string
  signalKind: ReliabilitySignalKind
  errorFamily: string
}): string {
  return `v2:target:${params.targetId}:scene:${params.scenarioId}:step:${params.stepId}:kind:${params.signalKind}:err:${params.errorFamily}`
}

export function formatModuleIncidentGroupingKey(params: {
  targetId: string
  moduleId: string
  implementationKey: string
  internalStepId: string
  signalKind: ReliabilitySignalKind
  errorFamily: string
}): string {
  return `v2:target:${params.targetId}:module:${params.moduleId}:impl:${params.implementationKey}:step:${params.internalStepId}:kind:${params.signalKind}:err:${params.errorFamily}`
}

export function formatAccountIncidentGroupingKey(params: {
  targetId: string
  accountId?: string | null
}): string {
  return `v2:target:${params.targetId}:account:${params.accountId || 'NONE'}:kind:session_fault`
}

export type ParsedIncidentGroupingKey =
  | {
      version: 2
      kind: 'scenario_step'
      targetId: string
      scenarioId: string
      stepId: string
      signalKind: ReliabilitySignalKind
      errorFamily: string
    }
  | {
      version: 2
      kind: 'module_step'
      targetId: string
      moduleId: string
      implementationKey: string
      internalStepId: string
      signalKind: ReliabilitySignalKind
      errorFamily: string
    }
  | {
      version: 2
      kind: 'session_fault'
      targetId: string
      accountId: string | null
      signalKind: 'session_fault'
      errorFamily: 'NONE'
    }
  | {
      version: 1
      raw: string
    }

export function parseIncidentGroupingKey(key: string): ParsedIncidentGroupingKey {
  if (!key.startsWith('v2:')) {
    return { version: 1, raw: key }
  }
  const parts = key.split(':')
  // v2:target:{targetId}:scene:{scenarioId}:step:{stepId}:kind:{signalKind}:err:{errorFamily}
  if (parts[3] === 'scene' && parts[5] === 'step' && parts[7] === 'kind' && parts[9] === 'err') {
    return {
      version: 2,
      kind: 'scenario_step',
      targetId: parts[2]!,
      scenarioId: parts[4]!,
      stepId: parts[6]!,
      signalKind: parts[8] as ReliabilitySignalKind,
      errorFamily: parts.slice(10).join(':') || 'NONE',
    }
  }
  // v2:target:{targetId}:module:{moduleId}:impl:{implementationKey}:step:{internalStepId}:kind:{signalKind}:err:{errorFamily}
  if (parts[3] === 'module' && parts[5] === 'impl' && parts[7] === 'step' && parts[9] === 'kind' && parts[11] === 'err') {
    return {
      version: 2,
      kind: 'module_step',
      targetId: parts[2]!,
      moduleId: parts[4]!,
      implementationKey: parts[6]!,
      internalStepId: parts[8]!,
      signalKind: parts[10] as ReliabilitySignalKind,
      errorFamily: parts.slice(12).join(':') || 'NONE',
    }
  }
  // v2:target:{targetId}:account:{accountId-or-NONE}:kind:session_fault
  if (parts[3] === 'account' && parts[5] === 'kind' && parts[6] === 'session_fault') {
    return {
      version: 2,
      kind: 'session_fault',
      targetId: parts[2]!,
      accountId: parts[4] === 'NONE' ? null : parts[4]!,
      signalKind: 'session_fault',
      errorFamily: 'NONE',
    }
  }
  return { version: 1, raw: key }
}

export interface ParsedIncidentMemberRef {
  raw: string
  kind: 'attempt' | 'step_run' | 'run'
  runId: string
  stepRunId?: string
  attemptId?: string
}

export function formatIncidentMemberRef(params: {
  runId: string
  stepRunId?: string
  attemptId?: string
}): string {
  if (params.stepRunId && params.attemptId) {
    return `run:${params.runId}:stepRun:${params.stepRunId}:att:${params.attemptId}`
  }
  if (params.stepRunId) {
    return `run:${params.runId}:stepRun:${params.stepRunId}`
  }
  return `run:${params.runId}`
}

export function parseIncidentMemberRef(ref: string): ParsedIncidentMemberRef | null {
  if (!ref || typeof ref !== 'string') return null
  // Match run:{runId}:stepRun:{stepRunId}:att:{attemptId}
  const attemptMatch = /^run:([^:]+):stepRun:([^:]+):att:([^:]+)$/.exec(ref)
  if (attemptMatch) {
    return {
      raw: ref,
      kind: 'attempt',
      runId: attemptMatch[1]!,
      stepRunId: attemptMatch[2]!,
      attemptId: attemptMatch[3]!,
    }
  }
  // Match run:{runId}:stepRun:{stepRunId}
  const stepRunMatch = /^run:([^:]+):stepRun:([^:]+)$/.exec(ref)
  if (stepRunMatch) {
    return {
      raw: ref,
      kind: 'step_run',
      runId: stepRunMatch[1]!,
      stepRunId: stepRunMatch[2]!,
    }
  }
  // Match run:{runId} or legacy run:{runId}:...
  const runMatch = /^run:([^:]+)(?::.*)?$/.exec(ref)
  if (runMatch) {
    return {
      raw: ref,
      kind: 'run',
      runId: runMatch[1]!,
    }
  }
  // Bare UUID
  if (/^[0-9a-fA-F-]{36}$/.test(ref)) {
    return {
      raw: ref,
      kind: 'run',
      runId: ref,
    }
  }
  return null
}

export const reliabilityRunReceiptDtoSchema = z.object({
  runId: z.string(),
  ruleVersion: z.number().int().default(2),
  targetId: z.string(),
  finishedAt: z.string(),
  enqueuedAt: z.string(),
  consumedAt: z.string().nullable().optional(),
  evaluationOrdinal: z.number().int().nullable().optional(),
})
export type ReliabilityRunReceiptDto = z.infer<typeof reliabilityRunReceiptDtoSchema>

export const reliabilityRunSampleDtoSchema = z.object({
  id: z.string(),
  ruleVersion: z.number().int().default(2),
  targetId: z.string(),
  runId: z.string(),
  scopeDigest: z.string(),
  scopeKind: z.string(),
  evaluationOrdinal: z.number().int(),
  executionConclusion: z.string(),
  signals: z.array(z.record(z.string(), z.unknown())),
  isComparable: z.boolean(),
  durationMs: z.number().nullable().optional(),
  sourceRef: z.record(z.string(), z.unknown()),
  comparisons: z.record(z.string(), z.unknown()),
  assetKind: z.string().nullable().optional(),
  assetId: z.string().nullable().optional(),
  moduleId: z.string().nullable().optional(),
  implementationKey: z.string().nullable().optional(),
  stepId: z.string().nullable().optional(),
  internalStepId: z.string().nullable().optional(),
  accountId: z.string().nullable().optional(),
  occurredAt: z.string(),
  createdAt: z.string(),
})
export type ReliabilityRunSampleDto = z.infer<typeof reliabilityRunSampleDtoSchema>

export const reliabilityPolicyDtoSchema = z.object({
  minComparableSamples: z.number().default(10),
  observationWindowDays: z.number().default(14),
  ewmaAlpha: z.number().default(0.2),
  primaryHitRateThreshold: z.number().default(0.85),
  fallbackRateThreshold: z.number().default(0.15),
  latencyIncreaseRatioThreshold: z.number().default(1.5),
})
export type ReliabilityPolicyDto = z.infer<typeof reliabilityPolicyDtoSchema>

export const DEFAULT_RELIABILITY_POLICY: ReliabilityPolicyDto = {
  minComparableSamples: 10,
  observationWindowDays: 14,
  ewmaAlpha: 0.2,
  primaryHitRateThreshold: 0.85,
  fallbackRateThreshold: 0.15,
  latencyIncreaseRatioThreshold: 1.5,
}

export const RELIABILITY_ERROR_CODES = {
  INCIDENT_NOT_FOUND: 'INCIDENT_NOT_FOUND',
  INCIDENT_REVISION_CONFLICT: 'INCIDENT_REVISION_CONFLICT',
  INCIDENT_INVALID_STATUS_TRANSITION: 'INCIDENT_INVALID_STATUS_TRANSITION',
  INCIDENT_TARGET_MISMATCH: 'INCIDENT_TARGET_MISMATCH',
  INVALID_INCIDENT_ASSET: 'INVALID_INCIDENT_ASSET',
  EVALUATION_ACTIVE_EXISTS: 'EVALUATION_ACTIVE_EXISTS',
  EVALUATION_LEASE_EXPIRED: 'EVALUATION_LEASE_EXPIRED',
  INSUFFICIENT_SAMPLES: 'INSUFFICIENT_SAMPLES',
  UPGRADE_JOB_NOT_FOUND: 'UPGRADE_JOB_NOT_FOUND',
  NO_UPGRADEABLE_SCENARIOS: 'NO_UPGRADEABLE_SCENARIOS',
} as const

export const reliabilityIncidentListQuerySchema = z.object({
  targetId: z.string().uuid().optional(),
  status: incidentStatusSchema.optional(),
  severity: incidentSeveritySchema.optional(),
  assetKind: z.enum(['scenario', 'action_module']).optional(),
  assetId: z.string().optional(),
  search: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
export type ReliabilityIncidentListQuery = z.infer<typeof reliabilityIncidentListQuerySchema>

export const reliabilityIncidentListResponseSchema = z.object({
  items: z.array(reliabilityIncidentDtoSchema),
  nextCursor: z.string().nullable().optional(),
  total: z.number().optional(),
})
export type ReliabilityIncidentListResponse = z.infer<typeof reliabilityIncidentListResponseSchema>

export const incidentSignalsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
export type IncidentSignalsQuery = z.infer<typeof incidentSignalsQuerySchema>

export const incidentSignalsListResponseSchema = z.object({
  items: z.array(reliabilitySignalDtoSchema),
  nextCursor: z.string().nullable().optional(),
  total: z.number().optional(),
})
export type IncidentSignalsListResponse = z.infer<typeof incidentSignalsListResponseSchema>

export const ASSET_RELIABILITY_STATUSES = ['healthy', 'degraded', 'insufficient_data'] as const
export type AssetReliabilityStatus = (typeof ASSET_RELIABILITY_STATUSES)[number]
export const assetReliabilityStatusSchema = z.enum(ASSET_RELIABILITY_STATUSES)

export const assetReliabilityItemSchema = z.object({
  assetId: z.string(),
  assetType: z.enum(['scenario', 'action_module']),
  assetName: z.string(),
  targetId: z.string(),
  targetName: z.string(),
  sampleCount: z.number(),
  ewmaSuccessRate: z.number().nullable(),
  p95DurationMs: z.number().nullable(),
  activeIncidentsCount: z.number(),
  highestSeverity: incidentSeveritySchema.nullable(),
  lastEvaluatedAt: z.string(),
  status: assetReliabilityStatusSchema,
})
export type AssetReliabilityItemDto = z.infer<typeof assetReliabilityItemSchema>

export const assetReliabilityQuerySchema = z.object({
  targetId: z.string().uuid().optional(),
  assetType: z.enum(['scenario', 'action_module']).optional(),
  status: assetReliabilityStatusSchema.optional(),
  search: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})
export type AssetReliabilityQuery = z.infer<typeof assetReliabilityQuerySchema>
export type AssetReliabilityQueryInput = z.input<typeof assetReliabilityQuerySchema>

export const assetReliabilityListResponseSchema = z.object({
  items: z.array(assetReliabilityItemSchema),
  nextCursor: z.string().nullable().optional(),
  total: z.number().optional(),
})
export type AssetReliabilityListResponse = z.infer<typeof assetReliabilityListResponseSchema>

export const mergeIncidentBodySchema = z.object({
  targetIncidentId: z.string().uuid(),
})
export type MergeIncidentBody = z.infer<typeof mergeIncidentBodySchema>

export const splitIncidentBodySchema = z.object({
  memberIds: z.array(z.string()).min(1),
  newTitle: z.string().min(1).optional(),
})
export type SplitIncidentBody = z.infer<typeof splitIncidentBodySchema>

export const dismissIncidentBodySchema = z.object({
  reason: z.string().min(1),
})
export type DismissIncidentBody = z.infer<typeof dismissIncidentBodySchema>

export const silenceIncidentBodySchema = z.object({
  durationHours: z.number().int().min(1).max(720),
  reason: z.string().min(1),
})
export type SilenceIncidentBody = z.infer<typeof silenceIncidentBodySchema>

export const resolveIncidentBodySchema = z.object({
  reason: z.string().min(1, '请输入解决/归档原因'),
  expectedRevision: z.number().int().optional(),
})
export type ResolveIncidentBody = z.infer<typeof resolveIncidentBodySchema>

export const triggerEvaluationBodySchema = z.object({
  policy: reliabilityPolicyDtoSchema.optional(),
})
export type TriggerEvaluationBody = z.infer<typeof triggerEvaluationBodySchema>

// ==================== RI-03 Phase 3.1: 依赖影响分析与集中维护 ====================

export const impactedAssetSchema = z.object({
  assetKind: z.enum(['scenario', 'action_module']),
  assetId: z.string(),
  assetName: z.string(),
  targetId: z.string(),
  moduleId: z.string(),
  moduleName: z.string(),
  currentBindingVersionId: z.string(),
  currentBindingVersionNo: z.number(),
  targetVersionId: z.string(),
  targetVersionNo: z.number(),
  relation: z.enum(['confirmed', 'possible', 'coverage_gap']),
  gapReason: z.enum(['legacy_missing_manifest', 'unsupported_structure', 'scan_truncated']).optional(),
  upgradeStatus: z.enum(['upgradeable', 'blocked', 'already_latest', 'conflict']),
  blockerReason: z.string().optional(),
  invocationLocations: z.array(
    z.object({
      invocationId: z.string(),
      stepId: z.string().optional(),
      stepName: z.string().optional(),
    }),
  ),
})
export type ImpactedAssetDto = z.infer<typeof impactedAssetSchema>

export const incidentImpactRunSchema = z.object({
  runId: z.string(),
  stepRunId: z.string().optional(),
  attemptId: z.string().optional(),
  occurredAt: z.string(),
  executionStatus: z.string(),
  failureReason: z.string().optional(),
})
export type IncidentImpactRunDto = z.infer<typeof incidentImpactRunSchema>

export const incidentImpactSummarySchema = z.object({
  totalScenarios: z.number(),
  confirmedCount: z.number(),
  possibleCount: z.number(),
  gapsCount: z.number(),
  upgradeableCount: z.number(),
  blockedCount: z.number(),
  alreadyLatestCount: z.number(),
})
export type IncidentImpactSummaryDto = z.infer<typeof incidentImpactSummarySchema>

export const incidentImpactSnapshotSchema = z.object({
  incidentId: z.string(),
  targetId: z.string(),
  calculatedAt: z.string(),
  impactedRuns: z.array(incidentImpactRunSchema),
  affectedAssets: z.array(impactedAssetSchema),
  summary: incidentImpactSummarySchema,
})
export type IncidentImpactSnapshotDto = z.infer<typeof incidentImpactSnapshotSchema>

export const batchUpgradeBodySchema = z.object({
  moduleId: z.string().uuid(),
  toVersionId: z.string().uuid(),
  scenarioIds: z.array(z.string().uuid()).min(1),
  idempotencyKey: z.string().min(1),
})
export type BatchUpgradeBody = z.infer<typeof batchUpgradeBodySchema>

export const upgradeJobResultSchema = z.object({
  scenarioId: z.string(),
  scenarioName: z.string().optional(),
  status: z.enum(['upgraded', 'conflict', 'skipped', 'error']),
  code: z.string().optional(),
  reason: z.string().optional(),
})
export type UpgradeJobResult = z.infer<typeof upgradeJobResultSchema>

export const maintenanceUpgradeJobSchema = z.object({
  jobId: z.string(),
  incidentId: z.string(),
  targetId: z.string(),
  moduleId: z.string(),
  toVersionId: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'partial_failure']),
  results: z.array(upgradeJobResultSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type MaintenanceUpgradeJobDto = z.infer<typeof maintenanceUpgradeJobSchema>

