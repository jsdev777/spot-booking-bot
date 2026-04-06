import { BookingService } from './booking.service';

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
          timeZone: 'Europe/Kyiv',
          workingHours: [
            {
              weekday: 1,
              isClosed: false,
              slotStartHour: 8,
              slotEndHour: 21,
            },
          ],
          community: {
            bookingWindowTimeZone: 'Europe/Kyiv',
            bookingWindowStartHour: 0,
            bookingWindowEndHour: 24,
          },
          communityResourceId:
            resourceId === 'resource-a' ? 'cr-resource-a' : 'cr-resource-b',
        }),
      ),
    };

    const svc = new BookingService(prisma as never, resources as never);
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
});
