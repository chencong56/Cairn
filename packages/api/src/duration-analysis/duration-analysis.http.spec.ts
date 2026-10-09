import { UnauthorizedException, type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common'
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RequestAccount } from '../common/request-account'
import { AllExceptionsFilter } from '../common/all-exceptions.filter'
import { PermissionsGuard } from '../rbac/permissions.guard'
import { listenForSupertest } from '../__tests__/http-app'
import { DurationAnalysisController } from './duration-analysis.controller'
import { DurationAnalysisService } from './duration-analysis.service'

const TARGET_ID = '11111111-1111-4111-8111-111111111111'
const SCENARIO_ID = '33333333-3333-4333-8333-333333333333'
const SUITE_ID = '55555555-5555-4555-8555-555555555555'

const reader: RequestAccount = {
  id: 'acc-reader',
  displayName: 'Reader',
  email: 'reader@example.com',
  status: 'active',
  roles: [],
  permissions: ['run:read'],
}

class StaticAuthGuard implements CanActivate {
  constructor(private readonly account: RequestAccount) {}
  canActivate(context: ExecutionContext): boolean {
    if (!this.account) throw new UnauthorizedException('未认证')
    context.switchToHttp().getRequest().account = this.account
    return true
  }
}

function mockService() {
  return {
    target: vi.fn(async () => ({ scenarios: [] })),
    scenario: vi.fn(async () => ({ nodes: [] })),
    node: vi.fn(async () => ({ points: [] })),
  }
}

async function buildApp(account: RequestAccount, service: ReturnType<typeof mockService>) {
  const moduleRef = await Test.createTestingModule({
    controllers: [DurationAnalysisController],
    providers: [
      Reflector,
      { provide: DurationAnalysisService, useValue: service },
      { provide: APP_GUARD, useValue: new StaticAuthGuard(account) },
      { provide: APP_GUARD, useClass: PermissionsGuard },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
    ],
  }).compile()
  const app = moduleRef.createNestApplication({ logger: false })
  await listenForSupertest(app)
  return app
}

describe('Duration analysis HTTP', () => {
  const service = mockService()
  let app: INestApplication

  beforeAll(async () => {
    app = await buildApp(reader, service)
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterAll(async () => {
    await app.close()
  })

  it('按目标系统：默认 30 天、按天、环比、全部发起方；可带场景集', async () => {
    await request(app.getHttpServer()).get(`/duration-analysis/targets/${TARGET_ID}`).expect(200)
    expect(service.target).toHaveBeenLastCalledWith(TARGET_ID, { days: 30, granularity: 'day', compare: 'prev_period', trigger: 'all' }, reader.id)
    await request(app.getHttpServer())
      .get(`/duration-analysis/targets/${TARGET_ID}?days=90&granularity=week&compare=last_week&trigger=schedule&suiteId=${SUITE_ID}&tz=Asia/Shanghai`)
      .expect(200)
    expect(service.target).toHaveBeenLastCalledWith(
      TARGET_ID,
      { days: 90, granularity: 'week', compare: 'last_week', trigger: 'schedule', suiteId: SUITE_ID, tz: 'Asia/Shanghai' },
      reader.id,
    )
  })

  it('非法时间窗、对比方式与场景集 id 被拒', async () => {
    await request(app.getHttpServer()).get(`/duration-analysis/targets/${TARGET_ID}?days=14`).expect(400)
    await request(app.getHttpServer()).get(`/duration-analysis/scenarios/${SCENARIO_ID}?compare=yesterday`).expect(400)
    await request(app.getHttpServer()).get(`/duration-analysis/targets/${TARGET_ID}?suiteId=not-a-uuid`).expect(400)
    expect(service.target).not.toHaveBeenCalled()
    expect(service.scenario).not.toHaveBeenCalled()
  })

  it('自然周期参数：周 / 月与起点日期校验后传给服务', async () => {
    await request(app.getHttpServer()).get(`/duration-analysis/targets/${TARGET_ID}?period=week&periodStart=2026-09-28&compare=last_year`).expect(200)
    expect(service.target).toHaveBeenLastCalledWith(TARGET_ID, expect.objectContaining({ period: 'week', periodStart: '2026-09-28', compare: 'last_year' }), reader.id)
    await request(app.getHttpServer()).get(`/duration-analysis/targets/${TARGET_ID}?period=day`).expect(400)
    await request(app.getHttpServer()).get(`/duration-analysis/scenarios/${SCENARIO_ID}?period=month&periodStart=2026-02-30`).expect(400)
  })

  it('节点历史必须给出节点键（键含冒号与斜杠，走查询参数）', async () => {
    await request(app.getHttpServer()).get(`/duration-analysis/scenarios/${SCENARIO_ID}/node`).expect(400)
    const nodeKey = 'module:abc/step:def'
    await request(app.getHttpServer()).get(`/duration-analysis/scenarios/${SCENARIO_ID}/node?nodeKey=${encodeURIComponent(nodeKey)}&days=7`).expect(200)
    expect(service.node).toHaveBeenLastCalledWith(SCENARIO_ID, expect.objectContaining({ nodeKey, days: 7 }), reader.id)
  })

  it('没有 run:read 一律拒绝', async () => {
    const noRead = await buildApp({ ...reader, id: 'acc-none', permissions: ['target:read'] }, service)
    await request(noRead.getHttpServer()).get(`/duration-analysis/targets/${TARGET_ID}`).expect(403)
    await request(noRead.getHttpServer()).get(`/duration-analysis/scenarios/${SCENARIO_ID}`).expect(403)
    await request(noRead.getHttpServer()).get(`/duration-analysis/scenarios/${SCENARIO_ID}/node?nodeKey=step:a`).expect(403)
    await noRead.close()
    expect(service.target).not.toHaveBeenCalled()
    expect(service.scenario).not.toHaveBeenCalled()
    expect(service.node).not.toHaveBeenCalled()
  })
})
