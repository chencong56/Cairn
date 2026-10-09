import { z } from 'zod'

/**
 * 可合并的耗时分位数草图（耗时分析按天汇总用）。
 *
 * 天与天之间的 P50 不能直接平均，所以每行存一份可相加的草图：
 * - 样本少时直接存原值（`v`：正值升序，`z`：0 的次数），分位数与逐条排序完全一致；
 *   等待类分项几乎全是 0，只记次数不占空间；
 * - 正值超过上限后换成对数分桶（`b`：桶号 → 次数，`z`：0 的次数）。相邻桶上下界之比为 γ，
 *   取桶的代表值 2γ^i / (γ + 1)，相对误差不超过 (γ − 1) / (γ + 1) ≈ 0.99%。
 * 合并 = 原值拼接或桶计数相加，与合并顺序无关。
 */
export const DURATION_SKETCH_GAMMA = 1.02
/** 落库的一行最多存这么多正值原值，超过就换成分桶。 */
export const DURATION_SKETCH_STORE_EXACT_LIMIT = 256
/** 内存里合并时最多保留这么多正值原值（短窗口、低频场景仍得到精确分位数）。 */
export const DURATION_SKETCH_MERGE_EXACT_LIMIT = 4096

export const durationSketchSchema = z.strictObject({
  /** 样本总数。 */
  n: z.number().int().nonnegative(),
  /** 正值原值（升序）；有它就没有 b。 */
  v: z.array(z.number()).optional(),
  /** 对数分桶：桶号 → 次数。 */
  b: z.record(z.string(), z.number().int().positive()).optional(),
  /** 0 及以下的次数（两种形态都单独计）。 */
  z: z.number().int().nonnegative().optional(),
})
export type DurationSketch = z.infer<typeof durationSketchSchema>

const LOG_GAMMA = Math.log(DURATION_SKETCH_GAMMA)

function bucketOf(value: number): number {
  return Math.ceil(Math.log(value) / LOG_GAMMA)
}

function representative(index: number): number {
  return (2 * DURATION_SKETCH_GAMMA ** index) / (DURATION_SKETCH_GAMMA + 1)
}

export function emptyDurationSketch(): DurationSketch {
  return { n: 0, v: [] }
}

function toBuckets(sketch: DurationSketch): { b: Map<number, number>; z: number } {
  const b = new Map<number, number>()
  const zeros = sketch.z ?? 0
  if (sketch.v) {
    for (const value of sketch.v) {
      const index = bucketOf(value)
      b.set(index, (b.get(index) ?? 0) + 1)
    }
  }
  for (const [key, count] of Object.entries(sketch.b ?? {})) {
    const index = Number(key)
    b.set(index, (b.get(index) ?? 0) + count)
  }
  return { b, z: zeros }
}

function fromBuckets(b: Map<number, number>, zeros: number): DurationSketch {
  const entries = [...b.entries()].sort((x, y) => x[0] - y[0])
  const n = zeros + entries.reduce((sum, [, count]) => sum + count, 0)
  return { n, b: Object.fromEntries(entries.map(([index, count]) => [String(index), count])), ...(zeros > 0 ? { z: zeros } : {}) }
}

/** 由一组耗时建草图；非有限值丢弃。 */
function exact(positives: number[], zeros: number): DurationSketch {
  return { n: positives.length + zeros, v: positives, ...(zeros > 0 ? { z: zeros } : {}) }
}

export function durationSketchOf(values: Iterable<number | null | undefined>, exactLimit = DURATION_SKETCH_STORE_EXACT_LIMIT): DurationSketch {
  const positives: number[] = []
  let zeros = 0
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    if (value <= 0) zeros += 1
    else positives.push(value)
  }
  positives.sort((a, b) => a - b)
  if (positives.length <= exactLimit) return exact(positives, zeros)
  const { b } = toBuckets({ n: positives.length, v: positives })
  return fromBuckets(b, zeros)
}

