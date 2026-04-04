import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TelegrafModule } from 'nestjs-telegraf';
import { BookingModule } from '../booking/booking.module';
import { CommunityModule } from '../community/community.module';
import { BotUpdate } from './bot.update';

@Module({
  imports: [
    BookingModule,
    CommunityModule,
    TelegrafModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        token: config.getOrThrow<string>('BOT_TOKEN'),
        launchOptions: {
          allowedUpdates: ['message', 'callback_query', 'my_chat_member'],
        },
      }),
      inject: [ConfigService],
    }),
  ],
  providers: [BotUpdate],
  exports: [TelegrafModule],
})
export class BotModule {}
