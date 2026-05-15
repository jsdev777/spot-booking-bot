import {
  buildLookingLeaveCallbackData,
  parseLookingLeaveCallback,
} from './looking-leave-callback';

describe('looking-leave-callback', () => {
  const bookingId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  const userId = 12345;

  it('round-trips booking id and user id', () => {
    const data = buildLookingLeaveCallbackData(bookingId, userId);
    expect(data.length).toBeLessThanOrEqual(64);
    expect(parseLookingLeaveCallback(data)).toEqual({
      telegramUserId: userId,
      bookingId,
    });
  });

  it('rejects malformed callback data', () => {
    expect(parseLookingLeaveCallback('lv:1:not-a-uuid')).toBeNull();
    expect(parseLookingLeaveCallback('gr:1:2')).toBeNull();
  });
});
