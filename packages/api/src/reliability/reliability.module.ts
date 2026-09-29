import { Module } from '@nestjs/common'
import { MaintenanceAcceptanceController } from './maintenance-acceptance.controller'
import {
  ReliabilityAssetsController,
  ReliabilityIncidentsController,
  ReliabilityUpgradeJobsController,
  TargetReliabilityController,
} from './reliability.controller'
import { ReliabilityService } from './reliability.service'

@Module({
  controllers: [
    TargetReliabilityController,
    ReliabilityAssetsController,
    ReliabilityIncidentsController,
    ReliabilityUpgradeJobsController,
    MaintenanceAcceptanceController,
  ],
  providers: [ReliabilityService],
  exports: [ReliabilityService],
})
export class ReliabilityModule {}
