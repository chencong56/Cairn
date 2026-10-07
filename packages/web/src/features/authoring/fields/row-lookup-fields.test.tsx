import '@/styles/index.css'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { tableReadPlanSchema, type OutcomeContract, type Step, type TableSample } from '@cairn/shared'
import { TableChecksEditor } from './table-checks'
import { buildTableCheck } from './table-checks-model'
import { setTableSample } from './table-sample-store'

const STEP_ID = '00000000-0000-4000-8000-0000000000e9'
const plan = tableReadPlanSchema.parse({
  protocol: 'table.read@2',
  target: { framePath: [], candidates: [{ by: 'css', value: '#grid' }] },
  columns: [
    { key: 'name', name: '报表名称', valueType: 'text' },
    { key: 'data', name: '最新数据', valueType: 'number', numericKind: 'decimal' },
    { key: 'cycle', name: '更新周期', valueType: 'text' },
  ],
})
const step = {
  id: STEP_ID,
  name: '读表',
  type: 'extract',
  effectType: 'READ_ONLY',
  outputKey: 'report',
  input: { target: plan.target, as: 'table', table: plan },
} as Extract<Step, { type: 'extract' }>

const labelOf = (k: string) => ({ name: '报表名称', data: '最新数据', cycle: '更新周期' })[k] ?? k
const lookupCheck = () =>
  buildTableCheck(
    'report',
    {
      rule: 'row_lookup',
      where: [{ column: 'name', predicate: { op: 'eq', value: '需求订单统计表' } }],
      expect: [{ column: 'data', predicate: { op: 'neq', value: 0, numericPolicy: { mode: 'fixed', scale: 8, rounding: 'half_away_from_zero' } } }],
      onMissing: 'fail',
      onMultiple: 'all',
    },
    labelOf,
  )

const sample = (names: string[]): TableSample =>
  ({
    protocol: 'table.sample@1',
    source: { runId: '11111111-1111-4111-8111-111111111111', sampledAt: new Date().toISOString(), planDigest: 'a'.repeat(64) },
    columns: [
      { key: 'name', name: '报表名称', valueType: 'text' },
      { key: 'data', name: '最新数据', valueType: 'number', numericKind: 'decimal' },
    ],
    rows: names.map((n, i) => ({
      name: { value: n, rawText: n, status: 'ok' },
      data: { value: i, rawText: String(i), decimalValue: String(i), status: 'ok' },
    })),
    rowCount: names.length,
    coverage: { requestedScope: 'current_page', observedScope: 'current_page', status: 'complete' },
    presentation: { omitted: false, previewCount: names.length },
  }) as unknown as TableSample

afterEach(() => setTableSample(STEP_ID, null))

