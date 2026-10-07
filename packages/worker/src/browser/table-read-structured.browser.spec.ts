/**
 * table.read@2 × 卡片 / 键值（cards / keyvalue）靶场：重复块、“名称：值”文字、dl、th/td 表单表格、div 字段行。
 * 靶场按常见写法自建，不等于已兼容某真实系统。无浏览器时 skip，跳过不等于通过。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from 'playwright'
import { evaluateTableExpectation } from '@cairn/shared'
import { isChromiumAvailableCached } from '../testing/chromium-probe.js'
import { detectTable } from './table-read-v2.js'
import { centerOf, deps, plan, run, startHarness, valueOf, type FixtureHarness } from '../testing/table-read-test-kit.js'

describe('table.read@2 × 卡片 / 键值靶场', { timeout: 180_000 }, () => {
  let available = false
  let harness: FixtureHarness | undefined

  beforeAll(async () => {
    available = await isChromiumAvailableCached()
    if (available) harness = await startHarness()
  })
  afterAll(async () => {
    await harness?.close()
  })

  async function open(path: string): Promise<Page> {
    const page = await harness!.browser.newPage()
    await page.goto(`${harness!.base}/${path}`)
    return page
  }

  it('卡片（重复块）：每张卡片一行，标题 + 名称：值，数字与百分号规整', async ({ skip }) => {
    if (!available) skip()
    const page = await open('cards-metrics.html')
    const sample = await run(
      page,
      plan(
        '#board',
        [
          { key: 'title', name: '标题' },
          { key: 'cpu', name: 'CPU', valueType: 'number', numericKind: 'decimal' },
          { key: 'mem', name: '内存', valueType: 'number', numericKind: 'decimal' },
          { key: 'alarms', name: '告警数', valueType: 'number', numericKind: 'integer' },
        ],
        { kind: 'cards' },
      ),
    )
    expect(sample.coverage.status).toBe('complete')
    expect(sample.rows.map((r) => valueOf(r, 'title'))).toEqual(['服务器A', '服务器B', '服务器C'])
    expect(sample.rows.map((r) => valueOf(r, 'cpu'))).toEqual([35, 81, 12])
    expect(sample.rows.map((r) => valueOf(r, 'alarms'))).toEqual([2, 0, 5])
    expect(sample.summaryRows).toBeUndefined()
    await page.close()
  })

  it('卡片：点选任意一个字段识别整组卡片，并给出“单张卡片”的小一点候选', async ({ skip }) => {
    if (!available) skip()
    const page = await open('cards-metrics.html')
    const result = await detectTable(page, { kind: 'point', ...(await centerOf(page, '.card:nth-child(2) .row:nth-child(3) .value')) }, deps)
    expect(result.outcome).toBe('FOUND')
    if (result.outcome !== 'FOUND') return
    const d = result.detected
    expect(d.shape).toBe('cards')
    expect(d.plan.kind).toBe('cards')
    expect(d.rowCount).toBe(3)
    expect(d.columns.map((c) => c.name)).toEqual(['标题', 'CPU', '内存', '告警数'])
    expect(d.columns.find((c) => c.name === 'CPU')?.valueType).toBe('number')
    expect(d.sample.rows).toHaveLength(3)
    expect(d.alternatives.some((a) => a.level === 'inner')).toBe(true)
    // 识别出的计划可直接保存并重复读取
    const again = await run(page, d.plan)
    expect(again.rows.map((r) => valueOf(r, 'col_1'))).toEqual(['服务器A', '服务器B', '服务器C'])
    await page.close()
  })

  it('卡片：“名称：值”文字、缺字段的卡片该字段为空、分页提示进线索', async ({ skip }) => {
    if (!available) skip()
    const page = await open('cards-inline.html')
    const sample = await run(
      page,
      plan(
        '#orders',
        [
          { key: 'no', name: '订单号' },
          { key: 'customer', name: '客户' },
          { key: 'amount', name: '金额', valueType: 'number', numericKind: 'decimal' },
        ],
        { kind: 'cards' },
      ),
    )
    expect(sample.rows.map((r) => valueOf(r, 'no'))).toEqual(['SO-1001', 'SO-1002', 'SO-1003'])
    expect(sample.rows[0]!.amount!.decimalValue).toBe('1200.50')
    expect(sample.rows[2]!.amount!.status).toBe('missing')
    expect(sample.coverage.clues).toContain('pagination_present')
    await page.close()
  })

  it('键值（dl）：一块详情读成一行，列名就是名称，日期规范化', async ({ skip }) => {
    if (!available) skip()
    const page = await open('keyvalue-dl.html')
    const result = await detectTable(page, { kind: 'point', ...(await centerOf(page, '#detail dd:nth-of-type(2)')) }, deps)
    expect(result.outcome).toBe('FOUND')
    if (result.outcome !== 'FOUND') return
    const d = result.detected
    expect(d.shape).toBe('keyvalue')
    expect(d.plan.kind).toBe('keyvalue')
    expect(d.sample.rows).toHaveLength(1)
    expect(d.columns.map((c) => c.name)).toEqual(['设备名称', '状态', '端口数', '上线日期'])
    expect(d.columns.find((c) => c.name === '端口数')?.valueType).toBe('number')
    expect(d.columns.find((c) => c.name === '上线日期')?.valueType).toBe('date')
    const row = d.sample.rows[0]!
    expect(valueOf(row, 'col_2')).toBe('运行中')
    expect(valueOf(row, 'col_4')).toBe('2024-03-05')
    await page.close()
  })

  it('紧凑日期：8 位 / 14 位整列合法 → 日期列并规范化；混入非法值的整列保持数字；带时分秒按日期部分比较', async ({ skip }) => {
    if (!available) skip()
    const page = await open('compact-dates.html')
    const result = await detectTable(page, { kind: 'point', ...(await centerOf(page, '#reports tbody tr:nth-child(1) td:nth-child(2)')) }, deps)
    expect(result.outcome).toBe('FOUND')
    if (result.outcome !== 'FOUND') return
    const d = result.detected
    const typeOf = (name: string) => d.columns.find((c) => c.name === name)?.valueType
    expect(typeOf('最新数据')).toBe('date')
    expect(typeOf('更新时间')).toBe('date')
    expect(typeOf('单号')).toBe('number')
    const key = (name: string) => d.columns.find((c) => c.name === name)!.key
    const first = d.sample.rows[0]!
    expect(valueOf(first, key('最新数据'))).toBe('2025-12-22')
    expect(first[key('最新数据')]!.rawText).toBe('20251222')
    expect(valueOf(first, key('更新时间'))).toBe('2025-12-22 08:30:00')
    // 采样时刻按北京时间是 2025-12-22：更新时间（带时分秒）“是今天”按日期部分通过
    const verdict = evaluateTableExpectation(
      { ...d.sample, source: { ...d.sample.source, sampledAt: '2025-12-22T04:00:00.000Z' } },
      {
        rule: 'row_lookup',
        where: [{ column: key('报表名称'), predicate: { op: 'eq', value: '需求订单统计表' } }],
        expect: [{ column: key('更新时间'), predicate: { op: 'date_within_days', days: 0, allowFuture: false, timezone: 'Asia/Shanghai' } }],
        onMissing: 'fail',
        onMultiple: 'all',
      } as never,
    )
    expect(verdict.reasonMessage ?? '').toBe('')
    expect(verdict.passed).toBe(true)
    await page.close()
  })

  it('键值（th/td 表单表格）：一行两对 / 两列版都按“名称：值”读，空值为 missing', async ({ skip }) => {
    if (!available) skip()
    const page = await open('keyvalue-table.html')
    const four = await detectTable(page, { kind: 'point', ...(await centerOf(page, '#form-table tr:nth-child(2) td:nth-child(2)')) }, deps)
    expect(four.outcome).toBe('FOUND')
    if (four.outcome !== 'FOUND') return
    expect(four.detected.shape).toBe('keyvalue')
    expect(four.detected.columns.map((c) => c.name)).toEqual(['申请人', '部门', '金额', '状态'])
    expect(valueOf(four.detected.sample.rows[0], 'col_3')).toBe(5000)
    const two = await run(
      page,
      plan('#two-col', [
        { key: 'no', name: '编号' },
        { key: 'type', name: '类型' },
        { key: 'memo', name: '备注' },
      ], { kind: 'keyvalue' }),
    )
    expect(two.rows).toHaveLength(1)
    expect(valueOf(two.rows[0], 'no')).toBe('REQ-9')
    expect(two.rows[0]!.memo!.status).toBe('missing')
    await page.close()
  })

  it('键值（div 字段行 + label/value 类名）：布尔与带单位数字', async ({ skip }) => {
    if (!available) skip()
    const page = await open('keyvalue-div.html')
    const result = await detectTable(page, { kind: 'point', ...(await centerOf(page, '#contract .field:nth-child(3) .field-value')) }, deps)
    expect(result.outcome).toBe('FOUND')
    if (result.outcome !== 'FOUND') return
    const d = result.detected
    expect(d.shape).toBe('keyvalue')
    expect(d.columns.map((c) => c.name)).toEqual(['合同编号', '签约方', '合同金额', '是否续签'])
    expect(d.columns.find((c) => c.name === '是否续签')?.valueType).toBe('boolean')
    await page.close()
  })

  it('键值：读不到名称（找不到列）直接报错，不猜', async ({ skip }) => {
    if (!available) skip()
    const page = await open('keyvalue-dl.html')
    await expect(run(page, plan('#detail', [{ key: 'x', name: '不存在的项' }], { kind: 'keyvalue' }))).rejects.toMatchObject({ code: 'TABLE_COLUMN_NOT_FOUND' })
    await page.close()
  })

  it('检查复用：键值信息可直接做“某项满足条件”，卡片可做聚合与唯一', async ({ skip }) => {
    if (!available) skip()
    const page = await open('keyvalue-dl.html')
    const kv = await run(page, plan('#detail', [{ key: 'status', name: '状态' }, { key: 'ports', name: '端口数', valueType: 'number', numericKind: 'integer' }], { kind: 'keyvalue' }))
    expect(evaluateTableExpectation(kv, { rule: 'all_rows', column: 'status', predicate: { op: 'eq', value: '运行中' }, allowEmpty: false }).passed).toBe(true)
    expect(evaluateTableExpectation(kv, { rule: 'all_rows', column: 'ports', predicate: { op: 'gte', value: 64 }, allowEmpty: false }).passed).toBe(false)
    await page.close()
    const cardsPage = await open('cards-metrics.html')
    const cards = await run(
      cardsPage,
      plan('#board', [{ key: 'title', name: '标题' }, { key: 'alarms', name: '告警数', valueType: 'number', numericKind: 'integer' }], { kind: 'cards' }),
    )
    expect(evaluateTableExpectation(cards, { rule: 'column_stat', column: 'alarms', stat: 'sum', op: 'eq', value: 7, ignoreEmpty: false }).passed).toBe(true)
    expect(evaluateTableExpectation(cards, { rule: 'column_unique', column: 'title' }).passed).toBe(true)
    await cardsPage.close()
  })
})
