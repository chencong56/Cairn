import { describe, expect, it } from 'vitest'
import {
  AdaptivePrewarmController,
  buildLadderSteps,
} from './prewarm-adaptive.js'

describe('AdaptivePrewarmController (A18 / A21)', () => {
  it('buildLadderSteps 构造去重且合法的阶梯档位序列', () => {
    expect(buildLadderSteps(1, 5)).toEqual([1, 3, 5])
    expect(buildLadderSteps(1, 2)).toEqual([1, 2])
    expect(buildLadderSteps(2, 4)).toEqual([2, 3, 4])
    expect(buildLadderSteps(3, 3)).toEqual([3])
    expect(buildLadderSteps(0, 6)).toEqual([0, 1, 3, 5, 6])
  })

  it('初始状态为有效 minIdle，无调整原因', () => {
    const controller = new AdaptivePrewarmController({ minIdle: 1, maxIdle: 5 })
    expect(controller.getCurrentStep()).toBe(1)
    expect(controller.getLastReason()).toBeUndefined()
  })

  it('样本不足 (samples < 20) 维持当前档，不盲目扩容', () => {
    const controller = new AdaptivePrewarmController({
      minIdle: 1,
      maxIdle: 5,
      minSamples: 20,
      missRateThreshold: 0.1,
    })
    const now = 10_000_000
    // 只有 10 次冷启动未命中
    for (let i = 0; i < 10; i++) {
      controller.recordDemand('coldMiss', now - 1000 * i)
    }
    const res = controller.evaluate(now)
    expect(res.adjusted).toBe(false)
    expect(res.step).toBe(1)
  })

  it('有效样本达到 20 且冷启动未命中率达到 10% 时，上升一档 (1 -> 3)', () => {
    const controller = new AdaptivePrewarmController({
      minIdle: 1,
      maxIdle: 5,
      minSamples: 20,
      missRateThreshold: 0.1,
      cooldownMs: 300_000,
    })
    const now = 10_000_000
    // 18 次 warmHit, 2 次 coldMiss -> 2/20 = 10% miss rate
    for (let i = 0; i < 18; i++) {
      controller.recordDemand('warmHit', now - 1000 * i)
    }
    for (let i = 0; i < 2; i++) {
      controller.recordDemand('coldMiss', now - 1000 * i)
    }
    const res = controller.evaluate(now)
    expect(res.adjusted).toBe(true)
    expect(res.step).toBe(3)
    expect(res.reason).toContain('cold_miss_rate_10%_samples_20')
  })

  it('升档后冷却时间内 (5 分钟) 不得重复升档', () => {
    const controller = new AdaptivePrewarmController({
      minIdle: 1,
      maxIdle: 5,
      minSamples: 20,
      missRateThreshold: 0.1,
      cooldownMs: 300_000,
    })
    let now = 10_000_000
    for (let i = 0; i < 20; i++) {
      controller.recordDemand('coldMiss', now - 1000 * i)
    }
    expect(controller.evaluate(now).step).toBe(3)

    // 1 分钟后又有大量未命中
    now += 60_000
    for (let i = 0; i < 20; i++) {
      controller.recordDemand('coldMiss', now - 1000 * i)
    }
    const cooldownRes = controller.evaluate(now)
    expect(cooldownRes.adjusted).toBe(false)
    expect(cooldownRes.step).toBe(3)

    // 冷却满 5 分钟后允许再次升档至 5
    now += 250_000 // now is now + 310_000 > 300_000 cooldown
    for (let i = 0; i < 20; i++) {
      controller.recordDemand('coldMiss', now - 1000 * i)
    }
    const stepUpRes = controller.evaluate(now)
    expect(stepUpRes.adjusted).toBe(true)
    expect(stepUpRes.step).toBe(5)
  })

  it('达到最高档 (5) 后即使高未命中也不越界', () => {
    const controller = new AdaptivePrewarmController({
      minIdle: 1,
      maxIdle: 5,
      minSamples: 5,
      missRateThreshold: 0.1,
      cooldownMs: 1000,
    })
    let now = 10_000_000
    for (let i = 0; i < 10; i++) controller.recordDemand('coldMiss', now)
    controller.evaluate(now) // 1 -> 3
    now += 2000
    for (let i = 0; i < 10; i++) controller.recordDemand('coldMiss', now)
    controller.evaluate(now) // 3 -> 5
    expect(controller.getCurrentStep()).toBe(5)

    now += 2000
    for (let i = 0; i < 10; i++) controller.recordDemand('coldMiss', now)
    const topRes = controller.evaluate(now)
    expect(topRes.step).toBe(5)
    expect(topRes.adjusted).toBe(false)
  })

  it('连续 10 分钟无冷启动且冷却满足时降档 (3 -> 1)', () => {
    const controller = new AdaptivePrewarmController({
      minIdle: 1,
      maxIdle: 5,
      minSamples: 5,
      missRateThreshold: 0.1,
      downscaleWindowMs: 600_000,
      cooldownMs: 300_000,
    })
    let now = 10_000_000
    for (let i = 0; i < 5; i++) controller.recordDemand('coldMiss', now)
    controller.evaluate(now) // 1 -> 3
    expect(controller.getCurrentStep()).toBe(3)

    // 过去 10 分钟内只有 warmHit，无 coldMiss
    now += 650_000
    for (let i = 0; i < 5; i++) controller.recordDemand('warmHit', now - 1000 * i)
    const downRes = controller.evaluate(now)
    expect(downRes.adjusted).toBe(true)
    expect(downRes.step).toBe(1)
    expect(downRes.reason).toBe('zero_cold_misses_downscale')
  })

  it('流量完全停止（窗口内零需求事件）同样降档，备用不空烧 (A18)', () => {
    const controller = new AdaptivePrewarmController({
      minIdle: 1,
      maxIdle: 5,
      minSamples: 5,
      missRateThreshold: 0.1,
      downscaleWindowMs: 600_000,
      cooldownMs: 300_000,
    })
    const start = 10_000_000
    for (let i = 0; i < 5; i++) controller.recordDemand('coldMiss', start)
    controller.evaluate(start) // 1 -> 3
    expect(controller.getCurrentStep()).toBe(3)

    // 之后 11 分钟内没有任何需求事件（traffic stopped）
    const downRes = controller.evaluate(start + 660_000)
    expect(downRes.adjusted).toBe(true)
    expect(downRes.step).toBe(1)
    expect(downRes.reason).toBe('zero_cold_misses_downscale')
  })

  it('资源受限 (canUpscale = false) 时阻止升档', () => {
    const controller = new AdaptivePrewarmController({
      minIdle: 1,
      maxIdle: 5,
      minSamples: 5,
      missRateThreshold: 0.1,
      cooldownMs: 1000,
    })
    const now = 10_000_000
    for (let i = 0; i < 10; i++) controller.recordDemand('coldMiss', now)
    const res = controller.evaluate(now, false)
    expect(res.adjusted).toBe(false)
    expect(res.step).toBe(1)
  })

  it('平台配置动态调整上下限边界后，档位被约束在新的合法序列内', () => {
    const controller = new AdaptivePrewarmController({ minIdle: 1, maxIdle: 5 })
    expect(controller.getLadder()).toEqual([1, 3, 5])
    controller.updateBounds(2, 4)
    expect(controller.getLadder()).toEqual([2, 3, 4])
    expect(controller.getCurrentStep()).toBe(2)
  })
})
