import type { I18nService } from 'nestjs-i18n';
import { SportKindCode } from '@prisma/client';
import type { BookingDurationMinutes } from '../booking/booking-intervals';
import { resolveUiLang } from '../i18n/resolve-ui-lang';

const SPORT_CODES: SportKindCode[] = [
  SportKindCode.TENNIS,
  SportKindCode.FOOTBALL,
  SportKindCode.BASKETBALL,
  SportKindCode.VOLLEYBALL,
];

/**
 * All reply-keyboard and common bot strings for one resolved UI language.
 * Use the same object for building keyboards and matching `ctx.message.text`.
 */
export function createBotLabels(
  i18n: I18nService,
  languageId: string | null | undefined,
) {
  const lang = resolveUiLang(languageId);
  const t = (suffix: string, args?: Record<string, unknown>) =>
    i18n.t(`bot.${suffix}` as never, {
      lang,
      args: args as Record<string, string>,
    });

  return {
    /** Resolved locale id (e.g. ua, en). */
    lang,
    menuBook: t('menu.book'),
    menuList: t('menu.list'),
    menuListFindPlayers: t('menu.listFindPlayers'),
    menuGrid: t('menu.grid'),
    menuFreeSlots: t('menu.freeSlots'),
    menuSetup: t('menu.setup'),
    menuChatBot: t('menu.chatBot'),
    menuSwitchGroup: t('menu.switchGroup'),
    menuChangeLanguage: t('menu.changeLanguage'),
    menuBack: t('menu.back'),
    menuMain: t('menu.main'),
    menuWhPerDay: t('menu.whPerDay'),
    menuWhSkip: t('menu.whSkip'),
    menuWhDoneToMenu: t('menu.whDoneToMenu'),
    whDayClosed: t('wh.dayClosed'),
    whDaySetHours: t('wh.daySetHours'),
    menuDayToday: t('menu.dayToday'),
    menuDayTomorrow: t('menu.dayTomorrow'),
    bookLookingYes: t('book.lookingYes'),
    bookLookingNo: t('book.lookingNo'),
    rulesAccept: t('rules.accept'),
    msgNoSlotsBookingWindow: t('msg.noSlotsBookingWindow'),
    setupUseChatTitle: t('setup.useChatTitle'),
    setupKeepBotName: t('setup.keepBotName'),
    setupKeepAddress: t('setup.keepAddress'),
    setupNoAddress: t('setup.noAddress'),
    setupCancel: t('setup.cancel'),
    setupVenues: t('setup.venues'),
    setupGroupRules: t('setup.groupRules'),
    setupAllBookings: t('setup.allBookings'),
    setupRecurringBookings: t('setup.recurringBookings'),
    setupRecurringCreate: t('setup.recurringCreate'),
    setupRecurringDelete: t('setup.recurringDelete'),
    setupBookingWindow: t('setup.bookingWindow'),
    setupBookingLimit: t('setup.bookingLimit'),
    limitUnlimited: t('limit.unlimited'),
    bwEndMidnight: t('bw.endMidnight'),
    setupNewResource: t('setup.newResource'),
    setupLinkExistingResource: t('setup.linkExistingResource'),
    setupResourceActive: t('setup.resourceActive'),
    setupResourceInactive: t('setup.resourceInactive'),
    setupDeleteResource: t('setup.deleteResource'),
    setupConfirmDeleteResource: t('setup.confirmDeleteResource'),
    sportTennis: t('sport.TENNIS'),
    sportFootball: t('sport.FOOTBALL'),
    sportBasketball: t('sport.BASKETBALL'),
    sportVolleyball: t('sport.VOLLEYBALL'),
    duration1h: t('duration.h60'),
    duration90m: t('duration.m90'),
    duration2h: t('duration.h120'),
    listCancelSuffix: t('list.cancelSuffix'),
    listCancelConfirmYes: t('list.cancelConfirmYes'),
    freeSlotMorePlayers: t('freeSlot.morePlayers'),
    resourceInactiveMark: t('resource.inactiveMark'),
  };
}

export type BotLabels = ReturnType<typeof createBotLabels>;

/** Map reply-keyboard duration label (same as on the button) to minutes. */
export function durationMinutesFromReplyLabel(
  lbl: Pick<BotLabels, 'duration1h' | 'duration90m' | 'duration2h'>,
  text: string,
): BookingDurationMinutes | undefined {
  if (text === lbl.duration1h) {
    return 60;
  }
  if (text === lbl.duration90m) {
    return 90;
  }
  if (text === lbl.duration2h) {
    return 120;
  }
  return undefined;
}

export function sportLabelToCodeMap(
  i18n: I18nService,
  languageId: string | null | undefined,
): Map<string, SportKindCode> {
  const lang = resolveUiLang(languageId);
  const m = new Map<string, SportKindCode>();
  for (const code of SPORT_CODES) {
    m.set(i18n.t(`bot.sport.${code}` as never, { lang }), code);
  }
  return m;
}

export function weekdayIsoLabels(
  i18n: I18nService,
  languageId: string | null | undefined,
) {
  const lang = resolveUiLang(languageId);
  return [1, 2, 3, 4, 5, 6, 7].map((d) =>
    i18n.t(`bot.weekdayIso.${String(d)}` as never, { lang }),
  );
}
