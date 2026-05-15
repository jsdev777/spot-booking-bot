import { BookingService } from './booking.service';
import { LookingTargetBelowJoinedError } from './booking.errors';

describe('BookingService.setLookingPartnersTargetOnBooking', () => {
  const baseBooking = {
    id: 'b1',
    status: 'ACTIVE',
    userId: 10n,
    startTime: new Date('2026-06-01T10:00:00Z'),
    requiredPlayers: 0,
    isLookingForPlayers: false,
    resourceId: 'r1',
    sportKindCode: 'TENNIS',
    resource: {
      name: 'Court',
      timeZone: 'UTC',
      address: null,
    },
    sportKind: { sportKindCode: 'TENNIS' },
    lookingParticipants: [
      { peopleCount: 2 },
      { peopleCount: 1 },
    ],
  };

  function makeService(participants = baseBooking.lookingParticipants) {
    const booking = {
      ...baseBooking,
      lookingParticipants: participants,
    };
    const prisma = {
      booking: {
        findFirst: jest.fn().mockResolvedValue(booking),
        update: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            ...booking,
            ...data,
            resource: booking.resource,
            sportKind: booking.sportKind,
          }),
        ),
      },
    };
    const svc = new BookingService(
      prisma as never,
      {} as never,
      {} as never,
      { observeBookingSlotsBuildDuration: jest.fn() } as never,
      { t: () => '' } as never,
    );
    return { svc, prisma };
  }

  it('sets remaining slots to target minus joined', async () => {
    const { svc, prisma } = makeService();
    const result = await svc.setLookingPartnersTargetOnBooking({
      bookingId: 'b1',
      telegramChatId: 1n,
      telegramUserId: 10,
      targetPartners: 5,
      now: new Date('2026-05-01T00:00:00Z'),
    });
    expect(result.joinedCount).toBe(3);
    expect(result.remainingPlayers).toBe(2);
    expect(result.searchClosed).toBe(false);
    expect(prisma.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          isLookingForPlayers: true,
          requiredPlayers: 2,
        },
      }),
    );
  });

  it('closes search when target equals joined', async () => {
    const { svc } = makeService();
    const result = await svc.setLookingPartnersTargetOnBooking({
      bookingId: 'b1',
      telegramChatId: 1n,
      telegramUserId: 10,
      targetPartners: 3,
      now: new Date('2026-05-01T00:00:00Z'),
    });
    expect(result.searchClosed).toBe(true);
    expect(result.remainingPlayers).toBe(0);
  });

  it('rejects target below joined count', async () => {
    const { svc } = makeService();
    await expect(
      svc.setLookingPartnersTargetOnBooking({
        bookingId: 'b1',
        telegramChatId: 1n,
        telegramUserId: 10,
        targetPartners: 2,
        now: new Date('2026-05-01T00:00:00Z'),
      }),
    ).rejects.toBeInstanceOf(LookingTargetBelowJoinedError);
  });
});
