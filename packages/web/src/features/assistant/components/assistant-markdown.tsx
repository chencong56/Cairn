import React, { useMemo } from 'react'
import { cn } from '@/lib/utils'

export interface AssistantMarkdownProps {
  content: string
  className?: string
}

type InlineToken =
  | { type: 'text'; value: string }
  | { type: 'bold'; value: string }
  | { type: 'italic'; value: string }
  | { type: 'code'; value: string }

function parseInlineTokens(text: string): InlineToken[] {
  const tokens: InlineToken[] = []
  // 正则匹配: 内联代码 `...`、粗体 **...**、斜体 *...*
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: 'text', value: text.slice(lastIndex, match.index) })
    }
    const raw = match[0]
    if (raw.startsWith('`') && raw.endsWith('`')) {
      tokens.push({ type: 'code', value: raw.slice(1, -1) })
    } else if (raw.startsWith('**') && raw.endsWith('**')) {
      tokens.push({ type: 'bold', value: raw.slice(2, -2) })
    } else if (raw.startsWith('*') && raw.endsWith('*')) {
      tokens.push({ type: 'italic', value: raw.slice(1, -1) })
    }
    lastIndex = pattern.lastIndex
  }

  if (lastIndex < text.length) {
    tokens.push({ type: 'text', value: text.slice(lastIndex) })
  }

  return tokens
}

function renderInline(text: string): React.ReactNode {
  const tokens = parseInlineTokens(text)
  return tokens.map((token, i) => {
    switch (token.type) {
      case 'code':
        return (
          <code
            key={i}
            className='mx-0.5 rounded bg-surface-subtle px-1.5 py-0.5 font-mono text-caption text-text-primary border border-border-default/40'
          >
            {token.value}
          </code>
        )
      case 'bold':
        return (
          <strong key={i} className='font-semibold text-text-primary'>
            {token.value}
          </strong>
        )
      case 'italic':
        return (
          <em key={i} className='italic text-text-secondary'>
            {token.value}
          </em>
        )
      default:
        return <React.Fragment key={i}>{token.value}</React.Fragment>
    }
  })
}

type Block =
  | { type: 'ol'; items: string[] }
  | { type: 'ul'; items: string[] }
  | { type: 'blockquote'; text: string }
  | { type: 'paragraph'; text: string }

function parseBlocks(markdown: string): Block[] {
  // 先统一换行符，并按多行空白拆分大块
  const rawParagraphs = markdown
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)

  const blocks: Block[] = []

  for (const para of rawParagraphs) {
    const lines = para.split('\n').map((l) => l.trim()).filter(Boolean)
    if (lines.length === 0) continue

    let i = 0
    while (i < lines.length) {
      const line = lines[i]

      // 有序列表
      if (/^\d+[.、]\s+/.test(line)) {
        const items: string[] = []
        while (i < lines.length && /^\d+[.、]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\d+[.、]\s+/, ''))
          i++
        }
        blocks.push({ type: 'ol', items })
        continue
      }

      // 无序列表
      if (/^[-*•]\s+/.test(line)) {
        const items: string[] = []
        while (i < lines.length && /^[-*•]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^[-*•]\s+/, ''))
          i++
        }
        blocks.push({ type: 'ul', items })
        continue
      }

      // 引用块
      if (/^>\s*/.test(line)) {
        const quoteLines: string[] = []
        while (i < lines.length && /^>\s*/.test(lines[i])) {
          quoteLines.push(lines[i].replace(/^>\s*/, ''))
          i++
        }
        blocks.push({ type: 'blockquote', text: quoteLines.join(' ') })
        continue
      }

      // 普通段落行（连续非列表非引用行合并为一个普通段落）
      const pLines: string[] = []
      while (
        i < lines.length &&
        !/^\d+[.、]\s+/.test(lines[i]) &&
        !/^[-*•]\s+/.test(lines[i]) &&
        !/^>\s*/.test(lines[i])
      ) {
        pLines.push(lines[i])
        i++
      }
      if (pLines.length > 0) {
        blocks.push({ type: 'paragraph', text: pLines.join('\n') })
      }
    }
  }

  return blocks
}

/**
 * 满足 Apple Design Typography 与 Cairn 设计 Token 的轻量级安全 Markdown 文本渲染器
 * 1. 采用原生 React 节点组装，不使用 dangerouslySetInnerHTML，天然免疫 XSS 注入；
 * 2. 具备流式未闭合语法自愈能力（未匹配的星号/反引号直接作为文本回退）；
 * 3. 严格契合 Design Token，带来舒适的行间距与段落呼吸感。
 */
export function AssistantMarkdown({ content, className }: AssistantMarkdownProps) {
  const blocks = useMemo(() => parseBlocks(content || ''), [content])

  if (!content) return null

  return (
    <div
      data-testid='assistant-markdown'
      className={cn('text-body text-text-primary [overflow-wrap:anywhere]', className)}
    >
      {blocks.map((block, idx) => {
        switch (block.type) {
          case 'ol':
            return (
              <ol
                key={idx}
                className='list-decimal list-outside ml-4 space-y-1 mb-2.5 text-small text-text-secondary leading-relaxed'
              >
                {block.items.map((item, itemIdx) => (
                  <li key={itemIdx}>{renderInline(item)}</li>
                ))}
              </ol>
            )
          case 'ul':
            return (
              <ul
                key={idx}
                className='list-disc list-outside ml-4 space-y-1 mb-2.5 text-small text-text-secondary leading-relaxed'
              >
                {block.items.map((item, itemIdx) => (
                  <li key={itemIdx}>{renderInline(item)}</li>
                ))}
              </ul>
            )
          case 'blockquote':
            return (
              <blockquote
                key={idx}
                className='border-l-2 border-primary-500/50 pl-3 my-2 text-small text-text-secondary italic leading-relaxed'
              >
                {renderInline(block.text)}
              </blockquote>
            )
          case 'paragraph':
          default:
            return (
              <p
                key={idx}
                className='mb-2.5 last:mb-0 text-small text-text-primary leading-relaxed whitespace-pre-line'
              >
                {renderInline(block.text)}
              </p>
            )
        }
      })}
    </div>
  )
}
