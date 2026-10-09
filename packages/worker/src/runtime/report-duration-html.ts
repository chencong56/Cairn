import {
  DURATION_INSIGHT_LABELS,
  DURATION_MIN_SAMPLES,
  durationPeriodReportOf,
  formatDurationShort,
  type DurationComparison,
  type DurationPeriodReportBlock,
  type DurationReportScenarioMover,
  type ReportDocument,
} from '@cairn/shared'
import { SHARED_STYLES, escapeHtml } from './report-html-base.js'

type ReportImage = { kind: 'logo' | 'screenshot'; body: Buffer }

const TRIGGER_LABELS: Record<DurationPeriodReportBlock['trigger'], string> = {
  all: '全部发起方',
  schedule: '只看调度运行',
  manual: '只看手动运行',
  service: '只看接口调用',
}

const EXTRA_STYLES = `
  .conclusion { list-style: none; display: grid; gap: 6px; font-size: 14px; color: var(--text-primary); }
  .conclusion li::before { content: '•'; color: var(--color-brand); margin-right: 8px; }
  .delta-up { color: #be123c; font-variant-numeric: tabular-nums; }
  .delta-down { color: #047857; font-variant-numeric: tabular-nums; }
  .delta-flat { color: var(--text-secondary); font-variant-numeric: tabular-nums; }
  .muted { color: var(--text-muted); }
  .num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .cause-list { list-style: none; display: grid; gap: 2px; margin-top: 4px; font-size: 12px; color: var(--text-secondary); }
  .summary-line { font-size: 13px; color: var(--text-primary); }
  .low-sample td { color: var(--text-muted); }
  .insight-group { margin-bottom: 12px; }
  .insight-group h4 { font-size: 13px; margin-bottom: 4px; }
  .note { font-size: 12px; color: var(--text-secondary); line-height: 1.7; }
`

function ms(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : formatDurationShort(value)
}

function ratio(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`
}

function delta(pct: number | null | undefined, unit = '%'): string {
  if (pct === null || pct === undefined) return '<span class="muted">—</span>'
  const cls = unit === '%' ? (pct >= 20 ? 'delta-up' : pct <= -20 ? 'delta-down' : 'delta-flat') : pct >= 10 ? 'delta-up' : 'delta-flat'
  return `<span class="${cls}">${pct > 0 ? '+' : ''}${pct}${unit === '%' ? '%' : ` ${unit}`}</span>`
}

function comparisonText(c: DurationComparison | null, label: string, kind: 'ms' | 'ratio' = 'ms'): string {
  if (!c) return ''
  if (c.baseSamples === 0 || c.base === null) return `${escapeHtml(label)}：无同期数据`
  if (c.currentSamples < DURATION_MIN_SAMPLES || c.baseSamples < DURATION_MIN_SAMPLES) return `${escapeHtml(label)}：样本不足，不比较`
  return `${escapeHtml(label)} ${kind === 'ratio' ? ratio(c.base) : ms(c.base)} · ${delta(c.deltaPct, kind === 'ratio' ? '个百分点' : '%')}`
}

/** 迷你趋势：内联 SVG，空桶跳过，离线可看。 */
function sparkline(series: readonly (number | null)[]): string {
  const width = 120
  const height = 28
  const values = series.filter((v): v is number => v !== null)
  if (values.length === 0) return '<span class="muted">—</span>'
  const max = Math.max(...values)
  const min = Math.min(0, ...values)
  const span = max - min || 1
  const step = series.length > 1 ? width / (series.length - 1) : 0
  const points = series.flatMap((value, index) =>
    value === null ? [] : [`${(series.length > 1 ? index * step : width / 2).toFixed(1)},${(height - 3 - ((value - min) / span) * (height - 6)).toFixed(1)}`],
  )
  const dots = points.length <= 12 ? points.map((p) => `<circle cx="${p.split(',')[0]}" cy="${p.split(',')[1]}" r="1.8" fill="#0284c7"/>`).join('') : ''
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">${points.length > 1 ? `<polyline points="${points.join(' ')}" fill="none" stroke="#0284c7" stroke-width="1.5"/>` : ''}${dots}</svg>`
}

function sectionTitle(text: string): string {
  return `<div class="section-header"><div class="section-title">${escapeHtml(text)}</div></div>`
}

