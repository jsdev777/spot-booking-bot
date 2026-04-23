import { RecurringBookingService } from './recurring-booking.service';

describe('RecurringBookingService', () => {
  it('builds occurrences for a local day', async () => {
    const prisma = {
      recurringBookingRule: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'rule-1',
            sportKindCode: 'TENNIS',
            startMinuteOfDay: 600,
            durationMinutes: 90,
          },
        ]),
      },
    };
    const svc = new RecurringBookingService(prisma as never);
    const out = await svc.listRuleOccurrencesForDay({
      resourceId: 'resource-a',
      localDay: new Date('2026-04-06T00:00:00.000Z'),
      timeZone: 'UTC',
      windowStartUtc: new Date('2026-04-06T00:00:00.000Z'),
      maxEndUtc: new Date('2026-04-07T00:00:00.000Z'),
    });
    expect(out).toHaveLength(1);
    expect(out[0].startTime.toISOString()).toBe('2026-04-06T10:00:00.000Z');
    expect(out[0].endTime.toISOString()).toBe('2026-04-06T11:30:00.000Z');
  });

  it('filters rules by end date before local day', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = { recurringBookingRule: { findMany } };
    const svc = new RecurringBookingService(prisma as never);
    const out = await svc.listRuleOccurrencesForDay({
      resourceId: 'resource-a',
      localDay: new Date('2026-04-06T00:00:00.000Z'),
      timeZone: 'UTC',
      windowStartUtc: new Date('2026-04-06T00:00:00.000Z'),
      maxEndUtc: new Date('2026-04-07T00:00:00.000Z'),
    });
    expect(out).toEqual([]);
    const where = findMany.mock.calls[0][0].where as { endDate: { gte: Date } };
    expect(where.endDate.gte.toISOString().startsWith('2026-04-06')).toBe(true);
  });
});
