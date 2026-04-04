import type { Context } from 'telegraf';

export function isGroupChat(ctx: Context): boolean {
  const t = ctx.chat?.type;
  return t === 'group' || t === 'supergroup';
}

export async function isGroupAdmin(ctx: Context): Promise<boolean> {
  if (!ctx.chat || !ctx.from) {
    return false;
  }
  try {
    const m = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
    return m.status === 'creator' || m.status === 'administrator';
  } catch {
    return false;
  }
}

/** Checking administrator permissions in the specified chat (for private messages when `ctx.chat` is not a group). */
export async function isUserAdminOfGroupChat(
  telegram: Context['telegram'],
  groupChatId: bigint,
  userId: number,
): Promise<boolean> {
  try {
    const m = await telegram.getChatMember(groupChatId.toString(), userId);
    return m.status === 'creator' || m.status === 'administrator';
  } catch {
    return false;
  }
}
