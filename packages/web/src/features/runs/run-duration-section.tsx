import * as React from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useSearch } from '@tanstack/react-router'
import { CheckCircle2, ChevronRight, Clock, Flame, MinusCircle, XCircle } from 'lucide-react'
import {
  DURATION_COMPONENT_LABELS,
  describeDurationTag,
  exclusiveSlicesOf,
  formatDurationShort,
  type DurationAttribution,
  type DurationComponentKey,
  type NodeDurationFacts,
  type RunDetailDto,
  type RunDurationReadout,
} from '@cairn/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { SelectField, SelectFieldOption } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { fetchRunDuration } from '@/lib/duration-api'
import { cn } from '@/lib/utils'

const INCOMPLETE_LABELS: Record<string, string> = {
  not_started: '运行未开跑，没有耗时',
  in_progress: '运行进行中，分解按当前时刻现算',
  no_events: '运行事件已清理，只保留总耗时',
  timeline_inconsistent: '状态记录不完整，只保留总耗时',
  unclassified_exceeds_tolerance: '时钟误差超出容差，只保留总耗时',
}

const UNAVAILABLE_LABELS: Record<string, string> = {
  first_run: '这是该场景的第一次运行，没有可对比的上一次。',
  no_successful_base: '之前没有成功的运行，暂无可对比的基准。',
  base_not_found: '所选的对比运行不存在。',
  base_mismatch: '所选的对比运行不属于同一个场景。',
}

const KIND_LABELS: Partial<Record<NodeDurationFacts['kind'], string>> = {
  module: '模块',
  module_step: '模块内',
  check: '检查',
  scenario_checks: '场景级检查',
}

function ms(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : formatDurationShort(value)
}

function signed(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return `${value < 0 ? '−' : '+'}${formatDurationShort(value)}`
}

function retriesOf(node: NodeDurationFacts): number {
  return Math.max(0, node.attemptCount - node.iterationCount)
}

function childrenByParent<T extends { parentKey: string | null }>(nodes: readonly T[]): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const node of nodes) {
    if (!node.parentKey) continue
    const list = map.get(node.parentKey) ?? []
    list.push(node)
    map.set(node.parentKey, list)
  }
  return map
}

function useExpanded() {
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(new Set())
  const toggle = React.useCallback(
    (key: string) =>
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      }),
    [],
  )
  return [expanded, toggle] as const
}

/** 模块调用与带检查的节点可展开子行。 */
function ExpandButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <Button
      variant='ghost'
      size='icon'
      className='size-5 shrink-0'
      aria-label={open ? '收起子节点' : '展开子节点'}
      onClick={(event) => {
        event.stopPropagation()
        onToggle()
      }}
    >
      <ChevronRight className={cn('size-3.5 transition-transform motion-reduce:transition-none', open && 'rotate-90')} />
    </Button>
  )
}

function NodeDurationBar({ node, pct }: { node: NodeDurationFacts; pct: number }) {
  const slices = exclusiveSlicesOf(node)
  const failed = node.status === 'FAILED'
  const empty = node.activeMs <= 0
  if (failed || empty || (slices.mode === 'two' && node.modelMs <= 0)) {
    return <div className={cn('h-full w-full', failed ? 'bg-status-error' : pct >= 30 ? 'bg-status-warning' : 'bg-primary/70')} />
  }
  if (slices.mode === 'undetermined') {
    return <div className='h-full w-full bg-muted-foreground/25' title='重叠未测' />
  }
  const widthOf = (value: number) => `${node.activeMs > 0 ? Math.min(100, (value / node.activeMs) * 100) : 0}%`
  return (
    <>
      {slices.modelOnly > 0 ? <div className='h-full bg-primary' style={{ width: widthOf(slices.modelOnly) }} title={`模型独占 ${ms(slices.modelOnly)}`} /> : null}
      {slices.overlap > 0 ? <div className='h-full bg-primary/60' style={{ width: widthOf(slices.overlap) }} title={`重叠 ${ms(slices.overlap)}`} /> : null}
      {slices.pageOnly > 0 ? <div className='h-full bg-status-warning' style={{ width: widthOf(slices.pageOnly) }} title={`页面独占 ${ms(slices.pageOnly)}`} /> : null}
      {slices.residual > 0 ? <div className='h-full flex-1 bg-primary/30' title={`其余 ${ms(slices.residual)}`} /> : null}
    </>
  )
}