describe('找到某一行，再检查它 · 编辑器', () => {
  it.each([270, 330, 450])('检查器内容宽 %i px：无横向滚动、两个下拉并排、值输入独占整行、整句可见', async (width) => {
    const check = lookupCheck()
    const screen = await render(
      <div style={{ width }} data-testid='box'>
        <TableChecksEditor step={step} checks={[check as OutcomeContract as never]} onChange={vi.fn()} />
      </div>,
    )
    const box = screen.container.querySelector('[data-testid="box"]') as HTMLElement
    const boxRect = box.getBoundingClientRect()
    expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1)
    // 所有可见元素都不越出容器
    for (const el of Array.from(box.querySelectorAll('*')) as HTMLElement[]) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      expect(r.right, `${el.tagName}.${el.className}`).toBeLessThanOrEqual(boxRect.right + 1)
    }
    const cond = box.querySelector('[data-testid="lookup-condition"]') as HTMLElement
    const [colSelect, opSelect] = Array.from(cond.querySelectorAll('button[role="combobox"]')) as HTMLElement[]
    const input = cond.querySelector('input[aria-label="要找的内容"]') as HTMLElement
    const a = colSelect!.getBoundingClientRect()
    const b = opSelect!.getBoundingClientRect()
    const v = input.getBoundingClientRect()
    expect(a.right).toBeLessThanOrEqual(b.left + 1)
    expect(Math.abs(a.top - b.top)).toBeLessThan(2)
    expect(v.top).toBeGreaterThanOrEqual(a.bottom - 1)
    expect(v.width).toBeGreaterThan(width * 0.7)
    const sentence = box.textContent ?? ''
    expect(sentence).toContain('找到「报表名称」等于「需求订单统计表」的行，它的「最新数据」不等于 0；找不到这一行记为不通过')
  })

  it('预览里出现过的值作为候选，点一下填入找行条件', async () => {
    setTableSample(STEP_ID, sample(['存量收入统计表', '需求订单统计表', '楼宇覆盖统计表']))
    const onChange = vi.fn()
    const screen = await render(<TableChecksEditor step={step} checks={[lookupCheck() as never]} onChange={onChange} />)
    await screen.getByRole('button', { name: '存量收入统计表' }).click()
    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0]![0] as OutcomeContract[]
    const rule = (next[0] as { rule: { expect: { rule: { where: Array<{ predicate: { op: string; value: string } }> } } } }).rule.expect.rule
    expect(rule.where[0]!.predicate).toMatchObject({ op: 'eq', value: '存量收入统计表' })
  })

  it('按当前预览提示：找不到时给橙色提醒和最接近的名称，不阻断', async () => {
    setTableSample(STEP_ID, sample(['需求订单统计报表', '收入汇总']))
    const screen = await render(<TableChecksEditor step={step} checks={[lookupCheck() as never]} onChange={vi.fn()} />)
    const text = screen.container.querySelector('[data-testid="lookup-preview"]')?.textContent ?? ''
    expect(text).toContain('当前预览里没有找到符合的行（共 2 行）')
    expect(text).toContain('最接近的：需求订单统计报表')
  })

  it('再加一个条件：写出两个“并且”条件，且新条件换用另一列', async () => {
    const onChange = vi.fn()
    const screen = await render(<TableChecksEditor step={step} checks={[lookupCheck() as never]} onChange={onChange} />)
    await screen.getByRole('button', { name: '＋ 再加一个条件（并且）' }).click()
    const next = onChange.mock.calls[0]![0] as OutcomeContract[]
    const where = (next[0] as { rule: { expect: { rule: { where: Array<{ column: string }> } } } }).rule.expect.rule.where
    expect(where).toHaveLength(2)
    expect(where[1]!.column).not.toBe(where[0]!.column)
  })

  it('找行选“包含”但还没填内容：不写出不合法的规则（等填了再生效）', async () => {
    const onChange = vi.fn()
    const blank = buildTableCheck('report', { rule: 'row_lookup', where: [{ column: 'name', predicate: { op: 'eq', value: '' } }], expect: [{ column: 'cycle', predicate: { op: 'is_not_empty' } }], onMissing: 'fail', onMultiple: 'all' }, labelOf)
    const screen = await render(<TableChecksEditor step={step} checks={[blank as never]} onChange={onChange} />)
    await screen.getByRole('combobox', { name: '条件' }).first().click()
    await screen.getByRole('option', { name: '包含' }).click()
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.container.textContent).toContain('请填写要找的内容')
  })
})

