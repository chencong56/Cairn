import { z } from 'zod'
import {
  createDurationReportSubscriptionBodySchema,
  durationReportSubscriptionDtoSchema,
  durationReportSubscriptionListSchema,
  nodeDurationChildrenSchema,
  nodeDurationHistorySchema,
  reportDtoSchema,
  runDurationReadoutSchema,
  scenarioDurationAnalysisSchema,
  suiteRunDurationReadoutSchema,
  targetDurationAnalysisSchema,
  updateDurationReportSubscriptionBodySchema,
  type CreateDurationReportSubscriptionBody,
  type DurationAnalysisQuery,
  type DurationReportSubscriptionDto,
  type DurationReportSubscriptionList,
  type NodeDurationChildren,
  type NodeDurationHistory,
  type ReportDto,
  type RunDurationQuery,
  type RunDurationReadout,
  type ScenarioDurationAnalysis,
  type SuiteRunDurationReadout,
  type TargetDurationAnalysis,
  type TargetDurationAnalysisQuery,
  type UpdateDurationReportSubscriptionBody,
} from '@cairn/shared'
import { apiFetch, toQueryString } from '@/lib/api-client'

const post = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

export function fetchRunDuration(runId: string, query: RunDurationQuery = {}): Promise<RunDurationReadout> {
  return apiFetch(`/api/runs/${encodeURIComponent(runId)}/duration${toQueryString(query)}`, runDurationReadoutSchema)
}

export function fetchSuiteRunDuration(suiteRunId: string): Promise<SuiteRunDurationReadout> {
  return apiFetch(`/api/suite-runs/${encodeURIComponent(suiteRunId)}/duration`, suiteRunDurationReadoutSchema)
}

export function fetchTargetDurationAnalysis(targetId: string, query: TargetDurationAnalysisQuery = {}): Promise<TargetDurationAnalysis> {
  return apiFetch(
    `/api/duration-analysis/targets/${encodeURIComponent(targetId)}${toQueryString(query)}`,
    targetDurationAnalysisSchema,
  )
}

export function fetchScenarioDurationAnalysis(scenarioId: string, query: DurationAnalysisQuery = {}): Promise<ScenarioDurationAnalysis> {
  return apiFetch(
    `/api/duration-analysis/scenarios/${encodeURIComponent(scenarioId)}${toQueryString(query)}`,
    scenarioDurationAnalysisSchema,
  )
}

export function fetchScenarioNodeHistory(scenarioId: string, query: DurationAnalysisQuery & { nodeKey: string }): Promise<NodeDurationHistory> {
  return apiFetch(
    `/api/duration-analysis/scenarios/${encodeURIComponent(scenarioId)}/node${toQueryString(query)}`,
    nodeDurationHistorySchema,
  )
}

/** 节点表展开一行时读它的子节点。 */
export function fetchScenarioNodeChildren(scenarioId: string, query: DurationAnalysisQuery & { parentKey: string }): Promise<NodeDurationChildren> {
  return apiFetch(
    `/api/duration-analysis/scenarios/${encodeURIComponent(scenarioId)}/children${toQueryString(query)}`,
    nodeDurationChildrenSchema,
  )
}

export function fetchDurationReportSubscriptions(targetId: string): Promise<DurationReportSubscriptionList> {
  return apiFetch(`/api/duration-report-subscriptions${toQueryString({ targetId })}`, durationReportSubscriptionListSchema)
}

export function createDurationReportSubscription(body: CreateDurationReportSubscriptionBody): Promise<DurationReportSubscriptionDto> {
  return apiFetch('/api/duration-report-subscriptions', durationReportSubscriptionDtoSchema, post(createDurationReportSubscriptionBodySchema.parse(body)))
}

export function updateDurationReportSubscription(id: string, body: UpdateDurationReportSubscriptionBody): Promise<DurationReportSubscriptionDto> {
  return apiFetch(`/api/duration-report-subscriptions/${encodeURIComponent(id)}`, durationReportSubscriptionDtoSchema, post(updateDurationReportSubscriptionBodySchema.parse(body)))
}

export function deleteDurationReportSubscription(id: string): Promise<{ id: string; deleted: boolean }> {
  return apiFetch(`/api/duration-report-subscriptions/${encodeURIComponent(id)}/delete`, z.object({ id: z.string(), deleted: z.boolean() }), post({}))
}

export function previewDurationReportSubscription(id: string): Promise<ReportDto> {
  return apiFetch(`/api/duration-report-subscriptions/${encodeURIComponent(id)}/preview`, reportDtoSchema, post({}))
}
