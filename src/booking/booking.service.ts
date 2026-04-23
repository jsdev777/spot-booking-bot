import { Injectable, Logger } from '@nestjs/common';
import { I18nService } from 'nestjs-i18n';
import {
  addMinutes,
  addDays,
  differenceInMinutes,
  set,
  startOfDay,
} from 'date-fns';
import { formatInTimeZone, fromZonedTime, toZonedTime } from 'date-fns-tz';
import { BookingStatus, Prisma, SportKindCode } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ResourceService } from '../community/resource.service';
import { MetricsService } from '../metrics/metrics.service';
import {
  RecurringBookingOccurrence,
  RecurringBookingService,
} from './recurring-booking.service';
import {
  BookingNotFoundError,
  BookingWindowClosedError,
  SlotInPastError,
  SlotTakenError,
  UserDailyBookingLimitExceededError,
} from './booking.errors';
import { isLocalTimeWithinBookingWindow } from './booking-window';
import {
  BOOKING_DURATION_MINUTES,
  BookingDurationMinutes,
  hourSegmentOccupancy,
  intervalsOverlap,
} from './booking-intervals';
import {
  isoWeekdayInTimeZone,
  resolveResourceDaySchedule,
} from './resource-schedule';
import { isStartSlotBookable } from './slots';

/** Bookings that still hold the resource slot (not ended, not cancelled). */
const OCCUPIED_BOOKING_STATUSES: BookingStatus[] = [
  BookingStatus.PENDING,
  BookingStatus.ACTIVE,
];

/** Non-cancelled bookings for the same calendar day count toward the daily minute cap. */
const DAILY_LIMIT_BOOKING_STATUSES: BookingStatus[] = [
  BookingStatus.PENDING,
  BookingStatus.ACTIVE,
  BookingStatus.FINISHED,
];

type DayBookingWithSport = Prisma.BookingGetPayload<{
  include: { sportKind: true };
}>;

type LoadedResourceDayBookings = {
  res: NonNullable<Awaited<ReturnType<ResourceService['findByIdForChat']>>>;
  timeZone: string;
  dayClosed: boolean;
  slotStartHour: number;
  slotEndHour: number;
  localDay: Date;
  windowStartUtc: Date;
  maxEndUtc: Date;
  bookings: DayBookingWithSport[];
  recurringOccurrences: RecurringBookingOccurrence[];
};

/** Local start time of the reservation (in 30-minute increments: :00 and :30). */
export type BookingStartSlot = { hour: number; minute: number };

/** Who should be notified via private message and what should be sent after the organizer cancels the reservation. */
export type BookingCancelNotification = {
  recipientTelegramIds: number[];
  cancelNoticeText: string;
  resourceId: string;
  resourceName: string;
  timeZone: string;
  startTime: Date;
  endTime: Date;
  sportKindCode: SportKindCode;
};

export type TelegramFrom = {
  id: number;
  username?: string;
  first_name?: string;
};

function localDayAnchor(now: Date, dayOffset: number, timeZone: string): Date {
  const zonedNow = toZonedTime(now, timeZone);
  const localDayStart = startOfDay(zonedNow);
  return addDays(localDayStart, dayOffset);
}

function isBookingOverlapDbError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return false;
  }
  const metaText = JSON.stringify(error.meta ?? {});
  return (
    (error.code === 'P2004' || error.code === 'P2010') &&
    (metaText.includes('bookings_no_overlap_pending_active') ||
      metaText.includes('bookings_overlap_blocked'))
  );
}

function atLocalHour(
  localDay: Date,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const local = set(localDay, {
    hours: hour,
    minutes: minute,
    seconds: 0,
    milliseconds: 0,
  });
  return fromZonedTime(local, timeZone);
}

function localDayUtcRange(
  startTimeUtc: Date,
  timeZone: string,
): { dayStartUtc: Date; nextDayStartUtc: Date } {
  const local = toZonedTime(startTimeUtc, timeZone);
  const localStart = startOfDay(local);
  const localNext = addDays(localStart, 1);
  return {
    dayStartUtc: fromZonedTime(localStart, timeZone),
    nextDayStartUtc: fromZonedTime(localNext, timeZone),
  };
}

