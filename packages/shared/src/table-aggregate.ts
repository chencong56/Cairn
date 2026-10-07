/**
 * 表格列聚合用的精确十进制运算：整数 + 小数位数（BigInt 缩放），不经过浮点。
 * 输入是读取阶段保留的 `decimalValue` 字符串（形如 `-1234.50`）。
 */
import { roundDecimalString } from './numeric-policy.js'

export type ScaledDecimal = { int: bigint; scale: number }

const PLAIN_DECIMAL = /^-?\d+(\.\d+)?$/

export function parseScaledDecimal(text: string): ScaledDecimal | null {
  const s = text.trim()
  if (!PLAIN_DECIMAL.test(s)) return null
  const negative = s.startsWith('-')
  const body = negative ? s.slice(1) : s
  const [intPart = '0', frac = ''] = body.split('.')
  const int = BigInt(intPart + frac)
  return { int: negative ? -int : int, scale: frac.length }
}

function rescale(value: ScaledDecimal, scale: number): bigint {
  return value.int * 10n ** BigInt(scale - value.scale)
}

export function scaledToString(value: ScaledDecimal): string {
  const negative = value.int < 0n
  const digits = (negative ? -value.int : value.int).toString().padStart(value.scale + 1, '0')
  const intPart = value.scale === 0 ? digits : digits.slice(0, digits.length - value.scale)
  const frac = value.scale === 0 ? '' : digits.slice(digits.length - value.scale)
  return `${negative && (BigInt(intPart) !== 0n || /[1-9]/.test(frac)) ? '-' : ''}${intPart}${frac ? `.${frac}` : ''}`
}

export function compareScaled(a: ScaledDecimal, b: ScaledDecimal): -1 | 0 | 1 {
  const scale = Math.max(a.scale, b.scale)
  const x = rescale(a, scale)
  const y = rescale(b, scale)
  return x === y ? 0 : x < y ? -1 : 1
}

export function sumScaled(values: ScaledDecimal[]): ScaledDecimal {
  const scale = values.reduce((m, v) => Math.max(m, v.scale), 0)
  return { int: values.reduce((acc, v) => acc + rescale(v, scale), 0n), scale }
}

export function extremumScaled(values: ScaledDecimal[], which: 'min' | 'max'): ScaledDecimal | null {
  let best: ScaledDecimal | null = null
  for (const v of values) {
    if (best === null) best = v
    else {
      const cmp = compareScaled(v, best)
      if ((which === 'min' && cmp < 0) || (which === 'max' && cmp > 0)) best = v
    }
  }
  return best
}

/** 平均值：多保留 6 位小数，按中点远离零舍入。 */
export function averageScaled(values: ScaledDecimal[]): ScaledDecimal | null {
  if (values.length === 0) return null
  const sum = sumScaled(values)
  const extra = 6
  const scale = sum.scale + extra
  const scaled = sum.int * 10n ** BigInt(extra)
  const count = BigInt(values.length)
  const twice = scaled * 2n
  const rounded = (twice >= 0n ? twice + count : twice - count) / (count * 2n)
  return { int: rounded, scale }
}

/** 把 value 舍入到 scale 位小数（half_away_from_zero）。 */
export function roundScaled(value: ScaledDecimal, scale: number): ScaledDecimal {
  const rounded = roundDecimalString(scaledToString(value), scale)
  return parseScaledDecimal(rounded) ?? value
}

/** 数字（含 decimalValue）转精确十进制；number 走 toString，避免科学计数法。 */
export function toScaledDecimal(decimalValue: string | undefined, value: number): ScaledDecimal | null {
  if (decimalValue !== undefined) return parseScaledDecimal(decimalValue)
  if (!Number.isFinite(value)) return null
  return parseScaledDecimal(Number.isInteger(value) ? String(value) : value.toFixed(12).replace(/0+$/, ''))
}
