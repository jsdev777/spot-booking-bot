import type { BookingDurationMinutes } from '../booking/booking-intervals';
import type { SportKindCode } from '@prisma/client';

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
  /** `viewedDayOffset` is set after the user opens the schedule for today or tomorrow (used to skip day pick when booking from this screen). */
  | { t: 'grid_day'; resourceId: string; viewedDayOffset?: 0 | 1 }
  | { t: 'list'; bookingIds: string[]; rowLabels: string[] }
  /** Pick one of your bookings to enable partner search. */
  | { t: 'list_looking_pick'; bookingIds: string[]; rowLabels: string[] }
  /** Enter total partners needed for the selected booking. */
  | {
      t: 'list_looking_players';
      bookingId: string;
      /** Minimum allowed target (= max(1, joinedCount)). */
      minTargetPartners: number;
      joinedCount: number;
    }
  /** Reservations with partner search (the “Available Seats” button). */
  | { t: 'free_slots'; bookingIds: string[]; rowLabels: string[] };

export function defaultMenuState(): MenuState {
  return { t: 'main' };
}
