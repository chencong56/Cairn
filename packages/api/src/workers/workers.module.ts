import { Module } from '@nestjs/common'
import { WorkersController } from './workers.controller'
import { WorkersService } from './workers.service'
import { WorkerNodeHealthClient } from './node-health.client'

@Module({
  controllers: [WorkersController],
  providers: [WorkersService, WorkerNodeHealthClient],
})
export class WorkersModule {}
