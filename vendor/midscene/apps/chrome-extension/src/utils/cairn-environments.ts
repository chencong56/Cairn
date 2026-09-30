export const CAIRN_ENVIRONMENTS = {
  development: { label: '开发环境', origin: 'http://localhost:5173' },
  testing: { label: '测试环境', origin: null },
  production: { label: '生产环境', origin: null },
  custom: { label: '自定义环境...', origin: null },
} as const;

export type CairnEnvironment = keyof typeof CAIRN_ENVIRONMENTS;

export function isCairnEnvironment(value: string | null): value is CairnEnvironment {
  return value !== null && Object.prototype.hasOwnProperty.call(CAIRN_ENVIRONMENTS, value);
}

export function normalizeApiOrigin(input: string): string {
  return input.trim().replace(/\/+$/, '');
}

export function validateApiOrigin(input: string): { ok: true; origin: string } | { ok: false; error: string } {
  const trimmed = normalizeApiOrigin(input);
  if (!trimmed) {
    return { ok: false, error: '请输入自定义服务地址' };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: '服务地址格式不正确，必须包含协议，如 http:// 或 https://' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: '服务地址必须以 http:// 或 https:// 开头' };
  }
  return { ok: true, origin: trimmed };
}

export function cairnEnvironmentOrigin(environment: CairnEnvironment, customOrigin?: string | null): string | null {
  if (environment === 'custom') {
    return customOrigin ? normalizeApiOrigin(customOrigin) : '';
  }
  return CAIRN_ENVIRONMENTS[environment].origin;
}
