import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { resolveCommunityRulesText } from './community.service';

const IN_CHAT_STATUSES = new Set([
  'creator',
  'administrator',
  'member',
  'restricted',
]);

export type RecordJoinResult = {
  /**
   * User must pick a per-group UI language (no membership.languageId and no TelegramUser.defaultLanguageId).
   * Applies to any linked group chat membership, including chats without a configured community.
   */
  pendingLanguageSelection: boolean;
  /** Display the rules and wait for the button (language already chosen). */
  pendingGroupRules: boolean;
  rulesText: string | null;
};

@Injectable()
export class TelegramMembersService {
  constructor(private readonly prisma: PrismaService) {}

  async listActiveUserCommunities(telegramUserId: number): Promise<
    {
      telegramChatId: bigint;
      communityName: string | null;
      groupRulesAccepted: boolean;
    }[]
  > {
    const rows = await this.prisma.groupChatMembership.findMany({
      where: {
        isActive: true,
        user: { telegramUserId: BigInt(telegramUserId) },
      },
      include: {
        community: { select: { name: true } },
      },
      orderBy: [{ joinedAt: 'desc' }],
    });
    return rows.map((r) => ({
      telegramChatId: r.telegramChatId,
      communityName: r.community?.name ?? null,
      groupRulesAccepted: r.groupRulesAccepted,
    }));
  }

  async getMembershipLanguageId(params: {
    telegramChatId: bigint;
    telegramUserId: number;
  }): Promise<string | null> {
    const user = await this.prisma.telegramUser.findUnique({
      where: { telegramUserId: BigInt(params.telegramUserId) },
      select: { id: true },
    });
    if (!user) {
      return null;
    }
    const m = await this.prisma.groupChatMembership.findUnique({
      where: {
        telegramChatId_userId: {
          telegramChatId: params.telegramChatId,
          userId: user.id,
        },
      },
      select: { languageId: true },
    });
    return m?.languageId ?? null;
  }

  /**
   * UI language for this user in a chat context: membership override, else user default, else null (caller uses resolveUiLang).
   */
  async getEffectiveLanguageId(params: {
    telegramChatId: bigint | null;
    telegramUserId: number;
  }): Promise<string | null> {
    const user = await this.prisma.telegramUser.findUnique({
      where: { telegramUserId: BigInt(params.telegramUserId) },
      select: { id: true, defaultLanguageId: true },
    });
    if (!user) {
      return null;
    }
    if (params.telegramChatId == null) {
      return user.defaultLanguageId ?? null;
    }
    const m = await this.prisma.groupChatMembership.findUnique({
      where: {
        telegramChatId_userId: {
          telegramChatId: params.telegramChatId,
          userId: user.id,
        },
      },
      select: { languageId: true },
    });
    return m?.languageId ?? user.defaultLanguageId ?? null;
  }

  async upsertTelegramUser(params: {
    telegramUserId: number;
    username?: string;
    firstName?: string;
    lastName?: string;
  }): Promise<{ defaultLanguageId: string | null }> {
    const u = await this.prisma.telegramUser.upsert({
      where: { telegramUserId: BigInt(params.telegramUserId) },
      create: {
        telegramUserId: BigInt(params.telegramUserId),
        username: params.username ?? null,
        firstName: params.firstName ?? null,
        lastName: params.lastName ?? null,
      },
      update: {
        username: params.username ?? null,
        firstName: params.firstName ?? null,
        lastName: params.lastName ?? null,
      },
      select: { defaultLanguageId: true },
    });
    return { defaultLanguageId: u.defaultLanguageId };
  }

