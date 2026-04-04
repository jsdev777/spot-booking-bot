import {
  getSingleSlotUtc,
  getSlotStartsUtc,
  isHourBookable,
  isStartSlotBookable,
} from './slots';

describe('slots', () => {
  it('returns 13 hourly slots for default range', () => {
    const now = new Date('2026-06-15T12:00:00.000Z');
    const slots = getSlotStartsUtc({
      now,
      dayOffset: 0,
      timeZone: 'Europe/Kyiv',
    });
    expect(slots).toHaveLength(13);
    expect(slots[0].getUTCHours()).toBe(6);
    expect(slots[12].getUTCHours()).toBe(18);
  });

  it('getSingleSlotUtc matches slot list', () => {
    const now = new Date('2026-06-15T12:00:00.000Z');
    const list = getSlotStartsUtc({
      now,
      dayOffset: 1,
      timeZone: 'Europe/Kyiv',
      firstHour: 9,
      lastHour: 21,
    });
    const single = getSingleSlotUtc({
      now,
      dayOffset: 1,
      hour: 9,
      timeZone: 'Europe/Kyiv',
      firstHour: 9,
      lastHour: 21,
    });
    expect(single.getTime()).toBe(list[0].getTime());
  });

  it('isHourBookable respects range', () => {
    expect(isHourBookable(8, 9, 21)).toBe(false);
    expect(isHourBookable(9, 9, 21)).toBe(true);
    expect(isHourBookable(21, 9, 21)).toBe(true);
    expect(isHourBookable(22, 9, 21)).toBe(false);
  });

  it('isStartSlotBookable allows :00 and :30 within hour range', () => {
    expect(isStartSlotBookable(9, 0, 9, 21)).toBe(true);
    expect(isStartSlotBookable(9, 30, 9, 21)).toBe(true);
    expect(isStartSlotBookable(21, 30, 9, 21)).toBe(true);
    expect(isStartSlotBookable(9, 15, 9, 21)).toBe(false);
    expect(isStartSlotBookable(8, 0, 9, 21)).toBe(false);
  });
});
