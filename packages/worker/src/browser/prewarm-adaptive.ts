/**
 * 自适应浏览器预热控制器 (P6 Adaptive Prewarm Controller)
 *
 * 依据真实宿主需求做阶梯调档，首版采用可解释规则，按 Worker 实例独立统计。
 */

export function buildLadderSteps(minIdle: number, maxIdle: number): number[] {
  const clampedMin = Math.max(0, Math.min(minIdle, maxIdle))
  const clampedMax = Math.max(clampedMin, maxIdle)
  const defaultMilestones = [1, 3, 5]
  const set = new Set<number>([clampedMin, clampedMax])
  for (const m of defaultMilestones) {
    if (m >= clampedMin && m <= clampedMax) {
      set.add(m)
    }
  }
  return [...set].sort((a, b) => a - b)
}

export type DemandEventType = 'warmHit' | 'coldMiss'

export type DemandEvent = {
  timestamp: number
  type: DemandEventType
}

export type AdaptivePrewarmOptions = {
  minIdle?: number
  maxIdle?: number
  sampleWindowMs?: number
  minSamples?: number
  missRateThreshold?: number
  downscaleWindowMs?: number
  cooldownMs?: number
}

export class AdaptivePrewarmController {
  private ladder: number[]
  private stepIndex: number
  private lastAdjustmentTime = 0
  private demands: DemandEvent[] = []
  private lastAdjustmentReason?: string

  readonly sampleWindowMs: number
  readonly minSamples: number
  readonly missRateThreshold: number
  readonly downscaleWindowMs: number
  readonly cooldownMs: number

  constructor(options?: AdaptivePrewarmOptions) {
    const min = options?.minIdle ?? 1
    const max = options?.maxIdle ?? 5
    this.ladder = buildLadderSteps(min, max)
    this.stepIndex = 0
    this.sampleWindowMs = options?.sampleWindowMs ?? 5 * 60_000
    this.minSamples = options?.minSamples ?? 20
    this.missRateThreshold = options?.missRateThreshold ?? 0.10
    this.downscaleWindowMs = options?.downscaleWindowMs ?? 10 * 60_000
    this.cooldownMs = options?.cooldownMs ?? 5 * 60_000
  }

  getLadder(): readonly number[] {
    return this.ladder
  }

  getCurrentStep(): number {
    return this.ladder[this.stepIndex] ?? 1
  }

  getLastReason(): string | undefined {
    return this.lastAdjustmentReason
  }

  updateBounds(minIdle: number, maxIdle: number): void {
    const currentVal = this.getCurrentStep()
    this.ladder = buildLadderSteps(minIdle, maxIdle)
    if (currentVal <= this.ladder[0]!) {
      this.stepIndex = 0
    } else if (currentVal >= this.ladder[this.ladder.length - 1]!) {
      this.stepIndex = this.ladder.length - 1
    } else {
      let bestIdx = 0
      for (let i = 0; i < this.ladder.length; i++) {
        if (this.ladder[i]! <= currentVal) bestIdx = i
      }
      this.stepIndex = bestIdx
    }
  }

  recordDemand(type: DemandEventType, timestamp = Date.now()): void {
    this.demands.push({ timestamp, type })
    const cutoff = timestamp - 15 * 60_000
    while (this.demands.length > 0 && this.demands[0]!.timestamp < cutoff) {
      this.demands.shift()
    }
  }

  evaluate(now = Date.now(), canUpscale = true): { step: number; reason?: string; adjusted: boolean } {
    // 升档判定：最近 sampleWindowMs 内有至少 minSamples 个需求且 missRate >= missRateThreshold
    const sampleCutoff = now - this.sampleWindowMs
    const recentDemands = this.demands.filter((d) => d.timestamp >= sampleCutoff)
    const coldMisses = recentDemands.filter((d) => d.type === 'coldMiss').length
    const totalDemands = recentDemands.length

    if (totalDemands >= this.minSamples && totalDemands > 0) {
      const missRate = coldMisses / totalDemands
      if (missRate >= this.missRateThreshold) {
        if (now - this.lastAdjustmentTime >= this.cooldownMs) {
          if (this.stepIndex < this.ladder.length - 1 && canUpscale) {
            this.stepIndex += 1
            this.lastAdjustmentTime = now
            this.lastAdjustmentReason = `cold_miss_rate_${(missRate * 100).toFixed(0)}%_samples_${totalDemands}`
            return { step: this.getCurrentStep(), reason: this.lastAdjustmentReason, adjusted: true }
          }
        }
      }
    }

    // 降档判定：最近 downscaleWindowMs 内无冷启动未命中且多余备用持续空闲时下降一档。
    // 零流量（窗口内连需求事件都没有）同样满足「无冷启动未命中」——A18 流量停止口径。
    const downscaleCutoff = now - this.downscaleWindowMs
    const downscaleDemands = this.demands.filter((d) => d.timestamp >= downscaleCutoff)
    const downscaleMisses = downscaleDemands.filter((d) => d.type === 'coldMiss').length

    if (downscaleMisses === 0) {
      if (now - this.lastAdjustmentTime >= this.cooldownMs) {
        if (this.stepIndex > 0) {
          this.stepIndex -= 1
          this.lastAdjustmentTime = now
          this.lastAdjustmentReason = 'zero_cold_misses_downscale'
          return { step: this.getCurrentStep(), reason: this.lastAdjustmentReason, adjusted: true }
        }
      }
    }

    return { step: this.getCurrentStep(), reason: this.lastAdjustmentReason, adjusted: false }
  }
}
