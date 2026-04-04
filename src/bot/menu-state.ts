import type { BookingDurationMinutes } from '../booking/booking-intervals';
import type { SportKindCode } from '../generated/prisma/client';

/** Состояние меню в группе (на пользователя). */
export type MenuState =
  | { t: 'main' }
  /** Сначала выбор вида спорта (и у участников, и у админов). */
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
  /** Брони с поиском партнёров (кнопка «Свободные места»). */
  | { t: 'free_slots'; bookingIds: string[]; rowLabels: string[] };

export function defaultMenuState(): MenuState {
  return { t: 'main' };
}
