/**
 * Safely copy text to clipboard with automatic fallback.
 *
 * Supports:
 * 1. Modern Async Clipboard API (`navigator.clipboard.writeText`) when available in secure contexts.
 * 2. `document.execCommand('copy')` fallback for non-secure contexts (e.g. HTTP access via LAN IP address).
 */
export async function copyToClipboard(text: string | null | undefined): Promise<boolean> {
  if (text == null) {
    return false
  }

  // 1. Try modern Clipboard API if supported and available
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Permission denied or writeText failed, fall through to fallback
    }
  }

  // 2. Fallback using document.execCommand('copy')
  if (typeof document !== 'undefined' && document.body) {
    try {
      const previouslyFocusedElement = document.activeElement as HTMLElement | null
      const textarea = document.createElement('textarea')
      textarea.value = text

      // Prevent scrolling or visual glitches
      textarea.style.position = 'fixed'
      textarea.style.top = '0'
      textarea.style.left = '0'
      textarea.style.width = '2em'
      textarea.style.height = '2em'
      textarea.style.padding = '0'
      textarea.style.border = 'none'
      textarea.style.outline = 'none'
      textarea.style.boxShadow = 'none'
      textarea.style.background = 'transparent'
      textarea.style.opacity = '0'
      textarea.setAttribute('readonly', '')

      document.body.appendChild(textarea)

      const selection = document.getSelection()
      const originalRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null

      textarea.focus()
      textarea.select()
      textarea.setSelectionRange(0, text.length)

      const successful = document.execCommand('copy')

      if (selection) {
        selection.removeAllRanges()
        if (originalRange) {
          selection.addRange(originalRange)
        }
      }

      document.body.removeChild(textarea)
      previouslyFocusedElement?.focus?.()

      if (successful) {
        return true
      }
    } catch {
      // Fallback failed
    }
  }

  return false
}
