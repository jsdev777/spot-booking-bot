import { Module } from '@nestjs/common';
import { ReminderService } from './reminder.service';
import { BotModule } from '../bot/bot.module';
import { CommunityModule } from '../community/community.module';

@Module({
  imports: [BotModule, CommunityModule],
  providers: [ReminderService],
})
export class ReminderModule {}
