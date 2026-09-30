import { useLayoutEffect, useRef, useState, type HTMLAttributes } from 'react'
import { createPortal } from 'react-dom'
import { useAssistantStore } from '@/stores/assistant-store'
import { AssistantPanel } from './panel'
import { cn } from '@/lib/utils'

export const DEFAULT_WIDTH = 400
export const DEFAULT_HEIGHT = 600
export const MIN_WIDTH = 360
export const MIN_HEIGHT = 420
const STORAGE_KEY = 'cairn:assistant:window_rect'

export type WindowRect = {
  width: number
  height: number
  x: number // 归一化水平坐标 [0, 1]
  y: number // 归一化垂直坐标 [0, 1]
}

type Viewport = { width: number; height: number; left: number; top: number }

function viewport(): Viewport {
  const view = window.visualViewport
  return {
    width: view?.width ?? window.innerWidth,
    height: view?.height ?? window.innerHeight,
    left: view?.offsetLeft ?? 0,
    top: view?.offsetTop ?? 0,
  }
}

function getSavedRect(): WindowRect {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<WindowRect>
      if (
        typeof parsed.width === 'number' &&
        typeof parsed.height === 'number' &&
        typeof parsed.x === 'number' &&
        typeof parsed.y === 'number'
      ) {
        return {
          width: Math.max(MIN_WIDTH, parsed.width),
          height: Math.max(MIN_HEIGHT, parsed.height),
          x: Math.max(0, Math.min(1, parsed.x)),
          y: Math.max(0, Math.min(1, parsed.y)),
        }
      }
    }
  } catch {
    // ignore
  }
  return {
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    x: 1,
    y: 1,
  }
}

function saveRect(rect: WindowRect) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rect))
  } catch {
    // ignore
  }
}

function frame(view: Viewport, rect: WindowRect) {
  const edge = view.width < 640 ? 12 : 24
  const availWidth = Math.max(0, view.width - edge * 2)
  const availHeight = Math.max(0, view.height - edge * 2)

  const width = Math.min(availWidth, Math.max(0, rect.width))
  const height = Math.min(availHeight, Math.max(0, rect.height))

  const rangeX = Math.max(0, availWidth - width)
  const rangeY = Math.max(0, availHeight - height)

  return {
    width,
    height,
    left: view.left + edge + rect.x * rangeX,
    top: view.top + edge + rect.y * rangeY,
    rangeX,
    rangeY,
    edge,
    availWidth,
    availHeight,
  }
}

function positionAt(left: number, top: number, view: Viewport, width: number, height: number): { x: number; y: number } {
  const edge = view.width < 640 ? 12 : 24
  const availWidth = Math.max(0, view.width - edge * 2)
  const availHeight = Math.max(0, view.height - edge * 2)
  const rangeX = Math.max(0, availWidth - width)
  const rangeY = Math.max(0, availHeight - height)

  return {
    x: rangeX > 0 ? Math.max(0, Math.min(1, (left - view.left - edge) / rangeX)) : 1,
    y: rangeY > 0 ? Math.max(0, Math.min(1, (top - view.top - edge) / rangeY)) : 1,
  }
}

type DragMove = {
  pointerId: number
  x: number
  y: number
  left: number
  top: number
  startRect: WindowRect
  handle: HTMLElement
}

type ResizeDirection = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

type ResizeDrag = {
  pointerId: number
  direction: ResizeDirection
  startX: number
  startY: number
  startLeft: number
  startTop: number
  startWidth: number
  startHeight: number
  handle: HTMLElement
}

