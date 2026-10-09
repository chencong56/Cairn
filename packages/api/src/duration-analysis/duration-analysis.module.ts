import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { DurationAnalysisController } from './duration-analysis.controller'
import { DurationAnalysisService } from './duration-analysis.service'
import { DurationReportSubscriptionsController } from './duration-report-subscriptions.controller'
import { DurationReportSubscriptionsService } from './duration-report-subscriptions.service'

@Module({
  imports: [AuthModule],
  controllers: [DurationAnalysisController, DurationReportSubscriptionsController],
  providers: [DurationAnalysisService, DurationReportSubscriptionsService],
})
export class DurationAnalysisModule {}
