import * as React from 'react'
import {
  CAIRN_API_ENVIRONMENTS,
  CUSTOM_ENVIRONMENT_ID,
  resolveApiEnvironment,
  type ApiEnvironment,
} from './config'

type Props = {
  environments?: readonly ApiEnvironment[]
  environmentId: string
  onEnvironmentId: (id: string) => void
  customOrigin: string
  onCustomOrigin: (value: string) => void
  email: string
  password: string
  onEmail: (value: string) => void
  onPassword: (value: string) => void
  busy: boolean
  error: string | null
  onSubmit: (event: React.FormEvent) => void
}

export const LoginForm: React.FC<Props> = ({
  environments = CAIRN_API_ENVIRONMENTS,
  environmentId,
  onEnvironmentId,
  customOrigin,
  onCustomOrigin,
  email,
  password,
  onEmail,
  onPassword,
  busy,
  error,
  onSubmit,
}) => {
  const current = resolveApiEnvironment(environmentId, customOrigin, environments)

  return (
    <div className='cairn-login'>
      <div className='cairn-brand'>
        <img src='logo-observe.svg' alt='' width={40} height={40} />
        <div>
          识途
          <small>可观测场景执行平台</small>
        </div>
      </div>
      <form className='cairn-card' onSubmit={onSubmit}>
        <h1>登录识途</h1>
        <p className='cairn-lead'>用控制台账号进入。没有登录不能录制。</p>
        <div className='cairn-field'>
          <label htmlFor='cairn-env'>环境</label>
          <select
            id='cairn-env'
            aria-label='环境'
            value={current.id}
            onChange={(event) => onEnvironmentId(event.target.value)}
          >
            {environments.map((item) => (
              <option
                key={item.id}
                value={item.id}
                disabled={!item.origin && !item.isCustom}
              >
                {!item.origin && !item.isCustom ? `${item.label}（未配置）` : item.label}
              </option>
            ))}
          </select>
        </div>
        {current.id === CUSTOM_ENVIRONMENT_ID && (
          <div className='cairn-field'>
            <label htmlFor='cairn-custom-origin'>服务地址</label>
            <input
              id='cairn-custom-origin'
              name='customOrigin'
              type='url'
              autoComplete='off'
              placeholder='如 http://192.168.1.100:3030'
              value={customOrigin}
              onChange={(event) => onCustomOrigin(event.target.value)}
            />
          </div>
        )}
        <div className='cairn-field'>
          <label htmlFor='cairn-email'>账号</label>
          <input
            id='cairn-email'
            name='email'
            autoComplete='username'
            placeholder='请输入账号'
            value={email}
            onChange={(event) => onEmail(event.target.value)}
          />
        </div>
        <div className='cairn-field'>
          <label htmlFor='cairn-password'>密码</label>
          <input
            id='cairn-password'
            name='password'
            type='password'
            autoComplete='current-password'
            placeholder='请输入密码'
            value={password}
            onChange={(event) => onPassword(event.target.value)}
          />
        </div>
        {error ? <p className='cairn-error'>{error}</p> : null}
        <button className='cairn-btn cairn-btn-primary cairn-btn-block' type='submit' disabled={busy}>
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
    </div>
  )
}
