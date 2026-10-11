/**
 * 状态信号 × 靶场：映射表逐条核对、真实 antd / Bootstrap 页面（/grids/status）与 Element / layui 静态夹具。
 * 语义只按官方类名认；预设颜色、自定义颜色、非标准类名答案是“未识别”，拿它作条件判“无法确认”。
 * 无浏览器时 skip，跳过不等于通过。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from 'playwright'
import { evaluateTableExpectation, tableExpectRuleSchema, type TableReadPlanV2, type TableSample } from '@cairn/shared'
import { isChromiumAvailableCached } from '../testing/chromium-probe.js'
import { centerOf, deps, run, startHarness, startPortalHarness, type FixtureHarness, type PortalHarness } from '../testing/table-read-test-kit.js'
import { makeHelpers } from './table-adapters/helpers.js'
import { makeStatusReader } from './table-adapters/status.js'
import type { AdapterHelpers } from './table-adapters/types.js'
import { detectTable } from './table-read-v2.js'

type Truth = {
  steps: Array<{ text: string; tone: string }>
  tags: Array<{ text: string; tone: string }>
  alerts: Array<{ text: string; tone: string }>
  rows: Array<{ id: number; status: string; tone: string; progress: number }>
}

/** 映射表的每条规则一个最小样例：html 与答案。 */
function ruleCases(): Array<{ html: string; tone: string }> {
  const out: Array<{ html: string; tone: string }> = []
  const add = (html: string, tone: string) => out.push({ html, tone })
  for (const t of ['success', 'processing', 'error', 'warning', 'default']) {
    add(`<span class="ant-tag ant-tag-${t}">x</span>`, t)
    add(`<span class="ant-badge ant-badge-status"><span class="ant-badge-status-dot ant-badge-status-${t}"></span></span>`, t)
  }
  add('<span class="ant-tag">x</span>', 'default')
  add('<span class="ant-tag ant-tag-green">x</span>', 'unknown')
  add('<span class="ant-tag ant-tag-has-color">x</span>', 'unknown')
  for (const [c, t] of [['success', 'success'], ['exception', 'error'], ['active', 'processing'], ['normal', 'default']]) add(`<div class="ant-progress ant-progress-status-${c}"></div>`, t!)
  for (const [c, t] of [['finish', 'success'], ['process', 'processing'], ['error', 'error'], ['wait', 'default']]) add(`<div class="ant-steps-item ant-steps-item-${c}">x</div>`, t!)
  for (const t of ['success', 'info', 'warning', 'error']) {
    add(`<div class="ant-alert ant-alert-${t}">x</div>`, t)
    add(`<div class="el-alert el-alert--${t}">x</div>`, t)
  }
  for (const [c, t] of [['success', 'success'], ['warning', 'warning'], ['danger', 'error'], ['info', 'info']]) add(`<span class="el-tag el-tag--${c}">x</span>`, t!)
  add('<span class="el-tag el-tag--light">x</span>', 'default')
  for (const [c, t] of [['is-success', 'success'], ['is-exception', 'error'], ['is-warning', 'warning'], ['', 'default'], ['is-custom', 'unknown']]) add(`<div class="el-progress ${c}"></div>`, t!)
  for (const [c, t] of [['is-success', 'success'], ['is-finish', 'success'], ['is-process', 'processing'], ['is-error', 'error'], ['is-wait', 'default']]) add(`<div class="el-step"><div class="el-step__head ${c}"></div></div>`, t!)
  const ctx: Array<[string, string]> = [['success', 'success'], ['danger', 'error'], ['warning', 'warning'], ['info', 'info'], ['primary', 'default'], ['secondary', 'default'], ['light', 'default'], ['dark', 'default']]
  for (const [c, t] of ctx) {
    for (const prefix of ['bg-', 'text-bg-', 'badge-']) add(`<span class="badge ${prefix}${c}">x</span>`, t)
    add(`<div class="alert alert-${c}">x</div>`, t)
    add(`<div class="progress"><div class="progress-bar bg-${c}"></div></div>`, t)
  }
  add('<span class="badge bg-teal">x</span>', 'unknown')
  add('<div class="progress"><div class="progress-bar"></div></div>', 'default')
  const layui: Array<[string, string]> = [['green', 'success'], ['orange', 'warning'], ['red', 'error'], ['blue', 'info'], ['gray', 'default'], ['cyan', 'default'], ['black', 'default']]
  for (const [c, t] of layui) {
    add(`<span class="layui-badge layui-bg-${c}">x</span>`, t)
    add(`<div class="layui-progress"><div class="layui-progress-bar layui-bg-${c}"></div></div>`, t)
  }
  add('<span class="layui-badge">x</span>', 'unknown')
  add('<span class="layui-badge-dot layui-bg-green"></span>', 'success')
  add('<div class="layui-progress"><div class="layui-progress-bar"></div></div>', 'default')
  add('<div role="progressbar" aria-valuenow="30"></div>', 'default')
  return out
}

