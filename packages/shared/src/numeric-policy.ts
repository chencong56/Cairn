import { z } from 'zod'

export const toleranceComparisonSchema = z
  .strictObject({
    mode: z.literal('tolerance'),
    numberDelta: z.number().finite().nonnegative().optional(),
    percentDelta: z.number().finite().nonnegative().optional(),
  })
  .refine(
    (value) => value.numberDelta !== undefined || value.percentDelta !== undefined,
    { message: '至少声明一种容差，不能提交空容差' },
  )
export type ToleranceComparison = z.infer<typeof toleranceComparisonSchema>

export const fixedComparisonSchema = z.strictObject({
  mode: z.literal('fixed'),
  scale: z.number().int().min(0).max(8),
  rounding: z.literal('half_away_from_zero'),
})
export type FixedComparison = z.infer<typeof fixedComparisonSchema>

export const numericComparisonPolicySchema = z.discriminatedUnion('mode', [
  toleranceComparisonSchema,
  fixedComparisonSchema,
])
export type NumericComparisonPolicy = z.infer<typeof numericComparisonPolicySchema>

/**
 * 中点远离零（half_away_from_zero）高精度十进制字符串舍入。
 * 避免 JavaScript 浮点数如 1.005 * 100 = 100.49999999999999 导致的舍入错误。
 */
export function roundDecimalString(valStr: string, scale: number): string {
  const trimmed = valStr.trim()
  if (!trimmed || trimmed === 'NaN' || trimmed === 'Infinity' || trimmed === '-Infinity') {
    return trimmed
  }
  const isNegative = trimmed.startsWith('-')
  const absStr = isNegative ? trimmed.slice(1) : (trimmed.startsWith('+') ? trimmed.slice(1) : trimmed)

  // 处理科学计数法（例如 1e-4）
  if (absStr.includes('e') || absStr.includes('E')) {
    const num = Number(trimmed)
    if (!Number.isFinite(num)) return trimmed
    return roundDecimalString(num.toFixed(Math.max(scale + 4, 12)), scale)
  }

  const [intPart = '0', fracPart = ''] = absStr.split('.')
  if (scale === 0) {
    const firstFracDigit = fracPart.length > 0 ? Number(fracPart[0]) : 0
    let intVal = BigInt(intPart || '0')
    if (firstFracDigit >= 5) {
      intVal += 1n
    }
    return (isNegative && intVal !== 0n ? '-' : '') + intVal.toString()
  }

  if (fracPart.length <= scale) {
    const paddedFrac = fracPart.padEnd(scale, '0')
    const finalInt = intPart || '0'
    const isZero = finalInt === '0' && /^0+$/.test(paddedFrac)
    return (isNegative && !isZero ? '-' : '') + `${finalInt}.${paddedFrac}`
  }

  const neededFrac = fracPart.slice(0, scale)
  const nextDigit = Number(fracPart[scale])

  if (nextDigit >= 5) {
    const combinedStr = (intPart || '0') + neededFrac
    const incremented = (BigInt(combinedStr) + 1n).toString()
    const padLen = (intPart || '0').length + scale
    const normalized = incremented.padStart(padLen, '0')
    const newInt = normalized.slice(0, normalized.length - scale) || '0'
    const newFrac = normalized.slice(normalized.length - scale)
    const isZero = newInt === '0' && /^0+$/.test(newFrac)
    return (isNegative && !isZero ? '-' : '') + `${newInt}.${newFrac}`
  } else {
    const finalInt = intPart || '0'
    const isZero = finalInt === '0' && /^0+$/.test(neededFrac)
    return (isNegative && !isZero ? '-' : '') + `${finalInt}.${neededFrac}`
  }
}

export function roundHalfAwayFromZero(val: number | string, scale: number): number {
  const str = typeof val === 'number' ? val.toString() : val
  const rounded = roundDecimalString(str, scale)
  return Number(rounded)
}

/** 定点路径的系数位数守卫：有效数字或 scale 超过 64 位时无法可靠比较。 */
function fixedOverflow(valStr: string, scale: number): boolean {
  if (scale > 64) return true
  const digits = valStr.replace(/[^0-9]/g, '').replace(/^0+/, '')
  return digits.length > 64
}

/**
 * 依据 NumericComparisonPolicy 比较两侧数字或十进制值。
 */
export function compareWithNumericPolicy(
  actual: unknown,
  expected: unknown,
  op: string,
  policy?: NumericComparisonPolicy,
): { matched: boolean; error?: string } {
  const actualNum = typeof actual === 'number' ? actual : Number(actual)
  const expectedNum = typeof expected === 'number' ? expected : Number(expected)

  if (!Number.isFinite(actualNum) || !Number.isFinite(expectedNum)) {
    return { matched: false, error: '比较值为非有限数' }
  }

  if (!policy) {
    switch (op) {
      case 'eq':
        return { matched: actualNum === expectedNum }
      case 'neq':
      case 'ne':
        return { matched: actualNum !== expectedNum }
      case 'gt':
        return { matched: actualNum > expectedNum }
      case 'gte':
        return { matched: actualNum >= expectedNum }
      case 'lt':
        return { matched: actualNum < expectedNum }
      case 'lte':
        return { matched: actualNum <= expectedNum }
      default:
        return { matched: false, error: `不支持的操作符: ${op}` }
    }
  }

  if (policy.mode === 'tolerance') {
    if (op !== 'eq' && op !== 'neq' && op !== 'ne') {
      return { matched: false, error: '容差策略仅适用于相等比较 (eq/neq)' }
    }
    const numberDelta = policy.numberDelta ?? 0
    const percentDelta = policy.percentDelta !== undefined
      ? Math.abs(expectedNum) * (policy.percentDelta / 100)
      : 0
    const effectiveTolerance = Math.max(numberDelta, percentDelta)
    const diff = Math.abs(actualNum - expectedNum)
    const equal = diff <= effectiveTolerance

    return {
      matched: op === 'eq' ? equal : !equal,
    }
  }

  if (policy.mode === 'fixed') {
    const scale = policy.scale
    const actStr = typeof actual === 'string' ? actual : actualNum.toString()
    const expStr = typeof expected === 'string' ? expected : expectedNum.toString()

    if (fixedOverflow(actStr, scale) || fixedOverflow(expStr, scale)) {
      return { matched: false, error: 'TABLE_NUMERIC_OVERFLOW：数值系数有效位数或 scale 超过 64 位上限' }
    }

    const actRounded = roundHalfAwayFromZero(actStr, scale)
    const expRounded = roundHalfAwayFromZero(expStr, scale)

    switch (op) {
      case 'eq':
        return { matched: actRounded === expRounded }
      case 'neq':
      case 'ne':
        return { matched: actRounded !== expRounded }
      case 'gt':
        return { matched: actRounded > expRounded }
      case 'gte':
        return { matched: actRounded >= expRounded }
      case 'lt':
        return { matched: actRounded < expRounded }
      case 'lte':
        return { matched: actRounded <= expRounded }
    }
  }

  return { matched: false, error: '未知的精度比较策略' }
}