@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);
  private readonly createGate = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly resources: ResourceService,
    private readonly recurringBookings: RecurringBookingService,
    private readonly metrics: MetricsService,
    private readonly i18n: I18nService,
  ) {}

  private hasClashWithOccupiedIntervals(
    start: Date,
    end: Date,
    bookings: Pick<DayBookingWithSport, 'startTime' | 'endTime'>[],
    recurringOccurrences: Pick<RecurringBookingOccurrence, 'startTime' | 'endTime'>[],
  ): boolean {
    return (
      bookings.some((b) => intervalsOverlap(start, end, b.startTime, b.endTime)) ||
      recurringOccurrences.some((r) =>
        intervalsOverlap(start, end, r.startTime, r.endTime),
      )
    );
  }

  private uiT(
    lang: string,
    key: string,
    args?: Record<string, string | number>,
  ): string {
    return this.i18n.t(`bot.${key}` as never, {
      lang,
      args: args as Record<string, string>,
    });
  }

  /** Telegram @username, first name, or localized “player” fallback for stored display. */
  private displayBookerName(from: TelegramFrom, lang: string): string {
    const uname = from.username?.trim();
    if (uname) {
      return `@${uname}`;
    }
    const fn = from.first_name?.trim();
    if (fn) {
      return fn;
    }
    return this.uiT(lang, 'setup.adminPlayerFallback');
  }

  private reserveCreateGate(
    key: string,
    ttlMs = 500,
    nowMs = Date.now(),
  ): boolean {
    const lockedUntil = this.createGate.get(key);
    if (lockedUntil != null && lockedUntil > nowMs) {
      return false;
    }
    const expiresAt = nowMs + ttlMs;
    this.createGate.set(key, expiresAt);
    setTimeout(() => {
      if (this.createGate.get(key) === expiresAt) {
        this.createGate.delete(key);
      }
    }, ttlMs);
    return true;
  }

  /**
   * The `community_resource_user_booking_limits` limit for the day of the week and the calendar start date
   * of the booking in the venue's time zone (`limitTimeZone`). `null` means no limit.
   */
  private async resourceUserBookingLimitState(params: {
    communityResourceId: string;
    resourceId: string;
    telegramUserId: number;
    startTimeUtc: Date;
    limitTimeZone: string;
  }): Promise<{ cap: number; used: number } | null> {
    const limits = await this.prisma.communityResourceUserBookingLimit.findMany(
      {
        where: { communityResourceId: params.communityResourceId },
      },
    );
    const isoWeekday = Number(
      formatInTimeZone(params.startTimeUtc, params.limitTimeZone, 'i'),
    );
    const cap = limits.find((l) => l.weekday === isoWeekday)?.maxMinutes;
    if (cap == null) {
      return null;
    }
    const dayKey = formatInTimeZone(
      params.startTimeUtc,
      params.limitTimeZone,
      'yyyy-MM-dd',
    );
    const { dayStartUtc, nextDayStartUtc } = localDayUtcRange(
      params.startTimeUtc,
      params.limitTimeZone,
    );
    const sameUserBookings = await this.prisma.booking.findMany({
      where: {
        status: { in: DAILY_LIMIT_BOOKING_STATUSES },
        userId: BigInt(params.telegramUserId),
        communityResourceId: params.communityResourceId,
        resourceId: params.resourceId,
        startTime: { gte: dayStartUtc, lt: nextDayStartUtc },
      },
      select: { startTime: true, endTime: true },
    });
    let used = 0;
    for (const b of sameUserBookings) {
      if (
        formatInTimeZone(b.startTime, params.limitTimeZone, 'yyyy-MM-dd') ===
        dayKey
      ) {
        used += differenceInMinutes(b.endTime, b.startTime);
      }
    }
    return { cap, used };
  }

  private async loadResourceDayBookings(params: {
    resourceId: string;
    telegramChatId: bigint;
    dayOffset: number;
    now?: Date;
    /**
     * Telegram chat administrators or creators: are not restricted by the booking_window_* fields in Community
     * and can make reservations on hidden platforms.
     */
    telegramGroupAdmin?: boolean;
    /**
     * Daily schedule: The booking_window_* field is not validated (neither for users nor for admins).
     */
    forDayGridDisplay?: boolean;
  }): Promise<LoadedResourceDayBookings | null> {
    const admin = !!params.telegramGroupAdmin;
    const res = await this.resources.findByIdForChat(
      params.resourceId,
      params.telegramChatId,
      {
        onlyActive: !admin,
      },
    );
    if (!res) {
      return null;
    }
    const { timeZone, workingHours } = res;
    const now = params.now ?? new Date();
    const enforceCommunityBookingWindow = !admin && !params.forDayGridDisplay;
    if (enforceCommunityBookingWindow) {
      const c = res.community;
      if (
        !isLocalTimeWithinBookingWindow({
          now,
          timeZone: c.bookingWindowTimeZone,
          startHour: c.bookingWindowStartHour,
          endHour: c.bookingWindowEndHour,
        })
      ) {
        throw new BookingWindowClosedError();
      }
    }
    const localDay = localDayAnchor(now, params.dayOffset, timeZone);
    const isoWeekday = isoWeekdayInTimeZone(localDay, timeZone);
    const schedule = resolveResourceDaySchedule(workingHours, isoWeekday);
    const dayClosed = schedule.kind === 'closed';
    let slotStartHour: number;
    let slotEndHour: number;
    let windowStartUtc: Date;
    let maxEndUtc: Date;
    if (dayClosed) {
      slotStartHour = 0;
      slotEndHour = -1;
      windowStartUtc = atLocalHour(localDay, 0, 0, timeZone);
      maxEndUtc = atLocalHour(addDays(localDay, 1), 0, 0, timeZone);
    } else {
      slotStartHour = schedule.slotStartHour;
      slotEndHour = schedule.slotEndHour;
      windowStartUtc = atLocalHour(localDay, slotStartHour, 0, timeZone);
      maxEndUtc = atLocalHour(localDay, slotEndHour + 1, 0, timeZone);
    }

    const bookings = await this.prisma.booking.findMany({
      where: {
        resourceId: params.resourceId,
        status: { in: OCCUPIED_BOOKING_STATUSES },
        startTime: { lt: maxEndUtc },
        endTime: { gt: windowStartUtc },
      },
      include: { sportKind: true },
      orderBy: { startTime: 'asc' },
    });
    const recurringOccurrences =
      await this.recurringBookings.listRuleOccurrencesForDay({
        resourceId: params.resourceId,
        localDay,
        timeZone,
        windowStartUtc,
        maxEndUtc,
      });

    return {
      res,
      timeZone,
      dayClosed,
      slotStartHour,
      slotEndHour,
      localDay,
      windowStartUtc,
      maxEndUtc,
      bookings,
      recurringOccurrences,
    };
  }

  /**
   * Start times (:00 and :30) where at least one duration (1 / 1.5 / 2 hours)
   * fits within the working window and does not overlap with reservations.
   */
  async getAvailableStartSlots(params: {
    resourceId: string;
    telegramChatId: bigint;
    dayOffset: number;
    now?: Date;
    /** Telegram group admin/creator — outside the booking_window_* window in communities. */
    telegramGroupAdmin?: boolean;
  }): Promise<BookingStartSlot[]> {
    const startedAtMs = Date.now();
    let ctx: LoadedResourceDayBookings | null = null;
    try {
      ctx = await this.loadResourceDayBookings(params);
    } catch (e) {
      if (e instanceof BookingWindowClosedError) {
        return [];
      }
      throw e;
    }
    if (!ctx) {
      return [];
    }
    if (ctx.dayClosed) {
      return [];
    }
    const {
      timeZone,
      slotStartHour,
      slotEndHour,
      localDay,
      maxEndUtc,
      windowStartUtc,
      bookings,
      recurringOccurrences,
    } = ctx;
    const now = params.now ?? new Date();

    const result: BookingStartSlot[] = [];
    for (let h = slotStartHour; h <= slotEndHour; h++) {
      for (const m of [0, 30] as const) {
        if (!isStartSlotBookable(h, m, slotStartHour, slotEndHour)) {
          continue;
        }
        const t0 = atLocalHour(localDay, h, m, timeZone);
        if (t0 >= maxEndUtc || t0 < windowStartUtc) {
          continue;
        }
        if (params.dayOffset === 0 && t0 <= now) {
          continue;
        }
        let ok = false;
        for (const dur of BOOKING_DURATION_MINUTES) {
          const end = addMinutes(t0, dur);
          if (end > maxEndUtc) {
            continue;
          }
          const clash = this.hasClashWithOccupiedIntervals(
            t0,
            end,
            bookings,
            recurringOccurrences,
          );
          if (!clash) {
            ok = true;
            break;
          }
        }
        if (ok) {
          result.push({ hour: h, minute: m });
        }
      }
    }
    result.sort((a, b) => a.hour - b.hour || a.minute - b.minute);
    this.metrics.observeBookingSlotsBuildDuration(Date.now() - startedAtMs);
    this.logger.debug(
      JSON.stringify({
        action: 'booking_available_start_slots_built',
        resourceId: params.resourceId,
        telegramChatId: params.telegramChatId.toString(),
        dayOffset: params.dayOffset,
        slots: result.length,
        elapsedMs: Date.now() - startedAtMs,
      }),
    );
    return result;
  }

  async getAvailableDurationsMinutes(params: {
    resourceId: string;
    telegramChatId: bigint;
    dayOffset: number;
    startHour: number;
    startMinute: number;
    now?: Date;
    telegramGroupAdmin?: boolean;
    /** For the community's daily limit (non-admin). */
    telegramUserId?: number;
  }): Promise<BookingDurationMinutes[]> {
    let ctx: LoadedResourceDayBookings | null = null;
    try {
      ctx = await this.loadResourceDayBookings(params);
    } catch (e) {
      if (e instanceof BookingWindowClosedError) {
        return [];
      }
      throw e;
    }
    if (!ctx) {
      return [];
    }
    if (ctx.dayClosed) {
      return [];
    }
    const {
      timeZone,
      slotStartHour,
      slotEndHour,
      localDay,
      maxEndUtc,
      bookings,
      recurringOccurrences,
    } = ctx;
    const now = params.now ?? new Date();
    const h = params.startHour;
    const min = params.startMinute;
    if (!isStartSlotBookable(h, min, slotStartHour, slotEndHour)) {
      return [];
    }
    const t0 = atLocalHour(localDay, h, min, timeZone);
    if (params.dayOffset === 0 && t0 <= now) {
      return [];
    }
    const out: BookingDurationMinutes[] = [];
    for (const dur of BOOKING_DURATION_MINUTES) {
      const end = addMinutes(t0, dur);
      if (end > maxEndUtc) {
        continue;
      }
      const clash = this.hasClashWithOccupiedIntervals(
        t0,
        end,
        bookings,
        recurringOccurrences,
      );
      if (!clash) {
        out.push(dur);
      }
    }

    if (
      !params.telegramGroupAdmin &&
      params.telegramUserId != null &&
      out.length > 0
    ) {
      const lim = await this.resourceUserBookingLimitState({
        communityResourceId: ctx.res.communityResourceId,
        resourceId: ctx.res.id,
        telegramUserId: params.telegramUserId,
        startTimeUtc: t0,
        limitTimeZone: timeZone,
      });
      if (lim != null) {
        return out.filter((dur) => lim.used + dur <= lim.cap);
      }
    }

    return out;
  }

  async createBooking(params: {
    resourceId: string;
    telegramChatId: bigint;
    from: TelegramFrom;
    dayOffset: number;
    startHour: number;
    /** 0 or 30 — start at :00 or :30. */
    startMinute?: number;
    /** Sport type for the booking; if not specified, it is taken from the object (venue settings). */
    sportKindCode?: SportKindCode;
    durationMinutes: BookingDurationMinutes;
    /** Searching for players; if true, requiredPlayers must be ≥ 1. */
    isLookingForPlayers?: boolean;
    requiredPlayers?: number;
    now?: Date;
    telegramGroupAdmin?: boolean;
    /** Resolved UI locale (e.g. ua, en) for stored display name fallback. */
    displayLocale: string;
  }) {
    const startedAtMs = Date.now();
    if (params.dayOffset !== 0 && params.dayOffset !== 1) {
      throw new Error('Invalid day');
    }
    if (!BOOKING_DURATION_MINUTES.includes(params.durationMinutes)) {
      throw new Error('Invalid duration');
    }

    const ctx = await this.loadResourceDayBookings({
      resourceId: params.resourceId,
      telegramChatId: params.telegramChatId,
      dayOffset: params.dayOffset,
      now: params.now,
      telegramGroupAdmin: params.telegramGroupAdmin,
    });
    if (!ctx) {
      throw new Error('Resource not found');
    }
    if (ctx.dayClosed) {
      throw new Error('Closed day');
    }
    const { res, timeZone, slotStartHour, slotEndHour, localDay, maxEndUtc } =
      ctx;
    const startMinute = params.startMinute ?? 0;
    if (startMinute !== 0 && startMinute !== 30) {
      throw new Error('Invalid start minute');
    }
    if (
      !isStartSlotBookable(
        params.startHour,
        startMinute,
        slotStartHour,
        slotEndHour,
      )
    ) {
      throw new Error('Invalid hour');
    }

    const now = params.now ?? new Date();
    const startTime = atLocalHour(
      localDay,
      params.startHour,
      startMinute,
      timeZone,
    );
    if (params.dayOffset === 0 && startTime <= now) {
      throw new SlotInPastError();
    }
    const endTime = addMinutes(startTime, params.durationMinutes);
    if (endTime > maxEndUtc) {
      throw new Error('Outside working hours');
    }

    if (!params.telegramGroupAdmin) {
      const lim = await this.resourceUserBookingLimitState({
        communityResourceId: res.communityResourceId,
        resourceId: res.id,
        telegramUserId: params.from.id,
        startTimeUtc: startTime,
        limitTimeZone: timeZone,
      });
      if (lim != null && lim.used + params.durationMinutes > lim.cap) {
        throw new UserDailyBookingLimitExceededError();
      }
    }

    const userName = this.displayBookerName(params.from, params.displayLocale);
    const looking = params.isLookingForPlayers === true;
    const requiredPlayers = looking ? (params.requiredPlayers ?? 0) : 0;
    if (looking && (requiredPlayers < 1 || requiredPlayers > 50)) {
      throw new Error('requiredPlayers must be 1–50 when isLookingForPlayers');
    }
    const gateKey = `${params.resourceId}:${startTime.toISOString()}`;
    if (!this.reserveCreateGate(gateKey)) {
      this.metrics.incBookingCreateConflict();
      this.metrics.incBookingCreate('conflict');
      this.metrics.observeBookingCreateDuration(Date.now() - startedAtMs);
      throw new SlotTakenError();
    }

    try {
      const booking = await this.prisma.$transaction(async (tx) => {
        const clash = await tx.booking.findFirst({
          where: {
            resourceId: params.resourceId,
            status: { in: OCCUPIED_BOOKING_STATUSES },
            startTime: { lt: endTime },
            endTime: { gt: startTime },
          },
        });
        if (clash) {
          throw new SlotTakenError();
        }
        const recurringOccurrences =
          await this.recurringBookings.listRuleOccurrencesForDay({
            resourceId: params.resourceId,
            localDay,
            timeZone,
            windowStartUtc: ctx.windowStartUtc,
            maxEndUtc,
          });
        const recurringClash = recurringOccurrences.some((r) =>
          intervalsOverlap(startTime, endTime, r.startTime, r.endTime),
        );
        if (recurringClash) {
          throw new SlotTakenError();
        }
        return tx.booking.create({
          data: {
            communityResourceId: res.communityResourceId,
            resourceId: params.resourceId,
            sportKindCode: params.sportKindCode ?? SportKindCode.TENNIS,
            userId: BigInt(params.from.id),
            userName,
            startTime,
            endTime,
            status: BookingStatus.PENDING,
            isLookingForPlayers: looking,
            requiredPlayers,
          },
        });
      });

      this.logger.log(
        JSON.stringify({
          action: 'booking_created',
          bookingId: booking.id,
          resourceId: params.resourceId,
          telegramChatId: params.telegramChatId.toString(),
          telegramUserId: params.from.id,
          startTimeUtc: startTime.toISOString(),
          endTimeUtc: endTime.toISOString(),
          durationMinutes: params.durationMinutes,
          startLocal: formatInTimeZone(startTime, timeZone, 'yyyy-MM-dd HH:mm'),
          elapsedMs: Date.now() - startedAtMs,
        }),
      );
      this.metrics.incBookingCreate('success');
      this.metrics.observeBookingCreateDuration(Date.now() - startedAtMs);
      return {
        resourceId: res.id,
        startTime,
        endTime,
        resourceName: res.name,
        timeZone,
      };
    } catch (e) {
      if (e instanceof SlotTakenError || isBookingOverlapDbError(e)) {
        this.metrics.incBookingCreateConflict();
        this.metrics.incBookingCreate('conflict');
        this.metrics.observeBookingCreateDuration(Date.now() - startedAtMs);
        throw new SlotTakenError();
      }
      this.metrics.incBookingCreateSystemError();
      this.metrics.incBookingCreate('error');
      this.metrics.observeBookingCreateDuration(Date.now() - startedAtMs);
      throw e;
    }
  }

  async cancelBooking(params: {
    bookingId: string;
    telegramChatId: bigint;
    telegramUserId: number;
    /** Group admin cancels someone else's booking (Telegram admin rights are enforced by the bot). */
    asGroupAdmin?: boolean;
    /** Locale for DM notice text. */
    noticeLocale: string;
  }): Promise<BookingCancelNotification> {
    const whereCommon = {
      id: params.bookingId,
      status: { in: OCCUPIED_BOOKING_STATUSES },
      resource: {
        communityResources: {
          some: { community: { telegramChatId: params.telegramChatId } },
        },
      },
    };
    const booking = await this.prisma.booking.findFirst({
      where: params.asGroupAdmin
        ? whereCommon
        : { ...whereCommon, userId: BigInt(params.telegramUserId) },
      include: {
        resource: true,
        communityResource: { include: { community: true } },
        sportKind: true,
        lookingParticipants: true,
      },
    });
    if (!booking) {
      throw new BookingNotFoundError();
    }

    const tz = booking.resource.timeZone;
    const day = formatInTimeZone(booking.startTime, tz, 'dd.MM.yyyy');
    const a = formatInTimeZone(booking.startTime, tz, 'HH:mm');
    const z = formatInTimeZone(booking.endTime, tz, 'HH:mm');
    const lang = params.noticeLocale;
    const intro = params.asGroupAdmin
      ? this.uiT(lang, 'book.cancelDmIntroAdmin')
      : this.uiT(lang, 'book.cancelDmIntroOrganizer');
    const sportLabel = this.uiT(lang, `sport.${booking.sportKindCode}`);
    const cancelNoticeText =
      `${intro}\n\n` +
      `${this.uiT(lang, 'book.cancelDmVenue', {
        resource: booking.resource.name,
      })}\n` +
      `${this.uiT(lang, 'book.cancelDmWhen', {
        day,
        timeFrom: a,
        timeTo: z,
        tz,
      })}\n` +
      `${this.uiT(lang, 'book.cancelDmSport', { sport: sportLabel })}`;

    const organizerId = Number(booking.userId);
    const fromParticipants = booking.lookingParticipants.map((p) =>
      Number(p.telegramUserId),
    );
    const recipientTelegramIds = [
      ...new Set([organizerId, ...fromParticipants]),
    ];

    await this.prisma.$transaction(async (tx) => {
      await tx.bookingLookingParticipant.deleteMany({
        where: { bookingId: booking.id },
      });
      await tx.booking.update({
        where: { id: booking.id },
        data: { status: BookingStatus.CANCELLED },
      });
    });

    this.logger.log(
      JSON.stringify({
        action: 'booking_cancelled',
        bookingId: booking.id,
        telegramChatId: params.telegramChatId.toString(),
        telegramUserId: params.telegramUserId,
        startTimeUtc: booking.startTime.toISOString(),
        startLocal: formatInTimeZone(booking.startTime, tz, 'yyyy-MM-dd HH:mm'),
        notifiedRecipients: recipientTelegramIds.length,
      }),
    );

    return {
      recipientTelegramIds,
      cancelNoticeText,
      resourceId: booking.resource.id,
      resourceName: booking.resource.name,
      timeZone: tz,
      startTime: booking.startTime,
      endTime: booking.endTime,
      sportKindCode: booking.sportKindCode,
    };
  }

  /**
   * «Мої бронювання»: усе, що не FINISHED і не CANCELLED (тобто PENDING та ACTIVE).
   */
  async listMyBookingsNotFinishedOrCancelled(params: {
    telegramChatId: bigint;
    telegramUserId: number;
  }) {
    return this.prisma.booking.findMany({
      where: {
        status: { in: OCCUPIED_BOOKING_STATUSES },
        userId: BigInt(params.telegramUserId),
        resource: {
          communityResources: {
            some: { community: { telegramChatId: params.telegramChatId } },
          },
        },
      },
      include: {
        resource: true,
        communityResource: { include: { community: true } },
      },
      orderBy: { startTime: 'asc' },
    });
  }

  /** Усі ще дійсні броні (PENDING/ACTIVE) у чаті на сьогодні/завтра — локальна дата майданчику. */
  async listAllBookingsForChatDay(params: {
    telegramChatId: bigint;
    dayOffset: 0 | 1;
    now?: Date;
  }) {
    const now = params.now ?? new Date();
    const resources = await this.prisma.resource.findMany({
      where: {
        communityResources: {
          some: { community: { telegramChatId: params.telegramChatId } },
        },
      },
      select: { id: true, timeZone: true },
    });
    if (resources.length === 0) {
      return [];
    }
    const perResourceWindows = resources.map((resource) => {
      const localNow = toZonedTime(now, resource.timeZone);
      const targetDay = addDays(startOfDay(localNow), params.dayOffset);
      const startUtc = fromZonedTime(targetDay, resource.timeZone);
      const endUtc = fromZonedTime(addDays(targetDay, 1), resource.timeZone);
      return { resourceId: resource.id, startUtc, endUtc };
    });
    return this.prisma.booking.findMany({
      where: {
        status: { in: OCCUPIED_BOOKING_STATUSES },
        OR: perResourceWindows.map((w) => ({
          resourceId: w.resourceId,
          startTime: { gte: w.startUtc, lt: w.endUtc },
        })),
      },
      include: { resource: true, sportKind: true },
      orderBy: { startTime: 'asc' },
    });
  }

  /** Active bookings in the chat where people are still looking for partners (future slots only). */
  async listOpenLookingSlots(params: { telegramChatId: bigint; now?: Date }) {
    const now = params.now ?? new Date();
    return this.prisma.booking.findMany({
      where: {
        status: { in: OCCUPIED_BOOKING_STATUSES },
        isLookingForPlayers: true,
        requiredPlayers: { gt: 0 },
        startTime: { gt: now },
        resource: {
          communityResources: {
            some: { community: { telegramChatId: params.telegramChatId } },
          },
        },
      },
      include: { resource: true, sportKind: true },
      orderBy: { startTime: 'asc' },
    });
  }

  /**
   * Clicking “Available slots”: subtract 1 from required_players; count this user in booking_looking_participants (people_count += 1 for this user).
   */
  async volunteerForLookingSlot(params: {
    bookingId: string;
    telegramChatId: bigint;
    telegramUserId: number;
  }): Promise<{
    remainingPlayers: number;
    yourPeopleCount: number;
    /** The previous private message regarding this reservation — delete it before posting a new message. */
    previousDmMessageId: number | null;
    organizer: {
      telegramUserId: number;
      /** Display name stored when the booking was created (username or first name). */
      storedDisplayName: string | null;
    };
    dm: {
      resourceName: string;
      address: string | null;
      timeZone: string;
      startTime: Date;
      endTime: Date;
      sportKindCode: SportKindCode;
    };
  }> {
    return this.prisma.$transaction(async (tx) => {
      const b = await tx.booking.findFirst({
        where: {
          id: params.bookingId,
          status: { in: OCCUPIED_BOOKING_STATUSES },
          isLookingForPlayers: true,
          requiredPlayers: { gt: 0 },
          resource: {
            communityResources: {
              some: { community: { telegramChatId: params.telegramChatId } },
            },
          },
        },
        select: { id: true, requiredPlayers: true },
      });
      if (!b) {
        throw new BookingNotFoundError();
      }
      const prior = await tx.bookingLookingParticipant.findUnique({
        where: {
          bookingId_telegramUserId: {
            bookingId: b.id,
            telegramUserId: BigInt(params.telegramUserId),
          },
        },
        select: { lastDmMessageId: true },
      });
      const previousDmMessageId = prior?.lastDmMessageId ?? null;

      const dec = await tx.booking.updateMany({
        where: {
          id: b.id,
          status: { in: OCCUPIED_BOOKING_STATUSES },
          isLookingForPlayers: true,
          requiredPlayers: { gt: 0 },
        },
        data: {
          requiredPlayers: { decrement: 1 },
        },
      });
      if (dec.count === 0) {
        throw new BookingNotFoundError();
      }
      const current = await tx.booking.findUniqueOrThrow({
        where: { id: b.id },
        select: { requiredPlayers: true },
      });
      const remainingPlayers = Math.max(0, current.requiredPlayers);
      if (remainingPlayers === 0) {
        await tx.booking.update({
          where: { id: b.id },
          data: { isLookingForPlayers: false },
        });
      }
      const part = await tx.bookingLookingParticipant.upsert({
        where: {
          bookingId_telegramUserId: {
            bookingId: b.id,
            telegramUserId: BigInt(params.telegramUserId),
          },
        },
        create: {
          bookingId: b.id,
          telegramUserId: BigInt(params.telegramUserId),
          peopleCount: 1,
        },
        update: {
          peopleCount: { increment: 1 },
        },
      });
      const full = await tx.booking.findUniqueOrThrow({
        where: { id: b.id },
        include: { resource: true, sportKind: true },
      });
      const stored = full.userName?.trim() ?? '';
      return {
        remainingPlayers,
        yourPeopleCount: part.peopleCount,
        previousDmMessageId,
        organizer: {
          telegramUserId: Number(full.userId),
          storedDisplayName: stored.length > 0 ? stored : null,
        },
        dm: {
          resourceName: full.resource.name,
          address: full.resource.address,
          timeZone: full.resource.timeZone,
          startTime: full.startTime,
          endTime: full.endTime,
          sportKindCode: full.sportKindCode,
        },
      };
    });
  }

  async setLookingParticipantDmMessageId(params: {
    bookingId: string;
    telegramUserId: number;
    messageId: number;
  }): Promise<void> {
    await this.prisma.bookingLookingParticipant.update({
      where: {
        bookingId_telegramUserId: {
          bookingId: params.bookingId,
          telegramUserId: BigInt(params.telegramUserId),
        },
      },
      data: { lastDmMessageId: params.messageId },
    });
  }

  /**
   * Daily schedule: The booking_window_* permission does not apply (viewable by everyone).
   * telegramGroupAdmin — view hidden venues.
   */
  async buildDayGridText(params: {
    resourceId: string;
    telegramChatId: bigint;
    dayOffset: number;
    now?: Date;
    telegramGroupAdmin?: boolean;
    displayLocale: string;
  }): Promise<string> {
    const ctx = await this.loadResourceDayBookings({
      resourceId: params.resourceId,
      telegramChatId: params.telegramChatId,
      dayOffset: params.dayOffset,
      now: params.now,
      telegramGroupAdmin: params.telegramGroupAdmin,
      forDayGridDisplay: true,
    });
    const lang = params.displayLocale;
    if (!ctx) {
      return this.uiT(lang, 'grid.notFound');
    }
    const {
      res,
      timeZone,
      dayClosed,
      slotStartHour,
      slotEndHour,
      localDay,
      bookings,
      recurringOccurrences,
    } = ctx;
    const now = params.now ?? new Date();

    const label =
      params.dayOffset === 0
        ? this.uiT(lang, 'grid.dayToday')
        : params.dayOffset === 1
          ? this.uiT(lang, 'grid.dayTomorrow')
          : this.uiT(lang, 'grid.dayPlus', { n: String(params.dayOffset) });

    const lines = [
      this.uiT(lang, 'grid.header', {
        resource: res.name,
        day: label,
        tz: timeZone,
      }),
      '',
    ];

    if (bookings.length > 0) {
      lines.push(this.uiT(lang, 'grid.bookingsHeader'));
      for (const b of bookings) {
        const raw = b.userName?.trim() ?? '';
        const name = raw
          ? raw.replace(/^@+/, '@')
          : this.uiT(lang, 'setup.adminPlayerFallback');
        const sport = this.uiT(lang, `sport.${b.sportKindCode}`);
        const a = formatInTimeZone(b.startTime, timeZone, 'HH:mm');
        const z = formatInTimeZone(b.endTime, timeZone, 'HH:mm');
        lines.push(
          this.uiT(lang, 'grid.bookingRow', {
            from: a,
            to: z,
            sport,
            name,
          }),
        );
      }
      lines.push('');
    }

    if (recurringOccurrences.length > 0) {
      lines.push(this.uiT(lang, 'grid.recurringHeader'));
      for (const r of recurringOccurrences) {
        const sport = this.uiT(lang, `sport.${r.sportKindCode}`);
        const a = formatInTimeZone(r.startTime, timeZone, 'HH:mm');
        const z = formatInTimeZone(r.endTime, timeZone, 'HH:mm');
        lines.push(
          this.uiT(lang, 'grid.recurringRow', {
            from: a,
            to: z,
            sport,
          }),
        );
      }
      lines.push('');
    }

    if (dayClosed) {
      lines.push(this.uiT(lang, 'grid.dayClosed'));
      return lines.join('\n');
    }

    lines.push(this.uiT(lang, 'grid.hourlyHeader'));
    for (let h = slotStartHour; h <= slotEndHour; h++) {
      const segStart = atLocalHour(localDay, h, 0, timeZone);
      const segEnd = atLocalHour(localDay, h + 1, 0, timeZone);
      const hh = `${String(h).padStart(2, '0')}:00`;
      if (params.dayOffset === 0 && segStart <= now) {
        lines.push(this.uiT(lang, 'grid.hourPast', { hour: hh }));
        continue;
      }
      const occ = hourSegmentOccupancy(segStart, segEnd, [
        ...bookings,
        ...recurringOccurrences,
      ]);
      if (occ === 'free') {
        lines.push(this.uiT(lang, 'grid.hourFree', { hour: hh }));
      } else if (occ === 'full') {
        lines.push(this.uiT(lang, 'grid.hourFull', { hour: hh }));
      } else {
        lines.push(this.uiT(lang, 'grid.hourPartial', { hour: hh }));
      }
    }
    return lines.join('\n');
  }
}
