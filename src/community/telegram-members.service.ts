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
  /** User must pick a UI language for this community (membership.languageId). */
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
    const n = await this.prisma.groupChatMembership.updateMany({
      where: {
        telegramChatId: params.telegramChatId,
        userId: user.id,
        isActive: true,
      },
      data: { languageId: params.languageId },
    });
    if (n.count === 0) {
      return { ok: false, reason: 'not_member' };
    }
    return { ok: true };
  }

  /**
   * In a configured community, regular members must pick a language before rules/menu.
   */
  async participantMustPickLanguage(params: {
    telegramChatId: bigint;
    telegramUserId: number;
  }): Promise<boolean> {
    const comm = await this.prisma.community.findUnique({
      where: { telegramChatId: params.telegramChatId },
      select: { id: true },
    });
    if (!comm) {
      return false;
    }
    const user = await this.prisma.telegramUser.findUnique({
      where: { telegramUserId: BigInt(params.telegramUserId) },
      select: { id: true },
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
    return m.languageId == null;
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
    let preferredLanguageId: string | null = null;
    if (telegramUserId != null) {
      const user = await this.prisma.telegramUser.findUnique({
        where: { telegramUserId: BigInt(telegramUserId) },
        select: { id: true },
      });
      if (user) {
        const m = await this.prisma.groupChatMembership.findUnique({
          where: {
            telegramChatId_userId: {
              telegramChatId,
              userId: user.id,
            },
          },
          select: { languageId: true },
        });
        preferredLanguageId = m?.languageId ?? null;
      }
    }
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
      select: { id: true },
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
    if (!m.languageId) {
      return false;
    }
    const resolved = resolveCommunityRulesText(comm.rules, m.languageId);
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
      select: { id: true },
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
    if (!m.languageId) {
      return { ok: false, reason: 'no_language' };
    }
    const resolved = comm
      ? resolveCommunityRulesText(comm.rules, m.languageId)
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
    const hasRules = (comm?.rules ?? []).some(
      (r) => r.text.trim().length > 0,
    );

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

    if (!comm) {
      return {
        pendingLanguageSelection: false,
        pendingGroupRules: false,
        rulesText: null,
      };
    }
    if (!hasRules) {
      return {
        pendingLanguageSelection: false,
        pendingGroupRules: false,
        rulesText: null,
      };
    }

    const userRow = await this.prisma.telegramUser.findUnique({
      where: { telegramUserId: BigInt(params.telegramUserId) },
      select: { id: true },
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
      comm && !m?.languageId && m?.isActive,
    );
    const pendingGroupRules =
      m != null &&
      Boolean(m.languageId) &&
      !m.groupRulesAccepted &&
      hasRules;
    const rulesText =
      pendingGroupRules && m?.languageId
        ? resolveCommunityRulesText(comm.rules, m.languageId)
        : null;

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
