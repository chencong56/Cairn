import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export type SegmentOption<T extends string> = {
  value: T
  label: string
  /** 只显示图标时，label 作为可访问名称与 Tooltip。 */
  icon?: ReactNode
}

/** 分段控件：选中项是白色滑块，切换时平移；选中只改颜色不改字重，文字宽度不跳。 */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  iconOnly = false,
  className,
}: {
  value: T
  options: readonly SegmentOption<T>[]
  onChange: (value: T) => void
  ariaLabel: string
  iconOnly?: boolean
  className?: string
}) {
  const groupRef = useRef<HTMLDivElement>(null)
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null)

  useLayoutEffect(() => {
    const group = groupRef.current
    if (!group) return
    const measure = () => {
      const active = group.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')
      setThumb(active ? { left: active.offsetLeft, width: active.offsetWidth } : null)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(group)
    return () => observer.disconnect()
  }, [value, options])

  return (
    <div
      ref={groupRef}
      role='group'
      aria-label={ariaLabel}
      className={cn(
        'relative inline-flex shrink-0 rounded-md border border-border-divider bg-surface-subtle p-0.5',
        className,
      )}
    >
      {thumb ? (
        <span
          aria-hidden='true'
          className='absolute top-0.5 bottom-0.5 left-0 rounded-[7px] bg-card shadow-xs ring-1 ring-border-card transition-[translate,width] duration-150 ease-[var(--ease-standard)] motion-reduce:transition-none'
          style={{ width: thumb.width, translate: `${thumb.left}px 0` }}
        />
      ) : null}
      {options.map((option) => {
        const pressed = option.value === value
        const button = (
          <button
            key={option.value}
            type='button'
            aria-pressed={pressed}
            aria-label={iconOnly ? option.label : undefined}
            onClick={() => onChange(option.value)}
            className={cn(
              'relative inline-flex h-[26px] items-center justify-center gap-1.5 rounded-[7px] text-small font-medium outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring',
              iconOnly ? 'w-[30px] [&_svg]:size-4' : 'px-3',
              pressed ? 'text-text-primary' : 'text-muted-foreground hover:text-text-secondary',
            )}
          >
            {option.icon}
            {iconOnly ? null : option.label}
          </button>
        )
        if (!iconOnly) return button
        return (
          <Tooltip key={option.value}>
            <TooltipTrigger asChild>{button}</TooltipTrigger>
            <TooltipContent side='bottom'>{option.label}</TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}
