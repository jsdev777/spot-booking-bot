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
    return this.prisma.resource
      .findFirst({
        where: {
          id: resourceId,
          communityResources: {
            some: {
              community: { telegramChatId },
            },
          },
          ...(opts?.onlyActive
            ? { visibility: ResourceVisibility.ACTIVE }
            : {}),
        },
        include: {
          communityResources: {
            where: { community: { telegramChatId } },
            include: { community: true },
            take: 1,
          },
          sportKinds: { select: { sportKindCode: true } },
          workingHours: { orderBy: { weekday: 'asc' } },
        },
      })
      .then((row) => {
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
    return this.prisma.resource
      .findMany({
        where: {
          communityResources: {
            some: { community: { telegramChatId } },
          },
          ...(opts?.onlyActive
            ? { visibility: ResourceVisibility.ACTIVE }
            : {}),
        },
        orderBy: { name: 'asc' },
        include: {
          communityResources: {
            where: { community: { telegramChatId } },
            include: { community: true },
            take: 1,
          },
          sportKinds: { select: { sportKindCode: true } },
        },
      })
      .then((rows) =>
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
          some: {
            community: { telegramChatId: { not: params.telegramChatId } },
          },
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

  /**
   * Видалення майданчика з контексту групи під час /setup.
   * Якщо ресурс привʼязаний лише до цієї спільноти — повністю стирається Resource (каскадом: working_hours, bookings, community_resources тощо).
   * Якщо є інші групи — лише видаляється звʼязок CommunityResource для цього чату (каскадом: броні та ліміти цього звʼязку).
   */
  async deleteResourceForCommunityFromSetup(params: {
    telegramChatId: bigint;
    resourceId: string;
  }): Promise<{ mode: 'unlinked' | 'deleted_full'; resourceName: string }> {
    const cr = await this.prisma.communityResource.findFirst({
      where: {
        resourceId: params.resourceId,
        community: { telegramChatId: params.telegramChatId },
      },
      include: { resource: { select: { id: true, name: true } } },
    });
    if (!cr) {
      throw new Error('RESOURCE_NOT_LINKED_TO_CHAT');
    }
    const linkCount = await this.prisma.communityResource.count({
      where: { resourceId: params.resourceId },
    });
    const resourceName = cr.resource.name;
    if (linkCount > 1) {
      await this.prisma.communityResource.delete({ where: { id: cr.id } });
      return { mode: 'unlinked', resourceName };
    }
    await this.prisma.resource.delete({ where: { id: params.resourceId } });
    return { mode: 'deleted_full', resourceName };
  }
}
