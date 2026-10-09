import { describe, expect, it } from 'vitest'
import { durationPercentile } from '../duration-analysis.js'
import {
  DURATION_SKETCH_STORE_EXACT_LIMIT,
  compactDurationSketch,
  durationSketchOf,
  durationSketchQuantile,
  durationCountsOf,
  durationCountsQuantile,
  durationSketchSchema,
  mergeDurationCounts,
  mergeDurationSketches,
} from '../duration-sketch.js'

/** 可复现的伪随机耗时：长尾分布，覆盖几十毫秒到几分钟。 */
function samples(count: number, seed: number): number[] {
  let state = seed
  const next = () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
  return Array.from({ length: count }, () => Math.round(50 + 200_000 * next() ** 3))
}

describe('耗时分位数草图', () => {
  it('样本少时存原值，分位数与逐条排序完全一致', () => {
    const values = samples(200, 7)
    const sketch = durationSketchOf(values)
    expect(sketch.v).toHaveLength(200)
    const sorted = [...values].sort((a, b) => a - b)
    for (const p of [1, 25, 50, 90, 95, 99, 100]) {
      expect(durationSketchQuantile(sketch, p)).toBe(durationPercentile(sorted, p))
    }
  })

  it('超过上限换成分桶，P50 / P95 相对误差不超过 1%', () => {
    const values = samples(20_000, 11)
    const sketch = durationSketchOf(values)
    expect(sketch.v).toBeUndefined()
    expect(sketch.n).toBe(20_000)
    const sorted = [...values].sort((a, b) => a - b)
    for (const p of [5, 50, 75, 95, 99]) {
      const exact = durationPercentile(sorted, p)!
      const approx = durationSketchQuantile(sketch, p)!
      expect(Math.abs(approx - exact) / exact).toBeLessThanOrEqual(0.01)
    }
    expect(JSON.stringify(sketch).length).toBeLessThan(20_000)
  })

  it('合并与顺序无关；原值合并仍精确，超过内存上限转分桶', () => {
    const days = [samples(100, 1), samples(150, 2), samples(80, 3)]
    const sketches = days.map((values) => durationSketchOf(values))
    const merged = mergeDurationSketches(sketches)
    const reversed = mergeDurationSketches([...sketches].reverse())
    expect(merged).toEqual(reversed)
    const sorted = days.flat().sort((a, b) => a - b)
    expect(durationSketchQuantile(merged, 50)).toBe(durationPercentile(sorted, 50))

    const big = mergeDurationSketches(sketches, 200)
    expect(big.v).toBeUndefined()
    expect(big.n).toBe(330)
    const approx = durationSketchQuantile(big, 50)!
    expect(Math.abs(approx - durationPercentile(sorted, 50)!) / durationPercentile(sorted, 50)!).toBeLessThanOrEqual(0.01)
  })

  it('分桶与原值混合合并；0 毫秒单独计；空草图分位数为空', () => {
    const bucketed = durationSketchOf(samples(DURATION_SKETCH_STORE_EXACT_LIMIT + 10, 5))
    const zeros = durationSketchOf([0, 0, 0])
    const merged = mergeDurationSketches([bucketed, zeros])
    expect(merged.n).toBe(DURATION_SKETCH_STORE_EXACT_LIMIT + 13)
    expect(merged.z).toBe(3)
    expect(durationSketchQuantile(merged, 1)).toBe(0)
    expect(durationSketchQuantile(durationSketchOf([]), 50)).toBeNull()
    expect(durationSketchQuantile(mergeDurationSketches([]), 50)).toBeNull()
    expect(durationSketchOf([null, undefined, Number.NaN, 5]).n).toBe(1)
  })

  it('落库前收紧，序列化往返不变', () => {
    const wide = mergeDurationSketches([durationSketchOf(samples(200, 1)), durationSketchOf(samples(200, 2))])
    expect(wide.v).toHaveLength(400)
    const compact = compactDurationSketch(wide)
    expect(compact.v).toBeUndefined()
    expect(durationSketchSchema.parse(JSON.parse(JSON.stringify(compact)))).toEqual(compact)
  })

  it('原值形态的 0 只记次数，分位与逐条排序一致', () => {
    const values = [0, 0, 0, 0, 0, 0, 1200, 3400, 0, 800]
    const sketch = durationSketchOf(values)
    expect(sketch).toEqual({ n: 10, v: [800, 1200, 3400], z: 7 })
    const sorted = [...values].sort((a, b) => a - b)
    for (const p of [10, 50, 70, 80, 95, 100]) expect(durationSketchQuantile(sketch, p)).toBe(durationPercentile(sorted, p))
    expect(mergeDurationSketches([sketch, durationSketchOf([0, 500])])).toEqual({ n: 12, v: [500, 800, 1200, 3400], z: 8 })
  })

  it('小整数计数可相加，分位口径相同', () => {
    const merged = mergeDurationCounts([durationCountsOf([1, 1, 1, 2]), durationCountsOf([1, 3])])
    expect(merged).toEqual({ '1': 4, '2': 1, '3': 1 })
    expect(durationCountsQuantile(merged, 50)).toBe(durationPercentile([1, 1, 1, 1, 2, 3], 50))
    expect(durationCountsQuantile(merged, 95)).toBe(3)
    expect(durationCountsQuantile({}, 50)).toBeNull()
  })
})
