import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BookingStatus, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class BookingStatusCronService {
  private readonly logger = new Logger(BookingStatusCronService.name);
  private missingSchemaLogged = false;

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async reconcileStatuses(): Promise<void> {
    const now = new Date();
    try {
      const finished = await this.prisma.booking.updateMany({
        where: {
          endTime: { lte: now },
          status: { in: [BookingStatus.PENDING, BookingStatus.ACTIVE] },
        },
        data: { status: BookingStatus.FINISHED },
      });
      const activated = await this.prisma.booking.updateMany({
        where: {
          startTime: { lte: now },
          endTime: { gt: now },
          status: BookingStatus.PENDING,
        },
        data: { status: BookingStatus.ACTIVE },
      });
      if (finished.count > 0 || activated.count > 0) {
        this.logger.debug(
          JSON.stringify({
            action: 'booking_status_reconciled',
            finished: finished.count,
            activated: activated.count,
          }),
        );
      }
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2021'
      ) {
        if (!this.missingSchemaLogged) {
          this.missingSchemaLogged = true;
          this.logger.warn(
            'Таблиці в БД відсутні. Виконайте: npx prisma migrate deploy',
          );
        }
        return;
      }
      throw e;
    }
  }
}
