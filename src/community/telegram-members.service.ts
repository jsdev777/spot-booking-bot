import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const IN_CHAT_STATUSES = new Set([
  'creator',
  'administrator',
  'member',
  'restricted',
]);

export type RecordJoinResult = {
  /** Нужно показать правила и дождаться кнопки (новый вход в чат). */
  pendingGroupRules: boolean;
  rulesText: string | null;
};

@Injectable()
export class TelegramMembersService {
  constructor(private readonly prisma: PrismaService) {}

  /** Пользователь считается состоящим в чате при этих статусах chat_member. */
  static isStatusInChat(status: string): boolean {
    return IN_CHAT_STATUSES.has(status);
  }

  /**
   * Обычный участник (не админ группы) должен принять правила, прежде чем пользоваться ботом.
   * true = доступ к брони/меню заблокирован.
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
    /** Админ/creator чата в Telegram — правила не блокируют, сразу в сообществе. */
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
