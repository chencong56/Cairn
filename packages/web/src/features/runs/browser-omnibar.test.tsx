import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render } from 'vitest-browser-react'
import { BrowserOmnibar } from './browser-omnibar'

describe('BrowserOmnibar', () => {
  let writeTextMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    writeTextMock = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      configurable: true,
    })
  })

  it('展示格式化后的地址，不带多余前缀与分辨率杂音', async () => {
    const screen = await render(
      <BrowserOmnibar
        url="https://app.example.com/orders/list?status=active"
        caption="app.example.com/orders/list"
      />,
    )

    await expect.element(screen.getByText('app.example.com/orders/list')).toBeInTheDocument()
    await expect.element(screen.getByText('1920×1080')).not.toBeInTheDocument()
  })

  it('点击复制按钮调用剪贴板并切换为成功状态', async () => {
    const screen = await render(
      <BrowserOmnibar
        url="https://app.example.com/orders/list?status=active"
        caption="app.example.com/orders/list"
      />,
    )

    const copyBtn = screen.getByRole('button', { name: '复制完整地址' })
    await copyBtn.click()

    expect(writeTextMock).toHaveBeenCalledWith('https://app.example.com/orders/list?status=active')
    await expect.element(screen.getByRole('button', { name: '已复制完整地址' })).toBeInTheDocument()
  })

  it('没有操作权限时点击地址文本不进入编辑态', async () => {
    const screen = await render(
      <BrowserOmnibar
        url="https://app.example.com/orders"
        caption="app.example.com/orders"
        canNavigate={false}
      />,
    )

    await screen.getByText('app.example.com/orders').click()
    expect(screen.getByRole('textbox').elements()).toHaveLength(0)
  })

  it('持有操作权限时点击进入编辑态，输入新网址按回车触发导航', async () => {
    const onNavigate = vi.fn().mockResolvedValue(undefined)
    const screen = await render(
      <BrowserOmnibar
        url="https://app.example.com/orders"
        caption="app.example.com/orders"
        canNavigate={true}
        onNavigate={onNavigate}
      />,
    )

    // 点击进入编辑态
    await screen.getByText('app.example.com/orders').click()
    const input = screen.getByRole('textbox', { name: '目标网址输入框' })
    await expect.element(input).toBeInTheDocument()

    // 填入带端口但不带协议的地址（测试自动规范化补齐 http://）
    await input.fill('127.0.0.1:4183/legacy/table.html')
    await screen.getByRole('button', { name: '前往目标网址' }).click()

    expect(onNavigate).toHaveBeenCalledWith('http://127.0.0.1:4183/legacy/table.html')
    // 提交后恢复浏览态
    expect(screen.getByRole('textbox').elements()).toHaveLength(0)
  })

  it('输入非法协议（如 javascript:）拦截并不触发导航', async () => {
    const onNavigate = vi.fn()
    const screen = await render(
      <BrowserOmnibar
        url="https://app.example.com/orders"
        caption="app.example.com/orders"
        canNavigate={true}
        onNavigate={onNavigate}
      />,
    )

    await screen.getByText('app.example.com/orders').click()
    const input = screen.getByRole('textbox', { name: '目标网址输入框' })
    await input.fill('javascript:alert(1)')
    await screen.getByRole('button', { name: '前往目标网址' }).click()

    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('按 Escape 键或点击取消按钮退出编辑，不触发导航', async () => {
    const onNavigate = vi.fn()
    const screen = await render(
      <BrowserOmnibar
        url="https://app.example.com/orders"
        caption="app.example.com/orders"
        canNavigate={true}
        onNavigate={onNavigate}
      />,
    )

    await screen.getByText('app.example.com/orders').click()
    await expect.element(screen.getByRole('textbox', { name: '目标网址输入框' })).toBeInTheDocument()

    await screen.getByRole('button', { name: '取消编辑' }).click()
    expect(screen.getByRole('textbox').elements()).toHaveLength(0)
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('导航失败时保持编辑态并保留输入', async () => {
    const onNavigate = vi.fn().mockRejectedValue(new Error('x'))
    const screen = await render(
      <BrowserOmnibar
        url="https://app.example.com/orders"
        caption="app.example.com/orders"
        canNavigate={true}
        onNavigate={onNavigate}
      />,
    )

    await screen.getByText('app.example.com/orders').click()
    const input = screen.getByRole('textbox', { name: '目标网址输入框' })
    await input.fill('https://bad.example.com/x')
    await screen.getByRole('button', { name: '前往目标网址' }).click()

    expect(onNavigate).toHaveBeenCalled()
    await expect.element(input).toHaveValue('https://bad.example.com/x')
  })

  it('他人持有手动操作权时显示占用方并禁止进入编辑态', async () => {
    const screen = await render(
      <BrowserOmnibar
        url="https://app.example.com/orders"
        caption="app.example.com/orders"
        canNavigate={false}
        lockedReason='李四 正在手动操作'
      />,
    )

    await expect.element(screen.getByText('李四 正在手动操作')).toBeInTheDocument()
    await screen.getByText('app.example.com/orders').click()
    expect(screen.getByRole('textbox').elements()).toHaveLength(0)
  })
})
