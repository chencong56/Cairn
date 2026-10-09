import type { Grid } from './grid.js'

const DELIMS = { comma: ',', tab: '\t', semicolon: ';' } as const

/** 引号外的分隔符计数（只看前 20 行），选每行计数最一致且不为 0 的那个。 */
export function detectDelimiter(text: string): string {
  const lines: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < text.length && lines.length < 20; i++) {
    const ch = text[i] as string
    if (ch === '"') quoted = !quoted
    if (!quoted && (ch === '\n' || ch === '\r')) {
      if (cur) lines.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur && lines.length < 20) lines.push(cur)
  let best = ','
  let bestScore = -1
  for (const d of Object.values(DELIMS)) {
    const counts = lines.map((line) => {
      let n = 0
      let q = false
      for (const ch of line) {
        if (ch === '"') q = !q
        else if (!q && ch === d) n++
      }
      return n
    })
    const nonZero = counts.filter((n) => n > 0)
    if (nonZero.length === 0) continue
    // 出现频次最高的计数占比越高、计数越大越可信
    const freq = new Map<number, number>()
    for (const n of nonZero) freq.set(n, (freq.get(n) ?? 0) + 1)
    const [, top] = [...freq.entries()].sort((a, b) => b[1] - a[1])[0] as [number, number]
    const score = (top / lines.length) * 1000 + nonZero.length
    if (score > bestScore) {
      bestScore = score
      best = d
    }
  }
  return best
}

/** RFC 4180：双引号包裹的字段里可以有分隔符、换行，"" 表示一个引号；CRLF / LF / CR 都算换行。 */
export function parseCsv(text: string, delimiter: 'auto' | keyof typeof DELIMS, maxRows: number): Grid {
  const d = delimiter === 'auto' ? detectDelimiter(text) : DELIMS[delimiter]
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = 0
  let truncated = false
  const pushRow = (): boolean => {
    row.push(field)
    field = ''
    rows.push(row)
    row = []
    if (rows.length >= maxRows) {
      truncated = true
      return false
    }
    return true
  }
  while (i < text.length) {
    const ch = text[i] as string
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }
    if (ch === '"' && field === '') {
      quoted = true
      i++
      continue
    }
    if (ch === d) {
      row.push(field)
      field = ''
      i++
      continue
    }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      i++
      if (!pushRow()) break
      continue
    }
    field += ch
    i++
  }
  if (!truncated && (field !== '' || row.length > 0)) {
    row.push(field)
    rows.push(row)
  }
  // 文件末尾多出的空行不算
  while (rows.length > 0 && (rows[rows.length - 1] as string[]).every((v) => v.trim() === '')) rows.pop()
  return { rows, merges: [], clues: [], ...(truncated && i < text.length ? { truncated: true } : {}) }
}