describe('日期列条件 · 编辑器', () => {
  const datePlan = tableReadPlanSchema.parse({
    protocol: 'table.read@2',
    target: { framePath: [], candidates: [{ by: 'css', value: '#grid' }] },
    columns: [
      { key: 'name', name: '报表名称', valueType: 'text' },
      { key: 'latest', name: '最新数据', valueType: 'date' },
    ],
  })
  const dateStep = { ...step, input: { target: datePlan.target, as: 'table', table: datePlan } } as Extract<Step, { type: 'extract' }>
  const dateLabel = (k: string) => ({ name: '报表名称', latest: '最新数据' })[k] ?? k
  const dateCheck = () =>
    buildTableCheck(
      'report',
      {
        rule: 'row_lookup',
        where: [{ column: 'name', predicate: { op: 'eq', value: '需求订单统计表' } }],
        expect: [{ column: 'latest', predicate: { op: 'date_within_days', days: 1, allowFuture: false, timezone: 'Asia/Shanghai' } }],
        onMissing: 'fail',
        onMultiple: 'all',
      },
      dateLabel,
    )

  it.each([270, 330, 450])('检查器内容宽 %i px：日期条件两个下拉并排、不横向溢出、整句完整回显', async (width) => {
    const screen = await render(
      <div style={{ width }} data-testid='box'>
        <TableChecksEditor step={dateStep} checks={[dateCheck() as never]} onChange={vi.fn()} />
      </div>,
    )
    const box = screen.container.querySelector('[data-testid="box"]') as HTMLElement
    const boxRect = box.getBoundingClientRect()
    expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1)
    for (const el of Array.from(box.querySelectorAll('*')) as HTMLElement[]) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      expect(r.right, `${el.tagName}.${el.className}`).toBeLessThanOrEqual(boxRect.right + 1)
    }
    const conds = Array.from(box.querySelectorAll('[data-testid="lookup-condition"]')) as HTMLElement[]
    const [colSelect, opSelect] = Array.from(conds[1]!.querySelectorAll('button[role="combobox"]')) as HTMLElement[]
    const a = colSelect!.getBoundingClientRect()
    const b = opSelect!.getBoundingClientRect()
    expect(a.right).toBeLessThanOrEqual(b.left + 1)
    expect(Math.abs(a.top - b.top)).toBeLessThan(2)
    expect(opSelect!.textContent).toContain('不早于昨天')
    expect(box.textContent ?? '').toContain('「最新数据」不早于昨天（按北京时间的运行当天算）')
  })

  it('切换成“不早于某个日期”：写出固定日期谓词；切到“不早于 N 天前”：默认 3 天、沿用时区', async () => {
    const onChange = vi.fn()
    const screen = await render(<TableChecksEditor step={dateStep} checks={[dateCheck() as never]} onChange={onChange} />)
    const ops = screen.getByRole('combobox', { name: '条件' })
    await ops.nth(1).click()
    await screen.getByRole('option', { name: '不早于某个日期' }).click()
    const next = onChange.mock.calls[0]![0] as OutcomeContract[]
    const rule = (next[0] as { rule: { expect: { rule: { expect: Array<{ predicate: { op: string; value: string } }> } } } }).rule.expect.rule
    expect(rule.expect[0]!.predicate.op).toBe('date_on_or_after')
    expect(rule.expect[0]!.predicate.value).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    onChange.mockClear()
    await ops.nth(1).click()
    await screen.getByRole('option', { name: '不早于 N 天前' }).click()
    const rule2 = ((onChange.mock.calls[0]![0] as OutcomeContract[])[0] as { rule: { expect: { rule: { expect: Array<{ predicate: unknown }> } } } }).rule.expect.rule
    expect(rule2.expect[0]!.predicate).toMatchObject({ op: 'date_within_days', days: 3, timezone: 'Asia/Shanghai', allowFuture: false })
  })

  it('日期列在“找哪一行”里：预览出现过的日期作为候选，点一下填入', async () => {
    setTableSample(STEP_ID, {
      ...sample(['a']),
      columns: [
        { key: 'name', name: '报表名称', valueType: 'text' },
        { key: 'latest', name: '最新数据', valueType: 'date' },
      ],
      rows: [{ name: { value: 'a', status: 'ok' }, latest: { value: '2025-12-22', rawText: '20251222', status: 'ok' } }],
    } as unknown as TableSample)
    const onChange = vi.fn()
    const check = buildTableCheck(
      'report',
      {
        rule: 'row_lookup',
        where: [{ column: 'latest', predicate: { op: 'date_on', value: '2025-01-01' } }],
        expect: [{ column: 'name', predicate: { op: 'is_not_empty' } }],
        onMissing: 'fail',
        onMultiple: 'all',
      },
      dateLabel,
    )
    const screen = await render(<TableChecksEditor step={dateStep} checks={[check as never]} onChange={onChange} />)
    await screen.getByRole('button', { name: '2025-12-22' }).click()
    const rule = ((onChange.mock.calls[0]![0] as OutcomeContract[])[0] as { rule: { expect: { rule: { where: Array<{ predicate: unknown }> } } } }).rule.expect.rule
    expect(rule.where[0]!.predicate).toEqual({ op: 'date_on', value: '2025-12-22' })
  })
})
