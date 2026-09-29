import { eq } from 'drizzle-orm'
import type { AuditActor } from '../audit/record.js'
import type { Db } from '../client.js'
import { schemaFor } from '../native.js'
import { assertTargetPermission } from '../console/target-authorization.js'
import { assertCredentialAccess } from './access.js'

export async function credentialOwnerCandidates(db: Db, id: string, actor: AuditActor) {
  const binding = await assertCredentialAccess(db, id, actor.id)
  const { consoleAccounts } = schemaFor(db)
  const accounts = await db.select({ id: consoleAccounts.id, name: consoleAccounts.displayName }).from(consoleAccounts).where(eq(consoleAccounts.status, 'active'))
  const items = []
  for (const account of accounts) {
    try { await assertTargetPermission(db, account.id, binding.targetId, 'credential:read'); items.push(account) } catch { /* not a visible candidate */ }
  }
  return { items }
}
