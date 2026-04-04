import { Module } from '@nestjs/common';
import { CommunityModule } from '../community/community.module';
import { BookingStatusCronService } from './booking-status.cron.service';
import { BookingService } from './booking.service';

@Module({
  imports: [CommunityModule],
  providers: [BookingService, BookingStatusCronService],
  exports: [BookingService],
})
export class BookingModule {}
