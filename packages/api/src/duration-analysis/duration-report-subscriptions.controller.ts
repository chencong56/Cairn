import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common'
import { z } from 'zod'
import {
  createDurationReportSubscriptionBodySchema,
  entityIdSchema,
  updateDurationReportSubscriptionBodySchema,
  type CreateDurationReportSubscriptionBody,
  type UpdateDurationReportSubscriptionBody,
} from '@cairn/shared'
import type { RequestAccount } from '../common/request-account'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import { CurrentAccount } from '../rbac/current-account.decorator'
import { RequirePermissions } from '../rbac/require-permission.decorator'
import { DurationReportSubscriptionsService } from './duration-report-subscriptions.service'

const listQuerySchema = z.object({ targetId: entityIdSchema })

@Controller('duration-report-subscriptions')
export class DurationReportSubscriptionsController {
  constructor(private readonly subscriptions: DurationReportSubscriptionsService) {}

  @Get()
  @RequirePermissions('report:read')
  list(@Query(new ZodValidationPipe(listQuerySchema)) query: { targetId: string }, @CurrentAccount() actor: RequestAccount) {
    return this.subscriptions.list(query.targetId, actor.id)
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('report:export', 'outbound:read')
  create(@Body(new ZodValidationPipe(createDurationReportSubscriptionBodySchema)) body: CreateDurationReportSubscriptionBody, @CurrentAccount() actor: RequestAccount) {
    return this.subscriptions.create(body, actor.id)
  }

  @Post(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('report:export', 'outbound:read')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateDurationReportSubscriptionBodySchema)) body: UpdateDurationReportSubscriptionBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.subscriptions.update(id, body, actor.id)
  }

  @Post(':id/delete')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('report:export', 'outbound:read')
  delete(@Param('id') id: string, @CurrentAccount() actor: RequestAccount) {
    return this.subscriptions.delete(id, actor.id)
  }

  /** 立即为最近一期生成报告（不推送），用于启用前确认内容。 */
  @Post(':id/preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('report:export')
  preview(@Param('id') id: string, @CurrentAccount() actor: RequestAccount) {
    return this.subscriptions.preview(id, actor.id)
  }
}
