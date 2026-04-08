import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { BookingModule } from './booking/booking.module';
import { BotModule } from './bot/bot.module';
import { HealthController } from './health/health.controller';
import { MetricsModule } from './metrics/metrics.module';
import { PrismaModule } from './prisma/prisma.module';
import { ReminderModule } from './reminder/reminder.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
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
