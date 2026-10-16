import { randomUUID } from 'node:crypto'

/**
 * 把本夹具登记进本机识途：目标系统、账号 demo/demo123 与一个跨标签场景（点「工作邮箱」切换到弹出窗口后填写并提交）。
 * 幂等：已存在则复用。需要本机 API 与 node server.mjs 已启动。
 */
const api = process.env.CAIRN_API_ORIGIN ?? 'http://127.0.0.1:3030'
const lab = process.env.PORTAL_ORIGIN ?? 'http://127.0.0.1:4183'
const adminEmail = process.env.CAIRN_BOOTSTRAP_ADMIN_EMAIL ?? 'admin'
const adminPassword = process.env.CAIRN_BOOTSTRAP_ADMIN_PASSWORD ?? 'cairn-admin'

export async function seedPortal() {
  const login = await fetch(`${api}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: adminEmail, password: adminPassword }) })
  if (!login.ok) throw new Error(`login ${login.status} ${await login.text()}`)
  const token = (await login.json()).accessToken
  async function req(path, method = 'GET', body) {
    const res = await fetch(`${api}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    const text = await res.text(); let data; try { data = JSON.parse(text) } catch { data = text }
    if (!res.ok) throw new Error(`${method} ${path} ${res.status} ${JSON.stringify(data)}`)
    return data
  }
  const code = 'popup-portal'
  let target = (await req(`/targets?search=${code}&limit=10`)).items?.find((t) => t.code === code)
  if (!target) target = await req('/targets', 'POST', { code, name: '新标签页门户（夹具）', entryUrl: `${lab}/`, loginUrl: `${lab}/login`, authMethod: 'password', captchaMode: 'none' })
  let account = (await req(`/targets/${target.id}/accounts`)).items?.[0]
  if (!account) account = await req(`/targets/${target.id}/accounts`, 'POST', { displayName: '门户测试员', username: 'demo', password: 'demo123', validity: { mode: 'permanent' } })
  const css = (value, semantic, extra = []) => ({ framePath: [], candidates: [...extra, { by: 'css', value }], semantic })
  const name = '门户打开工作邮箱并提交申请（跨标签）'
  let scenario = (await req(`/scenarios?targetId=${target.id}&search=${encodeURIComponent(name)}&limit=20`)).items?.find((s) => s.name === name)
  if (!scenario) scenario = await req('/scenarios', 'POST', { targetId: target.id, name, steps: [
    { id: randomUUID(), name: '打开门户首页', type: 'navigate', effectType: 'READ_ONLY', input: { url: `${lab}/eip/index` } },
    { id: randomUUID(), name: '点击常用功能「工作邮箱」', type: 'click', effectType: 'READ_ONLY', input: { target: css('#quick-mail', '常用功能里的「工作邮箱」按钮', [{ by: 'role', value: 'button', name: '工作邮箱' }]), pageAfter: 'popup' } },
    { id: randomUUID(), name: '填写关键字', type: 'fill', effectType: 'SIDE_EFFECT', input: { target: css('#keyword', '关键字输入框', [{ by: 'label', value: '关键字' }]), value: '周报' } },
    { id: randomUUID(), name: '提交申请', type: 'click', effectType: 'SIDE_EFFECT', input: { target: css('#submit-apply', '「提交申请」按钮', [{ by: 'role', value: 'button', name: '提交申请' }]) } },
  ] })
  return { api, token, targetId: target.id, accountId: account.id, scenarioId: scenario.id }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { targetId, accountId, scenarioId } = await seedPortal()
  console.log(JSON.stringify({ targetId, accountId, scenarioId }))
}
