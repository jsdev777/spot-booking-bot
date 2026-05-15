/** Inline callback: participant leaves a “player search” game (DM button). */
export const LOOKING_LEAVE_CALLBACK_RE =
  /^lv:(\d+):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export type ParsedLookingLeaveCallback = {
  telegramUserId: number;
  bookingId: string;
};

export function buildLookingLeaveCallbackData(
  bookingId: string,
  telegramUserId: number,
): string {
  return `lv:${telegramUserId}:${bookingId}`;
}

export function parseLookingLeaveCallback(
  data: string,
): ParsedLookingLeaveCallback | null {
  const m = LOOKING_LEAVE_CALLBACK_RE.exec(data);
  if (!m) {
    return null;
  }
  return { telegramUserId: Number(m[1]), bookingId: m[2] };
}
