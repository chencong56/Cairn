/**
 * 分页条读数（通用规则）：各种常见写法、输入框 / 下拉框里的值、互相矛盾时不给、不在表旁边的分页条不算。
 * 无浏览器时 skip，跳过不等于通过。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from 'playwright'
import { isChromiumAvailableCached } from '../testing/chromium-probe.js'
import { plan, run, startHarness, type FixtureHarness } from '../testing/table-read-test-kit.js'

const TABLE = `<table id="t"><thead><tr><th>名称</th></tr></thead><tbody><tr><td>甲</td></tr><tr><td>乙</td></tr></tbody></table>`

describe('分页条读数', { timeout: 120_000 }, () => {
  let available = false
  let harness: FixtureHarness | undefined
  beforeAll(async () => {
    available = await isChromiumAvailableCached()
    if (available) harness = await startHarness()
  })
  afterAll(async () => {
    await harness?.close()
  })

  async function read(html: string) {
    const page: Page = await harness!.browser.newPage()
    await page.setContent(html)
    const sample = await run(page, plan('#t', [{ key: 'name', name: '名称' }]))
    await page.close()
    const { rawText: _raw, ...fields } = sample.pageInfo ?? { rawText: '' }
    return { fields, clues: sample.coverage.clues ?? [] }
  }

  const cases: Array<[string, string, Record<string, unknown>]> = [
    ['第 x / y 页 + 每页 + 共', '<div class="pagination">第 2 / 5 页，每页 20 条，共 96 条</div>', { totalRows: 96, currentPage: 2, totalPages: 5, pageSize: 20 }],
    ['“1.2万”', '<div class="pager">共 1.2万 条</div>', { totalRows: 12000 }],
    ['DataTables 中文', '<div class="dataTables_paginate pagination">显示第 21 至 40 项结果，共 57 项</div>', { totalRows: 57, rowRange: { from: 21, to: 40 } }],
    ['DataTables 英文', '<div class="pagination">Showing 1 to 10 of 57 entries</div>', { totalRows: 57, rowRange: { from: 1, to: 10 } }],
    ['输入框里的当前页', '<div class="pagination">第 <input value="3" size="2"> 页 共 4 页</div>', { currentPage: 3, totalPages: 4 }],
    ['数字下拉框是每页条数', '<div class="pager"><select><option>10</option><option selected>20</option><option>50</option></select> 共 45 条</div>', { pageSize: 20, totalRows: 45 }],
    ['高亮的页码是当前页', '<ul class="pagination"><li><a>1</a></li><li class="active"><a>2</a></li><li><a>3</a></li></ul>', { currentPage: 2 }],
  ]
  for (const [name, pager, expected] of cases) {
    it(name, async ({ skip }) => {
      if (!available) skip()
      expect((await read(`${TABLE}${pager}`)).fields).toEqual(expected)
    })
  }

  it('上下两个分页条数字矛盾：该字段不给，并留线索', async ({ skip }) => {
    if (!available) skip()
    const r = await read(`<div class="pager">共 45 条 · 第 1 页</div>${TABLE}<div class="pager">共 46 条 · 第 1 页</div>`)
    expect(r.fields).toEqual({ currentPage: 1 })
    expect(r.clues).toContain('page_info_ambiguous')
  })

  it('隐藏的分页条、离表格很远的分页条都不算', async ({ skip }) => {
    if (!available) skip()
    expect((await read(`${TABLE}<div class="pager" style="display:none">共 45 条</div>`)).fields).toEqual({})
    expect((await read(`<div><div class="pager">共 45 条</div></div><p>无关段落</p><section>${TABLE}</section>`)).fields).toEqual({})
  })
})
