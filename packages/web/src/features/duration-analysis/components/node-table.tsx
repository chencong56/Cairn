import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight } from 'lucide-react'
import { DURATION_MIN_SAMPLES, type DurationNodeRow } from '@cairn/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { formatMs, formatRatio } from '../format'
import { DeltaText, InsightBadges, Sparkline } from '../shared'

const KIND_LABELS: Partial<Record<DurationNodeRow['kind'], string>> = {
  module: '模块',
  module_step: '模块内',
  check: '检查',
  scenario_checks: '场景级检查',
}

const COLUMN_COUNT = 10

/** 展开后才读的子节点行（按单场景读明细，与顶层同一时间窗与对比）。 */
function ChildRows({
  parentKey,
  queryKey,
  fetchChildren,
  renderRow,
  depth,
}: {
  parentKey: string
  queryKey: readonly unknown[]
  fetchChildren: (parentKey: string) => Promise<DurationNodeRow[]>
  renderRow: (node: DurationNodeRow, depth: number) => React.ReactNode
  depth: number
}) {
  const query = useQuery({ queryKey: [...queryKey, parentKey], queryFn: () => fetchChildren(parentKey) })
  const note = (text: React.ReactNode) => (
    <TableRow>
      <TableCell colSpan={COLUMN_COUNT} className='text-label text-muted-foreground'>
        <span style={{ paddingLeft: depth * 16 + 24 }}>{text}</span>
      </TableCell>
    </TableRow>
  )
  if (query.isPending) return note('正在读取子节点…')
  if (query.isError) {
    return note(
      <>
        子节点读取失败，
        <Button variant='link' size='sm' className='h-auto p-0 text-label' onClick={() => void query.refetch()}>
          重试
        </Button>
      </>,
    )
  }
  if (query.data.length === 0) return note('时间窗内没有子节点样本。')
  return <>{query.data.map((kid) => renderRow(kid, depth))}</>
}

/** 节点表：一行一个编排节点（顶层），模块与带检查的节点可展开，展开时再读子节点。 */
export function NodeTable({
  nodes,
  onOpen,
  fetchChildren,
  childrenQueryKey,
}: {
  nodes: DurationNodeRow[]
  onOpen: (node: DurationNodeRow) => void
  fetchChildren?: (parentKey: string) => Promise<DurationNodeRow[]>
  childrenQueryKey?: readonly unknown[]
}) {
  const [sort, setSort] = React.useState<'order' | 'delta'>('order')
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set())
  const top = React.useMemo(() => {
    const list = nodes.filter((node) => node.parentKey === null)
    return sort === 'delta' ? [...list].sort((a, b) => (b.deltaPct ?? -Infinity) - (a.deltaPct ?? -Infinity)) : list
  }, [nodes, sort])

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const renderRow = (node: DurationNodeRow, depth: number): React.ReactNode => {
    const expandable = node.hasChildren && Boolean(fetchChildren)
    const open = expandable && expanded.has(node.nodeKey)
    const low = node.samples < DURATION_MIN_SAMPLES
    return (
      <React.Fragment key={node.nodeKey}>
        <TableRow className={cn('cursor-pointer', low && 'text-text-muted')} onClick={() => onOpen(node)}>
          <TableCell className='max-w-72'>
            <div className='flex min-w-0 items-center gap-1' style={{ paddingLeft: depth * 16 }}>
              {expandable ? (
                <Button
                  variant='ghost'
                  size='icon'
                  className='size-5 shrink-0'
                  aria-label={open ? '收起子节点' : '展开子节点'}
                  onClick={(event) => {
                    event.stopPropagation()
                    toggle(node.nodeKey)
                  }}
                >
                  <ChevronRight className={cn('size-3.5 transition-transform motion-reduce:transition-none', open && 'rotate-90')} />
                </Button>
              ) : (
                <span className='inline-block size-5 shrink-0' />
              )}
              <span className='truncate text-text-primary' title={node.name}>
                {node.name}
              </span>
              {KIND_LABELS[node.kind] ? <Badge variant='outline' className='shrink-0'>{KIND_LABELS[node.kind]}</Badge> : null}
              {node.tags.includes('new') ? <Badge variant='outline' className='shrink-0 text-status-info'>新增</Badge> : null}
              {node.tags.includes('removed') ? <Badge variant='outline' className='shrink-0'>已删除</Badge> : null}
            </div>
          </TableCell>
          <TableCell className='font-mono tabular-nums'>{formatMs(node.activeP50)}</TableCell>
          <TableCell className='font-mono tabular-nums'>{formatMs(node.activeP95)}</TableCell>
          <TableCell>{low ? <span className='text-label'>样本不足</span> : <DeltaText pct={node.deltaPct} />}</TableCell>
          <TableCell className='w-32'>
            <Sparkline series={node.sparkline} height={24} />
          </TableCell>
          <TableCell className='tabular-nums'>{node.samples}</TableCell>
          <TableCell className='tabular-nums'>{formatRatio(node.retryRate)}</TableCell>
          <TableCell className='tabular-nums'>{node.avgIterations === null ? '—' : node.avgIterations}</TableCell>
          <TableCell className='tabular-nums'>{formatRatio(node.assistedRate)}</TableCell>
          <TableCell>
            <InsightBadges insights={node.insights} limit={2} />
          </TableCell>
        </TableRow>
        {open && fetchChildren ? (
          <ChildRows parentKey={node.nodeKey} queryKey={childrenQueryKey ?? ['duration-node-children']} fetchChildren={fetchChildren} renderRow={renderRow} depth={depth + 1} />
        ) : null}
      </React.Fragment>
    )
  }

  return (
    <section className='flex flex-col gap-3 rounded-lg border border-border-card bg-card p-5 shadow-card'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div>
          <h2 className='text-section font-semibold text-text-primary'>每一步耗时</h2>
          <p className='mt-0.5 text-label text-muted-foreground'>按编排节点汇总：模块按调用合并、循环合并（记平均迭代次数）、检查计入所属步骤；点击一行看这一步的历史</p>
        </div>
        <div className='flex items-center gap-1 rounded-md border border-border-card bg-surface-subtle p-0.5'>
          <Button size='sm' variant={sort === 'order' ? 'secondary' : 'ghost'} className='h-7 px-2.5 text-label' onClick={() => setSort('order')}>
            编排顺序
          </Button>
          <Button size='sm' variant={sort === 'delta' ? 'secondary' : 'ghost'} className='h-7 px-2.5 text-label' onClick={() => setSort('delta')}>
            按涨幅
          </Button>
        </div>
      </div>
      {top.length === 0 ? (
        <p className='py-6 text-center text-label text-muted-foreground'>时间窗内没有步骤样本。</p>
      ) : (
        <div className='overflow-x-auto'>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>步骤</TableHead>
                <TableHead>P50</TableHead>
                <TableHead>P95</TableHead>
                <TableHead>对比</TableHead>
                <TableHead>走势</TableHead>
                <TableHead>样本</TableHead>
                <TableHead>重试率</TableHead>
                <TableHead>平均迭代</TableHead>
                <TableHead>地图 / AI 定位</TableHead>
                <TableHead>问题</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>{top.map((node) => renderRow(node, 0))}</TableBody>
          </Table>
        </div>
      )}
    </section>
  )
}
