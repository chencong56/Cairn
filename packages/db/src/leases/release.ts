import { and, eq, gt } from 'drizzle-orm'
import { workerReleaseMismatch } from '@cairn/shared'
import type { Db } from '../client.js'
import { databaseNow, schemaFor } from '../native.js'

/**
 * 锁步部署的发布号守卫（方案 2026-10-08-lockstep-deploy-remove-protocol-gates 第 4 节）：
 * 在线控制台实例（READY 且心跳未过期）的发布号。控制台先升级时，旧版 Worker 据此停领新运行。
 */
export async function liveApiReleases(db: Db): Promise<Array<string | null>> {
  const { apiInstances } = schemaFor(db)
  const rows = await db
    .select({ version: apiInstances.version })
    .from(apiInstances)
    .where(and(eq(apiInstances.status, 'READY'), gt(apiInstances.heartbeatExpiresAt, databaseNow(db))))
  return rows.map((row) => row.version)
}

/** 这个 Worker 的发布号与在线控制台不一致：不领新运行（跑完手头的）。 */
export async function workerReleaseBlocked(db: Db, worker: { release: string | null }): Promise<boolean> {
  if (!worker.release) return false
  return workerReleaseMismatch(worker.release, await liveApiReleases(db))
}
