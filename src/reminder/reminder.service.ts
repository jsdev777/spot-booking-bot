import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { formatInTimeZone } from 'date-fns-tz';
import { InjectBot } from 'nestjs-telegraf';
import { Context, Telegraf } from 'telegraf';
import { BookingStatus, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type BookingReminder = Prisma.BookingGetPayload<{
  include: {
    resource: { include: { community: true } };
    lookingParticipants: true;
  };
}>;

@Injectable()
export class ReminderService {
  private readonly logger = new Logger(ReminderService.name);
  private missingSchemaLogged = false;

  constructor(
    private readonly prisma: PrismaService,
    @InjectBot() private readonly bot: Telegraf<Context>,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async sendUpcomingReminders(): Promise<void> {
    const now = Date.now();
    const from = new Date(now + 14 * 60 * 1000);
    const to = new Date(now + 16 * 60 * 1000);

    let bookings: BookingReminder[];
    try {
      bookings = await this.prisma.booking.findMany({
        where: {
          status: BookingStatus.ACTIVE,
          startTime: { gte: from, lte: to },
          OR: [
            { reminderSent: false },
            {
              lookingParticipants: {
                some: { reminderSent: false },
              },
            },
          ],
        },
        include: {
          resource: { include: { community: true } },
          lookingParticipants: true,
        },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2021'
      ) {
        if (!this.missingSchemaLogged) {
          this.missingSchemaLogged = true;
          this.logger.warn(
            'Таблицы в БД отсутствуют. Выполните: npx prisma migrate deploy',
          );
        }
        return;
      }
      throw e;
    }

    for (const b of bookings) {
      const tz = b.resource.timeZone;
      const localTime = formatInTimeZone(b.startTime, tz, 'HH:mm');
      const place = b.resource.name;
      const text = `Напоминание: Игра через 15 минут! ${place}, начало в ${localTime}`;
      const organizerId = Number(b.userId);

      if (!b.reminderSent) {
        try {
          await this.bot.telegram.sendMessage(organizerId, text);
          await this.prisma.booking.update({
            where: { id: b.id },
            data: { reminderSent: true },
          });
          this.logger.log(
            JSON.stringify({
              action: 'reminder_sent',
              bookingId: b.id,
              role: 'organizer',
              telegramUserId: organizerId,
              startTimeUtc: b.startTime.toISOString(),
            }),
          );
        } catch (e) {
          const err = e as {
            response?: { error_code?: number; description?: string };
          };
          this.logger.warn(
            JSON.stringify({
              action: 'reminder_failed',
              bookingId: b.id,
              role: 'organizer',
              telegramUserId: organizerId,
              error: err?.response?.description ?? String(e),
            }),
          );
        }
      }

      for (const p of b.lookingParticipants) {
        if (p.reminderSent) {
          continue;
        }
        const pid = Number(p.telegramUserId);
        if (pid === organizerId) {
          await this.prisma.bookingLookingParticipant.update({
            where: { id: p.id },
            data: { reminderSent: true },
          });
          continue;
        }
        try {
          await this.bot.telegram.sendMessage(pid, text);
          await this.prisma.bookingLookingParticipant.update({
            where: { id: p.id },
            data: { reminderSent: true },
          });
          this.logger.log(
            JSON.stringify({
              action: 'reminder_sent',
              bookingId: b.id,
              role: 'looking_participant',
              telegramUserId: pid,
              startTimeUtc: b.startTime.toISOString(),
            }),
          );
        } catch (e) {
          const err = e as {
            response?: { error_code?: number; description?: string };
          };
          this.logger.warn(
            JSON.stringify({
              action: 'reminder_failed',
              bookingId: b.id,
              role: 'looking_participant',
              telegramUserId: pid,
              error: err?.response?.description ?? String(e),
            }),
          );
        }
      }
    }
  }
}
