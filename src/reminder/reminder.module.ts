import { Module } from '@nestjs/common';
import { ReminderService } from './reminder.service';
import { BotModule } from '../bot/bot.module';

@Module({
  imports: [BotModule],
  providers: [ReminderService],
})
export class ReminderModule {}
