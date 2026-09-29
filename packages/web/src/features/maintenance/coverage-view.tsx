import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  AlertTriangle,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Play,
  Search,
} from 'lucide-react'
import { toast } from 'sonner'
import { triggerAcceptanceSweep } from '@/lib/reliability-api'
import { formatAsOf, formatRelativeTime } from '@/lib/formatters'
import { useAuthStore } from '@/stores/auth-store'
import { hasPermission, type AcceptanceCoverageOverviewResponse, type ScenarioCoverageItem } from '@cairn/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'

export type CoverageViewProps = {
  data?: AcceptanceCoverageOverviewResponse
  targets: Array<{ id: string; name: string }>
  targetIdFilter: string
  onTargetFilterChange: (targetId: string) => void
  searchTerm: string
  onSearchChange: (search: string) => void
}

export function AcceptanceCoverageView({
  data,
  targets,
  targetIdFilter,
  onTargetFilterChange,
  searchTerm,
  onSearchChange,
}: CoverageViewProps) {
  const queryClient = useQueryClient()
  const user = useAuthStore((s) => s.auth.user)
  const canTriage = user ? hasPermission(user.permissions, 'reliability:triage') : false

  const [onlyFindings, setOnlyFindings] = useState(false)
  const [onlyUnaudited, setOnlyUnaudited] = useState(false)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())

  const latestBatch = data?.latestBatch
  const isBatchRunning = latestBatch ? latestBatch.status === 'queued' || latestBatch.status === 'running' : false

  const sweepMutation = useMutation({
    mutationFn: triggerAcceptanceSweep,
    onSuccess: () => {
      toast.success('已排队验收巡检批次，后台将自动执行')
      queryClient.invalidateQueries({ queryKey: ['maintenance-acceptance-coverage'] })
    },
    onError: (err) => {
      toast.error(err instanceof Error && err.message ? err.message : '启动巡检批次失败')
    },
  })

  const toggleExpand = (scenarioId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(scenarioId)) next.delete(scenarioId)
      else next.add(scenarioId)
      return next
    })
  }

  const scenarios = data?.scenarios ?? []

  const filteredScenarios = useMemo(() => {
    return scenarios.filter((item) => {
      if (targetIdFilter !== 'all' && item.targetId !== targetIdFilter) return false
      if (onlyFindings && (!item.findingsCount || item.findingsCount === 0)) return false
      if (onlyUnaudited && item.latestAuditedAt) return false
      if (searchTerm) {
        const query = searchTerm.toLowerCase()
        const matchName = item.scenarioName.toLowerCase().includes(query)
        const matchTarget = item.targetName.toLowerCase().includes(query)
        if (!matchName && !matchTarget) return false
      }
      return true
    })
  }, [scenarios, targetIdFilter, onlyFindings, onlyUnaudited, searchTerm])

  return (
    <div className='space-y-4'>
      {/* 筛选与巡检操作栏 */}
      <div className='flex flex-wrap items-center justify-between gap-3 bg-surface-subtle p-3 rounded-lg border border-border'>
        <div className='flex flex-wrap items-center gap-2'>
          <div className='relative w-48'>
            <Search className='absolute left-2.5 top-2.5 size-4 text-muted-foreground' />
            <Input
              placeholder='搜索场景或目标...'
              value={searchTerm}
              onChange={(e) => onSearchChange(e.target.value)}
              className='pl-8 h-9 text-body'
            />
          </div>

          <Select value={targetIdFilter} onValueChange={onTargetFilterChange}>
            <SelectTrigger className='w-44 h-9 text-body'>
              <SelectValue placeholder='全部目标' />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='all'>全部目标</SelectItem>
              {targets.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            variant={onlyFindings ? 'default' : 'outline'}
            size='sm'
            onClick={() => setOnlyFindings(!onlyFindings)}
            className='h-9'
          >
            只看有发现
          </Button>

          <Button
            variant={onlyUnaudited ? 'default' : 'outline'}
            size='sm'
            onClick={() => setOnlyUnaudited(!onlyUnaudited)}
            className='h-9'
          >
            只看未体检
          </Button>
        </div>

        <div className='flex items-center gap-2'>
          {canTriage ? (
            <Button
              variant='default'
              size='sm'
              disabled={sweepMutation.isPending || isBatchRunning}
              onClick={() => sweepMutation.mutate()}
              className='h-9 font-medium shadow-sm'
            >
              <Play className={cn('mr-1.5 size-3.5 fill-current', isBatchRunning ? 'animate-pulse' : '')} />
              {isBatchRunning ? '巡检进行中…' : '立即巡检'}
            </Button>
          ) : null}
        </div>
      </div>

      {/* 场景验收覆盖横向表格 */}
      <div className='rounded-lg border border-border bg-surface-base overflow-hidden'>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className='w-[240px]'>场景名</TableHead>
              <TableHead className='w-[140px]'>所属目标</TableHead>
              <TableHead className='w-[130px]'>浏览器步骤覆盖</TableHead>
              <TableHead className='w-[130px]'>取数进报告占比</TableHead>
              <TableHead className='w-[110px]'>体检发现</TableHead>
              <TableHead className='w-[180px]'>最近巡检</TableHead>
              <TableHead className='w-[90px] text-right'>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredScenarios.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className='h-32 text-center text-muted-foreground'>
                  未匹配到符合条件的场景覆盖记录
                </TableCell>
              </TableRow>
            ) : (
              filteredScenarios.map((item) => {
                const isExpanded = expandedIds.has(item.scenarioId)
                const hasTopFindings = item.topFindings && item.topFindings.length > 0

                return (
                  <ScenarioRow
                    key={item.scenarioId}
                    item={item}
                    isExpanded={isExpanded}
                    hasTopFindings={Boolean(hasTopFindings)}
                    onToggleExpand={() => toggleExpand(item.scenarioId)}
                  />
                )
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

function ScenarioRow({
  item,
  isExpanded,
  hasTopFindings,
  onToggleExpand,
}: {
  item: ScenarioCoverageItem
  isExpanded: boolean
  hasTopFindings: boolean
  onToggleExpand: () => void
}) {
  const browserCoveragePct =
    item.browserStepCoverage !== undefined ? Math.round(item.browserStepCoverage * 100) : null
  const outputCoveragePct =
    item.outputMetricCoverage !== undefined ? Math.round(item.outputMetricCoverage * 100) : null

  return (
    <>
      <TableRow className='hover:bg-surface-subtle/50 transition-colors'>
        <TableCell className='font-medium text-foreground'>
          <div className='flex items-center gap-1.5'>
            {hasTopFindings ? (
              <button
                type='button'
                onClick={onToggleExpand}
                className='text-muted-foreground hover:text-foreground p-0.5'
                aria-label={isExpanded ? '收起发现' : '展开发现'}
              >
                {isExpanded ? <ChevronDown className='size-3.5' /> : <ChevronRight className='size-3.5' />}
              </button>
            ) : (
              <span className='size-3.5 inline-block' />
            )}
            <Link
              to='/scenarios/$scenarioId'
              params={{ scenarioId: item.scenarioId }}
              className='hover:underline hover:text-primary transition-colors'
            >
              {item.scenarioName}
            </Link>
          </div>
        </TableCell>
        <TableCell className='text-muted-foreground text-small'>{item.targetName}</TableCell>
        <TableCell>
          {browserCoveragePct !== null ? (
            <div className='flex items-center gap-2'>
              <div className='w-14 h-1.5 rounded-full bg-surface-subtle border border-border overflow-hidden'>
                <div
                  className='bg-status-success-foreground h-full rounded-full'
                  style={{ width: `${browserCoveragePct}%` }}
                />
              </div>
              <span className='text-small font-medium font-mono'>{browserCoveragePct}%</span>
            </div>
          ) : (
            <span className='text-xs text-muted-foreground'>
              {item.hasDraft ? '未体检' : '未体检（无草稿）'}
            </span>
          )}
        </TableCell>
        <TableCell>
          {outputCoveragePct !== null ? (
            <span className='text-small font-medium font-mono'>{outputCoveragePct}%</span>
          ) : (
            <span className='text-xs text-muted-foreground'>—</span>
          )}
        </TableCell>
        <TableCell>
          {item.findingsCount !== undefined ? (
            item.findingsCount > 0 ? (
              <Badge
                variant='outline'
                className='cursor-pointer text-status-warning-foreground border-status-warning-border bg-status-warning-background/20 font-medium'
                onClick={hasTopFindings ? onToggleExpand : undefined}
              >
                <AlertTriangle className='size-3 mr-1' />
                {item.findingsCount} 个
              </Badge>
            ) : (
              <Badge variant='outline' className='text-status-success-foreground border-status-success-border bg-status-success-background/20'>
                <CheckCircle2 className='size-3 mr-1' />
                良好
              </Badge>
            )
          ) : (
            <span className='text-xs text-muted-foreground'>—</span>
          )}
        </TableCell>
        <TableCell className='text-muted-foreground text-small'>
          {item.latestAuditedAt ? (
            <div className='space-y-0.5'>
              <div>{formatRelativeTime(item.latestAuditedAt)}</div>
              <div className='text-2xs text-muted-foreground/70'>
                {formatAsOf(item.latestAuditedAt)} ({item.trigger === 'manual' ? '手动' : '定时'})
              </div>
            </div>
          ) : (
            <span className='text-xs text-muted-foreground'>
              {item.hasDraft ? '尚未巡检' : '无草稿'}
            </span>
          )}
        </TableCell>
        <TableCell className='text-right'>
          <Link
            to='/scenarios/$scenarioId'
            params={{ scenarioId: item.scenarioId }}
            className='inline-flex items-center text-xs text-link hover:underline font-medium gap-0.5'
          >
            下钻 <ArrowRight className='size-3' />
          </Link>
        </TableCell>
      </TableRow>

      {/* 展开的发现摘要 */}
      {isExpanded && hasTopFindings ? (
        <TableRow className='bg-surface-subtle/30 border-b border-border/80'>
          <TableCell colSpan={7} className='py-2.5 px-8'>
            <div className='space-y-1.5'>
              <div className='text-2xs font-semibold text-muted-foreground uppercase tracking-wider'>
                体检发现摘要（上限 10 条）
              </div>
              <ul className='space-y-1'>
                {item.topFindings!.map((f, idx) => (
                  <li key={`${item.scenarioId}-f-${idx}`} className='text-xs flex items-center gap-2'>
                    <Badge variant={f.severity === 'error' ? 'destructive' : 'outline'} className='text-2xs px-1.5 py-0'>
                      {f.code}
                    </Badge>
                    <span className='text-foreground'>{f.message}</span>
                    {f.stepId ? <span className='text-2xs text-muted-foreground'>（步骤 {f.stepId}）</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  )
}