export function AssistantFloatingWindow({
  open,
  onClose,
  onReturnFocus,
}: {
  open: boolean
  onClose: () => void
  onReturnFocus: () => void
}) {
  const [rect, setRect] = useState<WindowRect>(getSavedRect)
  const [view, setView] = useState(viewport)
  const [dragging, setDragging] = useState(false)
  const [resizing, setResizing] = useState(false)

  const moveDrag = useRef<DragMove | null>(null)
  const resizeDrag = useRef<ResizeDrag | null>(null)
  const windowRef = useRef<HTMLElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const returnFocusRef = useRef(onReturnFocus)

  const bounds = frame(view, rect)

  useLayoutEffect(() => {
    returnFocusRef.current = onReturnFocus
  }, [onReturnFocus])

  useLayoutEffect(() => {
    if (!open) return
    const update = () => setView(viewport())
    update()
    window.addEventListener('resize', update)
    window.visualViewport?.addEventListener('resize', update)
    window.visualViewport?.addEventListener('scroll', update)
    return () => {
      window.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('scroll', update)
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open) return
    openerRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    const assistantWindow = windowRef.current
    const input = assistantWindow?.querySelector<HTMLTextAreaElement>(
      'textarea:not(:disabled)'
    )
    ;(input ?? windowRef.current)?.focus({ preventScroll: true })
    return () => {
      moveDrag.current = null
      resizeDrag.current = null
      queueMicrotask(() => {
        if (assistantWindow?.isConnected || useAssistantStore.getState().open) return
        const opener = openerRef.current
        if (opener?.isConnected && opener !== document.body)
          opener.focus({ preventScroll: true })
        else returnFocusRef.current()
      })
    }
  }, [open])

  // --- 移动位置（拖动标题栏） ---
  function finishMove(cancelled: boolean) {
    const active = moveDrag.current
    if (!active) return
    moveDrag.current = null
    setDragging(false)
    if (cancelled) {
      setRect(active.startRect)
    } else {
      saveRect(rect)
    }
    if (active.handle.hasPointerCapture(active.pointerId))
      active.handle.releasePointerCapture(active.pointerId)
  }

  const handle: HTMLAttributes<HTMLElement> = {
    tabIndex: 0,
    role: 'group',
    'aria-label': '移动助手窗口',
    'aria-description':
      '按住标题栏拖动，方向键移动，双击或 Home 键回到右下角。',
    title: '按住拖动 · 双击回到右下角',
    onPointerDown: (event) => {
      if (
        event.button !== 0 ||
        moveDrag.current ||
        resizeDrag.current ||
        (event.target instanceof Element && event.target.closest('button'))
      )
        return
      event.preventDefault()
      event.currentTarget.focus({ preventScroll: true })
      const domRect = windowRef.current!.getBoundingClientRect()
      moveDrag.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        left: domRect.left,
        top: domRect.top,
        startRect: rect,
        handle: event.currentTarget,
      }
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    onPointerMove: (event) => {
      const active = moveDrag.current
      if (!active || active.pointerId !== event.pointerId) return
      const dx = event.clientX - active.x
      const dy = event.clientY - active.y
      if (!dragging && Math.hypot(dx, dy) < 4) return
      event.preventDefault()
      setDragging(true)
      const currentView = viewport()
      const nextPos = positionAt(
        active.left + dx,
        active.top + dy,
        currentView,
        bounds.width,
        bounds.height
      )
      setRect((prev) => {
        const next = { ...prev, x: nextPos.x, y: nextPos.y }
        saveRect(next)
        return next
      })
    },
    onPointerUp: (event) => {
      if (event.pointerId === moveDrag.current?.pointerId) finishMove(false)
    },
    onPointerCancel: (event) => {
      if (event.pointerId === moveDrag.current?.pointerId) finishMove(true)
    },
    onLostPointerCapture: (event) => {
      if (event.pointerId === moveDrag.current?.pointerId) finishMove(true)
    },
    onDoubleClick: (event) => {
      if (event.target instanceof Element && event.target.closest('button'))
        return
      setRect((prev) => {
        const next = { ...prev, x: 1, y: 1 }
        saveRect(next)
        return next
      })
    },
    onKeyDown: (event) => {
      if (event.target !== event.currentTarget) return
      if (event.key === 'Escape' && moveDrag.current) {
        event.preventDefault()
        event.stopPropagation()
        finishMove(true)
        return
      }
      const step = event.shiftKey ? 40 : 12
      const directions: Record<string, { x: number; y: number }> = {
        ArrowLeft: { x: -step, y: 0 },
        ArrowRight: { x: step, y: 0 },
        ArrowUp: { x: 0, y: -step },
        ArrowDown: { x: 0, y: step },
      }
      const direction = directions[event.key]
      if (direction) {
        event.preventDefault()
        const currentView = viewport()
        const nextPos = positionAt(
          bounds.left + direction.x,
          bounds.top + direction.y,
          currentView,
          bounds.width,
          bounds.height
        )
        setRect((prev) => {
          const next = { ...prev, x: nextPos.x, y: nextPos.y }
          saveRect(next)
          return next
        })
      } else if (event.key === 'Home') {
        event.preventDefault()
        setRect((prev) => {
          const next = { ...prev, x: 1, y: 1 }
          saveRect(next)
          return next
        })
      }
    },
  }

  // --- 8 向拉伸调整尺寸（Resize） ---
  function startResize(e: React.PointerEvent<HTMLElement>, direction: ResizeDirection) {
    if (e.button !== 0 || moveDrag.current || resizeDrag.current) return
    e.preventDefault()
    e.stopPropagation()

    const target = e.currentTarget
    target.setPointerCapture(e.pointerId)
    setResizing(true)

    const domRect = windowRef.current!.getBoundingClientRect()
    resizeDrag.current = {
      pointerId: e.pointerId,
      direction,
      startX: e.clientX,
      startY: e.clientY,
      startLeft: domRect.left,
      startTop: domRect.top,
      startWidth: domRect.width,
      startHeight: domRect.height,
      handle: target,
    }
  }

  function handleResizeMove(e: React.PointerEvent<HTMLElement>) {
    const active = resizeDrag.current
    if (!active || active.pointerId !== e.pointerId) return
    e.preventDefault()

    const dx = e.clientX - active.startX
    const dy = e.clientY - active.startY
    const currentView = viewport()
    const edge = currentView.width < 640 ? 12 : 24
    const availWidth = Math.max(0, currentView.width - edge * 2)
    const availHeight = Math.max(0, currentView.height - edge * 2)

    const effectiveMinWidth = Math.min(MIN_WIDTH, availWidth)
    const effectiveMinHeight = Math.min(MIN_HEIGHT, availHeight)

    let nextLeft = active.startLeft
    let nextTop = active.startTop
    let nextWidth = active.startWidth
    let nextHeight = active.startHeight

    const { direction } = active

    if (direction.includes('e')) {
      nextWidth = Math.max(effectiveMinWidth, Math.min(availWidth, active.startWidth + dx))
      if (nextLeft + nextWidth > currentView.left + currentView.width - edge) {
        nextWidth = currentView.left + currentView.width - edge - nextLeft
      }
    } else if (direction.includes('w')) {
      const rawWidth = active.startWidth - dx
      nextWidth = Math.max(effectiveMinWidth, Math.min(availWidth, rawWidth))
      nextLeft = active.startLeft + (active.startWidth - nextWidth)
      if (nextLeft < currentView.left + edge) {
        nextLeft = currentView.left + edge
        nextWidth = active.startLeft + active.startWidth - (currentView.left + edge)
      }
    }

    if (direction.includes('s')) {
      nextHeight = Math.max(effectiveMinHeight, Math.min(availHeight, active.startHeight + dy))
      if (nextTop + nextHeight > currentView.top + currentView.height - edge) {
        nextHeight = currentView.top + currentView.height - edge - nextTop
      }
    } else if (direction.includes('n')) {
      const rawHeight = active.startHeight - dy
      nextHeight = Math.max(effectiveMinHeight, Math.min(availHeight, rawHeight))
      nextTop = active.startTop + (active.startHeight - nextHeight)
      if (nextTop < currentView.top + edge) {
        nextTop = currentView.top + edge
        nextHeight = active.startTop + active.startHeight - (currentView.top + edge)
      }
    }

    const nextPos = positionAt(nextLeft, nextTop, currentView, nextWidth, nextHeight)
    const updated: WindowRect = {
      width: Math.round(nextWidth),
      height: Math.round(nextHeight),
      x: nextPos.x,
      y: nextPos.y,
    }
    setRect(updated)
    saveRect(updated)
  }

  function handleResizeEnd(e?: { pointerId: number }) {
    const active = resizeDrag.current
    if (!active || (e && active.pointerId !== e.pointerId)) return
    try {
      if (active.handle.hasPointerCapture(active.pointerId)) {
        active.handle.releasePointerCapture(active.pointerId)
      }
    } catch {
      // ignore
    }
    resizeDrag.current = null
    setResizing(false)
  }

  useLayoutEffect(() => {
    if (!resizing) return
    const onMove = (e: PointerEvent) => handleResizeMove(e as unknown as React.PointerEvent<HTMLElement>)
    const onUp = (e: PointerEvent) => handleResizeEnd(e)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [resizing])

  if (!open) return null
  return createPortal(
    <section
      ref={windowRef}
      role='dialog'
      aria-modal='false'
      aria-labelledby='assistant-window-title'
      aria-describedby='assistant-window-description'
      tabIndex={-1}
      data-assistant-window='true'
      data-dragging={dragging || undefined}
      data-resizing={resizing || undefined}
      className={cn(
        'fixed z-40 flex flex-col overflow-hidden rounded-xl border border-border-default bg-surface-card shadow-popover outline-none transition-[box-shadow] duration-150',
        (dragging || resizing) && 'select-none'
      )}
      style={{
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height,
      }}
      onKeyDown={(event) => {
        if (
          event.key === 'Escape' &&
          !event.defaultPrevented &&
          !event.nativeEvent.isComposing
        ) {
          event.stopPropagation()
          onClose()
        }
      }}
    >
      {/* 8 向 Resize 触手 */}
      {/* 顶部 */}
      <div
        role='separator'
        aria-orientation='horizontal'
        aria-label='拉伸调整助手高度（顶部）'
        data-resize-handle='n'
        className='absolute top-0 inset-x-2 z-20 h-2 cursor-ns-resize touch-none hover:bg-primary-500/20 active:bg-primary-500/30'
        onPointerDown={(e) => startResize(e, 'n')}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
        onPointerCancel={handleResizeEnd}
      />
      {/* 底部 */}
      <div
        role='separator'
        aria-orientation='horizontal'
        aria-label='拉伸调整助手高度（底部）'
        data-resize-handle='s'
        className='absolute bottom-0 inset-x-2 z-20 h-2 cursor-ns-resize touch-none hover:bg-primary-500/20 active:bg-primary-500/30'
        onPointerDown={(e) => startResize(e, 's')}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
        onPointerCancel={handleResizeEnd}
      />
      {/* 左侧 */}
      <div
        role='separator'
        aria-orientation='vertical'
        aria-label='拉伸调整助手宽度（左侧）'
        data-resize-handle='w'
        className='absolute inset-y-2 left-0 z-20 w-2 cursor-ew-resize touch-none hover:bg-primary-500/20 active:bg-primary-500/30'
        onPointerDown={(e) => startResize(e, 'w')}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
        onPointerCancel={handleResizeEnd}
      />
      {/* 右侧 */}
      <div
        role='separator'
        aria-orientation='vertical'
        aria-label='拉伸调整助手宽度（右侧）'
        data-resize-handle='e'
        className='absolute inset-y-2 right-0 z-20 w-2 cursor-ew-resize touch-none hover:bg-primary-500/20 active:bg-primary-500/30'
        onPointerDown={(e) => startResize(e, 'e')}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
        onPointerCancel={handleResizeEnd}
      />
      {/* 左上角 */}
      <div
        role='separator'
        aria-label='自由拉伸调整尺寸（左上角）'
        data-resize-handle='nw'
        className='absolute top-0 left-0 z-30 size-3.5 cursor-nwse-resize touch-none hover:bg-primary-500/20 active:bg-primary-500/30'
        onPointerDown={(e) => startResize(e, 'nw')}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
        onPointerCancel={handleResizeEnd}
      />
      {/* 右上角 */}
      <div
        role='separator'
        aria-label='自由拉伸调整尺寸（右上角）'
        data-resize-handle='ne'
        className='absolute top-0 right-0 z-30 size-3.5 cursor-nesw-resize touch-none hover:bg-primary-500/20 active:bg-primary-500/30'
        onPointerDown={(e) => startResize(e, 'ne')}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
        onPointerCancel={handleResizeEnd}
      />
      {/* 左下角 */}
      <div
        role='separator'
        aria-label='自由拉伸调整尺寸（左下角）'
        data-resize-handle='sw'
        className='absolute bottom-0 left-0 z-30 size-3.5 cursor-nesw-resize touch-none hover:bg-primary-500/20 active:bg-primary-500/30'
        onPointerDown={(e) => startResize(e, 'sw')}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
        onPointerCancel={handleResizeEnd}
      />
      {/* 右下角 */}
      <div
        role='separator'
        aria-label='自由拉伸调整尺寸（右下角）'
        data-resize-handle='se'
        className='absolute bottom-0 right-0 z-30 size-3.5 cursor-nwse-resize touch-none hover:bg-primary-500/20 active:bg-primary-500/30'
        onPointerDown={(e) => startResize(e, 'se')}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
        onPointerCancel={handleResizeEnd}
      />

      <AssistantPanel onClose={onClose} dragHandleProps={handle} />
    </section>,
    document.body
  )
}
