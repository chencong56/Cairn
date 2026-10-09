import type { ScenarioDto } from '@cairn/shared'
import { CalendarClock, PauseCircle } from 'lucide-react'
import { StatusBadge } from '@/components/status-badge'

/** 只显示例外状态：已启用、无调度这类每行都一样的信息不重复。 */
export function ScenarioExceptionTags({
  scenario,
  evidenceIncomplete,
}: {
  scenario: ScenarioDto
  evidenceIncomplete: boolean
}) {
  return (
    <>
      {scenario.status === 'disabled' ? (
        <StatusBadge tone='neutral' hideIcon>
          已停用
        </StatusBadge>
      ) : null}
      {scenario.draftDirty ? (
        <StatusBadge
          tone='warning'
          hideIcon
          title={scenario.latestVersionId ? '有未发布的修改，正式运行不会带上' : '还没有发布过版本'}
        >
          {scenario.latestVersionId ? '有未发布修改' : '未发布'}
        </StatusBadge>
      ) : null}
      {evidenceIncomplete ? (
        <StatusBadge tone='warning' title='最近一次正式运行缺少必要证据，不能视为完整交付'>
          证据不全
        </StatusBadge>
      ) : null}
    </>
  )
}

export function ScheduleTag({ schedule }: { schedule: NonNullable<ScenarioDto['schedule']> }) {
  return (
    <StatusBadge
      tone='neutral'
      hideIcon
      className={schedule.enabled ? 'text-text-secondary' : 'text-muted-foreground'}
      title={schedule.name ? `${schedule.name}（定时调度，不含场景集）` : '定时调度（不含场景集）'}
    >
      {schedule.enabled ? (
        <CalendarClock aria-hidden='true' className='size-3' />
      ) : (
        <PauseCircle aria-hidden='true' className='size-3' />
      )}
      {schedule.enabled ? schedule.summary : `${schedule.summary} · 已暂停`}
    </StatusBadge>
  )
}
