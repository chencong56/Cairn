import { useState } from 'react'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { describe, expect, it } from 'vitest'
import '@/styles/index.css'
import { MemberPickerDialog } from './member-picker-dialog'
import { matchPublishedScenarioName, toggleCurrentListSelection } from './member-picker-selection'

const scenarios = [
  { id: 'sc-1', name: '登录巡检场景', latestVersionId: 'v1', latestVersionNo: 3 },
  { id: 'sc-2', name: '风控拦截场景', latestVersionId: 'v2', latestVersionNo: 1 },
  { id: 'sc-3', name: '登录后对账检查', latestVersionId: 'v3', latestVersionNo: 2 },
]

function Harness({
  currentMemberScenarioIds = [],
}: {
  currentMemberScenarioIds?: string[]
}) {
  const [open, setOpen] = useState(true)
  const [added, setAdded] = useState<string[]>([])
  return (
    <>
      <output data-testid='added'>{added.join(',')}</output>
      <MemberPickerDialog
        open={open}
        onOpenChange={setOpen}
        availableScenarios={scenarios}
        currentMemberScenarioIds={currentMemberScenarioIds}
        title='选择场景加入场景集'
        onSelectScenarios={setAdded}
      />
    </>
  )
}

describe('matchPublishedScenarioName', () => {
  it('按空格分词，全部命中才留下', () => {
    expect(matchPublishedScenarioName('账号登录巡检', '登录 巡检')).toBe(true)
    expect(matchPublishedScenarioName('账号登录巡检', '登录 风控')).toBe(false)
    expect(matchPublishedScenarioName('账号登录巡检', '  ')).toBe(true)
  })
})

describe('toggleCurrentListSelection', () => {
  it('全选只并入当前列表，不丢掉已选的其他项', () => {
    expect(toggleCurrentListSelection(['keep'], ['a', 'b'])).toEqual(['keep', 'a', 'b'])
  })

  it('取消当前只拿掉当前列表，保留组合勾选里的其他项', () => {
    expect(toggleCurrentListSelection(['keep', 'a', 'b'], ['a', 'b'])).toEqual(['keep'])
  })
})

describe('MemberPickerDialog 场景库大面板', () => {
  it('支持搜索后组合勾选，一次加入所选', async () => {
    await render(<Harness currentMemberScenarioIds={['sc-1']} />)
    await page.viewport(1280, 800)

    await page.getByPlaceholder('搜索场景名称，空格分词').fill('登录')
    await expect.element(page.getByText('搜索结果 (2)')).toBeVisible()
    await expect.element(page.getByRole('checkbox', { name: '选择 风控拦截场景' })).not.toBeInTheDocument()

    await page.getByRole('button', { name: '全选当前 (2)' }).click()
    await expect.element(page.getByText('已在集合')).toBeVisible()
    await expect.element(page.getByRole('button', { name: '取消选择 登录巡检场景' })).toBeVisible()
    await expect.element(page.getByRole('button', { name: '取消选择 登录后对账检查' })).toBeVisible()

    await page.getByPlaceholder('搜索场景名称，空格分词').fill('风控')
    await page.getByRole('checkbox', { name: '选择 风控拦截场景' }).click()
    await expect.element(page.getByText('已选 3 个')).toBeVisible()

    await page.getByRole('button', { name: '加入所选 (3)' }).click()
    await expect.element(page.getByTestId('added')).toHaveTextContent('sc-1,sc-3,sc-2')
  })
})
