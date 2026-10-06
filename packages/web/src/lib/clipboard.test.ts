import { beforeEach, describe, expect, it, vi } from 'vitest'
import { copyToClipboard } from './clipboard'

describe('copyToClipboard', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns false for null or undefined input', async () => {
    expect(await copyToClipboard(null)).toBe(false)
    expect(await copyToClipboard(undefined)).toBe(false)
  })

  it('copies successfully via navigator.clipboard.writeText when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    })

    const result = await copyToClipboard('https://example.com/target')
    expect(result).toBe(true)
    expect(writeText).toHaveBeenCalledWith('https://example.com/target')
  })

  it('falls back to document.execCommand when navigator.clipboard is undefined (insecure context)', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
      writable: true,
    })

    const execCommand = vi.fn().mockReturnValue(true)
    Object.defineProperty(document, 'execCommand', {
      value: execCommand,
      configurable: true,
      writable: true,
    })

    const result = await copyToClipboard('https://insecure.internal/system')
    expect(result).toBe(true)
    expect(execCommand).toHaveBeenCalledWith('copy')
  })

  it('falls back to document.execCommand when navigator.clipboard.writeText rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('Permission denied'))
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    })

    const execCommand = vi.fn().mockReturnValue(true)
    Object.defineProperty(document, 'execCommand', {
      value: execCommand,
      configurable: true,
      writable: true,
    })

    const result = await copyToClipboard('https://example.com/fallback')
    expect(result).toBe(true)
    expect(writeText).toHaveBeenCalledWith('https://example.com/fallback')
    expect(execCommand).toHaveBeenCalledWith('copy')
  })

  it('returns false if both clipboard API and execCommand fail', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('NotAllowedError'))
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    })

    const execCommand = vi.fn().mockReturnValue(false)
    Object.defineProperty(document, 'execCommand', {
      value: execCommand,
      configurable: true,
      writable: true,
    })

    const result = await copyToClipboard('https://example.com/fail')
    expect(result).toBe(false)
  })
})
