import { toZonedTime } from 'date-fns-tz';

/**
 * The current local time in `timeZone` falls within the half-interval
 * [startHour, endHour) based on wall clock time (minutes are taken into account).
 * endHour 24 means before 24:00 (midnight) of the same calendar day.
 */
export function isLocalTimeWithinBookingWindow(params: {
  now: Date;
  timeZone: string;
  startHour: number;
  endHour: number;
}): boolean {
  const { now, timeZone, startHour, endHour } = params;
  if (
    startHour < 0 ||
    startHour > 23 ||
    endHour < 1 ||
    endHour > 24 ||
    startHour >= endHour
  ) {
    return true;
  }
  const z = toZonedTime(now, timeZone);
  const minutes = z.getHours() * 60 + z.getMinutes();
  const startM = startHour * 60;
  const endM = endHour >= 24 ? 24 * 60 : endHour * 60;
  return minutes >= startM && minutes < endM;
}
