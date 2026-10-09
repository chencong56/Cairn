import type { SuiteMember } from '@cairn/shared'
import { accountOptionLabel } from '@/features/runs/target-account'
import {
  ArrowDown,
  ArrowUp,
  FileText,
  GripVertical,
  Layers,
  Sliders,
  Trash2,
  User,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ReportProfileSelect } from '@/features/reports/profiles'
import { cn } from '@/lib/utils'

export function MemberNode({
  member,
  canWrite,
  scenarioName,
  targetAccounts,
  targetId,
  canMoveUp,
  canMoveDown,
  isSelected = false,
  onSelect,
  onUpdateDisplayName,
  onUpdateAccount,
  onUpdateReportProfile,
  onOpenInputEditor,
  onMove,
  onRemove,
}: {
  member: SuiteMember
  canWrite: boolean
  scenarioName: string
  targetAccounts: Array<{ id: string; displayName: string; username: string | null; identityKind?: string | null }>
  targetId: string
  canMoveUp: boolean
  canMoveDown: boolean
  isSelected?: boolean
  onSelect?: () => void
  onUpdateDisplayName: (name: string) => void
  onUpdateAccount: (accountId: string | undefined) => void
  onUpdateReportProfile: (profileId: string | undefined) => void
  onOpenInputEditor: () => void
  onMove: (delta: number) => void
  onRemove: () => void
}) {
  const overrideCount = Object.keys(member.input ?? {}).length

  return (
    <div
      onClick={onSelect}
      className={cn(
        'group relative rounded-xl border bg-card p-3 shadow-card transition-all duration-150 space-y-2.5 cursor-pointer',
        isSelected
          ? 'border-primary ring-2 ring-primary/20 bg-primary/[0.015] shadow-card-hover'
          : 'border-border-card hover:border-border hover:shadow-xs'
      )}
    >
      {/* Row 1: Primary Entity Row (Handle, Index, Scenario Name, Alias, Member ID, and Actions) */}
      <div className='flex items-center justify-between gap-3'>
        <div className='flex items-center gap-2.5 min-w-0 flex-1'>
          {/* Grip & Ordinal */}
          {canWrite ? (
            <div
              className='cursor-grab text-muted-foreground/40 hover:text-muted-foreground shrink-0 transition-colors'
              title='可拖拽调整顺序'
              onClick={(e) => e.stopPropagation()}
            >
              <GripVertical className='size-3.5' />
            </div>
          ) : null}
          <span
            className={cn(
              'flex size-5 shrink-0 items-center justify-center rounded-full font-mono text-label transition-colors cursor-default',
              isSelected
                ? 'bg-primary text-primary-foreground font-semibold'
                : 'bg-muted text-muted-foreground'
            )}
            title={`成员序号: ${member.ordinal + 1} (ID: ${member.memberId})`}
          >
            {member.ordinal + 1}
          </span>

          {/* Scenario Name (Primary Entity - prominent, never chopped) */}
          <div
            className='flex items-center gap-1.5 min-w-0 flex-1 font-medium text-body text-foreground truncate'
            title={`关联场景: ${scenarioName}`}
          >
            <Layers className={cn('size-3.5 shrink-0', isSelected ? 'text-primary' : 'text-primary/80')} />
            <span className='truncate'>{scenarioName}</span>
          </div>

          {/* Custom Alias Input (flexible width, non-intrusive input styling) */}
          <div className='w-52 min-w-0 shrink-0' onClick={(e) => e.stopPropagation()}>
            <Input
              value={member.displayName ?? ''}
              disabled={!canWrite}
              aria-label={`${member.memberId} 展示名称`}
              placeholder='自定义别名 (可选)'
              className='h-7 text-label px-2 bg-transparent hover:bg-muted/40 focus:bg-background border-border-divider/80 focus:border-border transition-colors truncate'
              onChange={(e) => onUpdateDisplayName(e.target.value)}
            />
          </div>
        </div>

        {/* Row 1 Actions: Move Up / Down, Delete */}
        {canWrite ? (
          <div className='flex items-center gap-0.5 shrink-0' onClick={(e) => e.stopPropagation()}>
            <Button
              variant='ghost'
              size='icon'
              className='size-7 text-muted-foreground/70 hover:text-foreground'
              aria-label='上移'
              disabled={!canMoveUp}
              onClick={() => onMove(-1)}
            >
              <ArrowUp className='size-3.5' />
            </Button>
            <Button
              variant='ghost'
              size='icon'
              className='size-7 text-muted-foreground/70 hover:text-foreground'
              aria-label='下移'
              disabled={!canMoveDown}
              onClick={() => onMove(1)}
            >
              <ArrowDown className='size-3.5' />
            </Button>
            <Button
              variant='ghost'
              size='icon'
              className='size-7 text-muted-foreground/70 hover:text-destructive'
              aria-label='移除'
              onClick={onRemove}
            >
              <Trash2 className='size-3.5' />
            </Button>
          </div>
        ) : null}
      </div>

      {/* Row 2: Secondary Configuration Bar (Target Account, Input Overrides, Report Config) */}
      <div className='flex items-center justify-between gap-3 pt-2 border-t border-border-divider/60 text-label'>
        <div className='flex items-center gap-3 min-w-0 flex-1' onClick={(e) => e.stopPropagation()}>
          {/* Target Account Select */}
          <div className='w-64 min-w-0 shrink-0'>
            <Select
              value={member.targetAccountId ?? '__default__'}
              disabled={!canWrite}
              onValueChange={(val) => onUpdateAccount(val === '__default__' ? undefined : val)}
            >
              <SelectTrigger
                aria-label={`${member.memberId} 目标账号`}
                className='h-7 w-full min-w-0 text-label px-2.5 overflow-hidden bg-background/50 hover:bg-background'
              >
                <div className='flex items-center gap-1.5 min-w-0 flex-1 overflow-hidden'>
                  <User className='size-3 shrink-0 text-muted-foreground' />
                  <SelectValue placeholder='跟随场景 / 集合默认' />
                </div>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='__default__'>跟随场景 / 集合默认</SelectItem>
                {targetAccounts.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {accountOptionLabel(account)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Input Override Button */}
          <Button
            variant={overrideCount > 0 ? 'secondary' : 'outline'}
            size='sm'
            className={cn(
              'h-7 text-label shrink-0 px-2.5 gap-1.5 transition-colors',
              overrideCount > 0 && 'bg-primary/10 text-primary border-primary/20 hover:bg-primary/15'
            )}
            disabled={!canWrite}
            onClick={(e) => {
              e.stopPropagation()
              onOpenInputEditor()
            }}
            title='在右侧检视器配置参数覆盖'
          >
            <Sliders className='size-3 text-muted-foreground' />
            {overrideCount > 0 ? `已覆盖 (${overrideCount})` : '配置覆盖'}
          </Button>
        </div>

        {/* Sub-report collapsible */}
        <div className='shrink-0' onClick={(e) => e.stopPropagation()}>
          <details className='text-label'>
            <summary className='cursor-pointer text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-label'>
              <FileText className='size-3' />
              子报告配置
            </summary>
            <div className='mt-1.5 min-w-[200px]'>
              <ReportProfileSelect
                targetId={targetId}
                source='RUN'
                label={`${member.memberId} 子报告默认配置`}
                value={member.reportProfileId}
                disabled={!canWrite}
                onChange={onUpdateReportProfile}
              />
            </div>
          </details>
        </div>
      </div>
    </div>
  )
}
