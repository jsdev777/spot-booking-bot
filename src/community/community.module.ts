import { Module } from '@nestjs/common';
import { CommunityService } from './community.service';
import { ResourceService } from './resource.service';

@Module({
  providers: [CommunityService, ResourceService],
  exports: [CommunityService, ResourceService],
})
export class CommunityModule {}
