import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const IN_CHAT_STATUSES = new Set([
  'creator',
  'administrator',
  'member',
  'restricted',
]);

export type RecordJoinResult = {
  /** Display the rules and wait for the button (new chat entry). */
  pendingGroupRules: boolean;
  rulesText: string | null;
};

@Injectable()
export class TelegramMembersService {
  constructor(private readonly prisma: PrismaService) {}

  async getGroupRulesText(telegramChatId: bigint): Promise<string | null> {
    const comm = await this.prisma.community.findUnique({
      where: { telegramChatId },
      include: { rules: true },
    });
    const rulesText = comm?.rules?.text?.trim() ?? '';
    return rulesText.length > 0 ? rulesText : null;
  }

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
    const rulesText = comm?.rules?.text?.trim() ?? '';
    if (!comm || rulesText.length === 0) {
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
    });
    if (!m?.isActive) {
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
    const rulesText = comm?.rules?.text?.trim() ?? '';
    if (!comm || rulesText.length === 0) {
      return { ok: false, reason: 'no_rules' };
    }
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
    });
    if (!m?.isActive) {
      return { ok: false, reason: 'not_member' };
    }
    await this.prisma.groupChatMembership.update({
      where: { id: m.id },
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
    /** Telegram chat admin/creator — the rules don't block you; you're added to the community right away. */
    treatAsGroupAdmin?: boolean;
  }): Promise<RecordJoinResult> {
    const comm = await this.prisma.community.findUnique({
      where: { telegramChatId: params.telegramChatId },
      include: { rules: true },
    });
    const rulesBody = comm?.rules?.text?.trim() ?? '';
    const hasRules = Boolean(comm && rulesBody.length > 0);
    const rulesRequired = hasRules && params.treatAsGroupAdmin !== true;

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

      if (rulesRequired) {
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
      }
    });

    if (!rulesRequired || !comm) {
      return { pendingGroupRules: false, rulesText: null };
    }

    const userRow = await this.prisma.telegramUser.findUnique({
      where: { telegramUserId: BigInt(params.telegramUserId) },
      select: { id: true },
    });
    if (!userRow) {
      return { pendingGroupRules: false, rulesText: null };
    }
    const m = await this.prisma.groupChatMembership.findUnique({
      where: {
        telegramChatId_userId: {
          telegramChatId: params.telegramChatId,
          userId: userRow.id,
        },
      },
    });
    if (m?.groupRulesAccepted) {
      return { pendingGroupRules: false, rulesText: null };
    }
    return { pendingGroupRules: true, rulesText: rulesBody };
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
        leftAt: new Date(),
      },
    });
  }
}