function moverTable(movers: DurationReportScenarioMover[], baseLabel: string, empty: string): string {
  if (movers.length === 0) return `<p class="note">${escapeHtml(empty)}</p>`
  return `<div class="table-card"><div class="table-responsive"><table>
    <thead><tr><th>场景</th><th style="width:90px;">${escapeHtml(baseLabel)}</th><th style="width:90px;">本期</th><th style="width:80px;">涨跌</th><th style="width:70px;">样本</th><th>原因（按两期成功运行中位数归因）</th></tr></thead>
    <tbody>${movers
      .map(
        (m) => `<tr>
        <td>${escapeHtml(m.name)}</td>
        <td class="num">${ms(m.base)}</td>
        <td class="num">${ms(m.current)}</td>
        <td>${delta(m.deltaPct)}</td>
        <td class="num">${m.samples} / ${m.baseSamples}</td>
        <td><div class="summary-line">${escapeHtml(m.summary)}</div>${m.causes.length ? `<ul class="cause-list">${m.causes.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>` : ''}</td>
      </tr>`,
      )
      .join('')}</tbody></table></div></div>`
}

export function renderDurationPeriodHtml(document: ReportDocument, images: ReportImage[] = []): string {
  const report = durationPeriodReportOf(document)
  const timeZone = document.timeZone || 'Asia/Shanghai'
  const generated = new Intl.DateTimeFormat('zh-CN', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(document.generatedAt))
  const logo = images.find((img) => img.kind === 'logo')
  const logoDataUri = logo ? `data:image/jpeg;base64,${logo.body.toString('base64')}` : null
  const head = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${escapeHtml(document.title)}</title>
  <style>${SHARED_STYLES}${EXTRA_STYLES}</style>
</head>`
  if (!report) {
    return `${head}<body><div class="container"><div class="header-card"><h1 class="header-title">${escapeHtml(document.title)}</h1><p class="note">报告内容无法解析。</p></div></div></body></html>`
  }
  const { kpis } = report
  const kindLabel = report.period.kind === 'week' ? '耗时周报' : '耗时月报'
  const prev = report.comparisons[0]!
  const yoy = report.comparisons[1] ?? null
  const totalTriggers = kpis.triggers.schedule + kpis.triggers.manual + kpis.triggers.service
  const insightsByScenario = new Map<string, typeof report.insights>()
  for (const insight of report.insights) {
    const list = insightsByScenario.get(insight.scenarioName) ?? []
    list.push(insight)
    insightsByScenario.set(insight.scenarioName, list)
  }
  const withRuns = report.scenarios.filter((row) => row.runs > 0)
  const withoutRuns = report.scenarios.filter((row) => row.runs === 0)
  const suite = report.suiteSummary

  return `${head}
<body>
  <div class="container">
    <div class="top-bar">
      <div class="brand-logo-wrap">
        ${logoDataUri ? `<img class="brand-logo" src="${logoDataUri}" alt="Logo"/>` : ''}
        <div class="platform-tag">识途可观测场景执行平台 · ${kindLabel}</div>
      </div>
      <div class="actions-group no-print">
        <button class="btn btn-primary" onclick="window.print()">打印 / 另存为 PDF</button>
      </div>
    </div>

    <div class="header-card">
      <h1 class="header-title">${escapeHtml(document.title)}</h1>
      ${document.subtitle ? `<div style="font-size:14px;color:var(--text-secondary);margin-bottom:12px;">${escapeHtml(document.subtitle)}</div>` : ''}
      <div class="header-meta">
        <div class="meta-item"><strong>目标系统：</strong>${escapeHtml(report.target.name)}</div>
        ${report.suite ? `<div class="meta-item"><strong>场景集：</strong>${escapeHtml(report.suite.name)}</div>` : ''}
        <div class="meta-item"><strong>周期：</strong>${escapeHtml(report.period.label)}</div>
        <div class="meta-item"><strong>对比：</strong>${escapeHtml(prev.label)}${yoy ? ` · ${escapeHtml(yoy.label)}` : ''}</div>
        <div class="meta-item"><strong>口径：</strong>${escapeHtml(TRIGGER_LABELS[report.trigger])}，仅可比运行</div>
        <div class="meta-item"><strong>生成时间：</strong>${escapeHtml(generated)}</div>
        ${document.identity ? `<div class="meta-item"><strong>修订号：</strong>修订 ${escapeHtml(document.identity.revisionNo)}</div>` : ''}
      </div>
    </div>

    <div class="section">
      ${sectionTitle('一句话结论')}
      <div class="header-card"><ul class="conclusion">${report.conclusion.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul></div>
    </div>

    <div class="section">
      ${sectionTitle('概况')}
      <div class="grid-cards">
        <div class="stat-card"><div class="stat-label">可比运行</div><div class="stat-value">${kpis.runs} 次</div><div class="stat-subtext">成功 ${kpis.succeeded} · 失败 ${kpis.failed}</div></div>
        <div class="stat-card"><div class="stat-label">执行耗时 P50</div><div class="stat-value">${ms(kpis.activeP50.current)}</div><div class="stat-subtext">${comparisonText(kpis.activeP50, prev.label)}${kpis.activeP50Yoy && yoy ? `<br/>${comparisonText(kpis.activeP50Yoy, yoy.label)}` : ''}</div></div>
        <div class="stat-card"><div class="stat-label">执行耗时 P95</div><div class="stat-value">${ms(kpis.activeP95.current)}</div><div class="stat-subtext">${comparisonText(kpis.activeP95, prev.label)}</div></div>
        <div class="stat-card"><div class="stat-label">等待占比</div><div class="stat-value">${ratio(kpis.waitRatio.current)}</div><div class="stat-subtext">${comparisonText(kpis.waitRatio, prev.label, 'ratio')}</div></div>
        <div class="stat-card"><div class="stat-label">开跑前排队 P50</div><div class="stat-value">${ms(kpis.queueP50.current)}</div><div class="stat-subtext">${comparisonText(kpis.queueP50, prev.label)}<br/>不含场景集成员</div></div>
        <div class="stat-card"><div class="stat-label">变慢 / 变快场景</div><div class="stat-value">${kpis.slower} / ${kpis.faster}</div><div class="stat-subtext">执行耗时 P50 变化 ≥ 20%</div></div>
        <div class="stat-card"><div class="stat-label">隐藏问题</div><div class="stat-value">${kpis.insightCount} 项</div><div class="stat-subtext">报表侧标注，不影响运行结论</div></div>
        <div class="stat-card"><div class="stat-label">发起方构成</div><div class="stat-value" style="font-size:16px;">调度 ${kpis.triggers.schedule} · 手动 ${kpis.triggers.manual} · 接口 ${kpis.triggers.service}</div><div class="stat-subtext">全部可比运行 ${totalTriggers} 次</div></div>
      </div>
    </div>

    <div class="section">
      ${sectionTitle(`明显变慢的场景（前 ${report.slower.length || 0} 个，共 ${kpis.slower} 个）`)}
      ${moverTable(report.slower, prev.label, '没有明显变慢的场景。')}
    </div>

    <div class="section">
      ${sectionTitle(`明显变快的场景（共 ${kpis.faster} 个）`)}
      ${moverTable(report.faster, prev.label, '没有明显变快的场景。')}
    </div>

    <div class="section">
      ${sectionTitle('明显变慢的步骤')}
      ${
        report.slowerSteps.length === 0
          ? '<p class="note">没有明显变慢的步骤（P50 上升 ≥ 20% 且两期样本均 ≥ 10）。</p>'
          : `<div class="table-card"><div class="table-responsive"><table>
        <thead><tr><th>场景 · 步骤</th><th style="width:90px;">${escapeHtml(prev.label)}</th><th style="width:90px;">本期</th><th style="width:80px;">涨跌</th><th style="width:70px;">样本</th><th>线索</th></tr></thead>
        <tbody>${report.slowerSteps
          .map(
            (step) => `<tr>
            <td>${escapeHtml(step.scenarioName)} · <strong>${escapeHtml(step.name)}</strong></td>
            <td class="num">${ms(step.base)}</td>
            <td class="num">${ms(step.current)}</td>
            <td>${delta(step.deltaPct)}</td>
            <td class="num">${step.samples} / ${step.baseSamples}</td>
            <td class="note">${step.causes.length ? step.causes.map(escapeHtml).join('；') : '—'}</td>
          </tr>`,
          )
          .join('')}</tbody></table></div></div>`
      }
    </div>

    <div class="section">
      ${sectionTitle(`隐藏问题（${report.insights.length} 项）`)}
      ${
        report.insights.length === 0
          ? '<p class="note">本期没有命中隐藏问题规则。</p>'
          : `<div class="header-card">${[...insightsByScenario.entries()]
              .map(
                ([name, list]) => `<div class="insight-group"><h4>${escapeHtml(name)}</h4><ul class="cause-list">${list
                  .map((i) => `<li><span class="badge ${i.kind === 'faster' ? 'badge-success' : 'badge-warning'}">${escapeHtml(DURATION_INSIGHT_LABELS[i.kind])}</span> ${i.nodeName ? `『${escapeHtml(i.nodeName)}』` : ''}${escapeHtml(i.message)}</li>`)
                  .join('')}</ul></div>`,
              )
              .join('')}</div>`
      }
    </div>

    ${
      suite
        ? `<div class="section">
      ${sectionTitle(`场景集「${suite.name}」整组耗时`)}
      <div class="grid-cards">
        <div class="stat-card"><div class="stat-label">整组墙钟 P50</div><div class="stat-value">${ms(suite.wallP50.current)}</div><div class="stat-subtext">${comparisonText(suite.wallP50, prev.label)}</div></div>
        <div class="stat-card"><div class="stat-label">整组墙钟 P95</div><div class="stat-value">${ms(suite.wallP95)}</div><div class="stat-subtext">${suite.runs} 次场景集运行</div></div>
        <div class="stat-card"><div class="stat-label">成员开跑前排队 P50</div><div class="stat-value">${ms(suite.memberQueueP50)}</div><div class="stat-subtext">从成员可开跑起算</div></div>
        <div class="stat-card"><div class="stat-label">关键路径合计</div><div class="stat-value">${ms(suite.criticalPathP50)}</div><div class="stat-subtext">${suite.criticalPath.map((m) => escapeHtml(m.name)).join(' → ') || '—'}</div></div>
      </div>
    </div>`
        : ''
    }

    <div class="section">
      ${sectionTitle(`场景明细（${withRuns.length} 个有运行${withoutRuns.length ? `，${withoutRuns.length} 个无运行` : ''}）`)}
      <div class="table-card"><div class="table-responsive"><table>
        <thead><tr><th>场景</th><th style="width:80px;">运行</th><th style="width:80px;">成功率</th><th style="width:90px;">P50</th><th style="width:90px;">P95</th><th style="width:80px;">${escapeHtml(prev.label)}</th>${report.period.kind === 'month' && yoy ? `<th style="width:80px;">${escapeHtml(yoy.label)}</th>` : ''}<th style="width:80px;">等待占比</th><th style="width:130px;">走势</th></tr></thead>
        <tbody>${withRuns
          .map(
            (row) => `<tr class="${row.samples < DURATION_MIN_SAMPLES ? 'low-sample' : ''}">
            <td>${escapeHtml(row.name)}${row.insightCount ? ` <span class="badge badge-warning">${row.insightCount} 项问题</span>` : ''}</td>
            <td class="num">${row.runs}</td>
            <td class="num">${row.runs ? `${Math.round((row.succeeded / row.runs) * 100)}%` : '—'}</td>
            <td class="num">${ms(row.activeP50)}</td>
            <td class="num">${ms(row.activeP95)}</td>
            <td>${delta(row.deltaPct)}</td>
            ${report.period.kind === 'month' && yoy ? `<td>${delta(row.yoyDeltaPct)}</td>` : ''}
            <td class="num">${ratio(row.waitRatio)}</td>
            <td>${sparkline(row.series)}</td>
          </tr>`,
          )
          .join('')}</tbody></table></div></div>
      ${withoutRuns.length ? `<p class="note" style="margin-top:8px;">本期无可比运行：${withoutRuns.map((row) => escapeHtml(row.name)).join('、')}</p>` : ''}
    </div>

    <div class="section">
      ${sectionTitle('附录')}
      <div class="header-card note">
        <p>口径：以执行耗时为主（不含认证等待、重新排队、待核查）；仅统计可比运行（已发布版本、业务场景），已排除试跑与地图采集；分位取成功运行；样本少于 ${DURATION_MIN_SAMPLES} 次不给涨跌，也不进前列榜单。周期按 ${escapeHtml(report.period.timeZone)} 的本地日历切分，以运行完成时刻归属。</p>
        <p>对比周期：${escapeHtml(prev.label)} ${escapeHtml(prev.start)} 至 ${escapeHtml(prev.end)}（不含）${yoy ? `；${escapeHtml(yoy.label)} ${escapeHtml(yoy.start)} 至 ${escapeHtml(yoy.end)}（不含）` : ''}。</p>
        ${report.gaps.length ? `<p>数据缺口：${report.gaps.map(escapeHtml).join('；')}。</p>` : ''}
        <p>本报告为生成时封存的快照，之后补算或删除运行不会改变报告内容。在控制台复现同一组数字：耗时分析页 <span class="num">${escapeHtml(report.consolePath)}</span></p>
      </div>
    </div>
  </div>
</body>
</html>`
}
