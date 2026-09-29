// outbound 更名后仅存的旧名桥接；其余 notification* 别名已随迁移完成删除。
import { OUTBOUND_WORKER_PROTOCOL, type PlatformOutbound } from './outbound.js'

export const NOTIFICATION_WORKER_PROTOCOL = OUTBOUND_WORKER_PROTOCOL
export type PlatformNotifications = PlatformOutbound
