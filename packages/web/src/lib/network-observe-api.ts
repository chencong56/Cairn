import {
  networkInspectObservationSchema,
  networkListObservationSchema,
  networkReadObservationSchema,
  observeOperationSchema,
  type NetworkInspectObservation,
  type NetworkListObservation,
  type NetworkReadObservation,
  type ObserveNetworkOperation,
} from '@cairn/shared'
import { apiFetch } from '@/lib/api-client'

/** 接口来源的编写期操作发到哪：调试挂起中的运行，或还没试跑的受管会话。 */
export type NetworkObserveOwner = { kind: 'run'; runId: string } | { kind: 'session'; sessionId: string }

type ResultOf<O extends ObserveNetworkOperation> = O['subOp'] extends 'inspect'
  ? NetworkInspectObservation
  : O['subOp'] extends 'read'
    ? NetworkReadObservation
    : NetworkListObservation

export function observeNetwork<O extends ObserveNetworkOperation>(owner: NetworkObserveOwner, op: O): Promise<ResultOf<O>> {
  const path = owner.kind === 'run' ? `/api/runs/${owner.runId}/observe` : `/api/browser-sessions/${owner.sessionId}/observe`
  const schema = op.subOp === 'inspect' ? networkInspectObservationSchema : op.subOp === 'read' ? networkReadObservationSchema : networkListObservationSchema
  return apiFetch(path, schema as never, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(observeOperationSchema.parse(op)),
  }) as Promise<ResultOf<O>>
}
