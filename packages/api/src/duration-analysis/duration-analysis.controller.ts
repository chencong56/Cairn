import { Controller, Get, Param, Query } from '@nestjs/common'
import {
  durationAnalysisQuerySchema,
  nodeDurationChildrenQuerySchema,
  nodeDurationHistoryQuerySchema,
  targetDurationAnalysisQuerySchema,
  type DurationAnalysisQueryParsed,
  type NodeDurationChildrenQueryParsed,
  type NodeDurationHistoryQueryParsed,
  type TargetDurationAnalysisQueryParsed,
} from '@cairn/shared'
import type { RequestAccount } from '../common/request-account'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import { CurrentAccount } from '../rbac/current-account.decorator'
import { RequirePermissions } from '../rbac/require-permission.decorator'
import { DurationAnalysisService } from './duration-analysis.service'

@Controller('duration-analysis')
export class DurationAnalysisController {
  constructor(private readonly analysis: DurationAnalysisService) {}

  @Get('targets/:targetId')
  @RequirePermissions('run:read')
  target(
    @Param('targetId') targetId: string,
    @Query(new ZodValidationPipe(targetDurationAnalysisQuerySchema)) query: TargetDurationAnalysisQueryParsed,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.analysis.target(targetId, query, actor.id)
  }

  @Get('scenarios/:scenarioId')
  @RequirePermissions('run:read')
  scenario(
    @Param('scenarioId') scenarioId: string,
    @Query(new ZodValidationPipe(durationAnalysisQuerySchema)) query: DurationAnalysisQueryParsed,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.analysis.scenario(scenarioId, query, actor.id)
  }

  @Get('scenarios/:scenarioId/node')
  @RequirePermissions('run:read')
  node(
    @Param('scenarioId') scenarioId: string,
    @Query(new ZodValidationPipe(nodeDurationHistoryQuerySchema)) query: NodeDurationHistoryQueryParsed,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.analysis.node(scenarioId, query, actor.id)
  }

  /** 节点表展开某一行：读它的子节点（单场景明细）。 */
  @Get('scenarios/:scenarioId/children')
  @RequirePermissions('run:read')
  children(
    @Param('scenarioId') scenarioId: string,
    @Query(new ZodValidationPipe(nodeDurationChildrenQuerySchema)) query: NodeDurationChildrenQueryParsed,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.analysis.children(scenarioId, query, actor.id)
  }
}
