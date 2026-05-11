import { BookingService } from './booking.service';
import { SlotTakenError } from './booking.errors';

describe('BookingService daily limit by resource', () => {
  it('applies cap per user + resource per day', async () => {
    const prisma = {
      communityResourceUserBookingLimit: {
        findMany: jest.fn().mockResolvedValue([{ weekday: 1, maxMinutes: 60 }]),
      },
      booking: {
        findMany: jest.fn().mockImplementation((args: unknown) => {
          const q = args as {
            where?: { userId?: bigint; resourceId?: string };
            select?: { startTime: true; endTime: true };
          };
          if (q.select?.startTime && q.select?.endTime && q.where?.userId) {
            if (q.where.resourceId === 'resource-a') {
              return Promise.resolve([
                {
                  startTime: new Date('2026-04-06T08:00:00Z'),
                  endTime: new Date('2026-04-06T08:30:00Z'),
                },
              ]);
            }
            return Promise.resolve([]);
          }
          return Promise.resolve([]);
        }),
      },
    };
    const resources = {
      findByIdForChat: jest.fn().mockImplementation((resourceId: string) =>
        Promise.resolve({
          id: resourceId,
          name: resourceId,
        timeZone: 'UTC',
          workingHours: [
            {
              weekday: 1,
              isClosed: false,
              slotStartHour: 8,
              slotEndHour: 21,
            },
          ],
          community: {
            bookingWindowTimeZone: 'UTC',
            bookingWindowStartHour: 0,
            bookingWindowEndHour: 24,
          },
          communityResourceId:
            resourceId === 'resource-a' ? 'cr-resource-a' : 'cr-resource-b',
        }),
      ),
    };

    const i18n = { t: () => '' };
    const recurringBookings = {
      listRuleOccurrencesForDay: jest.fn().mockResolvedValue([]),
    };
    const metrics = {
      observeBookingSlotsBuildDuration: jest.fn(),
      incBookingCreateConflict: jest.fn(),
      incBookingCreate: jest.fn(),
      observeBookingCreateDuration: jest.fn(),
      incBookingCreateSystemError: jest.fn(),
    };
    const svc = new BookingService(
      prisma as never,
      resources as never,
      recurringBookings as never,
      metrics as never,
      i18n as never,
    );
    const baseParams = {
      telegramChatId: 1n,
      dayOffset: 0 as const,
      startHour: 10,
      startMinute: 0,
      now: new Date('2026-04-06T06:00:00Z'),
      telegramUserId: 10,
      telegramGroupAdmin: false,
    };

    const a = await svc.getAvailableDurationsMinutes({
      ...baseParams,
      resourceId: 'resource-a',
    });
    const b = await svc.getAvailableDurationsMinutes({
      ...baseParams,
      resourceId: 'resource-b',
    });

    expect(a).toEqual([]);
    expect(b).toEqual([60]);
  });

  it('blocks start slot when recurring booking exists', async () => {
    const prisma = {
      booking: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const resources = {
      findByIdForChat: jest.fn().mockResolvedValue({
        id: 'resource-a',
        name: 'resource-a',
        timeZone: 'UTC',
        workingHours: [
          { weekday: 1, isClosed: false, slotStartHour: 8, slotEndHour: 21 },
        ],
        community: {
          bookingWindowTimeZone: 'UTC',
          bookingWindowStartHour: 0,
          bookingWindowEndHour: 24,
        },
        communityResourceId: 'cr-resource-a',
      }),
    };
    const recurringBookings = {
      listRuleOccurrencesForDay: jest.fn().mockResolvedValue([
        {
          ruleId: 'rule-1',
          startTime: new Date('2026-04-06T08:00:00Z'),
          endTime: new Date('2026-04-06T10:00:00Z'),
          sportKindCode: 'TENNIS',
        },
      ]),
    };
    const metrics = { observeBookingSlotsBuildDuration: jest.fn() };
    const svc = new BookingService(
      prisma as never,
      resources as never,
      recurringBookings as never,
      metrics as never,
      { t: () => '' } as never,
    );
    const slots = await svc.getAvailableStartSlots({
      resourceId: 'resource-a',
      telegramChatId: 1n,
      dayOffset: 0,
      now: new Date('2026-04-06T06:00:00Z'),
      telegramGroupAdmin: false,
    });
    expect(slots.some((s) => s.hour === 11 && s.minute === 0)).toBe(true);
    expect(slots.some((s) => s.hour === 10 && s.minute === 0)).toBe(true);
    expect(slots.some((s) => s.hour === 8 && s.minute === 0)).toBe(false);
  });

  it('omits :30 start slots when daily cap is 60 minutes for that weekday', async () => {
    const prisma = {
      booking: { findMany: jest.fn().mockResolvedValue([]) },
      communityResourceUserBookingLimit: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ weekday: 1, maxMinutes: 60 }]),
      },
    };
    const resources = {
      findByIdForChat: jest.fn().mockResolvedValue({
        id: 'resource-a',
        name: 'resource-a',
        timeZone: 'UTC',
        workingHours: [
          { weekday: 1, isClosed: false, slotStartHour: 8, slotEndHour: 21 },
        ],
        community: {
          bookingWindowTimeZone: 'UTC',
          bookingWindowStartHour: 0,
          bookingWindowEndHour: 24,
        },
        communityResourceId: 'cr-resource-a',
      }),
    };
    const recurringBookings = {
      listRuleOccurrencesForDay: jest.fn().mockResolvedValue([]),
    };
    const metrics = { observeBookingSlotsBuildDuration: jest.fn() };
    const svc = new BookingService(
      prisma as never,
      resources as never,
      recurringBookings as never,
      metrics as never,
      { t: () => '' } as never,
    );
    const slots = await svc.getAvailableStartSlots({
      resourceId: 'resource-a',
      telegramChatId: 1n,
      dayOffset: 0,
      now: new Date('2026-04-06T06:00:00Z'),
      telegramGroupAdmin: false,
      telegramUserId: 10,
    });
    expect(slots.some((s) => s.hour === 8 && s.minute === 0)).toBe(true);
    expect(slots.some((s) => s.hour === 8 && s.minute === 30)).toBe(false);
  });

  it('keeps :30 start slots when daily cap is not 60 minutes', async () => {
    const prisma = {
      booking: { findMany: jest.fn().mockResolvedValue([]) },
      communityResourceUserBookingLimit: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ weekday: 1, maxMinutes: 90 }]),
      },
    };
    const resources = {
      findByIdForChat: jest.fn().mockResolvedValue({
        id: 'resource-a',
        name: 'resource-a',
        timeZone: 'UTC',
        workingHours: [
          { weekday: 1, isClosed: false, slotStartHour: 8, slotEndHour: 21 },
        ],
        community: {
          bookingWindowTimeZone: 'UTC',
          bookingWindowStartHour: 0,
          bookingWindowEndHour: 24,
        },
        communityResourceId: 'cr-resource-a',
      }),
    };
    const recurringBookings = {
      listRuleOccurrencesForDay: jest.fn().mockResolvedValue([]),
    };
    const metrics = { observeBookingSlotsBuildDuration: jest.fn() };
    const svc = new BookingService(
      prisma as never,
      resources as never,
      recurringBookings as never,
      metrics as never,
      { t: () => '' } as never,
    );
    const slots = await svc.getAvailableStartSlots({
      resourceId: 'resource-a',
      telegramChatId: 1n,
      dayOffset: 0,
      now: new Date('2026-04-06T06:00:00Z'),
      telegramGroupAdmin: false,
      telegramUserId: 10,
    });
    expect(slots.some((s) => s.hour === 8 && s.minute === 30)).toBe(true);
  });

  it('returns configured daily cap minutes for the booking day', async () => {
    const prisma = {
      booking: { findMany: jest.fn().mockResolvedValue([]) },
      communityResourceUserBookingLimit: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ weekday: 1, maxMinutes: 60 }]),
      },
    };
    const resources = {
      findByIdForChat: jest.fn().mockResolvedValue({
        id: 'resource-a',
        name: 'resource-a',
        timeZone: 'UTC',
        workingHours: [
          { weekday: 1, isClosed: false, slotStartHour: 8, slotEndHour: 21 },
        ],
        community: {
          bookingWindowTimeZone: 'UTC',
          bookingWindowStartHour: 0,
          bookingWindowEndHour: 24,
        },
        communityResourceId: 'cr-resource-a',
      }),
    };
    const recurringBookings = {
      listRuleOccurrencesForDay: jest.fn().mockResolvedValue([]),
    };
    const svc = new BookingService(
      prisma as never,
      resources as never,
      recurringBookings as never,
      { observeBookingSlotsBuildDuration: jest.fn() } as never,
      { t: () => '' } as never,
    );
    const cap = await svc.getConfiguredDailyBookingLimitCapMinutes({
      resourceId: 'resource-a',
      telegramChatId: 1n,
      dayOffset: 0,
      now: new Date('2026-04-06T12:00:00Z'),
      telegramGroupAdmin: false,
    });
    expect(cap).toBe(60);
  });

  it('keeps :30 for group admin even when daily cap is 60 minutes', async () => {
    const prisma = {
      booking: { findMany: jest.fn().mockResolvedValue([]) },
      communityResourceUserBookingLimit: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ weekday: 1, maxMinutes: 60 }]),
      },
    };
    const resources = {
      findByIdForChat: jest.fn().mockResolvedValue({
        id: 'resource-a',
        name: 'resource-a',
        timeZone: 'UTC',
        workingHours: [
          { weekday: 1, isClosed: false, slotStartHour: 8, slotEndHour: 21 },
        ],
        community: {
          bookingWindowTimeZone: 'UTC',
          bookingWindowStartHour: 0,
          bookingWindowEndHour: 24,
        },
        communityResourceId: 'cr-resource-a',
      }),
    };
    const recurringBookings = {
      listRuleOccurrencesForDay: jest.fn().mockResolvedValue([]),
    };
    const metrics = { observeBookingSlotsBuildDuration: jest.fn() };
    const svc = new BookingService(
      prisma as never,
      resources as never,
      recurringBookings as never,
      metrics as never,
      { t: () => '' } as never,
    );
    const slots = await svc.getAvailableStartSlots({
      resourceId: 'resource-a',
      telegramChatId: 1n,
      dayOffset: 0,
      now: new Date('2026-04-06T06:00:00Z'),
      telegramGroupAdmin: true,
      telegramUserId: 10,
    });
    expect(slots.some((s) => s.hour === 8 && s.minute === 30)).toBe(true);
  });

  it('throws SlotTakenError when creating booking over recurring rule', async () => {
    const tx = {
      booking: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
    };
    const prisma = {
      communityResourceUserBookingLimit: { findMany: jest.fn().mockResolvedValue([]) },
      booking: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn().mockImplementation((cb: (arg: unknown) => unknown) => cb(tx)),
    };
    const resources = {
      findByIdForChat: jest.fn().mockResolvedValue({
        id: 'resource-a',
        name: 'resource-a',
        timeZone: 'UTC',
        workingHours: [
          { weekday: 1, isClosed: false, slotStartHour: 8, slotEndHour: 21 },
        ],
        community: {
          bookingWindowTimeZone: 'UTC',
          bookingWindowStartHour: 0,
          bookingWindowEndHour: 24,
        },
        communityResourceId: 'cr-resource-a',
      }),
    };
    const recurringBookings = {
      listRuleOccurrencesForDay: jest.fn().mockResolvedValue([
        {
          ruleId: 'rule-1',
          startTime: new Date('2026-04-06T09:00:00Z'),
          endTime: new Date('2026-04-06T11:00:00Z'),
          sportKindCode: 'TENNIS',
        },
      ]),
    };
    const metrics = {
      incBookingCreateConflict: jest.fn(),
      incBookingCreate: jest.fn(),
      observeBookingCreateDuration: jest.fn(),
      incBookingCreateSystemError: jest.fn(),
    };
    const svc = new BookingService(
      prisma as never,
      resources as never,
      recurringBookings as never,
      metrics as never,
      { t: () => '' } as never,
    );
    await expect(
      svc.createBooking({
        resourceId: 'resource-a',
        telegramChatId: 1n,
        from: { id: 10, first_name: 'A' },
        dayOffset: 0,
        startHour: 9,
        startMinute: 0,
        durationMinutes: 120,
        telegramGroupAdmin: true,
        displayLocale: 'en',
        now: new Date('2026-04-06T06:00:00Z'),
      }),
    ).rejects.toBeInstanceOf(SlotTakenError);
  });
});
