import {
  deriveFallbackSummary,
  type OutcomeStatus,
  type RunStatus,
} from '@cairn/shared'

/**
 * 列表只展示带来新事实的业务结论。
 * 与状态列、业务结果列同义的保底句不占主行。
 */
export function listFacingRunOutputSummary(
  summary: string | null | undefined,
  status: RunStatus,
  outcomeStatus: OutcomeStatus,
): string | null {
  const text = summary?.trim()
  if (!text) return null
  if (text === deriveFallbackSummary(status, outcomeStatus)) return null
  return text
}
