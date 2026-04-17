import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import * as path from 'node:path';
import { HeaderResolver, I18nModule } from 'nestjs-i18n';
import { BookingModule } from './booking/booking.module';
import { BotModule } from './bot/bot.module';
import { HealthController } from './health/health.controller';
import { MetricsModule } from './metrics/metrics.module';
import { PrismaModule } from './prisma/prisma.module';
import { ReminderModule } from './reminder/reminder.module';
import { UI_FALLBACK_LANGUAGE } from './i18n/resolve-ui-lang';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    {
      ...I18nModule.forRoot({
        fallbackLanguage: UI_FALLBACK_LANGUAGE,
        loaderOptions: {
          path: path.join(__dirname, '..', 'i18n'),
          watch: process.env.NODE_ENV !== 'production',
        },
        resolvers: [{ use: HeaderResolver, options: ['x-spot-booking-lang'] }],
        disableMiddleware: true,
        logging: false,
      }),
      global: true,
    },
    ScheduleModule.forRoot(),
    MetricsModule,
    PrismaModule,
    BookingModule,
    BotModule,
    ReminderModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
