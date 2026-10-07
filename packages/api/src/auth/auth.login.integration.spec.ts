import { ForbiddenException, UnauthorizedException } from '@nestjs/common'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId, openIsolatedDb, type DbHandle } from '@cairn/db/testing'
import { loginAuditQuerySchema } from '@cairn/shared'
import { RbacStore } from '@cairn/db'
import { AuthService } from './auth.service'
import { RbacService } from '../rbac/rbac.service'
import { hashSecret, verifySecret } from './password'

const prefix = `login-${Date.now().toString(36)}`

describe('AuthService 登录审计（集成）', () => {
  let handle: DbHandle
  let auth: AuthService
  let rbac: RbacService
  let store: RbacStore
  let accountId: string
  const login = `${prefix}-user`
  const password = 'secret-password'

  beforeAll(async () => {
    // 隔离库：原先直连主库并依赖它「已迁移」，测试因此只能跑在开发库上、还会往里写账号与审计行
    handle = await openIsolatedDb(`cairn_test_authlogin_${newId().replaceAll('-', '')}`)
    store = new RbacStore(handle, { hash: hashSecret, verify: verifySecret })
    rbac = new RbacService(handle)
    auth = new AuthService(handle, { signAsync: async () => 'jwt-token' } as never, rbac)
    const account = await store.createAccount(
      { email: login, displayName: '登录审计', password },
      null,
    )
    accountId = account.id
  })

  afterAll(async () => {
    // close 会整库删除，不再需要逐行清理
    await handle?.close()
  })

  it('成功登录写 login/success，响应不含口令', async () => {
    const result = await auth.login(login, password, {
      ip: '203.0.113.10',
      userAgent: 'vitest',
      kind: 'extension',
    })
    expect(result.accessToken).toBe('jwt-token')
    expect(JSON.stringify(result)).not.toContain(password)
    const logins = await store.listLoginAuditEvents(
      loginAuditQuerySchema.parse({ identifier: login, outcome: 'success' }),
    )
    expect(logins.items[0]).toMatchObject({
      loginIdentifier: login,
      outcome: 'success',
      clientIp: '203.0.113.10',
      clientKind: 'extension',
    })
    expect(JSON.stringify(logins)).not.toContain(password)
  })

  it('错误密码与未知账号保持 401 文案，对内原因分开', async () => {
    await expect(auth.login(login, 'wrong-password', { kind: 'web' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
    await expect(auth.login(`${prefix}-ghost`, 'wrong-password', { kind: 'web' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
    const failed = await store.listLoginAuditEvents(
      loginAuditQuerySchema.parse({ identifier: login, outcome: 'failure' }),
    )
    expect(failed.items.some((row) => row.failureReason === 'invalid_password' && row.actor?.id === accountId)).toBe(
      true,
    )
    const ghost = await store.listLoginAuditEvents(
      loginAuditQuerySchema.parse({ identifier: `${prefix}-ghost` }),
    )
    expect(ghost.items[0]).toMatchObject({
      failureReason: 'unknown_account',
      actor: null,
    })
  })

  it('停用账号且密码正确：403，failure_reason=account_disabled', async () => {
    await store.updateAccount(accountId, { status: 'disabled' }, null)
    await expect(auth.login(login, password, { kind: 'web' })).rejects.toBeInstanceOf(ForbiddenException)
    const failed = await store.listLoginAuditEvents(
      loginAuditQuerySchema.parse({ identifier: login, outcome: 'failure' }),
    )
    expect(failed.items.some((row) => row.failureReason === 'account_disabled')).toBe(true)
  })
})