const BREAKDOWN: Array<[DurationComponentKey, keyof RunDurationReadout['facts']]> = [
  ['active', 'activeMs'],
  ['authWait', 'authWaitMs'],
  ['requeue', 'requeueMs'],
  ['review', 'reviewMs'],
  ['hold', 'holdMs'],
  ['queue', 'queueMs'],
  ['overhead', 'overheadMs'],
]

/** 运行详情的耗时区块：总耗时分解、按编排节点的耗时分布，以及「与上次对比」。 */
export function RunDurationSection({ run, onSelectStep }: { run: RunDetailDto; onSelectStep: (stepRunId: string) => void }) {
  const search = useSearch({ from: '/_authenticated/runs/$runId/' })
  const [compareOn, setCompareOn] = React.useState(search.duration === 'compare')
  const [mode, setMode] = React.useState<'previous' | 'median10'>('previous')
  // 运行进行中随进度刷新：状态、完成时间与 attempt 数任一变化就重新取
  const progressKey = `${run.status}:${run.finishedAt ?? ''}:${run.stepRuns.reduce((sum, step) => sum + step.attempts.length + (step.finishedAt ? 1 : 0), 0)}`
  const duration = useQuery({
    queryKey: ['run-duration', run.id, compareOn ? mode : 'none', progressKey],
    queryFn: () => fetchRunDuration(run.id, { compare: compareOn ? mode : 'none' }),
    placeholderData: keepPreviousData,
  })
  const data = duration.data
  const stepRunByStepId = React.useMemo(() => new Map(run.stepRuns.map((step) => [step.stepId, step.id])), [run.stepRuns])
  const stepRunOf = (node: NodeDurationFacts) => (node.nodeKey.startsWith('step:') ? stepRunByStepId.get(node.nodeKey.slice(5)) : undefined)

  const top = React.useMemo(() => (data ? data.nodes.filter((node) => node.parentKey === null) : []), [data])
  const children = React.useMemo(() => childrenByParent(data?.nodes ?? []), [data])
  const [expanded, toggle] = useExpanded()
  const topTotal = top.reduce((sum, node) => sum + node.activeMs, 0) || 1
  const bottlenecks = [...top].filter((node) => node.activeMs >= 1000).sort((a, b) => b.activeMs - a.activeMs).slice(0, 3)

  const renderNode = (node: NodeDurationFacts, depth: number): React.ReactNode => {
    const pct = Math.round((node.activeMs / topTotal) * 100)
    const stepRunId = stepRunOf(node)
    const retries = retriesOf(node)
    const kids = children.get(node.nodeKey) ?? []
    const open = expanded.has(node.nodeKey)
    return (
      <React.Fragment key={node.nodeKey}>
        <div
          onClick={() => stepRunId && onSelectStep(stepRunId)}
          className={cn('group flex items-center justify-between rounded-md p-1.5 text-label transition-colors motion-reduce:transition-none', stepRunId && 'cursor-pointer hover:bg-muted/40')}
        >
          <div className='flex w-44 min-w-0 shrink-0 items-center gap-2 md:w-64' style={{ paddingLeft: depth * 16 }}>
            {kids.length > 0 ? <ExpandButton open={open} onToggle={() => toggle(node.nodeKey)} /> : depth > 0 || children.size > 0 ? <span className='inline-block size-5 shrink-0' /> : null}
            <span className='shrink-0'>
              {node.status === 'SUCCEEDED' ? (
                <CheckCircle2 className='size-3.5 text-status-success' />
              ) : node.status === 'FAILED' ? (
                <XCircle className='size-3.5 text-status-error' />
              ) : node.status === 'RUNNING' ? (
                <Clock className='size-3.5 animate-spin text-status-warning motion-reduce:animate-none' />
              ) : (
                <MinusCircle className='size-3.5 text-muted-foreground' />
              )}
            </span>
            <span className='truncate font-medium text-foreground transition-colors group-hover:text-primary motion-reduce:transition-none' title={node.name}>
              {node.name}
            </span>
            {KIND_LABELS[node.kind] ? <Badge variant='outline' className='shrink-0'>{KIND_LABELS[node.kind]}</Badge> : null}
          </div>
          <div className='mx-3 flex min-w-0 flex-1 items-center gap-2'>
            <div className='flex h-2 flex-1 overflow-hidden rounded-full bg-muted/50'>
              <div
                className='flex h-full overflow-hidden rounded-full transition-[width] motion-reduce:transition-none'
                style={{ width: `${pct > 0 ? Math.max(2, pct) : 0}%` }}
              >
                <NodeDurationBar node={node} pct={pct} />
              </div>
            </div>
          </div>
          <div className='flex shrink-0 items-center justify-end gap-2 text-right'>
            {retries > 0 ? <span className='text-caption text-status-warning'>重试 {retries}</span> : null}
            {node.iterationCount > 1 ? <span className='text-caption text-muted-foreground'>迭代 {node.iterationCount}</span> : null}
            <span className='min-w-14 font-mono text-caption font-medium text-foreground'>
              {node.status === 'RUNNING' && node.activeMs === 0 ? '进行中' : ms(node.activeMs)}
              {node.modelMs > 0 ? <span className='ml-1 text-3xs font-normal text-muted-foreground'>模型 {ms(node.modelMs)}</span> : null}
              {node.pageMs == null ? (
                <span className='ml-1 text-3xs font-normal text-muted-foreground'>页面未测</span>
              ) : node.pageMs > 0 ? (
                <span className='ml-1 text-3xs font-normal text-muted-foreground'>页面 {ms(node.pageMs)}</span>
              ) : null}
              {node.overlapMs == null ? <span className='ml-1 text-3xs font-normal text-muted-foreground'>重叠未测</span> : null}
            </span>
            <span className='w-8 text-right font-mono text-3xs text-muted-foreground'>{pct}%</span>
          </div>
        </div>
        {open ? kids.map((kid) => renderNode(kid, depth + 1)) : null}
      </React.Fragment>
    )
  }

  return (
    <section className='space-y-3.5 rounded-lg border border-border-card bg-card p-4 shadow-card'>
      <div className='flex flex-wrap items-center justify-between gap-2 border-b border-border-card/60 pb-2.5'>
        <div className='flex items-center gap-2'>
          <Clock className='size-4 text-primary' />
          <h2 className='text-body font-semibold text-foreground'>耗时分布与对比</h2>
        </div>
        <div className='flex flex-wrap items-center gap-3'>
          <div className='flex items-center gap-2'>
            <Switch id='run-duration-compare' checked={compareOn} onCheckedChange={setCompareOn} />
            <Label htmlFor='run-duration-compare' className='text-label'>与上次对比</Label>
          </div>
          {compareOn ? (
            <SelectField className='h-7 w-40' aria-label='对比基准' value={mode} onValueChange={(next) => setMode(next as 'previous' | 'median10')}>
              <SelectFieldOption value='previous'>上一次成功运行</SelectFieldOption>
              <SelectFieldOption value='median10'>近 10 次中位数</SelectFieldOption>
            </SelectField>
          ) : null}
        </div>
      </div>

      {!data ? (
        duration.isError ? (
          <p className='text-label text-status-error'>耗时数据加载失败，稍后重试。</p>
        ) : (
          <div className='space-y-2'>
            <Skeleton className='h-5 w-2/3' />
            <Skeleton className='h-24 w-full' />
          </div>
        )
      ) : (
        <>
          <div className='flex flex-wrap items-baseline gap-x-4 gap-y-1 text-label text-muted-foreground'>
            <span>
              总耗时 <strong className='font-mono text-body text-foreground'>{ms(data.facts.totalMs)}</strong>
            </span>
            {BREAKDOWN.map(([key, field]) => {
              const value = data.facts[field] as number | null
              if (value === null || (key !== 'active' && value === 0)) return null
              return (
                <span key={key}>
                  {DURATION_COMPONENT_LABELS[key]}
                  {key === 'queue' && data.facts.suiteRunId ? <span className='text-text-muted'>（场景集成员，含等前序成员）</span> : null}{' '}
                  <strong className='font-mono text-foreground'>{ms(value)}</strong>
                </span>
              )
            })}
            {data.facts.modelMs > 0 ? (
              <span>
                模型 <strong className='font-mono text-foreground'>{ms(data.facts.modelMs)}</strong>
              </span>
            ) : null}
            {data.facts.pageMs == null ? (
              <span>页面未测</span>
            ) : (
              <span>
                页面 <strong className='font-mono text-foreground'>{ms(data.facts.pageMs)}</strong>
              </span>
            )}
            {data.facts.overlapMs != null && data.facts.overlapMs > 0 ? (
              <span>
                重叠 <strong className='font-mono text-foreground'>{ms(data.facts.overlapMs)}</strong>
              </span>
            ) : null}
            {data.facts.residualMs > 0 && (data.facts.modelMs > 0 || data.facts.pageMs != null) ? (
              <span>
                其余 <strong className='font-mono text-foreground'>{ms(data.facts.residualMs)}</strong>
              </span>
            ) : null}
            {data.facts.pagePartial ? <Badge variant='outline'>部分步骤页面已测</Badge> : null}
            {data.facts.workerLost ? <Badge variant='outline' className='text-status-warning'>出现过执行节点失联</Badge> : null}
            <span className='basis-full text-3xs text-muted-foreground'>页面 = 平台为等待页面可用而阻塞的时间，不是 document.load</span>
          </div>
          {!data.facts.complete && data.facts.incompleteReason ? (
            <p className='text-label text-muted-foreground'>{INCOMPLETE_LABELS[data.facts.incompleteReason] ?? '耗时分解不完整'}</p>
          ) : null}

          {compareOn ? <ComparisonBlock data={data} onSelectNode={(node) => { const id = stepRunOf(node); if (id) onSelectStep(id) }} /> : null}

          {bottlenecks.length > 0 ? (
            <div className='space-y-2 rounded-md border border-status-warning-foreground/30 bg-status-warning-background/15 p-3'>
              <div className='flex items-center gap-1.5 text-label font-medium text-status-warning-foreground'>
                <Flame className='size-4' />
                <span>耗时最长的步骤：</span>
              </div>
              <div className='grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3'>
                {bottlenecks.map((node) => (
                  <button
                    key={node.nodeKey}
                    type='button'
                    disabled={!stepRunOf(node)}
                    onClick={() => {
                      const id = stepRunOf(node)
                      if (id) onSelectStep(id)
                    }}
                    className='flex items-center justify-between rounded border border-border-card bg-card/80 p-2 text-left text-label transition-colors hover:border-primary disabled:cursor-default disabled:hover:border-border-card motion-reduce:transition-none'
                  >
                    <div className='min-w-0 pr-2'>
                      <div className='truncate font-medium text-foreground'>{node.name}</div>
                      <div className='text-caption text-muted-foreground'>占步骤合计 {Math.round((node.activeMs / topTotal) * 100)}%</div>
                    </div>
                    <span className='shrink-0 font-mono font-bold text-status-warning-foreground'>{ms(node.activeMs)}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className='space-y-1.5 pt-1'>
            <p className='mb-1 text-caption font-medium text-muted-foreground'>
              按编排节点的执行耗时（含重试；循环已合并、模块按调用汇总；百分比以步骤合计为分母）：
            </p>
            {top.length === 0 ? <p className='text-label text-muted-foreground'>暂无已执行步骤耗时记录。</p> : null}
            {top.map((node) => renderNode(node, 0))}
          </div>
        </>
      )}
    </section>
  )
}

function ComparisonBlock({ data, onSelectNode }: { data: RunDurationReadout; onSelectNode: (node: NodeDurationFacts) => void }) {
  const [showAll, setShowAll] = React.useState(false)
  const [expanded, toggle] = useExpanded()
  if (!data.comparison) {
    return (
      <p className='rounded-md bg-surface-subtle px-3 py-2 text-label text-muted-foreground'>
        {data.comparisonUnavailable ? UNAVAILABLE_LABELS[data.comparisonUnavailable] : '暂无可对比的运行。'}
      </p>
    )
  }
  const { attribution } = data.comparison
  // 未归类只是时钟误差，超过 1 秒才值得一提
  const components = (['active', 'authWait', 'requeue', 'review', 'hold', 'unclassified', 'queue'] as DurationComponentKey[])
    .map((key) => ({ key, delta: attribution.components[key].delta }))
    .filter((item) => item.delta !== null && item.delta !== 0 && (item.key !== 'unclassified' || Math.abs(item.delta) >= 1000))
  // 开跑前排队不计入总耗时，不参与定标，免得把真正的差值压成一条细线
  const counted = components.filter((item) => item.key !== 'queue')
  const maxAbs = Math.max(1, ...(counted.length ? counted : components).map((item) => Math.abs(item.delta!)))
  const nodes = attribution.nodes.filter((node) => node.parentKey === null)
  const shown = showAll ? nodes : nodes.slice(0, 8)
  const children = childrenByParent(attribution.nodes)
  const nodeByKey = new Map(data.nodes.map((node) => [node.nodeKey, node]))
  const overhead = attribution.components.overhead
  const deltaTone = (delta: number | null) => ((delta ?? 0) >= 1000 ? 'text-status-error' : (delta ?? 0) <= -1000 ? 'text-status-success' : 'text-text-secondary')
  const renderDelta = (node: DurationAttribution['nodes'][number], depth: number): React.ReactNode => {
    const kids = children.get(node.nodeKey) ?? []
    const open = expanded.has(node.nodeKey)
    return (
      <React.Fragment key={node.nodeKey}>
        <tr className={cn(nodeByKey.has(node.nodeKey) && 'cursor-pointer hover:bg-muted/40')} onClick={() => { const current = nodeByKey.get(node.nodeKey); if (current) onSelectNode(current) }}>
          <td className='max-w-56 py-1.5 pr-2 text-text-primary'>
            <div className='flex min-w-0 items-center gap-1' style={{ paddingLeft: depth * 16 }}>
              {kids.length > 0 ? <ExpandButton open={open} onToggle={() => toggle(node.nodeKey)} /> : children.size > 0 ? <span className='inline-block size-5 shrink-0' /> : null}
              <span className='truncate' title={node.name}>{node.name}</span>
              {KIND_LABELS[node.kind] ? <Badge variant='outline' className='shrink-0'>{KIND_LABELS[node.kind]}</Badge> : null}
            </div>
          </td>
          <td className='py-1.5 pr-2 font-mono tabular-nums'>{ms(node.baseMs)}</td>
          <td className='py-1.5 pr-2 font-mono tabular-nums'>{ms(node.targetMs)}</td>
          <td className={cn('py-1.5 pr-2 font-mono tabular-nums', deltaTone(node.deltaMs))}>
            {signed(node.deltaMs)}
            {node.deltaPct !== null ? <span className='ml-1 text-muted-foreground'>({node.deltaPct > 0 ? '+' : ''}{node.deltaPct}%)</span> : null}
          </td>
          <td className='py-1.5 text-muted-foreground'>{node.tags.map(describeDurationTag).join('；') || '—'}</td>
        </tr>
        {open ? kids.map((kid) => renderDelta(kid, depth + 1)) : null}
      </React.Fragment>
    )
  }
  const notes = [
    attribution.context.versionChanged ? '两次运行的场景版本不同' : null,
    attribution.context.accountChanged ? '执行账号不同' : null,
    attribution.context.workerLost.target || attribution.context.workerLost.base ? '有一侧出现过执行节点失联' : null,
    attribution.context.incomplete.target || attribution.context.incomplete.base ? '有一侧耗时分解不完整' : null,
    data.comparison.trial ? '当前是试跑，对比的是上一次试跑' : null,
  ].filter(Boolean)

  return (
    <div className='space-y-3 rounded-md border border-border-divider p-3'>
      <p className='text-body font-medium text-text-primary'>{data.comparison.summary}</p>
      {notes.length ? <p className='text-label text-status-warning'>{notes.join('；')}</p> : null}
      {components.length ? (
        <div className='grid gap-1.5'>
          {components.map((item) => (
            <div key={item.key} className='grid grid-cols-[7.5rem_minmax(0,1fr)_4.5rem] items-center gap-2 text-label'>
              <span className='text-muted-foreground'>
                {DURATION_COMPONENT_LABELS[item.key]}
                {item.key === 'queue' ? <span className='text-text-muted'>（不计入）</span> : null}
              </span>
              <div className='flex h-2 items-center'>
                <div
                  className={cn('h-2 rounded-full', item.delta! > 0 ? 'bg-status-error/70' : 'bg-status-success/70')}
                  style={{ width: `${Math.min(100, Math.max(2, (Math.abs(item.delta!) / maxAbs) * 100))}%` }}
                />
              </div>
              <span className={cn('text-right font-mono tabular-nums', item.delta! > 0 ? 'text-status-error' : 'text-status-success')}>{signed(item.delta)}</span>
            </div>
          ))}
        </div>
      ) : null}
      {nodes.length || overhead.base !== null || overhead.target !== null ? (
        <div className='overflow-x-auto'>
          <table className='w-full text-label'>
            <thead>
              <tr className='text-left text-muted-foreground'>
                <th className='py-1 pr-2 font-normal'>步骤</th>
                <th className='py-1 pr-2 font-normal'>{data.comparison.mode === 'median10' ? '中位数' : '上次'}</th>
                <th className='py-1 pr-2 font-normal'>本次</th>
                <th className='py-1 pr-2 font-normal'>差值</th>
                <th className='py-1 font-normal'>原因线索</th>
              </tr>
            </thead>
            <tbody className='divide-y divide-border-divider'>
              {shown.map((node) => renderDelta(node, 0))}
              {overhead.base !== null || overhead.target !== null ? (
                <tr className='text-muted-foreground'>
                  <td className='py-1.5 pr-2'>
                    <span className={cn(children.size > 0 && 'pl-6')}>{DURATION_COMPONENT_LABELS.overhead}</span>
                    <span className='text-text-muted'>（不属于任何步骤）</span>
                  </td>
                  <td className='py-1.5 pr-2 font-mono tabular-nums'>{ms(overhead.base)}</td>
                  <td className='py-1.5 pr-2 font-mono tabular-nums'>{ms(overhead.target)}</td>
                  <td className={cn('py-1.5 pr-2 font-mono tabular-nums', deltaTone(overhead.delta))}>{signed(overhead.delta)}</td>
                  <td className='py-1.5'>会话获取、自动登录与收尾</td>
                </tr>
              ) : null}
            </tbody>
          </table>
          {nodes.length > 8 ? (
            <button type='button' className='mt-1 text-label text-primary hover:underline' onClick={() => setShowAll((v) => !v)}>
              {showAll ? '收起' : `展开全部 ${nodes.length} 个步骤`}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
