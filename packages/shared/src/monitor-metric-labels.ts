import { ALERTABLE_METRIC_KEYS, type AlertComparator, type AlertRule } from './alerting.js'
import { MONITOR_METRIC_CATALOG, type MonitorMetricKey, type MonitorUnit } from './monitoring.js'

/**
 * 监控指标的中文名称与分组。告警规则编辑器、告警列表、告警推送等面向用户的地方一律用中文名，
 * 英文键只作为次要信息（排查时对照）。新增可告警指标时必须补这里（`monitor-metric-labels.test.ts` 会卡住遗漏）。
 */
export type MetricGroup = '执行节点' | '执行队列' | '租约' | '证据存储' | '会话与浏览器' | '控制台服务' | 'AI 调用' | '目标系统'

export const METRIC_GROUP_ORDER: readonly MetricGroup[] = ['执行节点', '执行队列', '租约', '证据存储', '会话与浏览器', '控制台服务', 'AI 调用', '目标系统']

export const METRIC_LABELS: Partial<Record<MonitorMetricKey, { label: string; group: MetricGroup }>> = {
  'worker.status.ready': { label: '就绪的执行节点数', group: '执行节点' },
  'worker.status.draining': { label: '排空中的执行节点数', group: '执行节点' },
  'worker.status.stopped': { label: '已停止的执行节点数', group: '执行节点' },
  'worker.status.lost': { label: '失联的执行节点数', group: '执行节点' },
  'worker.release.mismatch': { label: '版本与控制台不一致的执行节点数', group: '执行节点' },
  'worker.heartbeat.fresh': { label: '心跳正常的执行节点数', group: '执行节点' },
  'worker.heartbeat.stale': { label: '心跳过期的执行节点数', group: '执行节点' },
  'worker.capacity.total': { label: '执行容量总数', group: '执行节点' },
  'worker.capacity.used': { label: '已占用的执行容量', group: '执行节点' },
  'worker.sessions.total': { label: '浏览器会话容量总数', group: '执行节点' },
  'worker.sessions.used': { label: '已占用的浏览器会话数', group: '执行节点' },
  'worker.slots.occupied': { label: '被占用的执行槽位', group: '执行节点' },
  'worker.slots.lostOccupied': { label: '失联节点上仍占用的槽位', group: '执行节点' },
  'worker.slots.executing': { label: '正在执行的槽位', group: '执行节点' },
  'worker.slots.running': { label: '运行中的槽位', group: '执行节点' },
  'worker.slots.holding': { label: '调试挂起的槽位', group: '执行节点' },
  'worker.slots.waitingForAuth': { label: '等待登录的槽位', group: '执行节点' },
  'worker.slots.leftoverAuthHolds': { label: '残留的登录占用槽位', group: '执行节点' },
  'worker.slots.expiredLeaseResidue': { label: '租约过期仍残留的槽位', group: '执行节点' },
  'worker.slots.runCapacityUsed': { label: '运行已占用的容量', group: '执行节点' },
  'worker.process.rssBytes': { label: '执行节点进程内存', group: '执行节点' },
  'worker.process.eventLoopDelayMs': { label: '执行节点事件循环延迟', group: '执行节点' },
  'worker.process.cpuPercent': { label: '执行节点 CPU 占用', group: '执行节点' },
  'worker.clockSkewMs': { label: '执行节点时钟偏移', group: '执行节点' },

  'queue.claimableRuns': { label: '可领取的排队运行数', group: '执行队列' },
  'queue.oldestWaitMs': { label: '最久的排队等待时长', group: '执行队列' },
  'queue.unclaimableRuns': { label: '暂时无法领取的运行数', group: '执行队列' },
  'queue.recovering': { label: '恢复中的运行数', group: '执行队列' },
  'queue.needsReview': { label: '待人工核查的运行数', group: '执行队列' },
  'queue.sessionOperations': { label: '排队中的会话操作数', group: '执行队列' },
  'queue.schedulePending': { label: '待触发的定时计划数', group: '执行队列' },
  'queue.mapJobsActive': { label: '进行中的地图采集作业数', group: '执行队列' },
  'queue.mapJobsQueued': { label: '排队中的地图采集作业数', group: '执行队列' },
  'queue.mapJobsRunning': { label: '运行中的地图采集作业数', group: '执行队列' },
  'queue.mapJobsActiveGuardMismatch': { label: '地图采集作业状态不一致数', group: '执行队列' },
  'queue.maxTargetBacklog': { label: '单个系统的最大积压数', group: '执行队列' },
  'queue.targetsWithBacklog': { label: '有积压的系统数', group: '执行队列' },
  'queue.targetBacklogP95': { label: '系统积压数（P95）', group: '执行队列' },
  'queue.lastClaimScanCount': { label: '最近一次领取扫描的运行数', group: '执行队列' },
  'queue.claim.durationMs': { label: '领取运行耗时', group: '执行队列' },
  'queue.claim.candidateSqlMs': { label: '领取候选查询耗时', group: '执行队列' },
  'queue.claim.windowRows': { label: '领取扫描窗口行数', group: '执行队列' },
  'queue.claim.windows': { label: '领取扫描窗口数', group: '执行队列' },
  'queue.claim.budgetExhausted': { label: '领取扫描预算耗尽次数', group: '执行队列' },
  'queue.claim.refillDelayMs': { label: '领取补位延迟', group: '执行队列' },
  'queue.lastGlobalReclaimAgeMs': { label: '距上次全局回收的时长', group: '执行队列' },

  'lease.expiredActiveRunLeases': { label: '已过期仍有效的运行租约数', group: '租约' },
  'lease.expiredActiveSessionLeases': { label: '已过期仍有效的会话租约数', group: '租约' },
  'lease.leftoverAuthHolds': { label: '残留的登录占用数', group: '租约' },
  'lease.orphanAttempts': { label: '孤儿执行尝试数', group: '租约' },
  'lease.recoveryCappedRuns': { label: '恢复次数已达上限的运行数', group: '租约' },

  'evidence.pendingUpload': { label: '待上传的证据数', group: '证据存储' },
  'evidence.uploadFailed': { label: '上传失败的证据数', group: '证据存储' },
  'evidence.maxUploadAttempts': { label: '证据最大上传重试次数', group: '证据存储' },
  'evidence.purgeBacklog': { label: '待清理的证据数', group: '证据存储' },
  'evidence.purgeFailed': { label: '清理失败的证据数', group: '证据存储' },
  'objectStore.up': { label: '对象存储是否可用（1 可用，0 不可用）', group: '证据存储' },
  'objectStore.probeLatencyMs': { label: '对象存储探测延迟', group: '证据存储' },

  'profile.pendingCleanups': { label: '待清理的浏览器配置档数', group: '会话与浏览器' },
  'profile.diskUsageBytes': { label: '浏览器配置档磁盘占用（总计）', group: '会话与浏览器' },
  'profile.nodeDiskUsageBytes': { label: '节点浏览器配置档磁盘占用', group: '会话与浏览器' },
  'sessions.stateSnapshotCount': { label: '登录状态快照数', group: '会话与浏览器' },
  'sessions.stateSnapshotBytes': { label: '登录状态快照占用空间', group: '会话与浏览器' },
  'worker.browserProcessCount': { label: '浏览器进程数', group: '会话与浏览器' },
  'worker.browserHostCount': { label: '浏览器宿主数', group: '会话与浏览器' },
  'worker.browserContextCount': { label: '浏览器上下文数', group: '会话与浏览器' },
  'worker.browserProcessRssBytes': { label: '浏览器进程内存', group: '会话与浏览器' },
  'worker.browserHostLostCount': { label: '失联的浏览器宿主数', group: '会话与浏览器' },
  'worker.profileCount': { label: '节点上的浏览器配置档数', group: '会话与浏览器' },
  'worker.profileDiskFreeBytes': { label: '浏览器配置档所在磁盘可用空间', group: '会话与浏览器' },
  'worker.midsceneBytes': { label: 'AI 运行缓存占用空间', group: '会话与浏览器' },

  'api.instances.ready': { label: '就绪的控制台服务实例数', group: '控制台服务' },
  'api.process.rssBytes': { label: '控制台服务进程内存', group: '控制台服务' },
  'api.process.eventLoopDelayMs': { label: '控制台服务事件循环延迟', group: '控制台服务' },
  'api.sse.connections': { label: '实时进度连接数', group: '控制台服务' },
  'api.internalForward.inFlight': { label: '内部转发进行中请求数', group: '控制台服务' },

  'ai.calls': { label: 'AI 调用次数', group: 'AI 调用' },
  'ai.errors': { label: 'AI 调用失败次数', group: 'AI 调用' },
  'ai.inputTokens': { label: 'AI 输入 Token 数', group: 'AI 调用' },
  'ai.outputTokens': { label: 'AI 输出 Token 数', group: 'AI 调用' },

  'target.apiSlowCount': { label: '目标系统接口耗时超阈次数（近 1 小时）', group: '目标系统' },
  'target.apiErrorCount': { label: '目标系统接口错误次数（近 1 小时）', group: '目标系统' },
  'target.pageHealthRunRate': { label: '目标系统页面健康违规运行占比（近 1 小时）', group: '目标系统' },
}

