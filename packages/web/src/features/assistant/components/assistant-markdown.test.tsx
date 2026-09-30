import '@/styles/index.css'
import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { AssistantMarkdown } from './assistant-markdown'

describe('AssistantMarkdown 组件测试', () => {
  it('正确解析段落与加粗行内语法', async () => {
    const text = '场景「**modelapi中转站**」共 5 步。\n\n已定义 1 个成功条件：**MUST** 尚未配置。'
    const screen = await render(<AssistantMarkdown content={text} />)

    const strongs = screen.container.querySelectorAll('strong')
    expect(strongs.length).toBe(2)
    expect(strongs[0].textContent).toBe('modelapi中转站')
    expect(strongs[1].textContent).toBe('MUST')

    const paragraphs = screen.container.querySelectorAll('p')
    expect(paragraphs.length).toBe(2)
  })

  it('正确解析有序编号列表', async () => {
    const text = '执行步骤如下：\n\n1. 打开仪表盘页面\n2. 点击用户管理\n3. 导出统计报表'
    const screen = await render(<AssistantMarkdown content={text} />)

    const ol = screen.container.querySelector('ol')
    expect(ol).not.toBeNull()
    const lis = ol!.querySelectorAll('li')
    expect(lis.length).toBe(3)
    expect(lis[0].textContent).toBe('打开仪表盘页面')
    expect(lis[1].textContent).toBe('点击用户管理')
    expect(lis[2].textContent).toBe('导出统计报表')
  })

  it('正确解析无序列表与行内代码', async () => {
    const text = '- 检查 `modelapi.im` 状态\n- 验证 `token` 有效期'
    const screen = await render(<AssistantMarkdown content={text} />)

    const ul = screen.container.querySelector('ul')
    expect(ul).not.toBeNull()
    const codes = screen.container.querySelectorAll('code')
    expect(codes.length).toBe(2)
    expect(codes[0].textContent).toBe('modelapi.im')
    expect(codes[1].textContent).toBe('token')
  })

  it('防 XSS 注入：将包含 HTML 标签的定位器转义为纯文本节点', async () => {
    const text = '检查元素 `<button id="submit">` 与 `<script>alert(1)</script>`。'
    const screen = await render(<AssistantMarkdown content={text} />)

    // 不应存在任何可执行的 script 标签
    expect(screen.container.querySelector('script')).toBeNull()
    expect(screen.container.textContent).toContain('<button id="submit">')
    expect(screen.container.textContent).toContain('<script>alert(1)</script>')
  })

  it('流式生成半闭合语法自愈（未闭合星号与反引号平滑降级）', async () => {
    const streamChunk = '正在生成：**关键重点'
    const screen = await render(<AssistantMarkdown content={streamChunk} />)

    expect(screen.container.textContent).toBe('正在生成：**关键重点')
    expect(screen.container.querySelector('strong')).toBeNull()
  })
})
