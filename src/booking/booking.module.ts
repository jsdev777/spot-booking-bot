import { Module } from '@nestjs/common';
import { CommunityModule } from '../community/community.module';
import { BookingService } from './booking.service';

@Module({
  imports: [CommunityModule],
  providers: [BookingService],
  exports: [BookingService],
})
export class BookingModule {}