/** 指标的中文名；没有登记时退回英文键。 */
export function metricLabel(key: string | null | undefined): string {
  if (!key) return ''
  return METRIC_LABELS[key as MonitorMetricKey]?.label ?? key
}

const UNIT_LABELS: Record<MonitorUnit, string> = {
  count: '数量',
  milliseconds: '毫秒',
  seconds: '秒',
  bytes: '字节',
  percent: '%',
}

/** 阈值单位，用在「阈值」输入旁。 */
export function metricUnitLabel(key: string | null | undefined): string {
  if (!key) return ''
  const def = MONITOR_METRIC_CATALOG[key as MonitorMetricKey]
  return def ? UNIT_LABELS[def.unit] : ''
}

const COMPARATOR_WORDS = { gt: '大于', gte: '大于等于', lt: '小于', lte: '小于等于', eq: '等于' } as const
const STALE_SOURCE_WORDS = {
  object_store_probe: '对象存储探测',
  worker_registry: '执行节点登记',
  api_registry: '控制台服务登记',
} as const
const SEVERITY_WORDS = { warning: '警告', critical: '严重' } as const

function durationWords(seconds: number): string {
  if (seconds <= 0) return '一出现就告警'
  if (seconds % 60 === 0) return `持续 ${seconds / 60} 分钟后告警`
  return `持续 ${seconds} 秒后告警`
}

