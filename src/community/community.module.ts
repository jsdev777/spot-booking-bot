import { Module } from '@nestjs/common';
import { CommunityService } from './community.service';
import { ResourceService } from './resource.service';
import { TelegramMembersService } from './telegram-members.service';

@Module({
  providers: [CommunityService, ResourceService, TelegramMembersService],
  exports: [CommunityService, ResourceService, TelegramMembersService],
})
export class CommunityModule {}
