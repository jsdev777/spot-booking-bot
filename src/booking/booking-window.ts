import { toZonedTime } from 'date-fns-tz';

/**
 * Текущее локальное время в `timeZone` попадает в полуинтервал
 * [startHour, endHour) по часам стенных часов (минуты учитываются).
 * endHour 24 означает до 24:00 (полночь) того же календарного дня.
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
