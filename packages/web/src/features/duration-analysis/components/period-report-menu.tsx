import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { ChevronDown, FileText } from 'lucide-react'
import { toast } from 'sonner'
import { DEFAULT_STATISTICS_TIME_ZONE, durationPeriodLabel, type DurationPeriodKind } from '@cairn/shared'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useCan } from '@/hooks/use-permissions'
import { ApiRequestError } from '@/lib/api-client'
import { createReport, fetchReports } from '@/lib/reports-api'
import { latestPeriodStart, type DurationFilters } from '../format'

function newIdempotencyKey() {
  return `duration-report-${Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

const KIND_LABELS: Record<DurationPeriodKind, string> = { week: '周报', month: '月报' }

/**
 * 生成周期耗时报告（周报 / 月报）与已生成报告的入口。
 * 当前是自然周期时直接为所看的周期生成；滚动窗口时提供「上周周报 / 上月月报」。
 */
export function PeriodReportMenu({
  targetId,
  suiteId,
  filters,
  timeZone = DEFAULT_STATISTICS_TIME_ZONE,
}: {
  targetId: string
  suiteId?: string
  filters: DurationFilters
  /** 统计时区（接口返回）：报告按它切周期。 */
  timeZone?: string
}) {
  const canExport = useCan('report:export')
  const canRead = useCan('report:read')
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [busy, setBusy] = React.useState(false)
  const reports = useQuery({
    queryKey: ['reports', 'duration-period', targetId],
    queryFn: () => fetchReports({ targetId, subjectKind: 'DURATION_PERIOD', limit: 10 }),
    enabled: canRead,
  })

  async function generate(period: DurationPeriodKind, periodStart: string) {
    setBusy(true)
    try {
      const report = await createReport({
        subject: {
          kind: 'DURATION_PERIOD',
          targetId,
          ...(suiteId ? { suiteId } : {}),
          period,
          periodStart,
          timeZone,
          trigger: filters.trigger,
        },
        scope: 'duration_period',
        stage: 'final',
        idempotencyKey: newIdempotencyKey(),
      })
      void queryClient.invalidateQueries({ queryKey: ['reports'] })
      toast.success('报告已生成')
      void navigate({ to: '/reports/$reportId', params: { reportId: report.id } })
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '生成报告失败')
    } finally {
      setBusy(false)
    }
  }

  const items = reports.data?.items ?? []
  const current = filters.period ? { kind: filters.period, start: filters.periodStart ?? latestPeriodStart(filters.period, timeZone) } : null

  return (
    <div className='flex items-center gap-2'>
      {canExport ? (
        current ? (
          <Button size='sm' disabled={busy} onClick={() => void generate(current.kind, current.start)}>
            <FileText className='size-4' />
            {busy ? '生成中…' : `生成${KIND_LABELS[current.kind]}`}
          </Button>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size='sm' disabled={busy}>
                <FileText className='size-4' />
                {busy ? '生成中…' : '生成报告'}
                <ChevronDown className='size-3.5' />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align='end'>
              {(['week', 'month'] as const).map((kind) => {
                const start = latestPeriodStart(kind, timeZone)
                return (
                  <DropdownMenuItem key={kind} onSelect={() => void generate(kind, start)}>
                    {KIND_LABELS[kind]} · {durationPeriodLabel(kind, start)}
                  </DropdownMenuItem>
                )
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )
      ) : null}
      {canRead && items.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size='sm' variant='outline'>
              已生成的报告
              <ChevronDown className='size-3.5' />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align='end' className='max-w-96'>
            <DropdownMenuLabel className='text-label text-muted-foreground'>该目标系统最近的周期报告</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {items.map((item) => (
              <DropdownMenuItem key={item.id} asChild>
                <Link to='/reports/$reportId' params={{ reportId: item.id }} className='flex flex-col items-start gap-0.5'>
                  <span className='truncate text-body'>{item.currentRevision?.title ?? '周期耗时报告'}</span>
                  <span className='text-label text-muted-foreground'>生成于 {new Date(item.createdAt).toLocaleString()}</span>
                </Link>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  )
}
