import { z } from 'zod'
import {
  recordingBindingSchema,
  recordingDraftDetailSchema,
  recordingDraftListResponseSchema,
  renameRecordingBodySchema as renameRecordingDraftBodySchema,
  updateRecordingExclusionsBodySchema,
  createScenarioHandoffBodySchema,
  recordingDraftExclusionSchema,
  scenarioDetailSchema,
  recordingImportReceiptSchema,
  type RecordingBindingDto,
  type RecordingDraftDetailDto,
  type RecordingDraftListQuery,
  type RecordingDraftListResponse,
  deleteResourceResultSchema,
  type DeleteResourceResult,
  type UpdateRecordingExclusionsBody,
  type CreateScenarioHandoffBody,
} from '@cairn/shared'
import { apiFetch, toQueryString } from '@/lib/api-client'

export function fetchRecordings(
  query?: RecordingDraftListQuery,
): Promise<RecordingDraftListResponse> {
  return apiFetch(`/api/recordings${toQueryString(query)}`, recordingDraftListResponseSchema)
}

export function fetchRecording(id: string): Promise<RecordingDraftDetailDto> {
  return apiFetch(`/api/recordings/${id}`, recordingDraftDetailSchema)
}

export function renameRecording(id: string, name: string): Promise<RecordingDraftDetailDto> {
  return apiFetch(`/api/recordings/${id}`, recordingDraftDetailSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(renameRecordingDraftBodySchema.parse({ name })),
  })
}

export function deleteRecording(id: string): Promise<DeleteResourceResult> {
  return apiFetch(`/api/recordings/${id}/delete`, deleteResourceResultSchema, {
    method: 'POST',
  })
}

export function closeRecordingBinding(id: string): Promise<RecordingBindingDto> {
  return apiFetch(`/api/recording-bindings/${id}/close`, recordingBindingSchema, {
    method: 'POST',
  })
}

export const updateRecordingExclusionsResponseSchema = z.object({
  exclusions: z.array(recordingDraftExclusionSchema),
  revision: z.number().int(),
})
export type UpdateRecordingExclusionsResponse = z.infer<typeof updateRecordingExclusionsResponseSchema>

export function updateRecordingExclusions(
  id: string,
  body: UpdateRecordingExclusionsBody,
): Promise<UpdateRecordingExclusionsResponse> {
  return apiFetch(`/api/recordings/${id}/exclusions`, updateRecordingExclusionsResponseSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updateRecordingExclusionsBodySchema.parse(body)),
  })
}

export const createScenarioFromHandoffResponseSchema = z.object({
  scenario: scenarioDetailSchema,
  receipt: recordingImportReceiptSchema,
})
export type CreateScenarioFromHandoffResponse = z.infer<typeof createScenarioFromHandoffResponseSchema>

export function handoffCreateScenario(
  id: string,
  body: CreateScenarioHandoffBody,
): Promise<CreateScenarioFromHandoffResponse> {
  return apiFetch(
    `/api/recordings/${id}/handoff/create-scenario`,
    createScenarioFromHandoffResponseSchema,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createScenarioHandoffBodySchema.parse(body)),
    },
  )
}
