export type ApiEnvironment = {
  id: string
  label: string
  origin: string
  isCustom?: boolean
}

export const CUSTOM_ENVIRONMENT_ID = 'custom'

/** 登录页提供预设选项与自定义环境；无固定 origin 的预设项标记为未配置。 */
export const CAIRN_API_ENVIRONMENTS: readonly ApiEnvironment[] = [
  {
    id: 'local',
    label: '本地开发环境',
    origin: 'http://localhost:3030',
  },
  {
    id: 'testing',
    label: '测试环境',
    origin: '',
  },
  {
    id: 'production',
    label: '生产环境',
    origin: '',
  },
  {
    id: CUSTOM_ENVIRONMENT_ID,
    label: '自定义环境...',
    origin: '',
    isCustom: true,
  },
]

export const DEFAULT_ENVIRONMENT_ID = CAIRN_API_ENVIRONMENTS[0].id

export function normalizeApiOrigin(input: string): string {
  return input.trim().replace(/\/+$/, '')
}

export function validateApiOrigin(input: string): { ok: true; origin: string } | { ok: false; error: string } {
  const trimmed = normalizeApiOrigin(input)
  if (!trimmed) {
    return { ok: false, error: '请输入自定义服务地址' }
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, error: '服务地址格式不正确，必须包含协议，如 http:// 或 https://' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: '服务地址必须以 http:// 或 https:// 开头' }
  }
  return { ok: true, origin: trimmed }
}

export function resolveApiEnvironment(
  id?: string | null,
  customOriginOrEnvs?: string | readonly ApiEnvironment[] | null,
  environments: readonly ApiEnvironment[] = CAIRN_API_ENVIRONMENTS,
): ApiEnvironment {
  let customOrigin: string | undefined
  let envList = environments
  if (Array.isArray(customOriginOrEnvs)) {
    envList = customOriginOrEnvs
  } else if (typeof customOriginOrEnvs === 'string') {
    customOrigin = customOriginOrEnvs
  }
  const matched = envList.find((item) => item.id === id) ?? envList[0] ?? CAIRN_API_ENVIRONMENTS[0]
  if (matched.id === CUSTOM_ENVIRONMENT_ID) {
    return {
      ...matched,
      origin: customOrigin ? normalizeApiOrigin(customOrigin) : '',
    }
  }
  return matched
}

