import {
  DEFAULT_MONITOR_SSE_INTERVAL_MS,
  monitorAlertChannelBodySchema,
  monitorAlertItemSchema,
  monitorAlertListQuerySchema,
  monitorAlertListResponseSchema,
  monitorAlertRulesResponseSchema,
  monitorAlertRulesUpdateBodySchema,
  monitorAlertSilenceBodySchema,
  monitorProbeBodySchema,
  monitorProbeResponseSchema,
  monitorProfileListResponseSchema,
  monitorSeriesResponseSchema,
  monitorStreamControlSchema,
  monitorTargetSlaResponseSchema,
  monitorAiModelResponseSchema,
  monitoringOverviewResponseSchema,
  platformConfigCurrentSchema,
  type MonitorAlertChannelBody,
  type MonitorAlertItem,
  type MonitorAlertListQueryInput,
  type MonitorAlertListResponse,
  type MonitorAlertRulesResponse,
  type MonitorAlertRulesUpdateBody,
  type MonitorAlertSilenceBody,
  type MonitorProbeBody,
  type MonitorProbeResponse,
  type MonitorProfileListQuery,
  type MonitorProfileListResponse,
  type MonitorSeriesQueryInput,
  type MonitorSeriesResponse,
  type MonitorStreamControl,
  type MonitorTargetSlaResponse,
  type MonitorAiModelResponse,
  type MonitoringOverviewResponse,
  type PlatformConfigCurrent,
  REQUEST_ID_HEADER,
} from '@cairn/shared'
import { apiFetch, toQueryString } from '@/lib/api-client'
import { assertSseResponseOk, newSseRequestId, parseJson, readSseStream } from '@/lib/sse'
import { useAuthStore } from '@/stores/auth-store'

export function fetchMonitoringOverview(): Promise<MonitoringOverviewResponse> {
  return apiFetch('/api/monitoring/overview', monitoringOverviewResponseSchema)
}

export function fetchTargetSla(windowHours?: number): Promise<MonitorTargetSlaResponse> {
  const query = windowHours ? `?windowHours=${windowHours}` : ''
  return apiFetch(`/api/monitoring/targets/sla${query}`, monitorTargetSlaResponseSchema)
}

export function fetchAiModels(): Promise<MonitorAiModelResponse> {
  return apiFetch('/api/monitoring/ai/models', monitorAiModelResponseSchema)
}

export function fetchMonitorProfiles(query: MonitorProfileListQuery): Promise<MonitorProfileListResponse> {
  return apiFetch(`/api/monitoring/profiles${toQueryString(query)}`, monitorProfileListResponseSchema)
}

export function fetchMonitorSeries(query: MonitorSeriesQueryInput): Promise<MonitorSeriesResponse> {
  return apiFetch(`/api/monitoring/series${toQueryString(query)}`, monitorSeriesResponseSchema)
}

export function fetchMonitorAlerts(
  query: MonitorAlertListQueryInput = {},
): Promise<MonitorAlertListResponse> {
  return apiFetch(
    `/api/monitoring/alerts${toQueryString(monitorAlertListQuerySchema.parse(query))}`,
    monitorAlertListResponseSchema,
  )
}

export function fetchMonitorAlertRules(): Promise<MonitorAlertRulesResponse> {
  return apiFetch('/api/monitoring/alert-rules', monitorAlertRulesResponseSchema)
}

export function updateMonitorAlertRules(
  body: MonitorAlertRulesUpdateBody,
): Promise<PlatformConfigCurrent> {
  return apiFetch('/api/monitoring/alert-rules', platformConfigCurrentSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(monitorAlertRulesUpdateBodySchema.parse(body)),
  })
}

export function registerMonitorAlertChannel(
  body: MonitorAlertChannelBody,
): Promise<PlatformConfigCurrent> {
  return apiFetch('/api/monitoring/alert-channels', platformConfigCurrentSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(monitorAlertChannelBodySchema.parse(body)),
  })
}

export function silenceMonitorAlert(
  alertId: string,
  body: MonitorAlertSilenceBody,
): Promise<MonitorAlertItem> {
  return apiFetch(`/api/monitoring/alerts/${alertId}/silence`, monitorAlertItemSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(monitorAlertSilenceBodySchema.parse(body)),
  })
}

export function probeObjectStore(body: MonitorProbeBody = { target: 'object_store' }): Promise<MonitorProbeResponse> {
  return apiFetch('/api/monitoring/probe', monitorProbeResponseSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(monitorProbeBodySchema.parse(body)),
  })
}

export type MonitorStreamHandlers = {
  onSnapshot?: (snapshot: MonitoringOverviewResponse) => void
  onControl?: (control: MonitorStreamControl) => void
}

export async function subscribeMonitoringStream(input: {
  intervalMs?: number
  lastEventId?: string
  signal: AbortSignal
  handlers: MonitorStreamHandlers
}): Promise<void> {
  const token = useAuthStore.getState().auth.accessToken
  const intervalMs = input.intervalMs ?? DEFAULT_MONITOR_SSE_INTERVAL_MS
  const res = await fetch(`/api/monitoring/stream${toQueryString({ intervalMs })}`, {
    headers: {
      Accept: 'text/event-stream',
      [REQUEST_ID_HEADER]: newSseRequestId(),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(input.lastEventId ? { 'Last-Event-ID': input.lastEventId } : {}),
    },
    signal: input.signal,
  })
  await assertSseResponseOk(res, token)
  if (!res.body) return
  await readSseStream(
    res.body,
    (frame) => {
      if (frame.event === 'ready' || frame.event === 'error') {
        const parsed = monitorStreamControlSchema.safeParse(parseJson(frame.data))
        if (parsed.success) input.handlers.onControl?.(parsed.data)
        return
      }
      if (frame.event !== 'snapshot') return
      const parsed = monitoringOverviewResponseSchema.safeParse(parseJson(frame.data))
      if (parsed.success) input.handlers.onSnapshot?.(parsed.data)
    },
    input.signal,
  )
}
