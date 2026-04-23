import { Injectable } from '@nestjs/common';
import { Prisma, SportKindCode } from '@prisma/client';
import { addMinutes, set } from 'date-fns';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { PrismaService } from '../prisma/prisma.service';

export type RecurringBookingOccurrence = {
  ruleId: string;
  startTime: Date;
  endTime: Date;
  sportKindCode: SportKindCode;
};

const ALLOWED_DURATIONS = new Set([60, 90, 120]);

function dateOnlyUtc(dayIso: string): Date {
  const [y, m, d] = dayIso.split('-').map((part) => Number(part));
  return new Date(Date.UTC(y, m - 1, d));
}

function isValidWeekday(weekday: number): boolean {
  return Number.isInteger(weekday) && weekday >= 1 && weekday <= 7;
}

function isValidStartMinuteOfDay(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 1439;
}

function isValidDurationMinutes(value: number): boolean {
  return Number.isInteger(value) && ALLOWED_DURATIONS.has(value);
}

@Injectable()
export class RecurringBookingService {
  constructor(private readonly prisma: PrismaService) {}

  private async resolveCommunityResource(params: {
    telegramChatId: bigint;
    resourceId: string;
  }): Promise<{ id: string; resourceId: string }> {
    const link = await this.prisma.communityResource.findFirst({
      where: {
        resourceId: params.resourceId,
        community: { telegramChatId: params.telegramChatId },
      },
      select: { id: true, resourceId: true },
    });
    if (!link) {
      throw new Error('RESOURCE_NOT_FOUND_IN_CHAT');
    }
    return link;
  }

  async createRule(params: {
    telegramChatId: bigint;
    resourceId: string;
    createdByTelegramUserId: number;
    sportKindCode: SportKindCode;
    weekday: number;
    startMinuteOfDay: number;
    durationMinutes: number;
    endDate: Date;
  }) {
    if (!isValidWeekday(params.weekday)) {
      throw new Error('INVALID_WEEKDAY');
    }
    if (!isValidStartMinuteOfDay(params.startMinuteOfDay)) {
      throw new Error('INVALID_START_MINUTE_OF_DAY');
    }
    if (!isValidDurationMinutes(params.durationMinutes)) {
      throw new Error('INVALID_DURATION_MINUTES');
    }
    const todayIso = new Date().toISOString().slice(0, 10);
    if (params.endDate.getTime() < dateOnlyUtc(todayIso).getTime()) {
      throw new Error('END_DATE_IN_PAST');
    }
    const link = await this.resolveCommunityResource({
      telegramChatId: params.telegramChatId,
      resourceId: params.resourceId,
    });
    const today = dateOnlyUtc(todayIso);
    const overlapping = await this.prisma.recurringBookingRule.findFirst({
      where: {
        resourceId: params.resourceId,
        weekday: params.weekday,
        endDate: { gte: today },
        startMinuteOfDay: { lt: params.startMinuteOfDay + params.durationMinutes },
      },
      select: {
        id: true,
        startMinuteOfDay: true,
        durationMinutes: true,
      },
    });
    if (overlapping) {
      const existingStart = overlapping.startMinuteOfDay;
      const existingEnd = existingStart + overlapping.durationMinutes;
      const newStart = params.startMinuteOfDay;
      const newEnd = params.startMinuteOfDay + params.durationMinutes;
      const intersects = existingStart < newEnd && existingEnd > newStart;
      if (intersects) {
        throw new Error('RECURRING_RULE_OVERLAP');
      }
    }
    try {
      return await this.prisma.recurringBookingRule.create({
        data: {
          communityResourceId: link.id,
          resourceId: params.resourceId,
          sportKindCode: params.sportKindCode,
          weekday: params.weekday,
          startMinuteOfDay: params.startMinuteOfDay,
          durationMinutes: params.durationMinutes,
          endDate: params.endDate,
          createdByTelegramUserId: BigInt(params.createdByTelegramUserId),
        },
        include: { sportKind: true },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new Error('RECURRING_RULE_DUPLICATE');
      }
      throw error;
    }
  }

  async listRulesForCommunityResource(params: {
    telegramChatId: bigint;
    resourceId: string;
  }) {
    const link = await this.resolveCommunityResource({
      telegramChatId: params.telegramChatId,
      resourceId: params.resourceId,
    });
    return this.prisma.recurringBookingRule.findMany({
      where: { communityResourceId: link.id },
      include: { sportKind: true },
      orderBy: [{ weekday: 'asc' }, { startMinuteOfDay: 'asc' }],
    });
  }

  async deleteRule(params: {
    telegramChatId: bigint;
    resourceId: string;
    ruleId: string;
  }): Promise<boolean> {
    const link = await this.resolveCommunityResource({
      telegramChatId: params.telegramChatId,
      resourceId: params.resourceId,
    });
    const deleted = await this.prisma.recurringBookingRule.deleteMany({
      where: { id: params.ruleId, communityResourceId: link.id },
    });
    return deleted.count > 0;
  }

  async listRuleOccurrencesForDay(params: {
    resourceId: string;
    localDay: Date;
    timeZone: string;
    windowStartUtc: Date;
    maxEndUtc: Date;
  }): Promise<RecurringBookingOccurrence[]> {
    const weekday = Number(formatInTimeZone(params.localDay, params.timeZone, 'i'));
    const localDayDate = formatInTimeZone(
      params.localDay,
      params.timeZone,
      'yyyy-MM-dd',
    );
    const rules = await this.prisma.recurringBookingRule.findMany({
      where: {
        resourceId: params.resourceId,
        weekday,
        endDate: { gte: dateOnlyUtc(localDayDate) },
      },
      orderBy: { startMinuteOfDay: 'asc' },
      select: {
        id: true,
        sportKindCode: true,
        startMinuteOfDay: true,
        durationMinutes: true,
      },
    });
    const occurrences: RecurringBookingOccurrence[] = [];
    for (const rule of rules) {
      const hour = Math.floor(rule.startMinuteOfDay / 60);
      const minute = rule.startMinuteOfDay % 60;
      const localStart = set(params.localDay, {
        hours: hour,
        minutes: minute,
        seconds: 0,
        milliseconds: 0,
      });
      const startTime = fromZonedTime(localStart, params.timeZone);
      const endTime = addMinutes(startTime, rule.durationMinutes);
      if (startTime >= params.maxEndUtc || endTime <= params.windowStartUtc) {
        continue;
      }
      occurrences.push({
        ruleId: rule.id,
        startTime,
        endTime,
        sportKindCode: rule.sportKindCode,
      });
    }
    return occurrences;
  }
}
