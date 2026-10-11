/**
 * 树形读取（layout.mode = tree）× 靶场：真实 antd 树形表格（/grids/tree）与通用 ARIA treegrid 静态页。
 * 层级、读取范围、折叠判部分、父行等于子行之和、按层级路径找行，都与 /grids/truth?view=tree 的标准答案比。
 * 无浏览器时 skip，跳过不等于通过。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from 'playwright'
import { evaluateTableExpectation, tableExpectRuleSchema, tablePlanCheckColumns, validateTableExpectRuleAgainstPlan, type TableReadPlanV2 } from '@cairn/shared'
import { isChromiumAvailableCached } from '../testing/chromium-probe.js'
import { deps, plan, run, startHarness, startPortalHarness, type FixtureHarness, type PortalHarness, type TreeTruthRow } from '../testing/table-read-test-kit.js'
import { detectTable } from './table-read-v2.js'

const COLUMNS = [
  { key: 'name', name: '名称' },
  { key: 'qty', name: '数量', valueType: 'number' as const, numericKind: 'integer' as const },
  { key: 'amount', name: '金额（元）', valueType: 'number' as const, numericKind: 'decimal' as const },
]
const treePlan = (scope: 'all' | 'top' | 'leaf' = 'all', selector = '#grid'): TableReadPlanV2 => plan(selector, COLUMNS, { layout: { mode: 'tree', scope } })
const rollup = tableExpectRuleSchema.parse({ rule: 'tree_rollup_match', column: 'qty' })

describe('树形读取', { timeout: 180_000 }, () => {
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

  const openTree = async (query = '') => {
    await page.goto(`${portal!.base}/grids/tree?lib=antd${query ? `&${query}` : ''}`)
    await page.getByText('华东').first().waitFor()
  }
  const truth = async (query = '') => (await portal!.truth<{ rows: TreeTruthRow[] }>('tree', query)).rows

  it('全部展开：逐行与真值一致；父行位置指向真正的父行；读全', async (ctx) => {
    if (!available) return ctx.skip()
    await openTree()
    const sample = await run(page, treePlan())
    const t = await truth()
    expect(sample.rows.map((r) => [r.tree_path?.value, r.qty?.value, r.amount?.decimalValue])).toEqual(t.map((r) => [r.path, r.qty, r.amount.toFixed(2)]))
    expect(sample.coverage.status).toBe('complete')
    // 每行的父行就是层级路径去掉最后一段的那一行
    sample.rowMeta!.forEach((m, i) => {
      const path = String(sample.rows[i]!.tree_path!.value)
      const parentPath = path.split(' / ').slice(0, -1).join(' / ')
      if (m.level === 0) expect(m.parentIndex).toBeUndefined()
      else expect(sample.rows[m.parentIndex!]!.tree_path!.value).toBe(parentPath)
    })
    expect(sample.columns.map((c) => c.name)).toContain('层级路径')
  })

  it('读取范围：只取顶层 / 只取最底层', async (ctx) => {
    if (!available) return ctx.skip()
    await openTree()
    const t = await truth()
    const top = await run(page, treePlan('top'))
    expect(top.rows.map((r) => r.name?.value)).toEqual(t.filter((r) => r.level === 0).map((r) => r.name))
    const leaf = await run(page, treePlan('leaf'))
    expect(leaf.rows.map((r) => r.tree_path?.value)).toEqual(t.filter((r) => !r.hasChildren).map((r) => r.path))
    expect(leaf.rowMeta?.every((m) => m.parentIndex === undefined)).toBe(true)
  })

  it('有节点没展开：判“部分”并说清有几个没展开；只取顶层时不受影响', async (ctx) => {
    if (!available) return ctx.skip()
    await openTree('collapsed=1')
    const all = await run(page, treePlan())
    expect(all.coverage).toMatchObject({ status: 'partial', reasonCode: 'TABLE_TREE_COLLAPSED' })
    expect(all.coverage.reasonMessage).toContain('有 4 个节点没展开')
    expect(all.rows).toHaveLength(4)
    const top = await run(page, treePlan('top'))
    expect(top.coverage.status).toBe('complete')
    // 读不全时，父子之和无法确认（不当作通过）
    expect(evaluateTableExpectation(all, rollup).factsUnavailable).toBe(true)
  })

  it('父行等于子行之和：一致时通过；上海小计不符时只报上海', async (ctx) => {
    if (!available) return ctx.skip()
    await openTree()
    expect(evaluateTableExpectation(await run(page, treePlan()), rollup).passed).toBe(true)
    await openTree('bad=1')
    const bad = evaluateTableExpectation(await run(page, treePlan()), rollup)
    expect(bad.passed).toBe(false)
    expect(bad.factsUnavailable).toBeFalsy()
    expect(bad.details.violatingRows.map((v) => v.reasonSummary)).toEqual(['「华东 / 上海」的数量：子行相加 6，本行 7'])
    // 普通读法没有层级：如实说无法确认
    const flat = await run(page, plan('#grid', COLUMNS))
    expect(evaluateTableExpectation(flat, rollup).reasonCode).toBe('TABLE_TREE_LEVELS_MISSING')
  })

  it('按层级路径找行：“层级路径”可以作为检查条件', async (ctx) => {
    if (!available) return ctx.skip()
    await openTree()
    const p = treePlan()
    const lookup = tableExpectRuleSchema.parse({
      rule: 'row_lookup',
      where: [{ column: 'tree_path', predicate: { op: 'eq', value: '华南 / 深圳' } }],
      expect: [{ column: 'qty', predicate: { op: 'gt', value: 0 } }],
    })
    expect(validateTableExpectRuleAgainstPlan(lookup, tablePlanCheckColumns(p))).toEqual({ valid: true })
    expect(validateTableExpectRuleAgainstPlan(lookup, p.columns)).toMatchObject({ valid: false })
    expect(evaluateTableExpectation(await run(page, p), lookup).passed).toBe(true)
  })

  it('通用 ARIA treegrid（aria-level / aria-expanded）：识别为树形，层级与真值一致', async (ctx) => {
    if (!available) return ctx.skip()
    const p = await fixtures!.browser.newPage()
    await p.goto(`${fixtures!.base}/aria-treegrid.html`)
    const detected = await detectTable(p, { kind: 'root', selector: '#tree', framePath: [] }, deps)
    expect(detected.outcome).toBe('FOUND')
    if (detected.outcome !== 'FOUND') return
    expect(detected.detected.plan.layout).toEqual({ mode: 'tree', scope: 'all' })
    expect(detected.detected.notes.join('')).toContain('树形表格')
    const sample = await run(p, detected.detected.plan)
    const t = await truth()
    expect(sample.rows.map((r) => r.tree_path?.value)).toEqual(t.map((r) => r.path))
    expect(sample.rowMeta?.map((m) => m.level)).toEqual(t.map((r) => r.level))
    await p.close()
  })
})
