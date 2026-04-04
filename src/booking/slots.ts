import { addDays, set, startOfDay } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';

export const DEFAULT_FIRST_SLOT_HOUR = 9;
export const DEFAULT_LAST_SLOT_HOUR = 21;

export function getSlotStartsUtc(params: {
  now: Date;
  dayOffset: number;
  timeZone: string;
  firstHour?: number;
  lastHour?: number;
}): Date[] {
  const firstHour = params.firstHour ?? DEFAULT_FIRST_SLOT_HOUR;
  const lastHour = params.lastHour ?? DEFAULT_LAST_SLOT_HOUR;

  const zonedNow = toZonedTime(params.now, params.timeZone);
  const localDayStart = startOfDay(zonedNow);
  const targetLocalDay = addDays(localDayStart, params.dayOffset);
  const slots: Date[] = [];
  for (let hour = firstHour; hour <= lastHour; hour++) {
    const localSlot = set(targetLocalDay, {
      hours: hour,
      minutes: 0,
      seconds: 0,
      milliseconds: 0,
    });
    slots.push(fromZonedTime(localSlot, params.timeZone));
  }
  return slots;
}

export function getSingleSlotUtc(params: {
  now: Date;
  dayOffset: number;
  hour: number;
  timeZone: string;
  firstHour: number;
  lastHour: number;
}): Date {
  return getSlotStartsUtc({
    now: params.now,
    dayOffset: params.dayOffset,
    timeZone: params.timeZone,
    firstHour: params.hour,
    lastHour: params.hour,
  })[0];
}

export function isHourBookable(
  hour: number,
  minHour: number,
  maxHour: number,
): boolean {
  return Number.isInteger(hour) && hour >= minHour && hour <= maxHour;
}

/** Старт брони в :00 или :30 в пределах [minHour, maxHour]. */
export function isStartSlotBookable(
  hour: number,
  minute: number,
  minHour: number,
  maxHour: number,
): boolean {
  if (minute !== 0 && minute !== 30) {
    return false;
  }
  return Number.isInteger(hour) && hour >= minHour && hour <= maxHour;
}
