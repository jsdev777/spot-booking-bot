import { set } from 'date-fns';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

export type ResourceDaySchedule =
  | { kind: 'closed' }
  | { kind: 'open'; slotStartHour: number; slotEndHour: number };

export type WorkingHourRow = {
  weekday: number;
  isClosed: boolean;
  slotStartHour: number | null;
  slotEndHour: number | null;
};

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

/** ISO день недели 1–7 (пн–вс) для календарного дня `localDay` в часовом поясе площадки. */
export function isoWeekdayInTimeZone(localDay: Date, timeZone: string): number {
  return Number(
    formatInTimeZone(atLocalHour(localDay, 12, 0, timeZone), timeZone, 'i'),
  );
}

export function resolveResourceDaySchedule(
  workingHours: WorkingHourRow[],
  isoWeekday: number,
): ResourceDaySchedule {
  const row = workingHours.find((w) => w.weekday === isoWeekday);
  if (
    !row ||
    row.isClosed ||
    row.slotStartHour == null ||
    row.slotEndHour == null
  ) {
    return { kind: 'closed' };
  }
  return {
    kind: 'open',
    slotStartHour: row.slotStartHour,
    slotEndHour: row.slotEndHour,
  };
}
