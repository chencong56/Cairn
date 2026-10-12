import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getOrCreatePlatformConfig, getPlatformConfig, updatePlatformConfig } from '@cairn/db'
import { consoleAccounts, grantScopedPermissions, newId, openIsolatedDb, type DbHandle } from '@cairn/db/testing'
import { DEV_CREDENTIAL_KEY, FACTORY_PLATFORM_CONFIG, type RuntimeInvariant, type Step } from '@cairn/shared'
import type { RequestAccount } from '../common/request-account'
import { ScenariosService } from './scenarios.service'
import { TargetsService } from '../targets/targets.service'
import { credentialKeyFromEnv, LocalSecretProvider } from '../secrets/local-secret-provider'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_phdefault`

const navigate = (): Step => ({
  id: newId(),
  name: '打开页面',
  type: 'navigate',
  effectType: 'SIDE_EFFECT',
  input: { url: 'https://shop.example.com' },
})

function invariantsOf(document: unknown): RuntimeInvariant[] {
  return ((document as { runtimeInvariants?: RuntimeInvariant[] }).runtimeInvariants ?? [])
}

describe('新建场景默认带页面接口 / 脚本错误约束（真实库）', { timeout: 30_000 }, () => {
  let handle: DbHandle
  let targets: TargetsService
  let scenarios: ScenariosService
  let actor: RequestAccount

  beforeAll(async () => {
    handle = await openIsolatedDb(SCHEMA, { pristine: true })
    const actorId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'ph-tester',
      email: `ph-${actorId}@example.com`,
      status: 'active',
    })
    await grantScopedPermissions(handle.db, actorId, [
      'target:read',
      'target:write',
      'workflow:read',
      'workflow:write',
      'run:execute',
      'run:read',
    ])
    actor = {
      id: actorId,
      displayName: 'ph-tester',
      email: `ph-${actorId}@example.com`,
      status: 'active',
      roles: [],
      permissions: ['target:read', 'target:write', 'workflow:write', 'run:execute', 'run:read'],
    }
    targets = new TargetsService(handle, new LocalSecretProvider(credentialKeyFromEnv(DEV_CREDENTIAL_KEY)))
    scenarios = new ScenariosService(handle)
  })

  afterAll(async () => {
    await handle?.close()
  })

  async function createTarget() {
    return targets.createTarget(
      {
        code: `ph${newId().replaceAll('-', '')}`,
        name: `ph${newId().replaceAll('-', '')}`,
        entryUrl: 'https://shop.example.com',
        authMethod: 'password',
        captchaMode: 'none',
        status: 'active',
        loginFields: null,
      },
      actor,
    )
  }

  it('默认只带 network_health（SHOULD + continue），不带 script_errors；忽略清单写进接口约束', async () => {
    const target = await createTarget()
    const created = await scenarios.create({ targetId: target.id, name: '默认带约束', steps: [navigate()] }, actor)
    const detail = await scenarios.get(created.id)
    const draft = invariantsOf(detail.draft?.document)
    const published = invariantsOf(detail.published?.authoringDocument)
    for (const list of [draft, published]) {
      expect(list.map((item) => item.kind)).toEqual(['network_health'])
      expect(list.every((item) => item.severity === 'SHOULD' && item.onViolation === 'continue' && item.evaluateAt === 'each_step')).toBe(true)
    }
    expect(draft.map((item) => item.id)).toEqual(published.map((item) => item.id))
    expect(draft.find((item) => item.kind === 'network_health')?.network?.ignore).toEqual(['/favicon.ico'])
  })

  it('V1 客户端覆盖只带默认页面健康约束的草稿不被拦截（默认项可丢弃）', async () => {
    const target = await createTarget()
    const created = await scenarios.create({ targetId: target.id, name: 'V1 覆盖', steps: [navigate()] }, actor)
    const detail = await scenarios.get(created.id)
    await scenarios.saveDraft(
      created.id,
      { revision: detail.draft!.revision, document: { schemaVersion: 1, inputs: [], steps: [navigate()] } },
      actor,
    )
    const after = await scenarios.get(created.id)
    expect(after.draft!.revision).toBe(detail.draft!.revision + 1)
    expect(invariantsOf(after.draft!.document)).toEqual([])
  })

  it('平台开关关闭后新建场景不带约束；已有场景不被改动', async () => {
    const target = await createTarget()
    const before = await scenarios.create({ targetId: target.id, name: '关闭前', steps: [navigate()] }, actor)
    const existing = await getPlatformConfig(handle)
    const document = {
      ...FACTORY_PLATFORM_CONFIG,
      runtimeInvariants: {
        ...FACTORY_PLATFORM_CONFIG.runtimeInvariants,
        defaultNetworkHealthGuard: false,
        defaultScriptErrorsGuard: false,
      },
    }
    if (existing) {
      await updatePlatformConfig(handle, {
        expectedRevision: existing.revision,
        document,
        reason: '关闭页面健康默认约束',
        actor: { id: actor.id },
      })
    } else {
      await getOrCreatePlatformConfig(handle, { document, reason: '关闭页面健康默认约束' })
    }
    const after = await scenarios.create({ targetId: target.id, name: '关闭后', steps: [navigate()] }, actor)
    expect(invariantsOf((await scenarios.get(after.id)).draft?.document)).toEqual([])
    expect(invariantsOf((await scenarios.get(before.id)).draft?.document).map((item) => item.kind)).toEqual(['network_health'])
  })

  it('只开脚本开关时新建场景只带 script_errors', async () => {
    const existing = await getPlatformConfig(handle)
    const document = {
      ...FACTORY_PLATFORM_CONFIG,
      runtimeInvariants: {
        ...FACTORY_PLATFORM_CONFIG.runtimeInvariants,
        defaultNetworkHealthGuard: false,
        defaultScriptErrorsGuard: true,
      },
    }
    if (existing) {
      await updatePlatformConfig(handle, {
        expectedRevision: existing.revision,
        document,
        reason: '只开脚本默认约束',
        actor: { id: actor.id },
      })
    } else {
      await getOrCreatePlatformConfig(handle, { document, reason: '只开脚本默认约束' })
    }
    const target = await createTarget()
    const created = await scenarios.create({ targetId: target.id, name: '只带脚本', steps: [navigate()] }, actor)
    expect(invariantsOf((await scenarios.get(created.id)).draft?.document).map((item) => item.kind)).toEqual(['script_errors'])
  })
})
