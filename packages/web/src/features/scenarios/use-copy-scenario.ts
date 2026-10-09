import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { copyScenario } from '@/lib/scenarios-api'

/** 复制场景。`open` 为真时直接进入副本，否则在提示里给「打开」入口。 */
export function useCopyScenario() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [copyingId, setCopyingId] = useState<string | null>(null)

  async function copy(scenarioId: string, options: { open?: boolean } = {}) {
    if (copyingId) return
    setCopyingId(scenarioId)
    try {
      const created = await copyScenario(scenarioId)
      const openCopy = () =>
        void navigate({ to: '/scenarios/$scenarioId', params: { scenarioId: created.id } })
      void queryClient.invalidateQueries({ queryKey: ['scenarios'] })
      toast.success(
        `已复制为「${created.name}」`,
        options.open ? undefined : { action: { label: '打开', onClick: openCopy } },
      )
      for (const item of created.notCopied) toast.warning(item.reason)
      if (options.open) openCopy()
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '复制失败')
    } finally {
      setCopyingId(null)
    }
  }

  return { copy, copyingId }
}