/** 一句人话描述一条告警规则：什么情况下、持续多久、什么级别。给不懂指标键的用户看。 */
export function describeAlertRule(rule: AlertRule): string {
  const severity = SEVERITY_WORDS[rule.severity]
  if (rule.kind === 'threshold') {
    const unit = metricUnitLabel(rule.metricKey)
    const unitText = unit && unit !== '数量' ? ` ${unit}` : ''
    return `${metricLabel(rule.metricKey)} ${COMPARATOR_WORDS[rule.comparator]} ${rule.threshold}${unitText}，${durationWords(rule.forSeconds)}（${severity}）`
  }
  return `「${STALE_SOURCE_WORDS[rule.source]}」长时间没有更新，${durationWords(rule.forSeconds)}（${severity}）`
}

/** 指标下拉按业务分组；组内保持目录里的顺序。 */
export function metricOptionGroups(): { group: MetricGroup | '其他'; keys: MonitorMetricKey[] }[] {
  const groups = new Map<MetricGroup | '其他', MonitorMetricKey[]>()
  for (const key of ALERTABLE_METRIC_KEYS) {
    const group = METRIC_LABELS[key]?.group ?? '其他'
    groups.set(group, [...(groups.get(group) ?? []), key])
  }
  return [...METRIC_GROUP_ORDER, '其他' as const]
    .filter((group) => groups.has(group))
    .map((group) => ({ group, keys: groups.get(group)! }))
}

function readingNumber(value: number): string {
  return String(Number(value.toFixed(2)))
}

/**
 * 告警推送里的一句读数：阈值类给「指标中文名，当前值，规则」，陈旧类说明哪个判断依据没更新。
 * 推送只拿到事件里冻结的字段，所以参数是宽松的字符串；认不出的比较符 / 来源不硬译。
 */
export function describeAlertReading(alert: {
  metricKey: string | null
  source: string | null
  value: number | null
  threshold: number | null
  comparator: string | null
}): string | null {
  if (alert.metricKey) {
    const unit = metricUnitLabel(alert.metricKey)
    const unitText = unit && unit !== '数量' ? ` ${unit}` : ''
    const parts = [metricLabel(alert.metricKey)]
    if (alert.value !== null) parts.push(`当前 ${readingNumber(alert.value)}${unitText}`)
    const comparator = alert.comparator && alert.comparator in COMPARATOR_WORDS ? COMPARATOR_WORDS[alert.comparator as AlertComparator] : null
    if (comparator && alert.threshold !== null) parts.push(`规则 ${comparator} ${readingNumber(alert.threshold)}${unitText}`)
    return parts.join('，')
  }
  if (alert.source && alert.source in STALE_SOURCE_WORDS) {
    return `「${STALE_SOURCE_WORDS[alert.source as keyof typeof STALE_SOURCE_WORDS]}」长时间没有更新`
  }
  return null
}

const ALERT_SCOPE_WORDS = { target: '目标系统', worker: '执行节点', api: '控制台服务' } as const

/** 告警作用对象的一句话，如「目标系统：订单中心」；平台级告警没有对象。 */
export function describeAlertScope(alert: { scope: string; scopeId: string; scopeName?: string | null }): string | null {
  if (!(alert.scope in ALERT_SCOPE_WORDS)) return null
  return `${ALERT_SCOPE_WORDS[alert.scope as keyof typeof ALERT_SCOPE_WORDS]}：${alert.scopeName || alert.scopeId}`
}
