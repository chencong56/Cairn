import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ScenarioDto } from '@cairn/shared'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { createRun } from '@/lib/runs-api'
import { newUuid } from '@/lib/uuid'
import { useCan } from '@/hooks/use-permissions'
import { useQuickRunStore } from './quick-run-store'

export type QuickRunResult = { ok: true; runId: string } | { ok: false; message: string }

/** 正式运行最新已发布版本：不指定版本，由服务端取最新发布；每次点击一个幂等键。 */
export function useQuickRun() {
  const queryClient = useQueryClient()
  const add = useQuickRunStore((state) => state.add)
  const canReadRuns = useCan('run:read')
  const [pendingId, setPendingId] = useState<string | null>(null)

  async function start(
    scenario: ScenarioDto,
    options: { targetAccountId?: string; input?: Record<string, string> } = {},
  ): Promise<QuickRunResult> {
    setPendingId(scenario.id)
    try {
      const detail = await createRun({
        scenarioId: scenario.id,
        targetAccountId: options.targetAccountId || undefined,
        input: options.input,
        idempotencyKey: `quick-run:${newUuid()}`,
      })
      if (canReadRuns) {
        add({
          runId: detail.id,
          scenarioId: scenario.id,
          scenarioName: scenario.name,
          versionNo: scenario.latestVersionNo,
          startedAt: Date.now(),
          status: detail.status,
        })
      } else {
        toast.success(`已发起「${scenario.name}」的运行`)
      }
      void queryClient.invalidateQueries({ queryKey: ['scenarios'] })
      return { ok: true, runId: detail.id }
    } catch (error) {
      return { ok: false, message: error instanceof ApiRequestError ? error.message : '发起运行失败' }
    } finally {
      setPendingId(null)
    }
  }

  return { start, pendingId }
}
