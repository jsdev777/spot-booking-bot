import { Injectable, Logger } from '@nestjs/common';
import {
  addMinutes,
  addDays,
  differenceInMinutes,
  set,
  startOfDay,
} from 'date-fns';
import { formatInTimeZone, fromZonedTime, toZonedTime } from 'date-fns-tz';
import {
  BookingStatus,
  Prisma,
  SportKindCode,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ResourceService } from '../community/resource.service';
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
};

/** Локальное время начала брони (шаг 30 мин: :00 и :30). */
export type BookingStartSlot = { hour: number; minute: number };

export type TelegramFrom = {
  id: number;
  username?: string;
  first_name?: string;
};

/** Сначала ник в Telegram (@username), иначе имя; без скрытого юзернейма — «Игрок». */
function displayUserName(from: TelegramFrom): string {
  const uname = from.username?.trim();
  if (uname) {
    return `@${uname}`;
  }
  const fn = from.first_name?.trim();
  if (fn) {
    return fn;
  }
  return 'Игрок';
}

function localDayAnchor(now: Date, dayOffset: number, timeZone: string): Date {
  const zonedNow = toZonedTime(now, timeZone);
  const localDayStart = startOfDay(zonedNow);
  return addDays(localDayStart, dayOffset);
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

@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly resources: ResourceService,
  ) {}

  /**
   * Лимит community_user_booking_limits для дня недели и календарной даты начала брони
   * в часовом поясе площадки (`limitTimeZone`). null — ограничения нет.
   */
  private async communityUserBookingLimitState(params: {
    communityId: string;
    telegramUserId: number;
    startTimeUtc: Date;
    limitTimeZone: string;
  }): Promise<{ cap: number; used: number } | null> {
    const limits = await this.prisma.communityUserBookingLimit.findMany({
      where: { communityId: params.communityId },
    });
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
    const sameUserBookings = await this.prisma.booking.findMany({
      where: {
        status: BookingStatus.ACTIVE,
        userId: BigInt(params.telegramUserId),
        resource: { communityId: params.communityId },
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
     * Администратор или creator чата в Telegram: не ограничены полями booking_window_* в Community
     * и могут бронировать на скрытых площадках.
     */
    telegramGroupAdmin?: boolean;
    /**
     * Сетка дня: окно booking_window_* не проверяется (ни для участников, ни для админов).
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
        status: BookingStatus.ACTIVE,
        startTime: { lt: maxEndUtc },
        endTime: { gt: windowStartUtc },
      },
      include: { sportKind: true },
      orderBy: { startTime: 'asc' },
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
    };
  }

  /**
   * Времена начала (:00 и :30), с которых хотя бы одна длительность (1 / 1.5 / 2 ч)
   * укладывается в рабочее окно и не пересекается с бронями.
   */
  async getAvailableStartSlots(params: {
    resourceId: string;
    telegramChatId: bigint;
    dayOffset: number;
    now?: Date;
    /** Админ/creator группы в Telegram — вне окна booking_window_* в communities. */
    telegramGroupAdmin?: boolean;
  }): Promise<BookingStartSlot[]> {
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
          const clash = bookings.some((b) =>
            intervalsOverlap(t0, end, b.startTime, b.endTime),
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
    /** Для лимита сообщества по дню (не админ). */
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
      const clash = bookings.some((b) =>
        intervalsOverlap(t0, end, b.startTime, b.endTime),
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
      const lim = await this.communityUserBookingLimitState({
        communityId: ctx.res.community.id,
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
    /** 0 или 30 — старт в :00 или :30. */
    startMinute?: number;
    /** Вид спорта для брони; если не задан — берётся с объекта (настройка площадки). */
    sportKindCode?: SportKindCode;
    durationMinutes: BookingDurationMinutes;
    now?: Date;
    telegramGroupAdmin?: boolean;
  }) {
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
      const lim = await this.communityUserBookingLimitState({
        communityId: res.community.id,
        telegramUserId: params.from.id,
        startTimeUtc: startTime,
        limitTimeZone: timeZone,
      });
      if (lim != null && lim.used + params.durationMinutes > lim.cap) {
        throw new UserDailyBookingLimitExceededError();
      }
    }

    const userName = displayUserName(params.from);

    try {
      const booking = await this.prisma.$transaction(async (tx) => {
        const clash = await tx.booking.findFirst({
          where: {
            resourceId: params.resourceId,
            status: BookingStatus.ACTIVE,
            startTime: { lt: endTime },
            endTime: { gt: startTime },
          },
        });
        if (clash) {
          throw new SlotTakenError();
        }
        return tx.booking.create({
          data: {
            resourceId: params.resourceId,
            sportKindCode: params.sportKindCode ?? SportKindCode.TENNIS,
            userId: BigInt(params.from.id),
            userName,
            startTime,
            endTime,
            status: BookingStatus.ACTIVE,
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
        }),
      );
      return { startTime, endTime, resourceName: res.name, timeZone };
    } catch (e) {
      if (e instanceof SlotTakenError) {
        throw e;
      }
      throw e;
    }
  }

  async cancelBooking(params: {
    bookingId: string;
    telegramChatId: bigint;
    telegramUserId: number;
  }) {
    const booking = await this.prisma.booking.findFirst({
      where: {
        id: params.bookingId,
        status: BookingStatus.ACTIVE,
        userId: BigInt(params.telegramUserId),
        resource: {
          community: { telegramChatId: params.telegramChatId },
        },
      },
      include: {
        resource: { include: { community: true } },
      },
    });
    if (!booking) {
      throw new BookingNotFoundError();
    }

    await this.prisma.booking.update({
      where: { id: booking.id },
      data: { status: BookingStatus.CANCELLED },
    });

    const tz = booking.resource.timeZone;
    this.logger.log(
      JSON.stringify({
        action: 'booking_cancelled',
        bookingId: booking.id,
        telegramChatId: params.telegramChatId.toString(),
        telegramUserId: params.telegramUserId,
        startTimeUtc: booking.startTime.toISOString(),
        startLocal: formatInTimeZone(booking.startTime, tz, 'yyyy-MM-dd HH:mm'),
      }),
    );
  }

  async listMyActiveBookings(params: {
    telegramChatId: bigint;
    telegramUserId: number;
  }) {
    return this.prisma.booking.findMany({
      where: {
        status: BookingStatus.ACTIVE,
        userId: BigInt(params.telegramUserId),
        resource: {
          community: { telegramChatId: params.telegramChatId },
        },
      },
      include: { resource: { include: { community: true } } },
      orderBy: { startTime: 'asc' },
    });
  }

  /**
   * Сетка дня: окно booking_window_* не применяется (просмотр для всех).
   * telegramGroupAdmin — видеть скрытые площадки.
   */
  async buildDayGridText(params: {
    resourceId: string;
    telegramChatId: bigint;
    dayOffset: number;
    now?: Date;
    telegramGroupAdmin?: boolean;
  }): Promise<string> {
    const ctx = await this.loadResourceDayBookings({
      resourceId: params.resourceId,
      telegramChatId: params.telegramChatId,
      dayOffset: params.dayOffset,
      now: params.now,
      telegramGroupAdmin: params.telegramGroupAdmin,
      forDayGridDisplay: true,
    });
    if (!ctx) {
      return 'Объект не найден.';
    }
    const {
      res,
      timeZone,
      dayClosed,
      slotStartHour,
      slotEndHour,
      localDay,
      bookings,
    } = ctx;
    const now = params.now ?? new Date();

    const label =
      params.dayOffset === 0
        ? 'Сегодня'
        : params.dayOffset === 1
          ? 'Завтра'
          : `День +${params.dayOffset}`;

    const lines = [`${res.name} — ${label} (${timeZone}):`, ''];

    if (bookings.length > 0) {
      lines.push('Брони:');
      for (const b of bookings) {
        const raw = b.userName?.trim() || 'Игрок';
        const name = raw.replace(/^@+/, '').trim() || 'Игрок';
        const sport = b.sportKind.nameRu.trim() || b.sportKindCode;
        const a = formatInTimeZone(b.startTime, timeZone, 'HH:mm');
        const z = formatInTimeZone(b.endTime, timeZone, 'HH:mm');
        lines.push(`🔴 ${a}–${z} (${sport}) — ${name}`);
      }
      lines.push('');
    }

    if (dayClosed) {
      lines.push('В этот день площадка не работает.');
      return lines.join('\n');
    }

    lines.push('По часам:');
    for (let h = slotStartHour; h <= slotEndHour; h++) {
      const segStart = atLocalHour(localDay, h, 0, timeZone);
      const segEnd = atLocalHour(localDay, h + 1, 0, timeZone);
      const hh = `${String(h).padStart(2, '0')}:00`;
      if (params.dayOffset === 0 && segStart <= now) {
        lines.push(`⏱ ${hh} — уже прошло`);
        continue;
      }
      const occ = hourSegmentOccupancy(segStart, segEnd, bookings);
      if (occ === 'free') {
        lines.push(`🟢 ${hh} — свободно`);
      } else if (occ === 'full') {
        lines.push(`🔴 ${hh} — занято`);
      } else {
        lines.push(`🟡 ${hh} — занято (часть часа)`);
      }
    }
    return lines.join('\n');
  }
}