/** 合并多份草图：都还是原值且总数不超过上限时保持原值，否则统一换成分桶。 */
export function mergeDurationSketches(sketches: Iterable<DurationSketch>, exactLimit = DURATION_SKETCH_MERGE_EXACT_LIMIT): DurationSketch {
  const list = [...sketches].filter((sketch) => sketch.n > 0)
  if (list.length === 0) return emptyDurationSketch()
  // 只有一份时直接复用（草图不可变，调用方只读）
  if (list.length === 1 && (!list[0]!.v || list[0]!.v.length <= exactLimit)) return list[0]!
  const positives = list.reduce((sum, sketch) => sum + (sketch.v?.length ?? 0), 0)
  if (list.every((sketch) => sketch.v) && positives <= exactLimit) {
    return exact(
      list.flatMap((sketch) => sketch.v!).sort((a, b) => a - b),
      list.reduce((sum, sketch) => sum + (sketch.z ?? 0), 0),
    )
  }
  const b = new Map<number, number>()
  let zeros = 0
  for (const sketch of list) {
    const part = toBuckets(sketch)
    zeros += part.z
    for (const [index, count] of part.b) b.set(index, (b.get(index) ?? 0) + count)
  }
  return fromBuckets(b, zeros)
}

/** 落库前收紧：原值超过落库上限时换成分桶。 */
export function compactDurationSketch(sketch: DurationSketch, exactLimit = DURATION_SKETCH_STORE_EXACT_LIMIT): DurationSketch {
  if (!sketch.v || sketch.v.length <= exactLimit) return sketch
  const { b, z: zeros } = toBuckets(sketch)
  return fromBuckets(b, zeros)
}

/**
 * 第 p 百分位，口径与 durationPercentile 一致：取第 ceil(p% × n) 个（从 1 数）样本。
 * 原值形态精确；分桶形态取所在桶的代表值并四舍五入到整毫秒（误差 ≤ 1%）。
 */
export function durationSketchQuantile(sketch: DurationSketch, p: number): number | null {
  if (sketch.n === 0) return null
  const rank = Math.min(sketch.n, Math.max(1, Math.ceil((p / 100) * sketch.n)))
  let seen = sketch.z ?? 0
  if (rank <= seen) return 0
  if (sketch.v) return sketch.v[rank - seen - 1] ?? null
  const entries = Object.entries(sketch.b ?? {})
    .map(([key, count]) => [Number(key), count] as const)
    .sort((x, y) => x[0] - y[0])
  for (const [index, count] of entries) {
    seen += count
    if (rank <= seen) return Math.round(representative(index))
  }
  return Math.round(representative(entries.at(-1)![0]))
}

/**
 * 小整数（尝试次数、迭代次数）的精确计数：值 → 次数。可直接相加，分位口径同上。
 */
export type DurationCounts = Record<string, number>

export function durationCountsOf(values: Iterable<number>): DurationCounts {
  const counts: DurationCounts = {}
  for (const value of values) counts[String(value)] = (counts[String(value)] ?? 0) + 1
  return counts
}

export function mergeDurationCounts(list: Iterable<DurationCounts>): DurationCounts {
  const merged: DurationCounts = {}
  for (const counts of list) for (const [value, count] of Object.entries(counts)) merged[value] = (merged[value] ?? 0) + count
  return merged
}

export function durationCountsQuantile(counts: DurationCounts, p: number): number | null {
  const entries = Object.entries(counts)
    .map(([value, count]) => [Number(value), count] as const)
    .sort((a, b) => a[0] - b[0])
  const n = entries.reduce((sum, [, count]) => sum + count, 0)
  if (n === 0) return null
  const rank = Math.min(n, Math.max(1, Math.ceil((p / 100) * n)))
  let seen = 0
  for (const [value, count] of entries) {
    seen += count
    if (rank <= seen) return value
  }
  return entries.at(-1)![0]
}
