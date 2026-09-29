import { apiErrorSchema, REQUEST_ID_HEADER } from '@cairn/shared'
import { ApiRequestError } from '@/lib/api-client'
import { useAuthStore } from '@/stores/auth-store'

export type SseFrame = {
  id?: string
  event: string
  data: string
  retry?: number
}

/** SSE 订阅握手失败的统一处理：401 且令牌未轮换时登出，并抛出带 requestId 的 ApiRequestError。 */
export async function assertSseResponseOk(res: Response, token: string | undefined): Promise<void> {
  if (res.ok) return
  if (res.status === 401 && token === useAuthStore.getState().auth.accessToken) {
    useAuthStore.getState().auth.reset()
  }
  const body: unknown = await res.json().catch(() => null)
  const parsed = apiErrorSchema.safeParse(body)
  throw new ApiRequestError(
    res.status,
    parsed.success
      ? parsed.data
      : {
          code: 'REQUEST_FAILED',
          message: `请求失败（HTTP ${res.status}）`,
          requestId: res.headers.get(REQUEST_ID_HEADER) ?? 'unknown',
        },
  )
}

export function newSseRequestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

/**
 * 按 MDN SSE 规则解析 UTF-8 分片：字段、多行 data、注释心跳、CRLF。
 */
export async function readSseStream(
  stream: ReadableStream<Uint8Array>,
  onFrame: (frame: SseFrame) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let event = ''
  let data: string[] = []
  let id: string | undefined
  let retry: number | undefined

  const dispatch = () => {
    if (data.length === 0 && !event) return
    onFrame({
      event: event || 'message',
      data: data.join('\n'),
      ...(id !== undefined ? { id } : {}),
      ...(retry !== undefined ? { retry } : {}),
    })
    event = ''
    data = []
    retry = undefined
  }

  const consumeLine = (line: string) => {
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (line === '') {
      dispatch()
      return
    }
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
    else if (field === 'id') id = value
    else if (field === 'retry') {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) retry = parsed
    }
  }

  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })
      buffer = buffer.replace(/\r\n/g, '\n')
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        consumeLine(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
      }
      if (done) {
        if (buffer.length > 0) consumeLine(buffer)
        dispatch()
        return
      }
    }
  } finally {
    reader.releaseLock()
  }
}
