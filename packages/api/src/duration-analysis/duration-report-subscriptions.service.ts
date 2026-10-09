import { Inject, Injectable } from '@nestjs/common'
import {
  createDurationReportSubscription,
  deleteDurationReportSubscription,
  listDurationReportSubscriptions,
  previewDurationReportSubscription,
  updateDurationReportSubscription,
  type DbHandle,
} from '@cairn/db'
import type { CreateDurationReportSubscriptionBody, UpdateDurationReportSubscriptionBody } from '@cairn/shared'
import { DB_HANDLE } from '../db/db.module'
import { rethrowDomain } from '../common/domain-error'

/** 周期耗时报告订阅：按目标系统收窄，写操作需要 report:export；推送本身由 Worker 到点执行。 */
@Injectable()
export class DurationReportSubscriptionsService {
  constructor(@Inject(DB_HANDLE) private readonly db: DbHandle) {}

  list(targetId: string, actorId: string) {
    return listDurationReportSubscriptions(this.db, targetId, actorId).catch(rethrowDomain)
  }

  create(body: CreateDurationReportSubscriptionBody, actorId: string) {
    return createDurationReportSubscription(this.db, body, actorId).catch(rethrowDomain)
  }

  update(id: string, body: UpdateDurationReportSubscriptionBody, actorId: string) {
    return updateDurationReportSubscription(this.db, id, body, actorId).catch(rethrowDomain)
  }

  delete(id: string, actorId: string) {
    return deleteDurationReportSubscription(this.db, id, actorId).catch(rethrowDomain)
  }

  preview(id: string, actorId: string) {
    return previewDurationReportSubscription(this.db, id, actorId).catch(rethrowDomain)
  }
}
