import { runHealthBucket, type RunHealthBucket, type RunStatus } from '@cairn/shared'
import { RUN_STATUS_LABELS } from '../labels'

/** 场景列表只关心这几项：分组、执行状态与业务结论。 */
export type ListRun = {
  status: string
  outcomeStatus?: string | null
  evidenceStatus?: string | null
}

export type VerdictTone = 'success' | 'warning' | 'error' | 'info' | 'neutral' | 'muted'

export type RunVerdict = {
  bucket: RunHealthBucket
  tone: VerdictTone
  label: string
  /** 运行未结束：分段用状态灯脉冲，图标旋转。 */
  live: boolean
  evidenceIncomplete: boolean
}

const WAITING_STATUSES = new Set<string>(['WAITING_FOR_AUTH', 'HOLDING', 'NEEDS_REVIEW'])

export function runVerdict(run: ListRun | null | undefined): RunVerdict {
  const bucket = runHealthBucket(run)
  const evidenceIncomplete = run?.evidenceStatus === 'INCOMPLETE'
  if (!run || bucket === 'never') return { bucket, tone: 'muted', label: '还没有运行', live: false, evidenceIncomplete }
  if (bucket === 'running') {
    return {
      bucket,
      tone: WAITING_STATUSES.has(run.status) ? 'warning' : 'info',
      label: RUN_STATUS_LABELS[run.status as RunStatus] ?? '运行中',
      live: true,
      evidenceIncomplete,
    }
  }
  if (bucket === 'failing') {
    return { bucket, tone: 'error', label: run.status === 'FAILED' ? '执行失败' : '检查未通过', live: false, evidenceIncomplete }
  }
  if (bucket === 'cancelled') return { bucket, tone: 'neutral', label: '已取消', live: false, evidenceIncomplete }
  if (bucket === 'warning') {
    return { bucket, tone: 'warning', label: run.outcomeStatus === 'UNKNOWN' ? '结果不确定' : '有警告', live: false, evidenceIncomplete }
  }
  return { bucket, tone: 'success', label: run.outcomeStatus === 'PASS' ? '通过' : '已完成', live: false, evidenceIncomplete }
}
