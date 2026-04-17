/** Inline callback for setting TelegramUser.defaultLanguageId (private /start flow). */
export const USERLANG_CALLBACK_RE = /^userlang:(\d+):([\w-]+)$/;

export type ParsedUserlangCallback = {
  telegramUserId: number;
  languageId: string;
};

export function parseUserlangCallback(
  data: string,
): ParsedUserlangCallback | null {
  const m = USERLANG_CALLBACK_RE.exec(data);
  if (!m) {
    return null;
  }
  return { telegramUserId: Number(m[1]), languageId: m[2] };
}
