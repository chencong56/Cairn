import { eq } from 'drizzle-orm'
import type { Db } from '../client.js'
import { schemaFor } from '../native.js'
import { loadAccountGrants, scopeFromGrants } from '../console/target-authorization.js'
import { accountDisplayName } from '../sessions/manual-control.js'
import { conflict } from './errors.js'

/**
 * 调试挂起（HOLDING）的运行停在发起人的现场：调试命令、在场心跳和页面观察只给交互发起人。
 * 其他人只读围观，仍可取消运行。调度、套件、批量、服务调用的运行没有「本人」，
 * 只有目标上的 `session:dispose` 管理员可以接手。
 * 运行不存在或不在挂起状态时不设门禁，由执行面按状态自行拒绝。
 */
export async function assertRunDebugOwner(
  db: Db,
  input: { runId: string; actorId: string; includeRunning?: boolean },
): Promise<void> {
  const { runs } = schemaFor(db)
  const [run] = await db
    .select({
      status: runs.status,
      targetId: runs.targetId,
      createdBy: runs.createdByConsoleAccountId,
      serviceCallerId: runs.serviceCallerId,
      executionOrigin: runs.executionOrigin,
    })
    .from(runs)
    .where(eq(runs.id, input.runId))
    .limit(1)
  if (!run || !(run.status === 'HOLDING' || (input.includeRunning && run.status === 'RUNNING'))) return
  const interactive = run.executionOrigin === 'standalone' && !run.serviceCallerId && Boolean(run.createdBy)
  if (interactive && run.createdBy === input.actorId) return
  if (!interactive) {
    const scope = scopeFromGrants(await loadAccountGrants(db, input.actorId), 'session:dispose')
    if (scope.all || scope.ids.includes(run.targetId)) return
  }
  const owner = interactive && run.createdBy ? await accountDisplayName(db, run.createdBy) : '系统'
  throw conflict('RUN_NOT_OWNED', `这是 ${owner} 的调试运行，只能只读观看`, { ownerId: run.createdBy })
}
