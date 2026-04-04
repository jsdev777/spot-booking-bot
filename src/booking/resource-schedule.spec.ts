import { addDays, startOfDay } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import {
  isoWeekdayInTimeZone,
  resolveResourceDaySchedule,
  type WorkingHourRow,
} from './resource-schedule';

describe('resolveResourceDaySchedule', () => {
  it('returns closed when row missing', () => {
    expect(resolveResourceDaySchedule([], 1)).toEqual({ kind: 'closed' });
  });

  it('returns closed when isClosed', () => {
    const rows: WorkingHourRow[] = [
      {
        weekday: 3,
        isClosed: true,
        slotStartHour: null,
        slotEndHour: null,
      },
    ];
    expect(resolveResourceDaySchedule(rows, 3)).toEqual({ kind: 'closed' });
  });

  it('returns open window when set', () => {
    const rows: WorkingHourRow[] = [
      {
        weekday: 2,
        isClosed: false,
        slotStartHour: 9,
        slotEndHour: 21,
      },
    ];
    expect(resolveResourceDaySchedule(rows, 2)).toEqual({
      kind: 'open',
      slotStartHour: 9,
      slotEndHour: 21,
    });
  });
});

describe('isoWeekdayInTimeZone', () => {
  it('matches local calendar weekday in resource TZ', () => {
    const tz = 'Europe/Moscow';
    const now = new Date('2026-04-06T12:00:00Z');
    const localDay = startOfDay(toZonedTime(now, tz));
    expect(isoWeekdayInTimeZone(localDay, tz)).toBe(1);
    expect(isoWeekdayInTimeZone(addDays(localDay, 1), tz)).toBe(2);
  });
});
