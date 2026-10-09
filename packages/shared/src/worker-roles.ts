import { KNOWLEDGE_ANALYSIS_PROTOCOL } from './analysis-jobs.js'
import { MAP_SCHEDULER_PROTOCOL, UNIFIED_SCHEDULER_PROTOCOL } from './schedules.js'
import { SESSION_AUTH_RECOVERY_PROTOCOL } from './session-auth-recovery.js'
import { SESSION_MAINTENANCE_PROTOCOL } from './session-maintenance.js'
import { SESSION_ACCOUNT_CONCURRENCY_PROTOCOL, SESSION_OCCUPANCY_PROTOCOL } from './session-occupancy.js'
import { OUTBOUND_WORKER_PROTOCOL, RUN_OUTBOUND_PROTOCOL } from './outbound.js'
import { EXPORT_ARTIFACTS_PROTOCOL } from './reports.js'
import { SERVICE_WEBHOOK_DELIVERY_PROTOCOL } from './service-webhooks.js'
import { SUITE_SCHEDULER_PROTOCOL } from './suites.js'

export const WORKER_ROLES = ['executor', 'scheduler', 'maintenance', 'analyst', 'all'] as const
export type WorkerRole = (typeof WORKER_ROLES)[number]

export const DEFAULT_WORKER_ROLES = 'all'

/**
 * Worker 登记的协议能力只表达角色与会话占用能力。
 * 锁步部署：快照特性不再有对应的协议门禁（不为新旧 Worker 混跑做兼容）。
 */
const PROTOCOL_ORDER = [
  OUTBOUND_WORKER_PROTOCOL,
  SERVICE_WEBHOOK_DELIVERY_PROTOCOL,
  RUN_OUTBOUND_PROTOCOL,
  SESSION_OCCUPANCY_PROTOCOL,
  SESSION_ACCOUNT_CONCURRENCY_PROTOCOL,
  SESSION_MAINTENANCE_PROTOCOL,
  SESSION_AUTH_RECOVERY_PROTOCOL,
  MAP_SCHEDULER_PROTOCOL,
  UNIFIED_SCHEDULER_PROTOCOL,
  SUITE_SCHEDULER_PROTOCOL,
  KNOWLEDGE_ANALYSIS_PROTOCOL,
  EXPORT_ARTIFACTS_PROTOCOL,
] as const

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

const SCHEDULER_PROTOCOLS = new Set<string>([MAP_SCHEDULER_PROTOCOL, UNIFIED_SCHEDULER_PROTOCOL, SUITE_SCHEDULER_PROTOCOL])
const ANALYST_PROTOCOLS = new Set<string>([KNOWLEDGE_ANALYSIS_PROTOCOL])
const MAINTENANCE_PROTOCOLS = new Set<string>([
  OUTBOUND_WORKER_PROTOCOL,
  SERVICE_WEBHOOK_DELIVERY_PROTOCOL,
  EXPORT_ARTIFACTS_PROTOCOL,
])
const OCCUPANCY_EXEMPT_PROTOCOLS = new Set<string>([
  OUTBOUND_WORKER_PROTOCOL,
  SERVICE_WEBHOOK_DELIVERY_PROTOCOL,
  MAP_SCHEDULER_PROTOCOL,
  UNIFIED_SCHEDULER_PROTOCOL,
  SUITE_SCHEDULER_PROTOCOL,
  KNOWLEDGE_ANALYSIS_PROTOCOL,
  EXPORT_ARTIFACTS_PROTOCOL,
  SESSION_OCCUPANCY_PROTOCOL,
  SESSION_ACCOUNT_CONCURRENCY_PROTOCOL,
])

export function protocolCapabilitiesForRoles(roles: WorkerRoleSet): string[] {
  return PROTOCOL_ORDER.filter((protocol) =>
    MAINTENANCE_PROTOCOLS.has(protocol)
      ? roles.maintenance
      : SCHEDULER_PROTOCOLS.has(protocol)
        ? roles.scheduler
        : ANALYST_PROTOCOLS.has(protocol)
          ? roles.analyst
          : roles.executor,
  )
}

/**
 * 按登记的协议判断该 Worker 是否会领取 Run。只广告调度/分析/维护协议的分角色节点不领取；
 * 空协议视作早于协议登记的旧执行二进制，按会领取处理。
 */
export function advertisesRunExecution(capabilities: readonly string[] | undefined): boolean {
  const items = capabilities ?? []
  return (
    items.length === 0 ||
    items.some(
      (item) => !MAINTENANCE_PROTOCOLS.has(item) && !SCHEDULER_PROTOCOLS.has(item) && !ANALYST_PROTOCOLS.has(item),
    )
  )
}

/** 只有广告了执行/会话类协议才必须声明占用；调度与维护节点可以空协议登记。 */
export function registrationRequiresOccupancy(capabilities: readonly string[] | undefined): boolean {
  return (capabilities ?? []).some((item) => !OCCUPANCY_EXEMPT_PROTOCOLS.has(item))
}
