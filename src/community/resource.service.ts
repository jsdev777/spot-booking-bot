import { Injectable } from '@nestjs/common';
import { ResourceVisibility } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ResourceService {
  constructor(private readonly prisma: PrismaService) {}

  findByIdForChat(
    resourceId: string,
    telegramChatId: bigint,
    opts?: { onlyActive?: boolean },
  ) {
    return this.prisma.resource.findFirst({
      where: {
        id: resourceId,
        communityResources: {
          some: {
            community: { telegramChatId },
          },
        },
        ...(opts?.onlyActive ? { visibility: ResourceVisibility.ACTIVE } : {}),
      },
      include: {
        communityResources: {
          where: { community: { telegramChatId } },
          include: { community: true },
          take: 1,
        },
        workingHours: { orderBy: { weekday: 'asc' } },
      },
    }).then((row) => {
      if (!row) {
        return null;
      }
      const rel = row.communityResources[0];
      if (!rel) {
        return null;
      }
      return {
        ...row,
        community: rel.community,
        communityResourceId: rel.id,
      };
    });
  }

  listForChat(telegramChatId: bigint, opts?: { onlyActive?: boolean }) {
    return this.prisma.resource.findMany({
      where: {
        communityResources: {
          some: { community: { telegramChatId } },
        },
        ...(opts?.onlyActive ? { visibility: ResourceVisibility.ACTIVE } : {}),
      },
      orderBy: { name: 'asc' },
      include: {
        communityResources: {
          where: { community: { telegramChatId } },
          include: { community: true },
          take: 1,
        },
      },
    }).then((rows) =>
      rows
        .map((row) => {
          const rel = row.communityResources[0];
          if (!rel) {
            return null;
          }
          return {
            ...row,
            community: rel.community,
            communityResourceId: rel.id,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x != null),
    );
  }

  listLinkableForChatAdmin(params: {
    telegramChatId: bigint;
    adminTelegramUserId: number;
  }) {
    return this.prisma.resource.findMany({
      where: {
        communityResources: {
          // Candidate resources must already exist in at least one community
          // different from the current one and must not be linked to the current group yet.
          some: { community: { telegramChatId: { not: params.telegramChatId } } },
          none: { community: { telegramChatId: params.telegramChatId } },
        },
      },
      orderBy: { name: 'asc' },
      include: {
        communityResources: {
          include: {
            community: { select: { telegramChatId: true } },
          },
        },
      },
    });
  }

  async listTelegramChatIdsForResource(resourceId: string): Promise<bigint[]> {
    const links = await this.prisma.communityResource.findMany({
      where: { resourceId },
      select: {
        community: {
          select: { telegramChatId: true },
        },
      },
    });
    return [...new Set(links.map((x) => x.community.telegramChatId))];
  }
}
