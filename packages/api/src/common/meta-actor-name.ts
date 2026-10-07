import { accountDisplayNames, type DbHandle } from '@cairn/db'
import type { ManagedBrowserMeta } from '@cairn/shared'

/** Worker 不读账号表：手动操作持有人的显示名由 API 在转发后补齐。 */
export async function withAuthControlActorName(db: DbHandle, meta: ManagedBrowserMeta): Promise<ManagedBrowserMeta> {
  const actorId = meta.authControl?.actorId
  if (!meta.authControl || !actorId) return meta
  const name = (await accountDisplayNames(db, [actorId])).get(actorId) ?? null
  return { ...meta, authControl: { ...meta.authControl, actorName: name } }
}
