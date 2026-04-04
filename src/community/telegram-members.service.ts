import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const IN_CHAT_STATUSES = new Set([
  'creator',
  'administrator',
  'member',
  'restricted',
]);

@Injectable()
export class TelegramMembersService {
  constructor(private readonly prisma: PrismaService) {}

  /** Пользователь считается состоящим в чате при этих статусах chat_member. */
  static isStatusInChat(status: string): boolean {
    return IN_CHAT_STATUSES.has(status);
  }

  async recordJoin(params: {
    telegramChatId: bigint;
    telegramUserId: number;
    username?: string;
    firstName?: string;
    lastName?: string;
  }): Promise<void> {
    const comm = await this.prisma.community.findUnique({
      where: { telegramChatId: params.telegramChatId },
      select: { id: true },
    });
    const communityId = comm?.id ?? null;

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
          communityId,
          isActive: true,
          leftAt: null,
        },
        update: {
          isActive: true,
          leftAt: null,
          joinedAt: new Date(),
          ...(communityId ? { communityId } : {}),
        },
      });
    });
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
