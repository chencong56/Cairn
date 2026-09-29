import { Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common'
import { RequirePermissions } from '../rbac/require-permission.decorator'
import { ReliabilityService } from './reliability.service'

@Controller('maintenance')
export class MaintenanceAcceptanceController {
  constructor(private readonly reliability: ReliabilityService) {}

  @Get('acceptance-coverage')
  @RequirePermissions('reliability:read')
  getCoverage() {
    return this.reliability.getAcceptanceCoverage()
  }

  @Post('acceptance-sweeps')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('reliability:triage')
  triggerSweep() {
    return this.reliability.triggerAcceptanceSweep()
  }
}