/** 在页面里用与读取时相同的读取器判语义 / 规则 / 百分比。 */
async function judge(page: Page, selector: string): Promise<Array<{ tone: string; rule: string | null; percent: number | null; expectTone?: string; expectPercent?: string }>> {
  return page.evaluate(
    `(() => {
      const h = (${makeHelpers.toString()})(document);
      const r = (${makeStatusReader.toString()})(h);
      return Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map((el) => ({
        tone: r.toneOf(el), rule: r.ruleOf(el), percent: r.percentOf(el),
        expectTone: el.dataset.expectTone, expectPercent: el.dataset.expectPercent,
      }))
    })()`,
  )
}

const toneOf = (s: TableSample, key: string) => s.rows.map((r) => (r[key]?.status === 'ok' ? r[key]?.value : r[key]?.status === 'error' ? 'unknown' : null))

describe('状态信号', { timeout: 180_000 }, () => {
  let available = false
  let portal: PortalHarness | undefined
  let fixtures: FixtureHarness | undefined
  let page: Page

  beforeAll(async () => {
    available = await isChromiumAvailableCached()
    if (!available) return
    portal = await startPortalHarness()
    fixtures = await startHarness()
    page = await portal.newPage()
  })
  afterAll(async () => {
    await portal?.close()
    await fixtures?.close()
  })

  const detectAt = async (p: Page, selector: string) => {
    const result = await detectTable(p, { kind: 'point', ...(await centerOf(p, selector)) }, deps)
    if (result.outcome !== 'FOUND') throw new Error(`${selector}：${result.reason.message}`)
    return result.detected
  }

  it('映射表逐条核对：每条规则都有样例且语义对上，预设 / 自定义 / 非标准类名是“未识别”', async (ctx) => {
    if (!available) return ctx.skip()
    const cases = ruleCases()
    await page.setContent(cases.map((c, i) => `<div data-case="${i}" data-expect-tone="${c.tone}">${c.html}</div>`).join(''))
    const judged = await judge(page, '[data-case] > *')
    judged.forEach((j, i) => expect(j.tone, cases[i]!.html).toBe(cases[i]!.tone))
    const all = makeStatusReader({} as AdapterHelpers).rules.map((r) => r.id)
    const hit = new Set(judged.map((j) => j.rule).filter(Boolean))
    expect(all.filter((id) => !hit.has(id)), '没有样例的规则').toEqual([])
  })

  it('进度百分比：aria-valuenow、lay-percent、进度文字、Bootstrap 宽度、“45%”文字', async (ctx) => {
    if (!available) return ctx.skip()
    await page.setContent(`
      <div class="x" role="progressbar" aria-valuenow="3" aria-valuemin="0" aria-valuemax="4"></div>
      <div class="x layui-progress"><div class="layui-progress-bar" lay-percent="62%"></div></div>
      <div class="x ant-progress ant-progress-status-normal"><span class="ant-progress-text">80%</span></div>
      <div class="x ant-progress ant-progress-status-success"><span class="ant-progress-text"><span class="anticon-check"></span></span></div>
      <div class="x progress"><div class="progress-bar" style="width: 37%"></div></div>
      <span class="x">完成 45%</span>`)
    expect((await judge(page, '.x')).map((j) => j.percent)).toEqual([75, 62, 80, 100, 37, 45])
  })

  it('antd：点步骤条 / 标签 / 告警认成一组状态，语义与真值一致；未识别的格判“无法确认”', async (ctx) => {
    if (!available) return ctx.skip()
    await page.goto(`${portal!.base}/grids/status?lib=antd`)
    await page.waitForSelector('#status-grid .ant-table-row')
    const truth = await portal!.truth<Truth>('status', 'lib=antd')
    const steps = await detectAt(page, '#steps .ant-steps-item:nth-child(3)')
    expect(steps.shape).toBe('status')
    expect(steps.plan.kind).toBe('status')
    expect(steps.plan.columns.map((c) => [c.key, c.read ?? 'text'])).toEqual([['text', 'text'], ['tone', 'tone'], ['order', 'order']])
    const s1 = await run(page, steps.plan)
    expect(s1.rows.map((r) => [r.text?.value, r.tone?.value, r.order?.value])).toEqual(truth.steps.map((x, i) => [x.text, x.tone, i + 1]))

    const tags = await run(page, (await detectAt(page, '#tags .ant-tag:first-child')).plan)
    expect(tags.rows.map((r) => r.text?.value)).toEqual(truth.tags.map((t) => t.text))
    expect(toneOf(tags, 'tone')).toEqual(truth.tags.map((t) => t.tone))
    // 认得的项都不是“信息”，答案取决于未识别的项 → 无法确认（不当作不通过）；已有确定反例的条件照常判不通过
    const anyInfo = tableExpectRuleSchema.parse({ rule: 'any_row', column: 'tone', predicate: { op: 'eq', value: 'info' } })
    expect(evaluateTableExpectation(tags, anyInfo).factsUnavailable).toBe(true)
    const allOk = tableExpectRuleSchema.parse({ rule: 'all_rows', column: 'tone', predicate: { op: 'eq', value: 'success' } })
    expect(evaluateTableExpectation(tags, allOk)).toMatchObject({ passed: false })
    expect(evaluateTableExpectation(tags, allOk).factsUnavailable).toBeFalsy()

    const alerts = await run(page, (await detectAt(page, '#alerts .ant-alert:nth-child(2)')).plan)
    expect(toneOf(alerts, 'tone')).toEqual(truth.alerts.map((a) => a.tone))
  })

  it('antd 表格：状态列与进度列给出派生的“语义 / 百分比”列（默认不勾），勾上后与真值一致', async (ctx) => {
    if (!available) return ctx.skip()
    await page.goto(`${portal!.base}/grids/status?lib=antd`)
    await page.waitForSelector('#status-grid .ant-table-row')
    const truth = await portal!.truth<Truth>('status', 'lib=antd')
    const detected = await detectAt(page, '#status-grid .ant-table-row:first-child td:nth-child(2)')
    expect(detected.shape).toBe('antd')
    const derived = detected.columns.filter((c) => c.excludedReason === 'derived')
    expect(derived.map((c) => [c.label, c.read])).toEqual([['「状态」的语义', 'tone'], ['「进度」的语义', 'tone'], ['「进度」的百分比', 'percent']])
    expect(detected.plan.columns.some((c) => c.read)).toBe(false)
    const plan: TableReadPlanV2 = {
      ...detected.plan,
      columns: [
        { key: 'id', name: '编号', valueType: 'number', numericKind: 'integer' },
        { key: 'tone', name: '状态', label: '「状态」的语义', valueType: 'text', read: 'tone' },
        { key: 'pct', name: '进度', label: '「进度」的百分比', valueType: 'number', numericKind: 'decimal', read: 'percent' },
      ],
    }
    const sample = await run(page, plan)
    expect(sample.rows.map((r) => [r.id?.value, r.tone?.value, r.pct?.value])).toEqual(truth.rows.map((r) => [r.id, r.tone, r.progress]))
    const lookup = tableExpectRuleSchema.parse({
      rule: 'row_lookup',
      where: [{ column: 'id', predicate: { op: 'eq', value: truth.rows[2]!.id } }],
      expect: [{ column: 'tone', predicate: { op: 'eq', value: truth.rows[2]!.tone } }],
    })
    expect(evaluateTableExpectation(sample, lookup).passed).toBe(true)
  })

  it('Bootstrap（真实 CSS）：标签区域与表格的语义 / 进度与真值一致；没有的上下文色是“未识别”', async (ctx) => {
    if (!available) return ctx.skip()
    await page.goto(`${portal!.base}/grids/status?lib=bootstrap`)
    const truth = await portal!.truth<Truth>('status', 'lib=bootstrap')
    const tags = await run(page, (await detectAt(page, '#tags .badge:first-child')).plan)
    expect(toneOf(tags, 'tone')).toEqual(truth.tags.map((t) => t.tone))
    const detected = await detectAt(page, '#grid tbody tr:first-child td:nth-child(2)')
    const plan: TableReadPlanV2 = {
      ...detected.plan,
      columns: [
        { key: 'tone', name: '状态', valueType: 'text', read: 'tone' },
        { key: 'pct', name: '进度', valueType: 'number', numericKind: 'decimal', read: 'percent' },
      ],
    }
    const sample = await run(page, plan)
    expect(sample.rows.map((r) => [r.tone?.value, r.pct?.value])).toEqual(truth.rows.map((r) => [r.tone, r.progress]))
  })

  for (const [file, cell] of [['status-element.html', '#status-grid .el-table__row:first-child td:nth-child(2)'], ['status-layui.html', '#status-grid tbody tr:first-child td:nth-child(2)']] as const) {
    it(`${file}：每个状态元素的语义 / 进度与页面上标注的答案一致；表格派生列读出同样的答案`, async (ctx) => {
      if (!available) return ctx.skip()
      const p = await fixtures!.browser.newPage()
      await p.goto(`${fixtures!.base}/${file}`)
      for (const j of await judge(p, '[data-expect-tone]')) expect(j.tone).toBe(j.expectTone)
      for (const j of await judge(p, '[data-expect-percent]')) expect(String(j.percent)).toBe(j.expectPercent)
      // 区域：标签一组
      const tags = await run(p, (await detectAt(p, '#tags > :first-child')).plan)
      const want = await p.$$eval('#tags [data-expect-tone]', (els) => els.map((e) => e.getAttribute('data-expect-tone')))
      expect(toneOf(tags, 'tone')).toEqual(want)
      // 表格：派生的语义 / 百分比列
      const detected = await detectAt(p, cell)
      expect(detected.columns.filter((c) => c.excludedReason === 'derived').map((c) => c.read)).toEqual(expect.arrayContaining(['tone', 'percent']))
      const sample = await run(p, {
        ...detected.plan,
        columns: [
          { key: 'tone', name: '状态', valueType: 'text', read: 'tone' },
          { key: 'pct', name: '进度', valueType: 'number', numericKind: 'decimal', read: 'percent' },
        ],
      })
      const rowWant = await p.$$eval('#status-grid tbody tr', (trs) =>
        trs.map((tr) => [tr.querySelector('[data-expect-tone]')?.getAttribute('data-expect-tone'), Number(tr.querySelector('[data-expect-percent]')?.getAttribute('data-expect-percent'))]),
      )
      expect(sample.rows.map((r) => [r.tone?.value, r.pct?.value])).toEqual(rowWant)
      await p.close()
    })
  }
})
