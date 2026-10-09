import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import {
  createSuiteRunBodySchema,
  deleteResourceBodySchema,
  rerunSuiteItemBodySchema,
  suiteRunListQuerySchema,
  type CreateSuiteRunBody,
  type DeleteResourceBody,
  type RerunSuiteItemBody,
  type SuiteRunListQuery,
} from '@cairn/shared'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import type { RequestAccount } from '../common/request-account'
import { CurrentAccount } from '../rbac/current-account.decorator'
import { RequirePermissions } from '../rbac/require-permission.decorator'
import { SuiteRunsService } from './suite-runs.service'
import { cleanupAcceptedStatus } from '../common/cleanup-status'

@Controller('suite-runs')
export class SuiteRunsController {
  constructor(private readonly suiteRuns: SuiteRunsService) {}

  @Get()
  @RequirePermissions('suite:read')
  list(@Query(new ZodValidationPipe(suiteRunListQuerySchema)) query: SuiteRunListQuery, @CurrentAccount() account: RequestAccount) {
    return this.suiteRuns.list(query, account.id)
  }

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('run:execute', 'suite:read')
  preview(@Body(new ZodValidationPipe(createSuiteRunBodySchema)) body: CreateSuiteRunBody, @CurrentAccount() account: RequestAccount) {
    return this.suiteRuns.preview(body, account.id)
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('run:execute', 'suite:read')
  create(@Body(new ZodValidationPipe(createSuiteRunBodySchema)) body: CreateSuiteRunBody, @CurrentAccount() account: RequestAccount) {
    return this.suiteRuns.create(body, account)
  }

  @Get(':suiteRunId/observation')
  @RequirePermissions('suite:read')
  observation(@Param('suiteRunId') suiteRunId: string, @CurrentAccount() account: RequestAccount) {
    return this.suiteRuns.observation(suiteRunId, account.id)
  }

  @Get(':suiteRunId/duration')
  @RequirePermissions('suite:read', 'run:read')
  duration(@Param('suiteRunId') suiteRunId: string, @CurrentAccount() account: RequestAccount) {
    return this.suiteRuns.duration(suiteRunId, account.id)
  }

  @Get(':suiteRunId/events')
  @RequirePermissions('suite:read')
  events(
    @Param('suiteRunId') suiteRunId: string,
    @CurrentAccount() account: RequestAccount,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.suiteRuns.stream(suiteRunId, account.id, req, res)
  }

  @Post(':suiteRunId/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('run:cancel', 'suite:read')
  cancel(@Param('suiteRunId') suiteRunId: string, @CurrentAccount() account: RequestAccount) {
    return this.suiteRuns.cancel(suiteRunId, account)
  }

  @Post(':suiteRunId/rerun-item')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('run:execute', 'suite:read')
  rerunItem(
    @Param('suiteRunId') suiteRunId: string,
    @Body(new ZodValidationPipe(rerunSuiteItemBodySchema)) body: RerunSuiteItemBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.suiteRuns.rerunItem(suiteRunId, body, account)
  }

  @Get(':suiteRunId/delete-preview')
  @RequirePermissions('run:delete', 'suite:read')
  previewDelete(@Param('suiteRunId') suiteRunId: string) {
    return this.suiteRuns.previewDelete(suiteRunId)
  }

  @Post(':suiteRunId/delete')
  @RequirePermissions('run:delete', 'suite:read')
  async delete(
    @Param('suiteRunId') suiteRunId: string,
    @CurrentAccount() actor: RequestAccount,
    @Body(new ZodValidationPipe(deleteResourceBodySchema.optional())) body: DeleteResourceBody | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const cleanup = await this.suiteRuns.delete(suiteRunId, actor, body)
    res.status(cleanupAcceptedStatus(cleanup))
    return cleanup
  }

  @Get(':suiteRunId/cleanup')
  @RequirePermissions('run:read', 'suite:read')
  cleanupStatus(@Param('suiteRunId') suiteRunId: string) {
    return this.suiteRuns.cleanupStatus(suiteRunId)
  }
}
