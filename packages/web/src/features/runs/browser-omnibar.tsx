import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy, CornerDownLeft, Globe, Loader2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { normalizeNavigationUrl } from '@cairn/shared'

export interface BrowserOmnibarProps {
  url?: string | null
  caption?: string | null
  canNavigate?: boolean
  onNavigate?: (url: string) => Promise<void> | void
  navigating?: boolean
  className?: string
}

export function BrowserOmnibar({
  url,
  caption,
  canNavigate = false,
  onNavigate,
  navigating = false,
  className,
}: BrowserOmnibarProps) {
  const [editing, setEditing] = useState(false)
  const [inputValue, setInputValue] = useState('')
  const [copied, setCopied] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const copyTimerRef = useRef<number | null>(null)

  // 计算完整绝对 URL（用于复制与编辑）
  const fullUrl =
    url?.trim() ||
    (caption?.trim()
      ? caption.includes('://')
        ? caption.trim()
        : `http://${caption.trim()}`
      : '')

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current)
      }
    }
  }, [])

  // 进入编辑模式时自动全选聚焦
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  const handleCopy = useCallback(async () => {
    if (!fullUrl) return
    try {
      if (typeof navigator?.clipboard?.writeText === 'function') {
        await navigator.clipboard.writeText(fullUrl)
      }
      setCopied(true)
      toast.success('已复制页面完整地址')
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current)
      copyTimerRef.current = window.setTimeout(() => {
        setCopied(false)
        copyTimerRef.current = null
      }, 1500)
    } catch {
      toast.error('无法复制到剪贴板')
    }
  }, [fullUrl])

  const handleStartEditing = () => {
    if (!canNavigate || navigating) return
    setInputValue(fullUrl)
    setEditing(true)
  }

  const handleCancelEditing = () => {
    setEditing(false)
    setInputValue('')
  }

  const handleCommit = async () => {
    const trimmed = inputValue.trim()
    if (!trimmed) {
      handleCancelEditing()
      return
    }

    const normalized = normalizeNavigationUrl(trimmed)
    try {
      const parsed = new URL(normalized)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        toast.error('仅支持导航至 HTTP 或 HTTPS 地址')
        return
      }
    } catch {
      toast.error('请输入有效的网址')
      return
    }

    try {
      if (onNavigate) {
        const res = await onNavigate(normalized)
        if (res === false) {
          return
        }
      }
      setEditing(false)
    } catch {
      // 导航失败时保持编辑态，保留用户的输入，便于修正或重试
    }
  }

  return (
    <div
      className={cn(
        'group flex items-center gap-2 min-w-0 flex-1 rounded-md border border-border-default/60 bg-muted/30 hover:bg-muted/50 px-2.5 py-1 transition-[background-color,border-color]',
        editing && 'ring-1 ring-primary/40 border-primary/50 bg-background',
        className,
      )}
    >
      <Globe
        className={cn(
          'size-3.5 shrink-0 transition-colors',
          editing ? 'text-primary' : 'text-muted-foreground',
        )}
      />

      {editing ? (
        <div className='flex items-center gap-1.5 min-w-0 flex-1'>
          <input
            ref={inputRef}
            type='text'
            value={inputValue}
            disabled={navigating}
            aria-label='目标网址输入框'
            placeholder='输入目标网址后按回车前往 (如 https://example.com)'
            className='min-w-0 flex-1 bg-transparent px-1 font-mono text-small text-foreground outline-none border-0 placeholder:text-muted-foreground/60 select-all'
            onChange={(e) => setInputValue(e.target.value)}
            onBlur={(e) => {
              // 点到「前往 / 取消」按钮不算失焦退出
              if (e.relatedTarget && e.currentTarget.parentElement?.contains(e.relatedTarget as Node)) return
              if (!navigating) handleCancelEditing()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void handleCommit()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                handleCancelEditing()
              }
            }}
          />
          <Button
            size='sm'
            variant='ghost'
            disabled={navigating || !inputValue.trim()}
            className='h-6 px-1.5 text-caption font-medium hover:bg-primary/10 hover:text-primary shrink-0'
            title='前往目标网址 (Enter)'
            aria-label='前往目标网址'
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void handleCommit()}
          >
            {navigating ? (
              <Loader2 className='size-3 animate-spin' />
            ) : (
              <CornerDownLeft className='size-3' />
            )}
          </Button>
          <button
            type='button'
            disabled={navigating}
            aria-label='取消编辑'
            title='取消 (Esc)'
            className='shrink-0 rounded-xs p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer'
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleCancelEditing}
          >
            <X className='size-3' />
          </button>
        </div>
      ) : (
        <div className='flex items-center gap-1.5 min-w-0 flex-1 justify-between'>
          <span
            className={cn(
              'truncate font-mono select-all text-small min-w-0',
              canNavigate
                ? 'cursor-text text-foreground hover:text-primary transition-colors'
                : 'text-foreground',
            )}
            title={
              fullUrl
                ? `${fullUrl}${canNavigate ? ' (点击可编辑直接跳转)' : ''}`
                : caption ?? undefined
            }
            onClick={handleStartEditing}
          >
            {caption || '受管浏览器画面'}
          </span>

          <div className='flex items-center gap-1 shrink-0'>
            {fullUrl ? (
              <button
                type='button'
                aria-label={copied ? '已复制完整地址' : '复制完整地址'}
                title={copied ? '已复制完整地址' : '复制完整地址'}
                className={cn(
                  'shrink-0 rounded-xs p-1 transition-colors cursor-pointer',
                  copied
                    ? 'text-success hover:text-success'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
                onClick={(e) => {
                  e.stopPropagation()
                  void handleCopy()
                }}
              >
                {copied ? (
                  <Check className='size-3.5 transition-transform scale-110' />
                ) : (
                  <Copy className='size-3.5' />
                )}
              </button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}
