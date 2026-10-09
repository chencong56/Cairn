import { useEffect, useRef, useState } from 'react'

/** 文本是否被省略：只有真被截断时才给全文提示，避免每次悬停都弹出重复内容。 */
export function useIsTruncated<T extends HTMLElement>(text: string) {
  const ref = useRef<T>(null)
  const [truncated, setTruncated] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const check = () =>
      setTruncated(el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)
    check()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(check)
    observer.observe(el)
    return () => observer.disconnect()
  }, [text])
  return [ref, truncated] as const
}
