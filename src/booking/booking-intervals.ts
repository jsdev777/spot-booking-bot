/** Half-open intervals [start, end) in UTC. */
export function intervalsOverlap(
  aStart: Date,
  aEnd: Date,
  bStart: Date,
  bEnd: Date,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export const BOOKING_DURATION_MINUTES = [60, 90, 120] as const;
export type BookingDurationMinutes = (typeof BOOKING_DURATION_MINUTES)[number];

/** A one-hour time slot [segStart, segEnd) relative to the bookings for that day. */
export type HourSegmentOccupancy = 'free' | 'full' | 'partial';

/**
 * If the entire hour is booked, the entire time slot is reserved; otherwise, if any part of the hour is booked, only that portion is reserved.
 */
export function hourSegmentOccupancy(
  segStart: Date,
  segEnd: Date,
  bookings: { startTime: Date; endTime: Date }[],
): HourSegmentOccupancy {
  const segLen = segEnd.getTime() - segStart.getTime();
  if (segLen <= 0) {
    return 'free';
  }

  const parts: [number, number][] = [];
  for (const b of bookings) {
    const s = Math.max(segStart.getTime(), b.startTime.getTime());
    const e = Math.min(segEnd.getTime(), b.endTime.getTime());
    if (s < e) {
      parts.push([s, e]);
    }
  }
  if (parts.length === 0) {
    return 'free';
  }

  parts.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [[parts[0][0], parts[0][1]]];
  for (let i = 1; i < parts.length; i++) {
    const [s, e] = parts[i];
    const last = merged[merged.length - 1];
    if (s <= last[1]) {
      last[1] = Math.max(last[1], e);
    } else {
      merged.push([s, e]);
    }
  }

  const covered = merged.reduce((acc, [s, e]) => acc + (e - s), 0);
  if (covered >= segLen) {
    return 'full';
  }
  return 'partial';
}
