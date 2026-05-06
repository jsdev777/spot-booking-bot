import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  CommunityNameSource,
  Prisma,
  ResourceVisibility,
  SportKindCode,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

async function replaceUniformWorkingHours(
  tx: Prisma.TransactionClient,
  resourceId: string,
  slotStartHour: number,
  slotEndHour: number,
) {
  await tx.resourceWorkingHours.deleteMany({ where: { resourceId } });
  await tx.resourceWorkingHours.createMany({
    data: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
      id: randomUUID(),
      resourceId,
      weekday,
      isClosed: false,
      slotStartHour,
      slotEndHour,
    })),
  });
}

async function seedCommunityResourceUserBookingLimits(
  tx: Prisma.TransactionClient,
  communityResourceId: string,
) {
  const n = await tx.communityResourceUserBookingLimit.count({
    where: { communityResourceId },
  });
  if (n > 0) {
    return;
  }
  await tx.communityResourceUserBookingLimit.createMany({
    data: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
      id: randomUUID(),
      communityResourceId,
      weekday,
      maxMinutes: null,
    })),
  });
}

function buildResourceSportKindRows(
  resourceId: string,
  sportKindCodes: SportKindCode[],
): { resourceId: string; sportKindCode: SportKindCode }[] {
  const unique = [...new Set(sportKindCodes)];
  return unique.map((sportKindCode) => ({ resourceId, sportKindCode }));
}

/**
 * Picks non-empty community rules text: preferred language, then Ukrainian, then any.
 */
export function resolveCommunityRulesText(
  rules: readonly { languageId: string; text: string }[],
  preferredLanguageId: string | null | undefined,
): string | null {
  const nonempty = rules
    .map((r) => ({ languageId: r.languageId, body: r.text.trim() }))
    .filter((r) => r.body.length > 0);
  if (nonempty.length === 0) {
    return null;
  }
  if (preferredLanguageId) {
    const exact = nonempty.find((r) => r.languageId === preferredLanguageId);
    if (exact) {
      return exact.body;
    }
  }
  const ua = nonempty.find((r) => r.languageId === 'ua');
  if (ua) {
    return ua.body;
  }
  return nonempty[0].body;
}

@Injectable()
export class CommunityService {
  constructor(private readonly prisma: PrismaService) {}

  listAllCommunitiesBasic() {
    return this.prisma.community.findMany({
      select: { telegramChatId: true, name: true },
      orderBy: { name: 'asc' },
    });
  }

  listAutoNamedCommunitiesBasic() {
    return this.prisma.community.findMany({
      where: { nameSource: CommunityNameSource.AUTO },
      select: { telegramChatId: true, name: true },
      orderBy: { name: 'asc' },
    });
  }

  findByTelegramChatId(telegramChatId: bigint) {
    return this.prisma.community
      .findUnique({
        where: { telegramChatId },
        include: {
          communityResources: {
            include: { resource: true },
            orderBy: { resource: { name: 'asc' } },
          },
        },
      })
      .then((community) => {
        if (!community) {
          return null;
        }
        return {
          ...community,
          resources: community.communityResources.map((cr) => cr.resource),
        };
      });
  }

  async createWithFirstResource(params: {
    telegramChatId: bigint;
    name: string;
    nameSource?: CommunityNameSource;
    address?: string | null;
    timeZone: string;
    slotStartHour: number;
    slotEndHour: number;
    resourceName: string;
    sportKindCodes: SportKindCode[];
  }) {
    return this.prisma
      .$transaction(async (tx) => {
        const community = await tx.community.create({
          data: {
            telegramChatId: params.telegramChatId,
            name: params.name,
            nameSource: params.nameSource ?? CommunityNameSource.AUTO,
          },
        });
        const resource = await tx.resource.create({
          data: {
            name: params.resourceName,
            address: params.address ?? null,
            timeZone: params.timeZone,
            visibility: ResourceVisibility.ACTIVE,
          },
        });
        await tx.resourceSportKind.createMany({
          data: buildResourceSportKindRows(resource.id, params.sportKindCodes),
        });
        const communityResource = await tx.communityResource.create({
          data: {
            communityId: community.id,
            resourceId: resource.id,
          },
        });
        await seedCommunityResourceUserBookingLimits(tx, communityResource.id);
        await replaceUniformWorkingHours(
          tx,
          resource.id,
          params.slotStartHour,
          params.slotEndHour,
        );
        return { community, resource };
      })
      .then(async (result) => {
        await this.prisma.groupChatMembership.updateMany({
          where: {
            telegramChatId: params.telegramChatId,
            isActive: true,
            groupRulesAccepted: true,
          },
          data: { communityId: result.community.id },
        });
        return result;
      });
  }

