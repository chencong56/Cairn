import { Injectable } from '@nestjs/common'
import {
  assertWorkerEndpointAllowed,
  requireInternalSecret,
  signNodeHealthHeaders,
  WORKER_NODE_HEALTH_PATH,
  workerNodeHealthResponseSchema,
  INTERNAL_REQUEST_TTL_SECONDS,
  type WorkerNodeHealthResponse,
} from '@cairn/shared'
import { config } from '../config/env'

/**
 * 按 workerId 查询节点健康（含执行角色的浏览器预热观测）。
 * 使用 node-health 签名方案：不绑定 actor/run，只绑定 workerId 与路径，
 * Worker 侧校验 x-cairn-node-worker 与自身一致。
 */
@Injectable()
export class WorkerNodeHealthClient {

  async fetchNodeHealth(workerId: string, endpoint: string): Promise<WorkerNodeHealthResponse> {
    try {
      assertWorkerEndpointAllowed(endpoint)
    } catch {
      throw new NodeHealthError('WORKER_UNREACHABLE', '执行面暂时不可达')
    }
    const headers = await signNodeHealthHeaders(requireInternalSecret(config.CAIRN_INTERNAL_AUTH_SECRET), {
      method: 'GET',
      path: WORKER_NODE_HEALTH_PATH,
      body: '',
      expiresUnix: Math.floor(Date.now() / 1000) + INTERNAL_REQUEST_TTL_SECONDS,
      workerId,
    })
    let response: Response
    try {
      response = await fetch(`${endpoint}${WORKER_NODE_HEALTH_PATH}`, {
        method: 'GET',
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(3_000),
      })
    } catch {
      throw new NodeHealthError('WORKER_UNREACHABLE', '执行面暂时不可达')
    }
    if (!response.ok) {
      throw new NodeHealthError('WORKER_NODE_HEALTH_FAILED', `节点健康查询失败: ${response.status}`)
    }
    const raw = (await response.json()) as unknown
    return workerNodeHealthResponseSchema.parse(raw)
  }
}

export class NodeHealthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'NodeHealthError'
  }
}
