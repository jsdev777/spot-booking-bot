import { Module } from '@nestjs/common';
import { CommunityModule } from '../community/community.module';
import { BookingStatusCronService } from './booking-status.cron.service';
import { BookingService } from './booking.service';
import { RecurringBookingService } from './recurring-booking.service';

@Module({
  imports: [CommunityModule],
  providers: [
    BookingService,
    BookingStatusCronService,
    RecurringBookingService,
  ],
  exports: [BookingService, RecurringBookingService],
})
export class BookingModule {}