  /**
   * Creates a community or updates an existing one.
   * You can leave the community name (step 1) unchanged if you're managing multiple platforms and updating just one—`updateCommunityName: false`.
   * Resource: `resourceId` (if valid), otherwise the first one in the list; if there are no resources, one is created.
   */
  async createOrUpdateFromSetup(params: {
    telegramChatId: bigint;
    name: string;
    nameSource?: CommunityNameSource;
    address?: string | null;
    timeZone: string;
    slotStartHour: number;
    slotEndHour: number;
    resourceName: string;
    resourceId?: string;
    /** Default value is true — update `community.name` from step 1. */
    updateCommunityName?: boolean;
    /** Add a new resource; do not modify existing ones. */
    createNewResource?: boolean;
    /** For existing sites—visible in the booking system; new sites are always ACTIVE. */
    resourceVisibility?: ResourceVisibility;
    sportKindCodes: SportKindCode[];
  }) {
    const existing = await this.prisma.community.findUnique({
      where: { telegramChatId: params.telegramChatId },
      include: {
        communityResources: {
          include: { resource: true },
          orderBy: { resource: { id: 'asc' } },
        },
      },
    });
    if (!existing) {
      return this.createWithFirstResource(params);
    }

    if (params.createNewResource) {
      const updateCommunityName = params.updateCommunityName !== false;
      return this.prisma.$transaction(async (tx) => {
        const community = await tx.community.update({
          where: { id: existing.id },
          data: {
            ...(updateCommunityName
              ? {
                  name: params.name,
                  nameSource: params.nameSource ?? CommunityNameSource.AUTO,
                }
              : {}),
          },
        });
        const resource = await tx.resource.create({
          data: {
            name: params.resourceName,
            address: params.address ?? null,
            timeZone: params.timeZone,
            visibility: ResourceVisibility.ACTIVE,
          },
        });
        await tx.resourceSportKind.createMany({
          data: buildResourceSportKindRows(resource.id, params.sportKindCodes),
        });
        const communityResource = await tx.communityResource.create({
          data: {
            communityId: community.id,
            resourceId: resource.id,
          },
        });
        await seedCommunityResourceUserBookingLimits(tx, communityResource.id);
        await replaceUniformWorkingHours(
          tx,
          resource.id,
          params.slotStartHour,
          params.slotEndHour,
        );
        return { community, resource };
      });
    }

    const updateCommunityName = params.updateCommunityName !== false;
    const targetId =
      params.resourceId &&
      existing.communityResources.some(
        (r) => r.resource.id === params.resourceId,
      )
        ? params.resourceId
        : existing.communityResources[0]?.resource.id;

    return this.prisma.$transaction(async (tx) => {
      const community = await tx.community.update({
        where: { id: existing.id },
        data: {
          ...(updateCommunityName
            ? {
                name: params.name,
                nameSource: params.nameSource ?? CommunityNameSource.AUTO,
              }
            : {}),
        },
      });

      if (targetId) {
        const resource = await tx.resource.update({
          where: { id: targetId },
          data: {
            name: params.resourceName,
            address: params.address ?? null,
            timeZone: params.timeZone,
            visibility: params.resourceVisibility ?? ResourceVisibility.ACTIVE,
          },
        });
        await tx.resourceSportKind.deleteMany({
          where: { resourceId: resource.id },
        });
        await tx.resourceSportKind.createMany({
          data: buildResourceSportKindRows(resource.id, params.sportKindCodes),
        });
        await replaceUniformWorkingHours(
          tx,
          resource.id,
          params.slotStartHour,
          params.slotEndHour,
        );
        return { community, resource };
      }
      const resource = await tx.resource.create({
        data: {
          name: params.resourceName,
          address: params.address ?? null,
          timeZone: params.timeZone,
          visibility: ResourceVisibility.ACTIVE,
        },
      });
      await tx.resourceSportKind.createMany({
        data: buildResourceSportKindRows(resource.id, params.sportKindCodes),
      });
      const communityResource = await tx.communityResource.create({
        data: {
          communityId: community.id,
          resourceId: resource.id,
        },
      });
      await seedCommunityResourceUserBookingLimits(tx, communityResource.id);
      await replaceUniformWorkingHours(
        tx,
        resource.id,
        params.slotStartHour,
        params.slotEndHour,
      );
      return { community, resource };
    });
  }

