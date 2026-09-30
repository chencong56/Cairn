import { Inject, Injectable } from '@nestjs/common'
import { getWorkerDetail, listWorkers, type DbHandle } from '@cairn/db'
import {
  canSeeWorkerInternalEndpoint,
  parseWorkerEndpoints,
  type WorkerDetailResponse,
  type WorkerListQuery,
  type WorkerListResponse,
  type WorkerSessionListQuery,
} from '@cairn/shared'
import { config } from '../config/env'
import { DB_HANDLE } from '../db/db.module'
import { rethrowDomain } from '../common/domain-error'
import { WorkerNodeHealthClient } from './node-health.client'

@Injectable()
export class WorkersService {
  constructor(
    @Inject(DB_HANDLE) private readonly handle: DbHandle,
    private readonly nodeHealthClient: WorkerNodeHealthClient,
  ) {}

  async list(query: WorkerListQuery, permissions: readonly string[]): Promise<WorkerListResponse> {
    try {
      return await listWorkers(this.handle, query, this.options(permissions))
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async get(
    workerId: string,
    query: WorkerSessionListQuery,
    permissions: readonly string[],
  ): Promise<WorkerDetailResponse> {
    try {
      return await getWorkerDetail(this.handle, workerId, query, this.options(permissions))
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async disable(workerId: string) {
    try {
      const { disableWorker } = await import('@cairn/db')
      return await disableWorker(this.handle, workerId)
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async enable(workerId: string) {
    try {
      const { enableWorker } = await import('@cairn/db')
      return await enableWorker(this.handle, workerId)
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async remove(workerId: string) {
    try {
      const { deregisterWorker } = await import('@cairn/db')
      await deregisterWorker(this.handle, workerId)
      return { ok: true }
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async purgeStale() {
    try {
      const { purgeStaleWorkers } = await import('@cairn/db')
      return await purgeStaleWorkers(this.handle)
    } catch (error) {
      rethrowDomain(error)
    }
  }

  /**
   * 按 workerId 实时查询节点健康（含执行角色的浏览器预热应用状态）。
   * 只读内部端点，不经 Run 转发；节点离线/不可达返回明确的 degraded 事实而不是报错。
   */
  async nodeHealth(workerId: string) {
    const { getWorkerById } = await import('@cairn/db')
    const { evaluateWorkerRegistration } = await import('@cairn/shared')
    const worker = await getWorkerById(this.handle, workerId).catch(() => null)
    if (!worker) return { reachable: false as const, reason: 'WORKER_NOT_FOUND' as const }
    const route = evaluateWorkerRegistration({
      workerStatus: worker.status,
      heartbeatExpiresAt: worker.heartbeatExpiresAt,
      lostAfterSeconds: worker.lostAfterSeconds,
      internalBaseUrl: worker.internalBaseUrl,
      asOf: new Date(),
      envEndpoint: parseWorkerEndpoints(config.CAIRN_WORKER_ENDPOINTS)[worker.id],
    })
    if (route.availability !== 'eligible' || !route.endpoint) {
      return { reachable: false as const, reason: 'WORKER_NOT_ROUTABLE' as const, route }
    }
    try {
      const health = await this.nodeHealthClient.fetchNodeHealth(workerId, route.endpoint)
      return { reachable: true as const, health }
    } catch {
      return { reachable: false as const, reason: 'WORKER_UNREACHABLE' as const, route }
    }
  }

  private options(permissions: readonly string[]) {
    return {
      envEndpoints: parseWorkerEndpoints(config.CAIRN_WORKER_ENDPOINTS),
      canSeeEndpoint: canSeeWorkerInternalEndpoint(permissions),
    }
  }
}
