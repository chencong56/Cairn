import type { TableStatusTone } from '@cairn/shared'
import { cn } from '@/lib/utils'

/** 状态语义的色点：用语义 Token，不写死颜色；未识别画虚线圈。 */
const TONE_CLASS: Record<TableStatusTone | 'unknown', string> = {
  success: 'bg-status-success',
  warning: 'bg-status-warning',
  error: 'bg-status-error',
  info: 'bg-status-info',
  processing: 'bg-primary',
  default: 'bg-status-neutral-foreground',
  unknown: 'border border-dashed border-muted-foreground bg-transparent',
}

export function ToneDot({ tone, className }: { tone: TableStatusTone | 'unknown'; className?: string }) {
  return <span aria-hidden className={cn('mr-1.5 inline-block size-2 shrink-0 rounded-full align-middle', TONE_CLASS[tone], className)} />
}