  async syncAutoCommunityNameWithChatTitle(params: {
    telegramChatId: bigint;
    chatTitle: string;
  }): Promise<void> {
    const chatTitle = params.chatTitle.trim();
    if (!chatTitle) {
      return;
    }
    await this.prisma.community.updateMany({
      where: {
        telegramChatId: params.telegramChatId,
        nameSource: CommunityNameSource.AUTO,
        name: { not: chatTitle },
      },
      data: { name: chatTitle },
    });
  }

  /** A single schedule row (LS /setup “by day”). `weekday`: ISO 1–7. */
  async updateResourceWeekdayHours(params: {
    telegramChatId: bigint;
    resourceId: string;
    weekday: number;
    isClosed: boolean;
    slotStartHour?: number;
    slotEndHour?: number;
  }) {
    if (params.weekday < 1 || params.weekday > 7) {
      throw new Error('Invalid weekday');
    }
    const ok = await this.prisma.resource.findFirst({
      where: {
        id: params.resourceId,
        communityResources: {
          some: { community: { telegramChatId: params.telegramChatId } },
        },
      },
      select: { id: true },
    });
    if (!ok) {
      throw new Error('Resource not found');
    }
    if (params.isClosed) {
      await this.prisma.resourceWorkingHours.update({
        where: {
          resourceId_weekday: {
            resourceId: params.resourceId,
            weekday: params.weekday,
          },
        },
        data: {
          isClosed: true,
          slotStartHour: null,
          slotEndHour: null,
        },
      });
      return;
    }
    const start = params.slotStartHour;
    const end = params.slotEndHour;
    if (
      start === undefined ||
      end === undefined ||
      !Number.isInteger(start) ||
      !Number.isInteger(end)
    ) {
      throw new Error('Hours required when open');
    }
    if (start < 0 || start > 22 || end < 0 || end > 22 || end < start) {
      throw new Error('Invalid hours');
    }
    await this.prisma.resourceWorkingHours.update({
      where: {
        resourceId_weekday: {
          resourceId: params.resourceId,
          weekday: params.weekday,
        },
      },
      data: {
        isClosed: false,
        slotStartHour: start,
        slotEndHour: end,
      },
    });
  }

  /** The time window during which participants can make reservations (local time in the specified time zone). */
  async updateCommunityBookingWindow(params: {
    telegramChatId: bigint;
    bookingWindowTimeZone: string;
    bookingWindowStartHour: number;
    bookingWindowEndHour: number;
  }) {
    const sh = params.bookingWindowStartHour;
    const eh = params.bookingWindowEndHour;
    if (
      !Number.isInteger(sh) ||
      !Number.isInteger(eh) ||
      sh < 0 ||
      sh > 23 ||
      eh < 1 ||
      eh > 24 ||
      sh >= eh
    ) {
      throw new Error('Invalid booking window');
    }
    const existing = await this.prisma.community.findUnique({
      where: { telegramChatId: params.telegramChatId },
      select: { id: true },
    });
    if (!existing) {
      throw new Error('Community not found');
    }
    return this.prisma.community.update({
      where: { id: existing.id },
      data: {
        bookingWindowTimeZone: params.bookingWindowTimeZone,
        bookingWindowStartHour: sh,
        bookingWindowEndHour: eh,
      },
    });
  }

  /** UI layout (after /setup). */
  async getResourceWorkingHoursForChat(params: {
    telegramChatId: bigint;
    resourceId: string;
  }) {
    return this.prisma.resource.findFirst({
      where: {
        id: params.resourceId,
        communityResources: {
          some: { community: { telegramChatId: params.telegramChatId } },
        },
      },
      include: {
        workingHours: { orderBy: { weekday: 'asc' } },
      },
    });
  }

