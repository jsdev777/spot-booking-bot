import { isLocalTimeWithinBookingWindow } from './booking-window';

describe('isLocalTimeWithinBookingWindow', () => {
  it('allows full day 0–24 in Europe/Moscow', () => {
    const now = new Date('2026-06-15T12:00:00.000Z');
    expect(
      isLocalTimeWithinBookingWindow({
        now,
        timeZone: 'Europe/Moscow',
        startHour: 0,
        endHour: 24,
      }),
    ).toBe(true);
  });

  it('excludes times before start (Moscow local)', () => {
    const now = new Date('2026-06-15T05:30:00.000Z');
    expect(
      isLocalTimeWithinBookingWindow({
        now,
        timeZone: 'Europe/Moscow',
        startHour: 9,
        endHour: 21,
      }),
    ).toBe(false);
  });

  it('excludes end hour (half-open [start, end))', () => {
    const now = new Date('2026-06-15T15:00:00.000Z');
    expect(
      isLocalTimeWithinBookingWindow({
        now,
        timeZone: 'Europe/Moscow',
        startHour: 9,
        endHour: 18,
      }),
    ).toBe(false);
  });

  it('treats invalid config as always open', () => {
    const now = new Date();
    expect(
      isLocalTimeWithinBookingWindow({
        now,
        timeZone: 'Europe/Moscow',
        startHour: 10,
        endHour: 10,
      }),
    ).toBe(true);
  });
});
