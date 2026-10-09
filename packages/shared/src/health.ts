import { z } from 'zod'
import { utcInstantSchema } from './wire.js'
import { prewarmStatusSchema } from './browser-prewarm.js'

/**
 * `/health` 的响应契约。
 *
 * api 用它序列化响应，web 用它解析——同一个 schema 对象，
 * 是前后端契约不漂移的最小证明。
 */
export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  service: z.enum(['cairn-api', 'cairn-worker']),
  /** 进程启动至今的秒数 */
  uptimeSeconds: z.number().nonnegative(),
  checks: z.object({
    database: z.enum(['up', 'down']),
    changeHint: z.enum(['up', 'down', 'unused']).default('unused'),
  }),
  /** 发布号（CAIRN_BUILD_VERSION）；本机开发为空。check:stack 据此判断控制台与 Worker 是否同版本。 */
  version: z.string().nullable().optional(),
})

export type HealthResponse = z.infer<typeof healthResponseSchema>

export const workerNodeHealthNodeSchema = z.object({
  workerId: z.string().min(1),
  instanceId: z.string().min(1),
  lastTickAt: utcInstantSchema.nullable(),
  loopAlive: z.boolean(),
  runningRunCount: z.number().int().nonnegative(),
  liveHandleCount: z.number().int().nonnegative(),
  shuttingDown: z.boolean(),
})
export type WorkerNodeHealthNode = z.infer<typeof workerNodeHealthNodeSchema>

export const workerNodeHealthResponseSchema = healthResponseSchema.extend({
  node: workerNodeHealthNodeSchema,
  /** 执行角色的浏览器预热状态；非执行角色或旧版本 Worker 不返回 */
  browserPrewarm: prewarmStatusSchema.optional(),
})
export type WorkerNodeHealthResponse = z.infer<typeof workerNodeHealthResponseSchema>

/** console 按 workerId 探测节点健康的响应：不可达时给出原因而不是抛错 */
export const workerNodeHealthProbeSchema = z.object({
  reachable: z.boolean(),
  reason: z.string().optional(),
  health: workerNodeHealthResponseSchema.optional(),
})
export type WorkerNodeHealthProbe = z.infer<typeof workerNodeHealthProbeSchema>

export const platformHealthStatusSchema = z.enum(['healthy', 'degraded', 'critical', 'unknown'])
export type PlatformHealthStatus = z.infer<typeof platformHealthStatusSchema>

export const changeHintHealthStatusSchema = z.enum(['healthy', 'degraded', 'critical', 'unknown', 'unused'])
export type ChangeHintHealthStatus = z.infer<typeof changeHintHealthStatusSchema>

export const platformHealthItemSchema = z.object({
  status: platformHealthStatusSchema,
  code: z.string(),
  message: z.string(),
})
export type PlatformHealthItem = z.infer<typeof platformHealthItemSchema>

export const platformHealthWorkerItemSchema = platformHealthItemSchema.extend({
  healthyNodes: z.number().int().nonnegative(),
  affectedActiveRuns: z.number().int().nonnegative(),
  affectedActiveSessions: z.number().int().nonnegative(),
})
export type PlatformHealthWorkerItem = z.infer<typeof platformHealthWorkerItemSchema>

export const platformHealthChangeHintItemSchema = z.object({
  status: changeHintHealthStatusSchema,
  code: z.string(),
  message: z.string(),
})
export type PlatformHealthChangeHintItem = z.infer<typeof platformHealthChangeHintItemSchema>

export const platformHealthResponseSchema = z.object({
  overall: platformHealthStatusSchema,
  asOf: utcInstantSchema,
  validUntil: utcInstantSchema,
  freshForMs: z.number().nonnegative(),
  checks: z.object({
    api: platformHealthItemSchema,
    database: platformHealthItemSchema,
    worker: platformHealthWorkerItemSchema,
    changeHint: platformHealthChangeHintItemSchema,
  }),
})
export type PlatformHealthResponse = z.infer<typeof platformHealthResponseSchema>
