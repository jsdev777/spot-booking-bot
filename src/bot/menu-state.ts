import type { BookingDurationMinutes } from '../booking/booking-intervals';
import type { SportKindCode } from '../generated/prisma/client';

/** Menu state in the group (per user). */
export type MenuState =
  | { t: 'main' }
  /** First, select a sport (for both participants and administrators). */
  | { t: 'book_sport' }
  | { t: 'book_res'; sportKindCode?: SportKindCode }
  | { t: 'book_day'; resourceId: string; sportKindCode?: SportKindCode }
  | {
      t: 'book_hour';
      resourceId: string;
      dayOffset: 0 | 1;
      sportKindCode?: SportKindCode;
    }
  | {
      t: 'book_dur';
      resourceId: string;
      dayOffset: 0 | 1;
      hour: number;
      startMinute: number;
      sportKindCode?: SportKindCode;
    }
  | {
      t: 'book_looking';
      resourceId: string;
      dayOffset: 0 | 1;
      hour: number;
      startMinute: number;
      sportKindCode?: SportKindCode;
      durationMinutes: BookingDurationMinutes;
    }
  | {
      t: 'book_players';
      resourceId: string;
      dayOffset: 0 | 1;
      hour: number;
      startMinute: number;
      sportKindCode?: SportKindCode;
      durationMinutes: BookingDurationMinutes;
    }
  | { t: 'grid_res' }
  | { t: 'grid_day'; resourceId: string }
  | { t: 'list'; bookingIds: string[]; rowLabels: string[] }
  /** Reservations with partner search (the “Available Seats” button). */
  | { t: 'free_slots'; bookingIds: string[]; rowLabels: string[] };

export function defaultMenuState(): MenuState {
  return { t: 'main' };
}