  async setUserDefaultLanguage(params: {
    telegramUserId: number;
    languageId: string;
    username?: string;
    firstName?: string;
    lastName?: string;
  }): Promise<{ ok: true } | { ok: false; reason: string }> {
    const lang = await this.prisma.language.findUnique({
      where: { id: params.languageId },
      select: { id: true },
    });
    if (!lang) {
      return { ok: false, reason: 'bad_language' };
    }
    await this.prisma.telegramUser.upsert({
      where: { telegramUserId: BigInt(params.telegramUserId) },
      create: {
        telegramUserId: BigInt(params.telegramUserId),
        username: params.username ?? null,
        firstName: params.firstName ?? null,
        lastName: params.lastName ?? null,
        defaultLanguageId: params.languageId,
      },
      update: {
        defaultLanguageId: params.languageId,
        username: params.username ?? null,
        firstName: params.firstName ?? null,
        lastName: params.lastName ?? null,
      },
    });
    return { ok: true };
  }

  async listLanguagesForPicker(): Promise<
    { id: string; nameNative: string }[]
  > {
    return this.prisma.language.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, nameNative: true },
    });
  }

  async setMembershipLanguage(params: {
    telegramChatId: bigint;
    telegramUserId: number;
    languageId: string;
  }): Promise<{ ok: true } | { ok: false; reason: string }> {
    const lang = await this.prisma.language.findUnique({
      where: { id: params.languageId },
      select: { id: true },
    });
    if (!lang) {
      return { ok: false, reason: 'bad_language' };
    }
    const user = await this.prisma.telegramUser.findUnique({
      where: { telegramUserId: BigInt(params.telegramUserId) },
      select: { id: true },
    });
    if (!user) {
      return { ok: false, reason: 'no_user' };
    }
    const comm = await this.prisma.community.findUnique({
      where: {
        telegramChatId: params.telegramChatId,
      },
      select: { id: true },
    });
    await this.prisma.groupChatMembership.upsert({
      where: {
        telegramChatId_userId: {
          telegramChatId: params.telegramChatId,
          userId: user.id,
        },
      },
      create: {
        telegramChatId: params.telegramChatId,
        userId: user.id,
        communityId: comm?.id ?? null,
        languageId: params.languageId,
        groupRulesAccepted: false,
        isActive: true,
        leftAt: null,
      },
      update: {
        languageId: params.languageId,
        isActive: true,
        leftAt: null,
        joinedAt: new Date(),
        ...(comm ? { communityId: comm.id } : {}),
      },
    });
    return { ok: true };
  }

  /**
   * Regular members must pick a language before rules/menu when they have no per-group or default locale.
   */
  async participantMustPickLanguage(params: {
    telegramChatId: bigint;
    telegramUserId: number;
  }): Promise<boolean> {
    const user = await this.prisma.telegramUser.findUnique({
      where: { telegramUserId: BigInt(params.telegramUserId) },
      select: { id: true, defaultLanguageId: true },
    });
    if (!user) {
      return false;
    }
    const m = await this.prisma.groupChatMembership.findUnique({
      where: {
        telegramChatId_userId: {
          telegramChatId: params.telegramChatId,
          userId: user.id,
        },
      },
      select: { isActive: true, languageId: true },
    });
    if (!m?.isActive) {
      return false;
    }
    return m.languageId == null && user.defaultLanguageId == null;
  }

  async getGroupRulesText(
    telegramChatId: bigint,
    telegramUserId?: number,
  ): Promise<string | null> {
    const comm = await this.prisma.community.findUnique({
      where: { telegramChatId },
      include: { rules: true },
    });
    if (!comm) {
      return null;
    }
    const preferredLanguageId =
      telegramUserId == null
        ? null
        : await this.getEffectiveLanguageId({
            telegramChatId,
            telegramUserId,
          });
    return resolveCommunityRulesText(comm.rules, preferredLanguageId);
  }

  /** A user is considered to be in the chat if they have one of these chat_member statuses. */
  static isStatusInChat(status: string): boolean {
    return IN_CHAT_STATUSES.has(status);
  }

  /**
   * Regular members (non-group admins) must accept the rules before using the bot.
   * true = access to the armor/menu is blocked.
   */
  async participantMustAcceptGroupRules(params: {
    telegramChatId: bigint;
    telegramUserId: number;
  }): Promise<boolean> {
    const comm = await this.prisma.community.findUnique({
      where: { telegramChatId: params.telegramChatId },
      include: { rules: true },
    });
    if (!comm) {
      return false;
    }
    const user = await this.prisma.telegramUser.findUnique({
      where: { telegramUserId: BigInt(params.telegramUserId) },
      select: { id: true, defaultLanguageId: true },
    });
    if (!user) {
      return false;
    }
    const m = await this.prisma.groupChatMembership.findUnique({
      where: {
        telegramChatId_userId: {
          telegramChatId: params.telegramChatId,
          userId: user.id,
        },
      },
      select: { isActive: true, groupRulesAccepted: true, languageId: true },
    });
    if (!m?.isActive) {
      return false;
    }
    const effectiveLang = m.languageId ?? user.defaultLanguageId ?? null;
    if (!effectiveLang) {
      return false;
    }
    const resolved = resolveCommunityRulesText(comm.rules, effectiveLang);
    if (!resolved) {
      return false;
    }
    return !m.groupRulesAccepted;
  }

  async acceptGroupRules(params: {
    telegramChatId: bigint;
    telegramUserId: number;
  }): Promise<{ ok: true } | { ok: false; reason: string }> {
    const comm = await this.prisma.community.findUnique({
      where: { telegramChatId: params.telegramChatId },
      include: { rules: true },
    });
    const user = await this.prisma.telegramUser.findUnique({
      where: { telegramUserId: BigInt(params.telegramUserId) },
      select: { id: true, defaultLanguageId: true },
    });
    if (!user) {
      return { ok: false, reason: 'no_user' };
    }
    const m = await this.prisma.groupChatMembership.findUnique({
      where: {
        telegramChatId_userId: {
          telegramChatId: params.telegramChatId,
          userId: user.id,
        },
      },
      select: {
        isActive: true,
        languageId: true,
        groupRulesAccepted: true,
      },
    });
    if (!m?.isActive) {
      return { ok: false, reason: 'not_member' };
    }
    const effectiveLang = m.languageId ?? user.defaultLanguageId ?? null;
    if (!effectiveLang) {
      return { ok: false, reason: 'no_language' };
    }
    const resolved = comm
      ? resolveCommunityRulesText(comm.rules, effectiveLang)
      : null;
    if (!comm || !resolved) {
      return { ok: false, reason: 'no_rules' };
    }
    await this.prisma.groupChatMembership.update({
      where: {
        telegramChatId_userId: {
          telegramChatId: params.telegramChatId,
          userId: user.id,
        },
      },
      data: {
        groupRulesAccepted: true,
        communityId: comm.id,
      },
    });
    return { ok: true };
  }

  async recordJoin(params: {
    telegramChatId: bigint;
    telegramUserId: number;
    username?: string;
    firstName?: string;
    lastName?: string;
  }): Promise<RecordJoinResult> {
    const comm = await this.prisma.community.findUnique({
      where: { telegramChatId: params.telegramChatId },
      include: { rules: true },
    });
    const hasRules = (comm?.rules ?? []).some((r) => r.text.trim().length > 0);

    await this.prisma.$transaction(async (tx) => {
      const user = await tx.telegramUser.upsert({
        where: { telegramUserId: BigInt(params.telegramUserId) },
        create: {
          telegramUserId: BigInt(params.telegramUserId),
          username: params.username ?? null,
          firstName: params.firstName ?? null,
          lastName: params.lastName ?? null,
        },
        update: {
          username: params.username ?? null,
          firstName: params.firstName ?? null,
          lastName: params.lastName ?? null,
        },
      });

      const existing = await tx.groupChatMembership.findUnique({
        where: {
          telegramChatId_userId: {
            telegramChatId: params.telegramChatId,
            userId: user.id,
          },
        },
      });

      if (!comm) {
        await tx.groupChatMembership.upsert({
          where: {
            telegramChatId_userId: {
              telegramChatId: params.telegramChatId,
              userId: user.id,
            },
          },
          create: {
            telegramChatId: params.telegramChatId,
            userId: user.id,
            communityId: null,
            groupRulesAccepted: true,
            isActive: true,
            leftAt: null,
          },
          update: {
            isActive: true,
            leftAt: null,
            joinedAt: new Date(),
            groupRulesAccepted: true,
            communityId: null,
          },
        });
        return;
      }

      if (!hasRules) {
        await tx.groupChatMembership.upsert({
          where: {
            telegramChatId_userId: {
              telegramChatId: params.telegramChatId,
              userId: user.id,
            },
          },
          create: {
            telegramChatId: params.telegramChatId,
            userId: user.id,
            communityId: comm.id,
            groupRulesAccepted: true,
            isActive: true,
            leftAt: null,
          },
          update: {
            isActive: true,
            leftAt: null,
            joinedAt: new Date(),
            communityId: comm.id,
            groupRulesAccepted: true,
          },
        });
        return;
      }

      if (existing?.groupRulesAccepted) {
        await tx.groupChatMembership.update({
          where: { id: existing.id },
          data: {
            isActive: true,
            leftAt: null,
            joinedAt: new Date(),
            communityId: comm.id,
            groupRulesAccepted: true,
          },
        });
      } else {
        await tx.groupChatMembership.upsert({
          where: {
            telegramChatId_userId: {
              telegramChatId: params.telegramChatId,
              userId: user.id,
            },
          },
          create: {
            telegramChatId: params.telegramChatId,
            userId: user.id,
            communityId: null,
            groupRulesAccepted: false,
            isActive: true,
            leftAt: null,
          },
          update: {
            isActive: true,
            leftAt: null,
            joinedAt: new Date(),
            communityId: null,
            groupRulesAccepted: false,
          },
        });
      }
    });

    const userRow = await this.prisma.telegramUser.findUnique({
      where: { telegramUserId: BigInt(params.telegramUserId) },
      select: { id: true, defaultLanguageId: true },
    });
    if (!userRow) {
      return {
        pendingLanguageSelection: false,
        pendingGroupRules: false,
        rulesText: null,
      };
    }
    const m = await this.prisma.groupChatMembership.findUnique({
      where: {
        telegramChatId_userId: {
          telegramChatId: params.telegramChatId,
          userId: userRow.id,
        },
      },
      select: {
        groupRulesAccepted: true,
        languageId: true,
        isActive: true,
      },
    });

    const pendingLanguageSelection = Boolean(
      m?.isActive &&
        m.languageId == null &&
        userRow.defaultLanguageId == null,
    );
    const effectiveLang = m?.languageId ?? userRow.defaultLanguageId ?? null;
    const resolvedRulesText =
      comm && hasRules && effectiveLang
        ? resolveCommunityRulesText(comm.rules, effectiveLang)
        : null;
    const pendingGroupRules =
      m != null &&
      !m.groupRulesAccepted &&
      hasRules &&
      Boolean(resolvedRulesText);
    const rulesText = pendingGroupRules ? resolvedRulesText : null;

    return {
      pendingLanguageSelection,
      pendingGroupRules,
      rulesText,
    };
  }

  async recordLeave(params: {
    telegramChatId: bigint;
    telegramUserId: number;
  }): Promise<void> {
    const user = await this.prisma.telegramUser.findUnique({
      where: { telegramUserId: BigInt(params.telegramUserId) },
      select: { id: true },
    });
    if (!user) {
      return;
    }
    await this.prisma.groupChatMembership.updateMany({
      where: {
        telegramChatId: params.telegramChatId,
        userId: user.id,
      },
      data: {
        isActive: false,
        groupRulesAccepted: false,
        leftAt: new Date(),
      },
    });
  }
}
