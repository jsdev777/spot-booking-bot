import { parseUserlangCallback } from '../bot/userlang-callback';
import { TelegramMembersService } from './telegram-members.service';

function svcWithPrisma(prisma: object): TelegramMembersService {
  return new TelegramMembersService(prisma as never);
}

describe('TelegramMembersService getEffectiveLanguageId', () => {
  it('returns membership language when set', async () => {
    const prisma = {
      telegramUser: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'u1',
          defaultLanguageId: 'en',
        }),
      },
      groupChatMembership: {
        findUnique: jest.fn().mockResolvedValue({ languageId: 'de' }),
      },
    };
    const svc = svcWithPrisma(prisma);
    const id = await svc.getEffectiveLanguageId({
      telegramChatId: 10n,
      telegramUserId: 42,
    });
    expect(id).toBe('de');
  });

  it('falls back to user default when membership language is null', async () => {
    const prisma = {
      telegramUser: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'u1',
          defaultLanguageId: 'en',
        }),
      },
      groupChatMembership: {
        findUnique: jest.fn().mockResolvedValue({ languageId: null }),
      },
    };
    const svc = svcWithPrisma(prisma);
    const id = await svc.getEffectiveLanguageId({
      telegramChatId: 10n,
      telegramUserId: 42,
    });
    expect(id).toBe('en');
  });

  it('with null chat returns only user default', async () => {
    const prisma = {
      telegramUser: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'u1',
          defaultLanguageId: 'pl',
        }),
      },
      groupChatMembership: {
        findUnique: jest.fn(),
      },
    };
    const svc = svcWithPrisma(prisma);
    const id = await svc.getEffectiveLanguageId({
      telegramChatId: null,
      telegramUserId: 7,
    });
    expect(id).toBe('pl');
    expect(prisma.groupChatMembership.findUnique).not.toHaveBeenCalled();
  });

  it('returns null when user is missing', async () => {
    const prisma = {
      telegramUser: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      groupChatMembership: {
        findUnique: jest.fn(),
      },
    };
    const svc = svcWithPrisma(prisma);
    const id = await svc.getEffectiveLanguageId({
      telegramChatId: 10n,
      telegramUserId: 99,
    });
    expect(id).toBeNull();
  });
});

describe('TelegramMembersService setUserDefaultLanguage', () => {
  it('rejects unknown language id', async () => {
    const prisma = {
      language: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      telegramUser: { upsert: jest.fn() },
    };
    const svc = svcWithPrisma(prisma);
    const r = await svc.setUserDefaultLanguage({
      telegramUserId: 1,
      languageId: 'xx',
    });
    expect(r).toEqual({ ok: false, reason: 'bad_language' });
    expect(prisma.telegramUser.upsert).not.toHaveBeenCalled();
  });

  it('upserts telegram user with default language', async () => {
    type TelegramUserUpsertArg = {
      where: { telegramUserId: bigint };
      create: { defaultLanguageId: string; telegramUserId: bigint };
      update: { defaultLanguageId: string };
    };
    const upsert = jest
      .fn<Promise<object>, [TelegramUserUpsertArg]>()
      .mockResolvedValue({});
    const prisma = {
      language: {
        findUnique: jest.fn().mockResolvedValue({ id: 'uk' }),
      },
      telegramUser: { upsert },
    };
    const svc = svcWithPrisma(prisma);
    const r = await svc.setUserDefaultLanguage({
      telegramUserId: 555,
      languageId: 'uk',
      username: 'u',
    });
    expect(r).toEqual({ ok: true });
    expect(upsert).toHaveBeenCalledTimes(1);
    const [arg] = upsert.mock.calls[0];
    expect(arg.where.telegramUserId).toBe(555n);
    expect(arg.create.defaultLanguageId).toBe('uk');
    expect(arg.create.telegramUserId).toBe(555n);
    expect(arg.update.defaultLanguageId).toBe('uk');
  });
});

describe('userlang callback security', () => {
  it('detects mismatch between Telegram actor and callback payload user id', () => {
    const fromId = 100;
    const parsed = parseUserlangCallback('userlang:99:uk');
    expect(parsed).not.toBeNull();
    expect(fromId === parsed!.telegramUserId).toBe(false);
  });
});

describe('TelegramMembersService participantMustPickLanguage', () => {
  it('is false when user has global default even if membership language is null', async () => {
    const prisma = {
      telegramUser: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'u1',
          defaultLanguageId: 'en',
        }),
      },
      groupChatMembership: {
        findUnique: jest.fn().mockResolvedValue({
          isActive: true,
          languageId: null,
        }),
      },
    };
    const svc = svcWithPrisma(prisma);
    const must = await svc.participantMustPickLanguage({
      telegramChatId: 1n,
      telegramUserId: 10,
    });
    expect(must).toBe(false);
  });

  it('is true when membership language is null and user has no default', async () => {
    const prisma = {
      telegramUser: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'u1',
          defaultLanguageId: null,
        }),
      },
      groupChatMembership: {
        findUnique: jest.fn().mockResolvedValue({
          isActive: true,
          languageId: null,
        }),
      },
    };
    const svc = svcWithPrisma(prisma);
    const must = await svc.participantMustPickLanguage({
      telegramChatId: 1n,
      telegramUserId: 10,
    });
    expect(must).toBe(true);
  });
});
