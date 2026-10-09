import { z } from 'zod'

export const WORKER_ROLES = ['executor', 'scheduler', 'maintenance', 'analyst', 'all'] as const
export type WorkerRole = (typeof WORKER_ROLES)[number]

/**
 * 登记在 workers.roles 里的具体角色（不含 all）。锁步部署：Worker 只表达角色，不再声明协议能力；
 * 执行节点（executor）领运行与会话操作，维护节点（maintenance）发推送 / 服务回调 / 导出报告，
 * 调度节点（scheduler）推进定时任务，分析节点（analyst）跑知识分析与耗时汇总。
 */
export const WORKER_ROLE_NAMES = ['executor', 'scheduler', 'maintenance', 'analyst'] as const
export type WorkerRoleName = (typeof WORKER_ROLE_NAMES)[number]
export const workerRoleNameSchema = z.enum(WORKER_ROLE_NAMES)

export const DEFAULT_WORKER_ROLES = 'all'

export type WorkerRoleSet = {
  executor: boolean
  scheduler: boolean
  maintenance: boolean
  analyst: boolean
}

export const ALL_WORKER_ROLES: WorkerRoleSet = {
  executor: true,
  scheduler: true,
  maintenance: true,
  analyst: true,
}

export function parseWorkerRoles(raw: string | undefined): WorkerRoleSet {
  const tokens = (raw ?? DEFAULT_WORKER_ROLES)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  if (tokens.length === 0) return { ...ALL_WORKER_ROLES }
  if (tokens.includes('all')) {
    if (tokens.length !== 1) {
      throw new Error('CAIRN_WORKER_ROLES 使用 all 时不能再组合其他角色')
    }
    return { ...ALL_WORKER_ROLES }
  }
  const allowed = new Set(['executor', 'scheduler', 'maintenance', 'analyst'])
  for (const token of tokens) {
    if (!allowed.has(token)) {
      throw new Error(`CAIRN_WORKER_ROLES 只能是 all 或 executor,scheduler,maintenance,analyst 的组合，收到 ${raw}`)
    }
  }
  return {
    executor: tokens.includes('executor'),
    scheduler: tokens.includes('scheduler'),
    maintenance: tokens.includes('maintenance'),
    analyst: tokens.includes('analyst'),
  }
}

/** 角色集合 → 登记用的角色名列表。 */
export function workerRoleNames(roles: WorkerRoleSet): WorkerRoleName[] {
  return WORKER_ROLE_NAMES.filter((role) => roles[role])
}

export function workerHasRole(roles: readonly string[] | null | undefined, role: WorkerRoleName): boolean {
  return Boolean(roles?.includes(role))
}

/**
 * 发布号守卫：在线控制台实例都是同一发布号 R、而 Worker 的发布号不是 R 时，判为版本不一致（不领新运行）。
 * Worker 没有发布号（本机开发）或控制台之间本身不一致（滚动升级控制台中）时不判——后者只告警、不拦。
 */
export function workerReleaseMismatch(workerRelease: string | null | undefined, apiReleases: readonly (string | null | undefined)[]): boolean {
  if (!workerRelease) return false
  const known = [...new Set(apiReleases.filter((release): release is string => Boolean(release)))]
  return known.length === 1 && known[0] !== workerRelease
}
