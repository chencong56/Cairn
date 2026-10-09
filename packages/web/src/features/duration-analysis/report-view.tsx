import { Link } from '@tanstack/react-router'
import {
  DURATION_INSIGHT_LABELS,
  DURATION_MIN_SAMPLES,
  type DurationComparison,
  type DurationPeriodReportBlock,
  type DurationReportScenarioMover,
} from '@cairn/shared'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { TRIGGER_LABELS, formatMs, formatRatio } from './format'
import { consoleSearchOf } from './search'
import { DeltaText, Sparkline } from './shared'

function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className='flex flex-col gap-3 rounded-lg border border-border-card bg-card p-5 shadow-card'>
      <div className='flex flex-wrap items-baseline justify-between gap-2'>
        <h2 className='text-section font-semibold text-text-primary'>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  )
}

function CompareLine({ comparison, label, ratio }: { comparison: DurationComparison | null; label: string; ratio?: boolean }) {
  if (!comparison) return null
  // 对比周期一次可比运行都没有时说「无同期数据」，比「样本不足」更准确
  if (comparison.baseSamples === 0 || comparison.base === null) return <span className='text-label text-muted-foreground'>{label}：无同期数据</span>
  if (comparison.currentSamples < DURATION_MIN_SAMPLES || comparison.baseSamples < DURATION_MIN_SAMPLES) {
    return <span className='text-label text-muted-foreground'>{label}：样本不足，不比较</span>
  }
  return (
    <span className='flex flex-wrap items-center gap-x-1.5 text-label text-muted-foreground'>
      {label} {ratio ? formatRatio(comparison.base) : formatMs(comparison.base)}
      <DeltaText pct={comparison.deltaPct} unit={ratio ? ' 个百分点' : undefined} />
    </span>
  )
}

function Stat({ label, value, children }: { label: string; value: string; children?: React.ReactNode }) {
  return (
    <div className='flex min-w-0 flex-col gap-1 rounded-lg border border-border-card bg-card px-4 py-3 shadow-card'>
      <span className='text-label text-muted-foreground'>{label}</span>
      <span className='text-stat font-semibold tabular-nums text-text-primary'>{value}</span>
      {children}
    </div>
  )
}

