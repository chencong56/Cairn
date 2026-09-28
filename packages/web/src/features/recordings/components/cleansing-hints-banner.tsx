import { useState } from 'react'
import type { RecordingCleansingHints, RecordingDraftExclusion, RecordingExclusionReason } from '@cairn/shared'
import { Sparkles, ShieldCheck, MousePointerClick } from 'lucide-react'
import { Button } from '@/components/ui/button'

type Props = {
  hints?: RecordingCleansingHints
  exclusions: RecordingDraftExclusion[]
  onApplyCleansing: (
    toExclude: Array<{ itemId: string; reason: RecordingExclusionReason }>,
    successMessage: string,
  ) => Promise<void>
}

export function CleansingHintsBanner({ hints, exclusions, onApplyCleansing }: Props) {
  const [applying, setApplying] = useState(false)

  if (!hints) return null

  const excludedIds = new Set(exclusions.map((e) => e.itemId))

  const pendingLoginItemIds = (hints.loginPrefixItemIds ?? []).filter((id) => !excludedIds.has(id))
  const pendingMisfireItemIds = (hints.misfireItemIds ?? []).filter((id) => !excludedIds.has(id))

  if (pendingLoginItemIds.length === 0 && pendingMisfireItemIds.length === 0) {
    return null
  }

  const handleApplyLogin = async () => {
    setApplying(true)
    try {
      const items = pendingLoginItemIds.map((itemId) => ({
        itemId,
        reason: 'login_prefix' as const,
      }))
      await onApplyCleansing(items, `已一键剔除 ${items.length} 步登录前缀`)
    } finally {
      setApplying(false)
    }
  }

  const handleApplyMisfire = async () => {
    setApplying(true)
    try {
      const items = pendingMisfireItemIds.map((itemId) => ({
        itemId,
        reason: 'misfire_click' as const,
      }))
      await onApplyCleansing(items, `已一键清理 ${items.length} 处误触点击`)
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className='flex flex-col gap-2 rounded-lg border border-primary/20 bg-primary-50/50 p-3 shadow-card'>
      <div className='flex items-center gap-1.5 text-label font-medium text-primary'>
        <Sparkles className='size-3.5' />
        <span>清洗建议</span>
      </div>

      <div className='flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between'>
        <div className='flex flex-col gap-1.5 text-label text-foreground'>
          {pendingLoginItemIds.length > 0 ? (
            <div className='flex items-center gap-2'>
              <ShieldCheck className='size-3.5 text-status-success-foreground shrink-0' />
              <span>
                检测到开头 {hints.loginPrefixItemIds.length} 步为登录前缀，目标已配置受管认证
              </span>
            </div>
          ) : null}

          {pendingMisfireItemIds.length > 0 ? (
            <div className='flex items-center gap-2'>
              <MousePointerClick className='size-3.5 text-status-warning-foreground shrink-0' />
              <span>
                检测到 {hints.misfireItemIds.length} 处 500ms 内的重复点击，且页面未变
              </span>
            </div>
          ) : null}
        </div>

        <div className='flex flex-wrap items-center gap-2 shrink-0'>
          {pendingLoginItemIds.length > 0 ? (
            <Button
              size='sm'
              variant='outline'
              className='h-7 bg-background text-label gap-1.5'
              disabled={applying}
              onClick={handleApplyLogin}
            >
              一键剔除登录步骤
            </Button>
          ) : null}

          {pendingMisfireItemIds.length > 0 ? (
            <Button
              size='sm'
              variant='outline'
              className='h-7 bg-background text-label gap-1.5'
              disabled={applying}
              onClick={handleApplyMisfire}
            >
              一键清理误触
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
