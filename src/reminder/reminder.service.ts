import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { formatInTimeZone } from 'date-fns-tz';
import { I18nService } from 'nestjs-i18n';
import { InjectBot } from 'nestjs-telegraf';
import { Context, Telegraf } from 'telegraf';
import { BookingStatus, Prisma } from '@prisma/client';
import { TelegramMembersService } from '../community/telegram-members.service';
import { resolveUiLang } from '../i18n/resolve-ui-lang';
import { MetricsService } from '../metrics/metrics.service';
import { PrismaService } from '../prisma/prisma.service';

const REMINDER_SEND_CONCURRENCY = 6;
const MAX_429_RETRIES = 2;

type BookingReminder = Prisma.BookingGetPayload<{
  include: {
    resource: true;
    lookingParticipants: true;
    communityResource: { include: { community: true } };
  };
}>;

@Injectable()
export class ReminderService {
  private readonly logger = new Logger(ReminderService.name);
  private missingSchemaLogged = false;

  constructor(
    private readonly prisma: PrismaService,
    @InjectBot() private readonly bot: Telegraf<Context>,
    private readonly metrics: MetricsService,
    private readonly telegramMembers: TelegramMembersService,
    private readonly i18n: I18nService,
  ) {}

  private async uiLangInCommunity(
    telegramChatId: bigint,
    telegramUserId: number,
  ): Promise<string> {
    const id = await this.telegramMembers.getEffectiveLanguageId({
      telegramChatId,
      telegramUserId,
    });
    return resolveUiLang(id);
  }

  private reminderText(lang: string, place: string, localTime: string): string {
    return this.i18n.t('bot.reminder.upcoming' as never, {
      lang,
      args: { place, time: localTime },
    });
  }

  private async sendMessageWithBackoff(
    telegramUserId: number,
    text: string,
  ): Promise<void> {
    let attempt = 0;
    while (true) {
      try {
        await this.bot.telegram.sendMessage(telegramUserId, text);
        this.metrics.incTelegramSend('success', 'reminder');
        return;
      } catch (e) {
        const err = e as {
          response?: {
            error_code?: number;
            description?: string;
            parameters?: { retry_after?: number };
          };
        };
        const retryAfterSec = err.response?.parameters?.retry_after ?? 1;
        const isRateLimit = err.response?.error_code === 429;
        if (!isRateLimit || attempt >= MAX_429_RETRIES) {
          this.metrics.incTelegramSend('error', 'reminder');
          throw e;
        }
        this.metrics.incTelegramRetry('reminder');
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(1, retryAfterSec) * 1000),
        );
        attempt += 1;
      }
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async sendUpcomingReminders(): Promise<void> {
    const startedAtMs = Date.now();
    const now = Date.now();
    const from = new Date(now + 14 * 60 * 1000);
    const to = new Date(now + 16 * 60 * 1000);

    let bookings: BookingReminder[];
    try {
      bookings = await this.prisma.booking.findMany({
        where: {
          status: { in: [BookingStatus.PENDING, BookingStatus.ACTIVE] },
          endTime: { gt: new Date(now) },
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
          resource: true,
          lookingParticipants: true,
          communityResource: { include: { community: true } },
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
            'Таблиці в БД відсутні. Виконайте: npx prisma migrate deploy',
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
      const groupChatId = b.communityResource.community.telegramChatId;
      const organizerId = Number(b.userId);
      const organizerLang = await this.uiLangInCommunity(
        groupChatId,
        organizerId,
      );
      const organizerText = this.reminderText(
        organizerLang,
        place,
        localTime,
      );

      const participantTargets = b.lookingParticipants
        .filter((p) => !p.reminderSent)
        .map((p) => ({
          participantId: p.id,
          telegramUserId: Number(p.telegramUserId),
        }));
      const batches: Array<
        Array<{ participantId: string; telegramUserId: number }>
      > = [];
      for (let i = 0; i < participantTargets.length; i += REMINDER_SEND_CONCURRENCY) {
        batches.push(participantTargets.slice(i, i + REMINDER_SEND_CONCURRENCY));
      }

      if (!b.reminderSent) {
        try {
          await this.sendMessageWithBackoff(organizerId, organizerText);
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

      for (const batch of batches) {
        await Promise.all(
          batch.map(async ({ participantId, telegramUserId }) => {
            if (telegramUserId === organizerId) {
              await this.prisma.bookingLookingParticipant.update({
                where: { id: participantId },
                data: { reminderSent: true },
              });
              return;
            }
            try {
              const pLang = await this.uiLangInCommunity(
                groupChatId,
                telegramUserId,
              );
              const pText = this.reminderText(pLang, place, localTime);
              await this.sendMessageWithBackoff(telegramUserId, pText);
              await this.prisma.bookingLookingParticipant.update({
                where: { id: participantId },
                data: { reminderSent: true },
              });
              this.logger.log(
                JSON.stringify({
                  action: 'reminder_sent',
                  bookingId: b.id,
                  role: 'looking_participant',
                  telegramUserId,
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
                  telegramUserId,
                  error: err?.response?.description ?? String(e),
                }),
              );
            }
          }),
        );
      }
    }
    this.logger.debug(
      JSON.stringify({
        action: 'reminder_batch_processed',
        bookings: bookings.length,
        elapsedMs: Date.now() - startedAtMs,
      }),
    );
    this.metrics.observeReminderBatchDuration(Date.now() - startedAtMs);
  }
}
