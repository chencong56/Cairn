import { failure } from '../runs/errors.js'

/**
 * 凭据路径上取登录名。访客没有登录名，也不登记任何凭据：走到这里说明调用方漏了访客分支，
 * 闭合失败，不拿空字符串顶替。
 */
export function credentialUsername(account: { username: string | null }): string {
  if (account.username == null) {
    throw failure('conflict', {
      code: 'TARGET_ACCOUNT_VISITOR_READONLY',
      message: '访客账号没有登录名，不能登记口令、TOTP 或登录快照',
    })
  }
  return account.username
}
