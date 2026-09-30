import { StudioScreen, type StudioScreenProps } from '../studio-screen'
import type { StudioViewPreset } from './studio-splitter-layout'
import { cn } from '@/lib/utils'

export interface ManagedStageScreenProps extends StudioScreenProps {
  preset?: StudioViewPreset
  onPresetChange?: (preset: StudioViewPreset) => void
  className?: string
}

export function ManagedStageScreen({
  preset: _preset,
  onPresetChange: _onPresetChange,
  className,
  ...screenProps
}: ManagedStageScreenProps) {
  return (
    <div
      data-testid='managed-stage-screen'
      className={cn('flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden bg-card relative', className)}
    >
      <StudioScreen {...screenProps} />
    </div>
  )
}
