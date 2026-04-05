import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma, ResourceVisibility } from '@prisma/client';
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

async function seedCommunityUserBookingLimits(
  tx: Prisma.TransactionClient,
  communityId: string,
) {
  const n = await tx.communityUserBookingLimit.count({
    where: { communityId },
  });
  if (n > 0) {
    return;
  }
  await tx.communityUserBookingLimit.createMany({
    data: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
      id: randomUUID(),
      communityId,
      weekday,
      maxMinutes: null,
    })),
  });
}

@Injectable()
export class CommunityService {
  constructor(private readonly prisma: PrismaService) {}

  findByTelegramChatId(telegramChatId: bigint) {
    return this.prisma.community.findUnique({
      where: { telegramChatId },
      include: { resources: { orderBy: { name: 'asc' } } },
    });
  }

  async createWithFirstResource(params: {
    telegramChatId: bigint;
    name: string;
    address?: string | null;
    timeZone: string;
    slotStartHour: number;
    slotEndHour: number;
    resourceName: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const community = await tx.community.create({
        data: {
          telegramChatId: params.telegramChatId,
          name: params.name,
        },
      });
      await seedCommunityUserBookingLimits(tx, community.id);
      const resource = await tx.resource.create({
        data: {
          communityId: community.id,
          name: params.resourceName,
          address: params.address ?? null,
          timeZone: params.timeZone,
          visibility: ResourceVisibility.ACTIVE,
        },
      });
      await replaceUniformWorkingHours(
        tx,
        resource.id,
        params.slotStartHour,
        params.slotEndHour,
      );
      return { community, resource };
    }).then(async (result) => {
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
  }) {
    const existing = await this.prisma.community.findUnique({
      where: { telegramChatId: params.telegramChatId },
      include: { resources: { orderBy: { id: 'asc' } } },
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
            ...(updateCommunityName ? { name: params.name } : {}),
          },
        });
        const resource = await tx.resource.create({
          data: {
            communityId: community.id,
            name: params.resourceName,
            address: params.address ?? null,
            timeZone: params.timeZone,
            visibility: ResourceVisibility.ACTIVE,
          },
        });
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
      existing.resources.some((r) => r.id === params.resourceId)
        ? params.resourceId
        : existing.resources[0]?.id;

    return this.prisma.$transaction(async (tx) => {
      const community = await tx.community.update({
        where: { id: existing.id },
        data: {
          ...(updateCommunityName ? { name: params.name } : {}),
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
          communityId: community.id,
          name: params.resourceName,
          address: params.address ?? null,
          timeZone: params.timeZone,
          visibility: ResourceVisibility.ACTIVE,
        },
      });
      await replaceUniformWorkingHours(
        tx,
        resource.id,
        params.slotStartHour,
        params.slotEndHour,
      );
      return { community, resource };
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
        community: { telegramChatId: params.telegramChatId },
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
        community: { telegramChatId: params.telegramChatId },
      },
      include: {
        workingHours: { orderBy: { weekday: 'asc' } },
      },
    });
  }

  /** “Hours per user” limits by day of the week (ISO 1–7) for the community. */
  async getUserBookingLimitsForChat(telegramChatId: bigint) {
    return this.prisma.communityUserBookingLimit.findMany({
      where: { community: { telegramChatId } },
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
      await seedCommunityUserBookingLimits(tx, c.id);
      return tx.communityUserBookingLimit.update({
        where: {
          communityId_weekday: {
            communityId: c.id,
            weekday: params.weekday,
          },
        },
        data: { maxMinutes: params.maxMinutes },
      });
    });
  }
}
