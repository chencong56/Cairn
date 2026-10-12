import type { ReactNode } from 'react'
import { StatusBadge } from '@/components/status-badge'

export function CatalogName({
  name,
  deleted,
  children,
}: {
  name: string
  deleted?: boolean
  children: ReactNode
}) {
  if (deleted) {
    return (
      <span className='flex min-w-0 flex-wrap items-center gap-1.5'>
        <span
          className='line-clamp-2 min-w-0 break-words [overflow-wrap:anywhere]'
          title={name}
        >
          {name}
        </span>
        <StatusBadge tone='neutral'>已删除</StatusBadge>
      </span>
    )
  }
  return children
}
