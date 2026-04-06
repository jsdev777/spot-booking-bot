import { hourSegmentOccupancy, intervalsOverlap } from './booking-intervals';

describe('intervalsOverlap', () => {
  it('detects overlap', () => {
    const a = new Date('2026-06-15T10:00:00.000Z');
    const b = new Date('2026-06-15T11:00:00.000Z');
    const c = new Date('2026-06-15T10:30:00.000Z');
    const d = new Date('2026-06-15T11:30:00.000Z');
    expect(intervalsOverlap(a, b, c, d)).toBe(true);
  });

  it('no overlap when touching boundary', () => {
    const a = new Date('2026-06-15T10:00:00.000Z');
    const b = new Date('2026-06-15T11:00:00.000Z');
    const c = new Date('2026-06-15T11:00:00.000Z');
    const d = new Date('2026-06-15T12:00:00.000Z');
    expect(intervalsOverlap(a, b, c, d)).toBe(false);
  });
});

describe('hourSegmentOccupancy', () => {
  it('бронювання на 1,5 години: перша година повністю зайнята, наступна — частково', () => {
    const h9 = new Date('2026-06-15T09:00:00.000Z');
    const h10 = new Date('2026-06-15T10:00:00.000Z');
    const h11 = new Date('2026-06-15T11:00:00.000Z');
    const booking = {
      startTime: h9,
      endTime: new Date('2026-06-15T10:30:00.000Z'),
    };
    expect(hourSegmentOccupancy(h9, h10, [booking])).toBe('full');
    expect(hourSegmentOccupancy(h10, h11, [booking])).toBe('partial');
  });

  it('дві суміжні броні на 30 хвилин заповнюють цілу годину', () => {
    const h9 = new Date('2026-06-15T09:00:00.000Z');
    const h10 = new Date('2026-06-15T10:00:00.000Z');
    const bookings = [
      {
        startTime: h9,
        endTime: new Date('2026-06-15T09:30:00.000Z'),
      },
      {
        startTime: new Date('2026-06-15T09:30:00.000Z'),
        endTime: h10,
      },
    ];
    expect(hourSegmentOccupancy(h9, h10, bookings)).toBe('full');
  });
});