  /** “Hours per user” limits by day of the week (ISO 1–7) for the community. */
  async getUserBookingLimitsForChat(telegramChatId: bigint) {
    const community = await this.prisma.community.findUnique({
      where: { telegramChatId },
      select: {
        id: true,
        communityResources: { select: { id: true }, orderBy: { id: 'asc' } },
      },
    });
    if (!community || community.communityResources.length === 0) {
      return [];
    }
    await this.prisma.$transaction(async (tx) => {
      for (const cr of community.communityResources) {
        await seedCommunityResourceUserBookingLimits(tx, cr.id);
      }
    });
    return this.prisma.communityResourceUserBookingLimit.findMany({
      where: { communityResourceId: community.communityResources[0].id },
      orderBy: { weekday: 'asc' },
    });
  }

  /** A single limit value; `maxMinutes` set to null indicates no limit. */
  async updateCommunityUserBookingLimitWeekday(params: {
    telegramChatId: bigint;
    weekday: number;
    maxMinutes: number | null;
  }) {
    if (params.weekday < 1 || params.weekday > 7) {
      throw new Error('Invalid weekday');
    }
    if (
      params.maxMinutes !== null &&
      (!Number.isInteger(params.maxMinutes) ||
        params.maxMinutes < 0 ||
        params.maxMinutes > 24 * 60)
    ) {
      throw new Error('Invalid max minutes');
    }
    const c = await this.prisma.community.findUnique({
      where: { telegramChatId: params.telegramChatId },
      select: { id: true },
    });
    if (!c) {
      throw new Error('Community not found');
    }
    return this.prisma.$transaction(async (tx) => {
      const links = await tx.communityResource.findMany({
        where: { communityId: c.id },
        select: { id: true },
      });
      for (const link of links) {
        await seedCommunityResourceUserBookingLimits(tx, link.id);
        await tx.communityResourceUserBookingLimit.update({
          where: {
            communityResourceId_weekday: {
              communityResourceId: link.id,
              weekday: params.weekday,
            },
          },
          data: { maxMinutes: params.maxMinutes },
        });
      }
    });
  }

  async linkExistingResourceToCommunityFromSetup(params: {
    telegramChatId: bigint;
    adminTelegramUserId: number;
    resourceId: string;
  }) {
    const community = await this.prisma.community.findUnique({
      where: { telegramChatId: params.telegramChatId },
      select: { id: true },
    });
    if (!community) {
      throw new Error('Community not found');
    }
    return this.prisma.$transaction(async (tx) => {
      const resource = await tx.resource.findUnique({
        where: { id: params.resourceId },
        include: {
          communityResources: {
            include: {
              community: true,
            },
          },
        },
      });
      if (!resource) {
        throw new Error('Resource not found');
      }
      // Server-side guard: the linked resource must come from another community
      // and must not already be linked to the current one.
      const hasSourceCommunity = resource.communityResources.some(
        (cr) => cr.community.telegramChatId !== params.telegramChatId,
      );
      const alreadyLinked = resource.communityResources.some(
        (cr) => cr.communityId === community.id,
      );
      if (!hasSourceCommunity || alreadyLinked) {
        throw new Error('Resource is not allowed for linking');
      }
      const rel = await tx.communityResource.upsert({
        where: {
          communityId_resourceId: {
            communityId: community.id,
            resourceId: resource.id,
          },
        },
        update: {},
        create: {
          communityId: community.id,
          resourceId: resource.id,
        },
      });
      await seedCommunityResourceUserBookingLimits(tx, rel.id);
      return { resource, communityResource: rel };
    });
  }

  async getCommunityRulesForChat(
    telegramChatId: bigint,
    preferredLanguageId?: string | null,
  ): Promise<string | null> {
    const comm = await this.prisma.community.findUnique({
      where: { telegramChatId },
      include: { rules: true },
    });
    if (!comm) {
      return null;
    }
    return resolveCommunityRulesText(comm.rules, preferredLanguageId ?? null);
  }

  async upsertCommunityRulesForChat(params: {
    telegramChatId: bigint;
    text: string;
    /** Defaults to Ukrainian for backward compatibility with the admin setup flow. */
    languageId?: string;
  }) {
    const comm = await this.prisma.community.findUnique({
      where: { telegramChatId: params.telegramChatId },
      select: { id: true },
    });
    if (!comm) {
      throw new Error('Community not found');
    }
    const languageId = params.languageId ?? 'ua';
    return this.prisma.communityRules.upsert({
      where: {
        communityId_languageId: {
          communityId: comm.id,
          languageId,
        },
      },
      update: { text: params.text },
      create: {
        communityId: comm.id,
        languageId,
        text: params.text,
      },
    });
  }
}
