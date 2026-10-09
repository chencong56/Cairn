import { Module } from '@nestjs/common'
import { ObjectsModule } from '../objects/objects.module'
import { PlatformConfigModule } from '../platform-config/platform-config.module'
import { ScenariosController } from './scenarios.controller'
import { ScenariosService } from './scenarios.service'
import { TableFilePreviewService } from './table-file-preview.service'

@Module({
  imports: [PlatformConfigModule, ObjectsModule],
  controllers: [ScenariosController],
  providers: [ScenariosService, TableFilePreviewService],
})
export class ScenariosModule {}
