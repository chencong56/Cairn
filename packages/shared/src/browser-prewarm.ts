import { z } from 'zod'
import { browserPrewarmModeSchema } from './platform-config.js'

/**
 * 浏览器预热池的节点级观测契约（SSOT）。
 * Worker HostPool 产出，经 node-health 内部端点透出，API/Web 消费；
 * 属于观测结果，不作为平台配置保存。
 */
export const prewarmStatusSchema = z.object({
  mode: browserPrewarmModeSchema,
  policyRevision: z.number().int().nonnegative(),
  configuredTarget: z.number().int().nonnegative(),
  effectiveTarget: z.number().int().nonnegative(),
  actualIdleCount: z.number().int().nonnegative(),
  startingCount: z.number().int().nonnegative(),
  activeCount: z.number().int().nonnegative(),
  drainingCount: z.number().int().nonnegative(),
  contextsCount: z.number().int().nonnegative(),
  warmHits: z.number().int().nonnegative(),
  coldMisses: z.number().int().nonnegative(),
  reuseHits: z.number().int().nonnegative(),
  lastAdjustmentReason: z.string().optional(),
  underMemoryPressure: z.boolean(),
  lastPrewarmError: z.string().optional(),
  lastPrewarmSkipReason: z.string().optional(),
  /** 受管进程树 RSS 采样（字节）；未配置预算/高水位时不采样 */
  managedRssBytes: z.number().nonnegative().optional(),
  memoryBudgetMb: z.number().nonnegative(),
  rssSampleAgeMs: z.number().nonnegative().optional(),
})
export type PrewarmStatusDto = z.infer<typeof prewarmStatusSchema>
