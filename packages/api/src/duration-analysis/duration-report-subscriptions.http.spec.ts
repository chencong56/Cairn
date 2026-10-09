import { UnauthorizedException, type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common'
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RequestAccount } from '../common/request-account'
import { AllExceptionsFilter } from '../common/all-exceptions.filter'
import { PermissionsGuard } from '../rbac/permissions.guard'
import { listenForSupertest } from '../__tests__/http-app'
import { DurationReportSubscriptionsController } from './duration-report-subscriptions.controller'
import { DurationReportSubscriptionsService } from './duration-report-subscriptions.service'

const TARGET_ID = '11111111-1111-4111-8111-111111111111'
const SUB_ID = '22222222-2222-4222-8222-222222222222'
const CHANNEL_ID = '33333333-3333-4333-8333-333333333333'

const manager: RequestAccount = {
  id: 'acc-manager',
  displayName: 'Manager',
  email: 'manager@example.com',
  status: 'active',
  roles: [],
  permissions: ['report:read', 'report:export', 'outbound:read'],
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
    list: vi.fn(async () => ({ items: [] })),
    create: vi.fn(async () => ({ id: SUB_ID })),
    update: vi.fn(async () => ({ id: SUB_ID })),
    delete: vi.fn(async () => ({ id: SUB_ID, deleted: true })),
    preview: vi.fn(async () => ({ id: 'report-1' })),
  }
}

async function buildApp(account: RequestAccount, service: ReturnType<typeof mockService>) {
  const moduleRef = await Test.createTestingModule({
    controllers: [DurationReportSubscriptionsController],
    providers: [
      Reflector,
      { provide: DurationReportSubscriptionsService, useValue: service },
      { provide: APP_GUARD, useValue: new StaticAuthGuard(account) },
      { provide: APP_GUARD, useClass: PermissionsGuard },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
    ],
  }).compile()
  const app = moduleRef.createNestApplication({ logger: false })
  await listenForSupertest(app)
  return app
}

describe('Duration report subscriptions HTTP', () => {
  const service = mockService()
  let app: INestApplication

  beforeAll(async () => {
    app = await buildApp(manager, service)
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterAll(async () => {
    await app.close()
  })

  it('新建订阅：缺省值补齐（默认不启用），非法发送时间与重复渠道被拒', async () => {
    await request(app.getHttpServer()).post('/duration-report-subscriptions').send({ targetId: TARGET_ID, period: 'week', channelIds: [CHANNEL_ID] }).expect(200)
    expect(service.create).toHaveBeenLastCalledWith(
      // 不传时区：由领域层按平台统计时区填
      { targetId: TARGET_ID, period: 'week', sendWeekday: 1, sendDay: 1, sendTime: '09:00', trigger: 'schedule', channelIds: [CHANNEL_ID], enabled: false },
      manager.id,
    )
    await request(app.getHttpServer()).post('/duration-report-subscriptions').send({ targetId: TARGET_ID, period: 'week', sendTime: '25:00' }).expect(400)
    await request(app.getHttpServer()).post('/duration-report-subscriptions').send({ targetId: TARGET_ID, period: 'week', channelIds: [CHANNEL_ID, CHANNEL_ID] }).expect(400)
    expect(service.create).toHaveBeenCalledTimes(1)
  })

  it('修改须带版本号；列表须给目标系统；删除与预览走 POST', async () => {
    await request(app.getHttpServer()).post(`/duration-report-subscriptions/${SUB_ID}`).send({ enabled: true }).expect(400)
    await request(app.getHttpServer()).post(`/duration-report-subscriptions/${SUB_ID}`).send({ expectedRevision: 2, enabled: true }).expect(200)
    expect(service.update).toHaveBeenLastCalledWith(SUB_ID, { expectedRevision: 2, enabled: true }, manager.id)
    await request(app.getHttpServer()).get('/duration-report-subscriptions').expect(400)
    await request(app.getHttpServer()).get(`/duration-report-subscriptions?targetId=${TARGET_ID}`).expect(200)
    expect(service.list).toHaveBeenLastCalledWith(TARGET_ID, manager.id)
    await request(app.getHttpServer()).post(`/duration-report-subscriptions/${SUB_ID}/delete`).expect(200)
    await request(app.getHttpServer()).post(`/duration-report-subscriptions/${SUB_ID}/preview`).expect(200)
    expect(service.delete).toHaveBeenCalledWith(SUB_ID, manager.id)
    expect(service.preview).toHaveBeenCalledWith(SUB_ID, manager.id)
  })

  it('只读报告可看列表；改订阅需要导出报告与查看消息推送权限', async () => {
    const reader = await buildApp({ ...manager, id: 'acc-reader', permissions: ['report:read'] }, service)
    await request(reader.getHttpServer()).get(`/duration-report-subscriptions?targetId=${TARGET_ID}`).expect(200)
    await request(reader.getHttpServer()).post('/duration-report-subscriptions').send({ targetId: TARGET_ID, period: 'week' }).expect(403)
    await request(reader.getHttpServer()).post(`/duration-report-subscriptions/${SUB_ID}/preview`).expect(403)
    await reader.close()
    const exporter = await buildApp({ ...manager, id: 'acc-exporter', permissions: ['report:read', 'report:export'] }, service)
    await request(exporter.getHttpServer()).post(`/duration-report-subscriptions/${SUB_ID}`).send({ expectedRevision: 1, enabled: false }).expect(403)
    await request(exporter.getHttpServer()).post(`/duration-report-subscriptions/${SUB_ID}/preview`).expect(200)
    await exporter.close()
    expect(service.create).not.toHaveBeenCalled()
    expect(service.update).not.toHaveBeenCalled()
  })
})
