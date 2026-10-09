import { Link } from '@tanstack/react-router'
import type { ScenarioDto } from '@cairn/shared'
import { Copy, History, MoreHorizontal, Pencil, Power, Timer, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useCan } from '@/hooks/use-permissions'
import { cn } from '@/lib/utils'

export type ScenarioMenuActions = {
  onCopy: (scenario: ScenarioDto) => void
  onRename: (scenario: ScenarioDto) => void
  onToggleStatus: (scenario: ScenarioDto) => void
  onDelete: (scenario: ScenarioDto) => void
  copyingId: string | null
}

/** 低频与破坏性操作收进「···」；每项按各自权限显示，一项都没有时不渲染按钮。 */
export function ScenarioMoreMenu({
  scenario,
  actions,
  className,
}: {
  scenario: ScenarioDto
  actions: ScenarioMenuActions
  className?: string
}) {
  const canReadRuns = useCan('run:read')
  const canWrite = useCan('workflow:write')
  const canDelete = useCan('workflow:delete')
  if (!canReadRuns && !canWrite && !canDelete) return null

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant='ghost'
          size='icon'
          className={cn('size-8 text-muted-foreground hover:text-text-primary', className)}
          aria-label={`更多操作：${scenario.name}`}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end' className='w-44'>
        {canReadRuns ? (
          <>
            <DropdownMenuItem asChild>
              <Link to='/runs' search={{ search: scenario.name, scenarioId: scenario.id }}>
                <History />
                运行记录
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link to='/duration-analysis/scenarios/$scenarioId' params={{ scenarioId: scenario.id }}>
                <Timer />
                耗时分析
              </Link>
            </DropdownMenuItem>
          </>
        ) : null}
        {canWrite ? (
          <>
            {canReadRuns ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem
              disabled={actions.copyingId !== null}
              onSelect={() => actions.onCopy(scenario)}
            >
              <Copy />
              复制场景
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => actions.onRename(scenario)}>
              <Pencil />
              重命名
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => actions.onToggleStatus(scenario)}>
              <Power />
              {scenario.status === 'active' ? '停用场景' : '启用场景'}
            </DropdownMenuItem>
          </>
        ) : null}
        {canDelete ? (
          <>
            {canReadRuns || canWrite ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem variant='destructive' onSelect={() => actions.onDelete(scenario)}>
              <Trash2 />
              删除场景
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
