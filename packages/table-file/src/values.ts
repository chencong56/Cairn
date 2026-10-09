/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 文字 → 字段值：数字、日期、是否的解析与列类型推断。
 *
 * 自包含、不依赖 DOM：页面读取（序列化进页面执行）与导出文件读取（在 Worker 的 Node 里直接调用）共用同一份，
 * 保证两边对“1,234.50”“1.2万”“2026年3月5日”这类写法的口径完全一致。
 */
export type ValueSpec = { key: string; valueType: 'text' | 'number' | 'boolean' | 'date'; scaleUnits?: boolean }
export type ValueField = {
  value: string | number | boolean | null
  rawText?: string
  decimalValue?: string
  status: 'ok' | 'missing' | 'error' | 'masked'
}

export function makeValueParsers() {
  const toHalf = (s: string): string =>
    s
      .replace(/[\uFF10-\uFF19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .replace(/\uFF0C/g, ',')
      .replace(/\uFF0E/g, '.')
      .replace(/\uFF05/g, '%')
      .replace(/[\uFF08]/g, '(')
      .replace(/[\uFF09]/g, ')')
      .replace(/[\uFF0D\u2212]/g, '-')
      .replace(/\uFF1A/g, ':')
  const PLACEHOLDERS = new Set(['', '-', '--', '—', '–', '/', 'n/a', 'null'])
  const shift = (digits: string, n: number): string => {
    const neg = digits.startsWith('-')
    const body = neg ? digits.slice(1) : digits
    const [intPart, fracPart = ''] = body.split('.')
    const padded = fracPart.padEnd(n, '0')
    const nextInt = (intPart + padded.slice(0, n)).replace(/^0+(?=\d)/, '')
    const nextFrac = padded.slice(n)
    const out = nextFrac ? `${nextInt}.${nextFrac}` : nextInt
    return neg ? `-${out}` : out
  }
  const parseNumber = (raw: string, scale: boolean): { ok: true; value: number; decimal: string } | { ok: false } => {
    let s = toHalf(raw).replace(/[¥￥$€£]/g, '').trim()
    let negative = false
    if (/^\(.*\)$/.test(s)) {
      negative = true
      s = s.slice(1, -1).trim()
    }
    if (s.startsWith('-')) {
      negative = true
      s = s.slice(1).trim()
    }
    const m = /^(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*([%‰]|[A-Za-z\u4e00-\u9fa5]{0,6})$/.exec(s)
    if (!m) return { ok: false }
    let decimal = `${(m[1] as string).replace(/,/g, '')}${m[2] ?? ''}`
    const unit = m[3] ?? ''
    if (scale) {
      if (unit.startsWith('万')) decimal = shift(decimal, 4)
      else if (unit.startsWith('亿')) decimal = shift(decimal, 8)
    }
    if (negative) decimal = `-${decimal}`
    const value = Number(decimal)
    if (!Number.isFinite(value)) return { ok: false }
    return { ok: true, value, decimal }
  }
  /** 日期规范化为不带时区的 YYYY-MM-DD / YYYY-MM-DD HH:mm:ss。 */
  const parseDate = (raw: string): string | null => {
    const s = toHalf(raw).trim()
    const compact = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2}))?$/.exec(s)
    const m = compact ?? /^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s)
    if (!m) return null
    const y = Number(m[1])
    const mo = Number(m[2])
    const d = Number(m[3])
    if (compact && (y < 1900 || y > 2100)) return null
    const probe = new Date(Date.UTC(y, mo - 1, d))
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null
    const p2 = (n: number): string => String(n).padStart(2, '0')
    const day = `${String(y).padStart(4, '0')}-${p2(mo)}-${p2(d)}`
    if (m[4] === undefined) return day
    const hh = Number(m[4])
    const mm = Number(m[5])
    const ss = Number(m[6] ?? 0)
    if (hh > 23 || mm > 59 || ss > 59) return null
    return `${day} ${p2(hh)}:${p2(mm)}:${p2(ss)}`
  }
  const TRUE_SET = new Set(['true', 'yes', 'y', '是', '真', '1', '√', '✓', '✔', '有', '启用', '开'])
  const FALSE_SET = new Set(['false', 'no', 'n', '否', '假', '0', '×', '✗', '✘', '无', '禁用', '关'])
  /** 一格文字 → 字段；digest 用于判断两次读取是否一致。 */
  const fieldFromText = (spec: ValueSpec, raw: string): { field: ValueField; digest: string } => {
    const lowered = raw.toLowerCase()
    if (spec.valueType === 'text') {
      if (!raw) return { field: { value: null, status: 'missing' }, digest: `${spec.key}:missing` }
      return { field: { value: raw, status: 'ok' }, digest: `${spec.key}:${raw}` }
    }
    if (PLACEHOLDERS.has(lowered)) {
      // 不写 rawText: undefined：文件读取在 Node 里直接持久化，没有页面序列化替它丢掉 undefined
      return { field: { value: null, ...(raw ? { rawText: raw } : {}), status: 'missing' }, digest: `${spec.key}:missing` }
    }
    if (spec.valueType === 'number') {
      const parsed = parseNumber(raw, Boolean(spec.scaleUnits))
      if (!parsed.ok) return { field: { value: null, rawText: raw, status: 'error' }, digest: `${spec.key}:error:${raw}` }
      return {
        field: { value: parsed.value, ...(raw !== String(parsed.value) ? { rawText: raw } : {}), decimalValue: parsed.decimal, status: 'ok' },
        digest: `${spec.key}:${parsed.decimal}`,
      }
    }
    if (spec.valueType === 'date') {
      const iso = parseDate(raw)
      if (iso === null) return { field: { value: null, rawText: raw, status: 'error' }, digest: `${spec.key}:error:${raw}` }
      return { field: { value: iso, ...(raw !== iso ? { rawText: raw } : {}), status: 'ok' }, digest: `${spec.key}:${iso}` }
    }
    const v = toHalf(lowered)
    if (TRUE_SET.has(v) || FALSE_SET.has(v)) {
      return { field: { value: TRUE_SET.has(v), ...(raw !== String(TRUE_SET.has(v)) ? { rawText: raw } : {}), status: 'ok' }, digest: `${spec.key}:${TRUE_SET.has(v)}` }
    }
    return { field: { value: null, rawText: raw, status: 'error' }, digest: `${spec.key}:error:${raw}` }
  }
  const DATE_LIKE = /^\d{4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}/
  /** 按样本文字推断列类型：全是是 / 否 → 是否；全像日期 → 日期；去掉千分位、货币与单位后全是数字 → 数字。 */
  const inferType = (texts: string[]): { valueType: ValueSpec['valueType']; numericKind?: 'integer' | 'decimal' } => {
    if (texts.length === 0) return { valueType: 'text' }
    const compact = texts.map((tx) => tx.replace(/[,，\s¥￥$€£%元万亿个]/g, ''))
    if (texts.every((tx) => /^(true|false|yes|no|是|否|真|假)$/i.test(tx))) return { valueType: 'boolean' }
    if (texts.every((tx) => DATE_LIKE.test(tx)) || texts.every((tx) => /^\d{8}(\d{6})?$/.test(toHalf(tx).trim()) && parseDate(tx) !== null)) return { valueType: 'date' }
    if (compact.every((x) => /^[-(]?\d+(\.\d+)?\)?$/.test(x)) && texts.some((tx) => /\d/.test(tx))) {
      return { valueType: 'number', numericKind: compact.every((x) => /^[-(]?\d+\)?$/.test(x)) ? 'integer' : 'decimal' }
    }
    return { valueType: 'text' }
  }
  return { toHalf, PLACEHOLDERS, parseNumber, parseDate, TRUE_SET, FALSE_SET, fieldFromText, inferType }
}

export type ValueParsers = ReturnType<typeof makeValueParsers>
