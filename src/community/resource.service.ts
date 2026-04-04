import { Injectable } from '@nestjs/common';
import { ResourceVisibility } from '../generated/prisma/client';
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
        community: { telegramChatId },
        ...(opts?.onlyActive ? { visibility: ResourceVisibility.ACTIVE } : {}),
      },
      include: {
        community: true,
        workingHours: { orderBy: { weekday: 'asc' } },
      },
    });
  }

  listForChat(telegramChatId: bigint, opts?: { onlyActive?: boolean }) {
    return this.prisma.resource.findMany({
      where: {
        community: { telegramChatId },
        ...(opts?.onlyActive ? { visibility: ResourceVisibility.ACTIVE } : {}),
      },
      orderBy: { name: 'asc' },
      include: { community: true },
    });
  }
}
