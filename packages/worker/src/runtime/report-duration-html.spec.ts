import { describe, expect, it } from 'vitest'
import type { DurationPeriodReportBlock, ReportDocument } from '@cairn/shared'
import { renderReportHtml } from './report-html'

const comparison = (current: number | null, base: number | null, deltaPct: number | null, samples = 12) => ({ current, base, deltaPct, currentSamples: samples, baseSamples: samples })

function block(overrides: Partial<DurationPeriodReportBlock> = {}): DurationPeriodReportBlock {
  return {
    type: 'duration_period_report',
    version: 1,
    target: { id: '11111111-1111-4111-8111-111111111111', name: '商城' },
    suite: null,
    period: { kind: 'month', start: '2026-09-01', end: '2026-10-01', label: '2026 年 9 月', timeZone: 'Asia/Shanghai' },
    trigger: 'schedule',
    comparisons: [
      { mode: 'prev_period', label: '上月', start: '2026-08-01', end: '2026-09-01' },
      { mode: 'last_year', label: '去年同月', start: '2025-09-01', end: '2025-10-01' },
    ],
    kpis: {
      runs: 30,
      succeeded: 29,
      failed: 1,
      activeP50: comparison(13_000, 10_000, 30),
      activeP50Yoy: comparison(13_000, null, null, 12),
      activeP95: comparison(20_000, 15_000, 33.3),
      waitRatio: comparison(0.1, 0.05, 5),
      queueP50: comparison(1_000, 1_000, 0),
      slower: 1,
      faster: 0,
      insightCount: 1,
      triggers: { schedule: 30, manual: 4, service: 0 },
    },
    conclusion: ['本月整体执行耗时 P50 为 13s，比上月慢 30%。'],
    slower: [
      {
        scenarioId: '33333333-3333-4333-8333-333333333333',
        name: '订单<script>alert(1)</script>巡检',
        current: 13_000,
        base: 10_000,
        deltaPct: 30,
        samples: 12,
        baseSamples: 12,
        summary: '本月比上月慢 3.0s：执行 +3.0s，其中『查询订单』+3.0s（重试 0→1 次）',
        causes: ['『查询订单』+3.0s（重试 0→1 次）'],
      },
    ],
    faster: [],
    slowerSteps: [],
    insights: [
      { kind: 'slower', scenarioId: '33333333-3333-4333-8333-333333333333', scenarioName: '订单巡检', nodeKey: null, nodeName: null, message: '执行耗时 P50 10s → 13s（+30%）' },
    ],
    buckets: ['2026-09-29', '2026-09-30'],
    scenarios: [
      { scenarioId: '33333333-3333-4333-8333-333333333333', name: '订单巡检', runs: 15, succeeded: 15, samples: 12, activeP50: 13_000, activeP95: 20_000, deltaPct: 30, yoyDeltaPct: null, waitRatio: 0.1, series: [12_000, 14_000], insightCount: 1 },
      { scenarioId: '44444444-4444-4444-8444-444444444444', name: '首页巡检', runs: 3, succeeded: 2, samples: 2, activeP50: 5_000, activeP95: 6_000, deltaPct: null, yoyDeltaPct: null, waitRatio: 0, series: [5_000, null], insightCount: 0 },
      { scenarioId: '55555555-5555-4555-8555-555555555555', name: '空闲巡检', runs: 0, succeeded: 0, samples: 0, activeP50: null, activeP95: null, deltaPct: null, yoyDeltaPct: null, waitRatio: null, series: [null, null], insightCount: 0 },
    ],
    suiteSummary: null,
    gaps: ['有 1 次运行的耗时尚未计算，未计入本报告'],
    consolePath: '/duration-analysis?targetId=11111111-1111-4111-8111-111111111111&period=month&periodStart=2026-09-01&trigger=schedule',
    ...overrides,
  }
}

function documentOf(report: unknown): ReportDocument {
  return {
    stage: 'final',
    title: '商城 耗时月报 · 2026 年 9 月',
    timeZone: 'Asia/Shanghai',
    generatedAt: '2026-10-01T02:00:00.000Z',
    asOf: '2026-10-01T02:00:00.000Z',
    source: { kind: 'DURATION_PERIOD' },
    summary: {},
    sections: [{ id: 'duration', title: '耗时报告', required: true, blocks: [report as Record<string, never>] }],
    gaps: [],
    identity: { reportId: '66666666-6666-4666-8666-666666666666', revisionId: '77777777-7777-4777-8777-777777777777', revisionNo: 2, parentRevisionId: null },
  }
}

describe('周期耗时报告 HTML', () => {
  it('周期报告走专用模板：结论、概况、变慢场景与原因、明细、附录齐全，离线自包含', () => {
    const html = renderReportHtml(documentOf(block()))
    expect(html).toContain('耗时月报')
    expect(html).toContain('<title>商城 耗时月报 · 2026 年 9 月</title>')
    expect(html).toContain('本月整体执行耗时 P50 为 13s，比上月慢 30%。')
    expect(html).toContain('修订 2')
    expect(html).toContain('只看调度运行')
    expect(html).toContain('调度 30 · 手动 4 · 接口 0')
    expect(html).toContain('去年同月：无同期数据')
    expect(html).toContain('本月比上月慢 3.0s')
    // 月报明细带同比列；样本不足的行淡化；无运行的场景折叠到表尾
    expect(html).toContain('<th style="width:80px;">去年同月</th>')
    expect(html).toContain('class="low-sample"')
    expect(html).toContain('本期无可比运行：空闲巡检')
    expect(html).toContain('数据缺口：有 1 次运行的耗时尚未计算，未计入本报告')
    expect(html).toContain('<polyline')
    expect(html).not.toMatch(/(?:src|href)="https?:/)
  })

  it('转义名称，不注入脚本', () => {
    const html = renderReportHtml(documentOf(block()))
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('订单&lt;script&gt;alert(1)&lt;/script&gt;巡检')
  })

  it('周报不出同比列；空榜单给说明；场景集段按需出现', () => {
    const weekly = block({
      period: { kind: 'week', start: '2026-09-28', end: '2026-10-05', label: '2026 年第 40 周（9/28–10/4）', timeZone: 'Asia/Shanghai' },
      comparisons: [{ mode: 'prev_period', label: '上周', start: '2026-09-21', end: '2026-09-28' }],
      slower: [],
      suiteSummary: {
        suiteId: '88888888-8888-4888-8888-888888888888',
        name: '订单集',
        executionMode: 'sequential',
        staged: false,
        runs: 4,
        wallP50: comparison(90_000, 80_000, 12.5, 4),
        wallP95: 120_000,
        memberQueueP50: 3_000,
        buckets: [],
        criticalPath: [{ memberId: 'm1', scenarioId: '33333333-3333-4333-8333-333333333333', name: '订单巡检', stage: '默认阶段', p50: 13_000 }],
        criticalPathP50: 13_000,
      },
    })
    const html = renderReportHtml(documentOf(weekly))
    expect(html).not.toContain('<th style="width:80px;">去年同月</th>')
    expect(html).toContain('没有明显变慢的场景。')
    expect(html).toContain('场景集「订单集」整组耗时')
    expect(html).toContain('上周：样本不足，不比较')
  })

  it('块无法解析时给出说明而不是抛错', () => {
    expect(renderReportHtml(documentOf({ type: 'duration_period_report', version: 1 }))).toContain('报告内容无法解析')
  })
})