function MoverTable({ movers, baseLabel, empty }: { movers: DurationReportScenarioMover[]; baseLabel: string; empty: string }) {
  if (movers.length === 0) return <p className='text-label text-muted-foreground'>{empty}</p>
  return (
    <div className='overflow-x-auto'>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>场景</TableHead>
            <TableHead>{baseLabel}</TableHead>
            <TableHead>本期</TableHead>
            <TableHead>涨跌</TableHead>
            <TableHead>样本</TableHead>
            <TableHead>原因（按两期成功运行中位数归因）</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {movers.map((mover) => (
            <TableRow key={mover.scenarioId}>
              <TableCell className='max-w-56 font-medium text-text-primary'>{mover.name}</TableCell>
              <TableCell className='font-mono tabular-nums'>{formatMs(mover.base)}</TableCell>
              <TableCell className='font-mono tabular-nums'>{formatMs(mover.current)}</TableCell>
              <TableCell>
                <DeltaText pct={mover.deltaPct} />
              </TableCell>
              <TableCell className='tabular-nums'>
                {mover.samples} / {mover.baseSamples}
              </TableCell>
              <TableCell className='min-w-72 whitespace-normal'>
                <p className='text-body text-text-primary'>{mover.summary}</p>
                {mover.causes.length ? (
                  <ul className='mt-1 flex flex-col gap-0.5 text-label text-muted-foreground'>
                    {mover.causes.map((cause) => (
                      <li key={cause}>· {cause}</li>
                    ))}
                  </ul>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

/** 周期耗时报告的控制台视图：只读封存的报告块，与 HTML 导出同一份内容。 */
export function DurationPeriodReportView({ report }: { report: DurationPeriodReportBlock }) {
  const { kpis } = report
  const prev = report.comparisons[0]!
  const yoy = report.comparisons[1] ?? null
  const withRuns = report.scenarios.filter((row) => row.runs > 0)
  const withoutRuns = report.scenarios.filter((row) => row.runs === 0)
  const insightsByScenario = new Map<string, typeof report.insights>()
  for (const insight of report.insights) {
    const list = insightsByScenario.get(insight.scenarioName) ?? []
    list.push(insight)
    insightsByScenario.set(insight.scenarioName, list)
  }
  const suite = report.suiteSummary
  const monthly = report.period.kind === 'month'

  return (
    <div className='flex flex-col gap-5'>
      <div className='flex flex-wrap items-center gap-x-4 gap-y-1 text-label text-muted-foreground'>
        <span>目标系统：<strong className='text-text-primary'>{report.target.name}</strong></span>
        {report.suite ? <span>场景集：<strong className='text-text-primary'>{report.suite.name}</strong></span> : null}
        <span>周期：<strong className='text-text-primary'>{report.period.label}</strong></span>
        <span>对比：{prev.label}{yoy ? ` · ${yoy.label}` : ''}</span>
        <span>口径：{TRIGGER_LABELS[report.trigger]}，仅可比运行</span>
        <Link to='/duration-analysis' search={consoleSearchOf({ targetId: report.target.id, suiteId: report.suite?.id, period: report.period.kind, periodStart: report.period.start, trigger: report.trigger })} className='text-link'>
          在耗时分析中打开
        </Link>
      </div>

      <Section title='一句话结论'>
        <ul className='flex flex-col gap-1.5 text-body text-text-primary'>
          {report.conclusion.map((line) => (
            <li key={line} className='flex gap-2'>
              <span className='text-primary'>•</span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </Section>

      <div className='grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4'>
        <Stat label='可比运行' value={`${kpis.runs} 次`}>
          <span className='text-label text-muted-foreground'>成功 {kpis.succeeded} · 失败 {kpis.failed}</span>
        </Stat>
        <Stat label='执行耗时 P50' value={formatMs(kpis.activeP50.current)}>
          <CompareLine comparison={kpis.activeP50} label={prev.label} />
          {yoy ? <CompareLine comparison={kpis.activeP50Yoy} label={yoy.label} /> : null}
        </Stat>
        <Stat label='执行耗时 P95' value={formatMs(kpis.activeP95.current)}>
          <CompareLine comparison={kpis.activeP95} label={prev.label} />
        </Stat>
        <Stat label='等待占比' value={formatRatio(kpis.waitRatio.current)}>
          <CompareLine comparison={kpis.waitRatio} label={prev.label} ratio />
        </Stat>
        <Stat label='开跑前排队 P50' value={formatMs(kpis.queueP50.current)}>
          <CompareLine comparison={kpis.queueP50} label={prev.label} />
          <span className='text-label text-text-muted'>不含场景集成员</span>
        </Stat>
        <Stat label='变慢 / 变快场景' value={`${kpis.slower} / ${kpis.faster}`}>
          <span className='text-label text-muted-foreground'>执行耗时 P50 变化 ≥ 20%</span>
        </Stat>
        <Stat label='隐藏问题' value={`${kpis.insightCount} 项`}>
          <span className='text-label text-muted-foreground'>报表侧标注，不影响运行结论</span>
        </Stat>
        <Stat label='发起方构成' value={`${kpis.triggers.schedule + kpis.triggers.manual + kpis.triggers.service} 次`}>
          <span className='text-label text-muted-foreground'>
            调度 {kpis.triggers.schedule} · 手动 {kpis.triggers.manual} · 接口 {kpis.triggers.service}
          </span>
        </Stat>
      </div>

      <Section title='明显变慢的场景' aside={<span className='text-label text-muted-foreground'>共 {kpis.slower} 个，列出前 {report.slower.length} 个</span>}>
        <MoverTable movers={report.slower} baseLabel={prev.label} empty='没有明显变慢的场景。' />
      </Section>

      <Section title='明显变快的场景' aside={<span className='text-label text-muted-foreground'>共 {kpis.faster} 个</span>}>
        <MoverTable movers={report.faster} baseLabel={prev.label} empty='没有明显变快的场景。' />
      </Section>

      <Section title='明显变慢的步骤'>
        {report.slowerSteps.length === 0 ? (
          <p className='text-label text-muted-foreground'>没有明显变慢的步骤（P50 上升 ≥ 20% 且两期样本均 ≥ {DURATION_MIN_SAMPLES}）。</p>
        ) : (
          <div className='overflow-x-auto'>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>场景 · 步骤</TableHead>
                  <TableHead>{prev.label}</TableHead>
                  <TableHead>本期</TableHead>
                  <TableHead>涨跌</TableHead>
                  <TableHead>样本</TableHead>
                  <TableHead>线索</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.slowerSteps.map((step) => (
                  <TableRow key={`${step.scenarioId}:${step.nodeKey}`}>
                    <TableCell className='max-w-72'>
                      <span className='text-muted-foreground'>{step.scenarioName} · </span>
                      <span className='font-medium text-text-primary'>{step.name}</span>
                    </TableCell>
                    <TableCell className='font-mono tabular-nums'>{formatMs(step.base)}</TableCell>
                    <TableCell className='font-mono tabular-nums'>{formatMs(step.current)}</TableCell>
                    <TableCell>
                      <DeltaText pct={step.deltaPct} />
                    </TableCell>
                    <TableCell className='tabular-nums'>
                      {step.samples} / {step.baseSamples}
                    </TableCell>
                    <TableCell className='min-w-56 whitespace-normal text-label text-muted-foreground'>{step.causes.join('；') || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>

      <Section title={`隐藏问题（${report.insights.length} 项）`}>
        {report.insights.length === 0 ? (
          <p className='text-label text-muted-foreground'>本期没有命中隐藏问题规则。</p>
        ) : (
          <div className='flex flex-col gap-3'>
            {[...insightsByScenario.entries()].map(([name, list]) => (
              <div key={name} className='flex flex-col gap-1'>
                <h3 className='text-body font-medium text-text-primary'>{name}</h3>
                <ul className='flex flex-col gap-1'>
                  {list.map((insight, index) => (
                    <li key={`${insight.kind}-${insight.nodeKey ?? ''}-${index}`} className='flex flex-wrap items-center gap-2 text-label text-muted-foreground'>
                      <Badge variant='outline' className={insight.kind === 'faster' ? 'text-status-success' : 'text-status-warning'}>
                        {DURATION_INSIGHT_LABELS[insight.kind]}
                      </Badge>
                      <span>
                        {insight.nodeName ? `『${insight.nodeName}』` : ''}
                        {insight.message}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Section>

      {suite ? (
        <Section title={`场景集「${suite.name}」整组耗时`}>
          <div className='grid grid-cols-2 gap-3 md:grid-cols-4'>
            <Stat label='整组墙钟 P50' value={formatMs(suite.wallP50.current)}>
              <CompareLine comparison={suite.wallP50} label={prev.label} />
            </Stat>
            <Stat label='整组墙钟 P95' value={formatMs(suite.wallP95)}>
              <span className='text-label text-muted-foreground'>{suite.runs} 次场景集运行</span>
            </Stat>
            <Stat label='成员开跑前排队 P50' value={formatMs(suite.memberQueueP50)}>
              <span className='text-label text-muted-foreground'>从成员可开跑起算</span>
            </Stat>
            <Stat label='关键路径合计' value={formatMs(suite.criticalPathP50)}>
              <span className='text-label text-muted-foreground'>{suite.criticalPath.map((m) => m.name).join(' → ') || '—'}</span>
            </Stat>
          </div>
        </Section>
      ) : null}

      <Section title='场景明细' aside={<span className='text-label text-muted-foreground'>{withRuns.length} 个有运行{withoutRuns.length ? `，${withoutRuns.length} 个无运行` : ''}</span>}>
        <div className='overflow-x-auto'>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>场景</TableHead>
                <TableHead>运行</TableHead>
                <TableHead>成功率</TableHead>
                <TableHead>P50</TableHead>
                <TableHead>P95</TableHead>
                <TableHead>{prev.label}</TableHead>
                {monthly && yoy ? <TableHead>{yoy.label}</TableHead> : null}
                <TableHead>等待占比</TableHead>
                <TableHead>走势</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {withRuns.map((row) => (
                <TableRow key={row.scenarioId} className={cn(row.samples < DURATION_MIN_SAMPLES && 'text-text-muted')}>
                  <TableCell className='max-w-64'>
                    <span className='font-medium'>{row.name}</span>
                    {row.insightCount ? <Badge variant='outline' className='ml-2 text-status-warning'>{row.insightCount} 项问题</Badge> : null}
                  </TableCell>
                  <TableCell className='tabular-nums'>{row.runs}</TableCell>
                  <TableCell className='tabular-nums'>{row.runs ? `${Math.round((row.succeeded / row.runs) * 100)}%` : '—'}</TableCell>
                  <TableCell className='font-mono tabular-nums'>{formatMs(row.activeP50)}</TableCell>
                  <TableCell className='font-mono tabular-nums'>{formatMs(row.activeP95)}</TableCell>
                  <TableCell>
                    <DeltaText pct={row.deltaPct} />
                  </TableCell>
                  {monthly && yoy ? (
                    <TableCell>
                      <DeltaText pct={row.yoyDeltaPct} />
                    </TableCell>
                  ) : null}
                  <TableCell className='tabular-nums'>{formatRatio(row.waitRatio)}</TableCell>
                  <TableCell className='w-36'>
                    <Sparkline series={row.series} height={24} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {withoutRuns.length ? <p className='text-label text-muted-foreground'>本期无可比运行：{withoutRuns.map((row) => row.name).join('、')}</p> : null}
      </Section>

      <Section title='附录'>
        <div className='flex flex-col gap-1.5 text-label text-muted-foreground'>
          <p>
            口径：以执行耗时为主（不含认证等待、重新排队、待核查）；仅统计可比运行，已排除试跑与地图采集；分位取成功运行；样本少于 {DURATION_MIN_SAMPLES} 次不给涨跌，也不进前列榜单。周期按 {report.period.timeZone} 的本地日历切分，以运行完成时刻归属。
          </p>
          <p>
            对比周期：{prev.label} {prev.start} 至 {prev.end}（不含）{yoy ? `；${yoy.label} ${yoy.start} 至 ${yoy.end}（不含）` : ''}。
          </p>
          {report.gaps.length ? <p className='text-status-warning'>数据缺口：{report.gaps.join('；')}。</p> : null}
          <p>本报告为生成时封存的快照，之后补算或删除运行不会改变报告内容；需要最新数字时生成新修订。</p>
        </div>
      </Section>
    </div>
  )
}
