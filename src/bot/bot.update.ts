import { AsyncLocalStorage } from 'node:async_hooks';
import { Logger } from '@nestjs/common';
import { formatInTimeZone } from 'date-fns-tz';
import { I18nService } from 'nestjs-i18n';
import { Action, Command, Ctx, Next, On, Start, Update } from 'nestjs-telegraf';
import { Markup } from 'telegraf';
import type { Context } from 'telegraf';
import type { BookingDurationMinutes } from '../booking/booking-intervals';
import { isLocalTimeWithinBookingWindow } from '../booking/booking-window';
import {
  BookingService,
  type BookingStartSlot,
} from '../booking/booking.service';
import { RecurringBookingService } from '../booking/recurring-booking.service';
import {
  BookingNotFoundError,
  BookingWindowClosedError,
  SlotInPastError,
  SlotTakenError,
  UserDailyBookingLimitExceededError,
} from '../booking/booking.errors';
import { CommunityService } from '../community/community.service';
import { TelegramMembersService } from '../community/telegram-members.service';
import { ResourceService } from '../community/resource.service';
import { SETUP_TIMEZONES } from '../community/setup.constants';
import { MetricsService } from '../metrics/metrics.service';
import * as PrismaClient from '@prisma/client';
import {
  isGroupAdmin,
  isGroupChat,
  isUserAdminOfGroupChat,
} from './bot.helpers';
import { type MenuState, defaultMenuState } from './menu-state';
import {
  type BotLabels,
  createBotLabels,
  durationMinutesFromReplyLabel,
  sportLabelToCodeMap,
  weekdayIsoLabels,
} from './bot-i18n.labels';
import {
  resolveUiLang,
  UI_FALLBACK_LANGUAGE,
  UI_LANGUAGE_PROMPT_NEUTRAL_LANG,
} from '../i18n/resolve-ui-lang';
import {
  parseUserlangCallback,
  USERLANG_CALLBACK_RE,
} from './userlang-callback';

const { SportKindCode, ResourceVisibility } = PrismaClient as unknown as {
  SportKindCode: {
    TENNIS: 'TENNIS';
    FOOTBALL: 'FOOTBALL';
    BASKETBALL: 'BASKETBALL';
    VOLLEYBALL: 'VOLLEYBALL';
  };
  ResourceVisibility: {
    ACTIVE: 'ACTIVE';
    INACTIVE: 'INACTIVE';
  };
};
type SportKindCode = (typeof SportKindCode)[keyof typeof SportKindCode];
type ResourceVisibility =
  (typeof ResourceVisibility)[keyof typeof ResourceVisibility];

/** Sport button order in booking picker (labels come from i18n). */
const SPORT_ORDER: SportKindCode[] = [
  SportKindCode.TENNIS,
  SportKindCode.FOOTBALL,
  SportKindCode.BASKETBALL,
  SportKindCode.VOLLEYBALL,
];

/** Макс. длина одного сообщения с фрагментом правил (запас под лимит Telegram). */
const RULES_MESSAGE_CHUNK = 3800;
const START_RULES_PREFIX = 'rules_';
const TELEGRAM_SEND_BATCH_SIZE = 6;
const TELEGRAM_MAX_429_RETRIES = 2;

/**
 * Group reply keyboard: fixed English for everyone (not tied to membership locale).
 * Handlers also accept legacy Ukrainian labels from older keyboards.
 */
const GROUP_REPLY_CHAT_BOT = 'Bot chat';
const GROUP_REPLY_FREE_SLOTS = 'Player search';
const GROUP_REPLY_CHAT_BOT_LEGACY = 'Чат Бот';
const GROUP_REPLY_FREE_SLOTS_LEGACY = 'Пошук гравців';

function isGroupReplyChatBotPress(text: string): boolean {
  return text === GROUP_REPLY_CHAT_BOT || text === GROUP_REPLY_CHAT_BOT_LEGACY;
}

function isGroupReplyFreeSlotsPress(text: string): boolean {
  return (
    text === GROUP_REPLY_FREE_SLOTS || text === GROUP_REPLY_FREE_SLOTS_LEGACY
  );
}

/** Two buttons per row — with `resize` they use roughly half the screen width. */
function kbRowsPaired(buttons: string[]): string[][] {
  const rows: string[][] = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(
      i + 1 < buttons.length ? [buttons[i], buttons[i + 1]] : [buttons[i]],
    );
  }
  return rows;
}

interface SetupDraft {
  /** 0 — выбор площадки или создание новой. */
  step: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  /** Выбранный ресурс; при одной площадке задаётся сразу, при первом /setup нет. */
  resourceId?: string;
  /** Мастер создания ещё одной площадки (шаг 0 → «Новая площадка»). */
  creatingNewResource?: boolean;
  /** Несколько площадок: не меняем название сообщества в шаге 1, только выбранный ресурс. */
  multiResourceFlow?: boolean;
  /** Как площадка называется в боте сейчас (для текста шага 1). */
  setupResourceLabel?: string;
  /** Режим имени сообщества: авто из Telegram или ручной. */
  communityNameSource?: PrismaClient.CommunityNameSource;
  /** Адрес в БД на начало мастера (шаг 2). */
  setupResourceAddressLabel?: string | null;
  /** Текущая видимость в БД (для шага 6 и подсказки). */
  setupResourceVisibility?: ResourceVisibility;
  name?: string;
  /** Итог шага 2: строка или null (без адреса); задаётся только после шага 2. */
  resourceAddress?: string | null;
  timeZone?: string;
  slotStart?: number;
  slotEnd?: number;
  sportKindCodes?: SportKindCode[];
  /** Название группы для текстов шага 1 (мастер ведётся в ЛС). */
  groupChatTitleForPrompt?: string;
  /** Шаг 0: хаб, список площадок или мастер «время бронирования в группе». */
  venuesSubstep?:
    | 'hub'
    | 'list'
    | 'link_pick'
    | 'rules_lang_pick'
    | 'rules_edit'
    | 'all_bookings_pick_day'
    | 'all_bookings_list'
    | 'bw_tz'
    | 'bw_start'
    | 'bw_end'
    | 'limit_pick_day'
    | 'limit_pick_hours'
    | 'sport_kinds_pick'
    | 'recurring_pick_resource'
    | 'recurring_pick_action'
    | 'recurring_pick_sport'
    | 'recurring_pick_weekday'
    | 'recurring_pick_start'
    | 'recurring_pick_duration'
    | 'recurring_pick_end_date'
    | 'recurring_list_delete';
  bwTzDraft?: string;
  bwStartHourDraft?: number;
  /** ISO 1–7 для мастера лимита по дням. */
  limitWeekdayDraft?: number;
  allBookingsDayOffsetDraft?: 0 | 1;
  allBookingsRowLabelsDraft?: string[];
  allBookingsBookingIdsDraft?: string[];
  recurringResourceIdDraft?: string;
  recurringSportKindCodeDraft?: SportKindCode;
  recurringWeekdayDraft?: number;
  recurringStartMinuteOfDayDraft?: number;
  recurringDurationMinutesDraft?: BookingDurationMinutes;
  recurringRuleIdsDraft?: string[];
  recurringRuleLabelsDraft?: string[];
  /** Після часового поясу одразу крок видимості (істотує майданчик), без вибору єдиного «годинника». */
  postTzVisibilityOnly?: boolean;
  /** Крок 1: очікуємо підтвердження видалення майданчика. */
  setupResourceDeleteConfirm?: boolean;
  /** Chosen language for community rules editing flow. */
  rulesLanguageIdDraft?: string;
  rulesLanguageNameDraft?: string;
}

interface WhPerDayEditDraft {
  groupChatId: bigint;
  resourceId: string;
  weekday: number;
  phase: 'start' | 'end';
  slotStart?: number;
}

type WhDmState =
  | { kind: 'offer'; groupChatId: bigint; resourceId: string }
  | { kind: 'pick_day'; groupChatId: bigint; resourceId: string }
  | {
      kind: 'day_menu';
      groupChatId: bigint;
      resourceId: string;
      weekday: number;
    };

@Update()
export class BotUpdate {
  private readonly logger = new Logger(BotUpdate.name);
  private readonly setupDrafts = new Map<string, SetupDraft>();
  /** Админ ведёт /setup в ЛС; значение — id группы (строка). */
  private readonly setupBridgeGroupByUser = new Map<number, string>();
  private readonly menuStates = new Map<string, MenuState>();
  private readonly activeGroupByUser = new Map<number, bigint>();
  private readonly groupPickerLabelsByUser = new Map<
    number,
    Map<string, bigint>
  >();
  private readonly pendingDmPickerActionByUser = new Map<number, 'setup'>();
  private readonly rulesPromptMessageByUserGroup = new Map<string, number>();
  /** ЛС: предложение после /setup или выбор дня / меню дня (reply-клавиатура внизу). */
  private readonly whDmStateByUser = new Map<number, WhDmState>();
  private readonly whPerDayEditByUser = new Map<number, WhPerDayEditDraft>();
  /** Последняя группа, из которой админ вёл /setup (ЛС «Настройки» открывает её снова). */
  private readonly lastSetupGroupByUser = new Map<number, string>();
  private readonly pendingBookSportResourceByUser = new Map<number, string>();
  /** After choosing a sport, skip `book_day` and use this day (set when booking from the day grid). */
  private readonly pendingBookDayOffsetAfterSportByUser = new Map<
    number,
    0 | 1
  >();

  constructor(
    private readonly booking: BookingService,
    private readonly recurringBookings: RecurringBookingService,
    private readonly community: CommunityService,
    private readonly resources: ResourceService,
    private readonly telegramMembers: TelegramMembersService,
    private readonly metrics: MetricsService,
    private readonly i18n: I18nService,
  ) {}

  private L(lang: string | null | undefined) {
    return createBotLabels(this.i18n, lang);
  }

  /** Reply keyboard + bot strings for this user in this group (membership override or user default). */
  private async labelsForUserInGroup(
    groupChatId: bigint,
    telegramUserId: number,
  ): Promise<BotLabels> {
    const id = await this.telegramMembers.getEffectiveLanguageId({
      telegramChatId: groupChatId,
      telegramUserId,
    });
    return this.L(resolveUiLang(id));
  }

  private async isBotAdminInGroup(
    telegram: Context['telegram'],
    groupChatId: bigint,
  ): Promise<boolean> {
    try {
      const me = await telegram.getMe();
      const member = await telegram.getChatMember(
        groupChatId.toString(),
        me.id,
      );
      return member.status === 'creator' || member.status === 'administrator';
    } catch {
      return false;
    }
  }

  private async langForCtx(ctx: Context): Promise<string> {
    if (!ctx.from) {
      return resolveUiLang(null);
    }
    if (isGroupChat(ctx) && ctx.chat?.id) {
      const id = await this.telegramMembers.getEffectiveLanguageId({
        telegramChatId: BigInt(ctx.chat.id),
        telegramUserId: ctx.from.id,
      });
      return resolveUiLang(id);
    }
    const gid = this.activeGroupByUser.get(ctx.from.id);
    if (gid == null) {
      const id = await this.telegramMembers.getEffectiveLanguageId({
        telegramChatId: null,
        telegramUserId: ctx.from.id,
      });
      return resolveUiLang(id);
    }
    const id = await this.telegramMembers.getEffectiveLanguageId({
      telegramChatId: gid,
      telegramUserId: ctx.from.id,
    });
    return resolveUiLang(id);
  }

  private async langForDmUser(
    userId: number,
    groupChatId: bigint | null,
  ): Promise<string> {
    const id = await this.telegramMembers.getEffectiveLanguageId({
      telegramChatId: groupChatId,
      telegramUserId: userId,
    });
    return resolveUiLang(id);
  }

  private botT(
    lang: string,
    key: string,
    args?: Record<string, string | number>,
  ): string {
    return this.i18n.t(`bot.${key}` as never, {
      lang,
      args: args as Record<string, string>,
    });
  }

  private whIsoLabels(): string[] {
    return weekdayIsoLabels(this.i18n, this.kb().lang);
  }

  private readonly labelStore = new AsyncLocalStorage<BotLabels>();

  /** Reply-keyboard labels for the current update (set via `withUserLabels`). */
  private kb(): BotLabels {
    return this.labelStore.getStore() ?? this.L(UI_FALLBACK_LANGUAGE);
  }

  /**
   * Runs `fn` with `AsyncLocalStorage` labels derived from membership language.
   * Keeps one source of truth for button text vs. `ctx.message.text` matching.
   */
  private async withBotLabels<T>(
    lbl: BotLabels,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.labelStore.run(lbl, fn);
  }

  private async withUserLabels<T>(
    ctx: Context,
    fn: () => Promise<T>,
  ): Promise<T> {
    const lang = await this.langForCtx(ctx);
    return this.withBotLabels(this.L(lang), fn);
  }

  /** Same as `withUserLabels` but when only membership `languageId` is known (no full `Context`). */
  private async withLabelsLang<T>(
    languageId: string | null | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.withBotLabels(this.L(resolveUiLang(languageId)), fn);
  }

  private sk(ctx: Context): string {
    if (!isGroupChat(ctx) && ctx.from) {
      const gid = this.activeGroupByUser.get(ctx.from.id);
      if (gid != null) {
        return this.setupSk(gid, ctx.from.id);
      }
    }
    return `${ctx.chat!.id}:${ctx.from!.id}`;
  }

  private setupSk(
    groupChatId: bigint | number | string,
    userId: number,
  ): string {
    return `${groupChatId}:${userId}`;
  }

  private rulesPromptSk(groupChatId: bigint, userId: number): string {
    return `${groupChatId}:${userId}`;
  }

  private clearSetupBridgeForGroup(userId: number, groupChatIdStr: string) {
    if (this.setupBridgeGroupByUser.get(userId) === groupChatIdStr) {
      this.setupBridgeGroupByUser.delete(userId);
    }
  }

  /** Ответы мастера /setup — только в ЛС админа. */
  private async sendSetupDm(
    ctx: Context,
    text: string,
    extra?: NonNullable<Parameters<Context['reply']>[1]>,
  ) {
    if (!ctx.from) {
      return;
    }
    await ctx.telegram.sendMessage(
      ctx.from.id,
      text,
      extra ? { ...extra } : undefined,
    );
  }

  /**
   * Клавиатура в ЛС с ботом: только «Настройки» (бронь — в группе).
   * Опционально нижний ряд после сохранения /setup — часы по дням.
   */
  private async dmAdminReplyMarkup(
    telegram: Context['telegram'],
    groupChatId: bigint,
    fromId: number,
    opts?: { perDayOffer?: boolean },
  ) {
    if (!(await isUserAdminOfGroupChat(telegram, groupChatId, fromId))) {
      return Markup.removeKeyboard();
    }
    const lang = await this.langForDmUser(fromId, groupChatId);
    const lbl = this.L(lang);
    const rows: string[][] = [
      [lbl.menuChatBot, lbl.menuSetup],
      [lbl.menuChangeLanguage],
    ];
    if (opts?.perDayOffer) {
      rows.push([lbl.menuWhPerDay, lbl.menuWhSkip]);
    }
    return Markup.keyboard(rows).resize().persistent(true);
  }

  private async replyWithMainMenuInDmForGroup(
    ctx: Context,
    groupChatId: bigint,
    text: string,
    opts?: { perDayOffer?: boolean },
  ) {
    if (!ctx.from) {
      return;
    }
    this.resetMenuStateForGroup(groupChatId, ctx.from.id);
    await ctx.telegram.sendMessage(
      ctx.from.id,
      text,
      await this.dmAdminReplyMarkup(
        ctx.telegram,
        groupChatId,
        ctx.from.id,
        opts,
      ),
    );
  }

  private resetMenuStateForGroup(groupChatId: bigint, userId: number) {
    this.menuStates.delete(this.setupSk(groupChatId, userId));
  }

  private getMenuState(ctx: Context): MenuState {
    return this.menuStates.get(this.sk(ctx)) ?? defaultMenuState();
  }

  private setMenuState(ctx: Context, state: MenuState) {
    this.menuStates.set(this.sk(ctx), state);
  }

  private resetMenuState(ctx: Context) {
    this.setMenuState(ctx, defaultMenuState());
    if (ctx.from) {
      this.pendingBookSportResourceByUser.delete(ctx.from.id);
      this.pendingBookDayOffsetAfterSportByUser.delete(ctx.from.id);
    }
  }

  private setupStepMax(draft: SetupDraft): 5 | 6 {
    if (draft.creatingNewResource) {
      return 5;
    }
    if (draft.resourceId) {
      return 6;
    }
    return 5;
  }

  private setupStepLine(step: number, draft: SetupDraft): string {
    return this.botT(this.kb().lang, 'setup.stepLine', {
      step: String(step),
      max: String(this.setupStepMax(draft)),
    });
  }

  private bookableResources<T extends { visibility: ResourceVisibility }>(
    resources: T[],
    admin: boolean,
  ): T[] {
    if (admin) {
      return resources;
    }
    return resources.filter((r) => r.visibility === ResourceVisibility.ACTIVE);
  }

  private resourcesForBookingUi(chatId: bigint, admin: boolean) {
    return this.resources.listForChat(chatId, { onlyActive: !admin });
  }

  /** Меню внизу экрана (reply keyboard). У админов группы — «Настройки». */
  private async mainMenuReplyMarkupForDmUser(
    telegram: Context['telegram'],
    userId: number,
  ) {
    const gid = this.activeGroupByUser.get(userId);
    const lang = await this.langForDmUser(userId, gid ?? null);
    const lbl = this.L(lang);
    const keys = [lbl.menuBook, lbl.menuList, lbl.menuGrid, lbl.menuFreeSlots];
    if (await this.showSwitchGroupInDmMenu(telegram, userId)) {
      keys.push(lbl.menuSwitchGroup);
    }
    if (gid != null && (await isUserAdminOfGroupChat(telegram, gid, userId))) {
      keys.push(lbl.menuSetup);
    }
    keys.push(lbl.menuChangeLanguage);
    keys.push(lbl.menuMain);
    return Markup.keyboard(kbRowsPaired(keys)).resize().persistent(true);
  }

  /** Group bottom row: English-only keys. */
  private groupEntryReplyMarkupForChatUser() {
    return Markup.keyboard([[GROUP_REPLY_CHAT_BOT, GROUP_REPLY_FREE_SLOTS]])
      .resize()
      .persistent(true);
  }

  private async mainMenuReplyMarkup(ctx: Context) {
    if (ctx.from && !isGroupChat(ctx)) {
      return this.mainMenuReplyMarkupForDmUser(ctx.telegram, ctx.from.id);
    }
    if (isGroupChat(ctx) && ctx.from) {
      return this.groupEntryReplyMarkupForChatUser();
    }
    return Markup.keyboard([[GROUP_REPLY_CHAT_BOT]])
      .resize()
      .persistent(true);
  }

  private async listAvailableGroupsForUser(
    telegram: Context['telegram'],
    userId: number,
  ) {
    const byMembership =
      await this.telegramMembers.listActiveUserCommunities(userId);
    const map = new Map<
      bigint,
      { telegramChatId: bigint; communityName: string | null }
    >();
    for (const g of byMembership) {
      try {
        const m = await telegram.getChatMember(
          g.telegramChatId.toString(),
          userId,
        );
        if (!TelegramMembersService.isStatusInChat(m.status)) {
          continue;
        }
        map.set(g.telegramChatId, {
          telegramChatId: g.telegramChatId,
          communityName: g.communityName,
        });
      } catch {
        /* stale membership or bot has no access to this chat */
      }
    }
    const communities = await this.community.listAllCommunitiesBasic();
    for (const c of communities) {
      if (map.has(c.telegramChatId)) {
        continue;
      }
      try {
        const m = await telegram.getChatMember(
          c.telegramChatId.toString(),
          userId,
        );
        if (!TelegramMembersService.isStatusInChat(m.status)) {
          continue;
        }
        map.set(c.telegramChatId, {
          telegramChatId: c.telegramChatId,
          communityName: c.name,
        });
      } catch {
        /* not a member or chat unavailable */
      }
    }
    return [...map.values()];
  }

  /** Whether the DM main menu should offer “Switch group” (more than one selectable group). */
  private async showSwitchGroupInDmMenu(
    telegram: Context['telegram'],
    userId: number,
  ): Promise<boolean> {
    const groups = await this.listAvailableGroupsForUser(telegram, userId);
    return groups.length > 1;
  }

  private async syncAutoCommunityNameFromChat(
    telegramChatId: bigint,
    chatTitle: string | undefined,
  ) {
    const title = chatTitle?.trim();
    if (!title) {
      return;
    }
    try {
      await this.community.syncAutoCommunityNameWithChatTitle({
        telegramChatId,
        chatTitle: title,
      });
    } catch (e) {
      this.logger.warn(
        `auto community name sync: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private groupPickerReplyMarkup(
    items: { telegramChatId: bigint; communityName: string | null }[],
  ) {
    const rows = kbRowsPaired(
      items.map((g, i) => {
        const name =
          g.communityName?.trim() ||
          this.botT(this.kb().lang, 'dm.groupFallback', {
            id: String(g.telegramChatId),
          });
        return `#${i + 1} ${name}`.slice(0, 64);
      }),
    );
    rows.push([this.kb().menuMain]);
    return Markup.keyboard(rows).resize().persistent(true);
  }

  private async promptGroupPickerInDm(
    ctx: Context,
    opts?: { force?: boolean; hint?: string },
  ): Promise<bigint | null> {
    if (!ctx.from || isGroupChat(ctx)) {
      return null;
    }
    const lang = await this.langForCtx(ctx);
    const fromId = ctx.from.id;
    return this.withBotLabels(this.L(lang), async () => {
      const groups = await this.listAvailableGroupsForUser(
        ctx.telegram,
        fromId,
      );
      if (groups.length === 0) {
        await ctx.reply(this.botT(lang, 'dm.noGroupsFound'));
        return null;
      }
      if (groups.length === 1 && !opts?.force) {
        const only = groups[0].telegramChatId;
        this.activeGroupByUser.set(fromId, only);
        this.groupPickerLabelsByUser.delete(fromId);
        return only;
      }
      const labels = new Map<string, bigint>();
      for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        const name =
          g.communityName?.trim() ||
          this.botT(lang, 'dm.groupFallback', {
            id: String(g.telegramChatId),
          });
        labels.set(`#${i + 1} ${name}`.slice(0, 64), g.telegramChatId);
      }
      this.groupPickerLabelsByUser.set(fromId, labels);
      this.activeGroupByUser.delete(fromId);
      await ctx.reply(
        opts?.hint ?? this.botT(lang, 'dm.pickGroupHint'),
        this.groupPickerReplyMarkup(groups),
      );
      return null;
    });
  }

  private async openDmMenuForGroupFromGroupContext(ctx: Context) {
    if (!ctx.from || !ctx.chat?.id || !isGroupChat(ctx)) {
      return;
    }
    const groupChatId = BigInt(ctx.chat.id);
    if (!(await this.ensureParticipantGroupOnboarding(ctx, groupChatId))) {
      await this.replyTransientInGroup(
        ctx,
        this.botT(this.kb().lang, 'onboarding.needLanguageRulesGroup'),
      );
      return;
    }
    this.activeGroupByUser.set(ctx.from.id, groupChatId);
    this.groupPickerLabelsByUser.delete(ctx.from.id);
    this.resetMenuStateForGroup(groupChatId, ctx.from.id);
    const comm = await this.community.findByTelegramChatId(groupChatId);
    const ready = comm && comm.resources.length > 0;
    const lang = this.kb().lang;
    const text = ready
      ? this.botT(lang, 'menu.titleForGroup')
      : this.botT(lang, 'book.groupNotConfigured');
    try {
      await ctx.telegram.sendMessage(
        ctx.from.id,
        text,
        await this.mainMenuReplyMarkupForDmUser(ctx.telegram, ctx.from.id),
      );
    } catch {
      await this.replyTransientInGroup(
        ctx,
        this.botT(lang, 'dm.cannotWriteOpenStart'),
      );
    }
  }

  private async openDmFreeSlotsForGroupFromGroupContext(ctx: Context) {
    if (!ctx.from || !ctx.chat?.id || !isGroupChat(ctx)) {
      return;
    }
    const groupChatId = BigInt(ctx.chat.id);
    if (!(await this.ensureParticipantGroupOnboarding(ctx, groupChatId))) {
      await this.replyTransientInGroup(
        ctx,
        this.botT(this.kb().lang, 'onboarding.needLanguageRulesGroup'),
      );
      return;
    }
    this.activeGroupByUser.set(ctx.from.id, groupChatId);
    this.groupPickerLabelsByUser.delete(ctx.from.id);
    this.resetMenuStateForGroup(groupChatId, ctx.from.id);
    const lang = this.kb().lang;
    const comm = await this.community.findByTelegramChatId(groupChatId);
    if (!comm) {
      try {
        await ctx.telegram.sendMessage(
          ctx.from.id,
          this.botT(lang, 'book.venueNotConfiguredShort'),
          await this.mainMenuReplyMarkupForDmUser(ctx.telegram, ctx.from.id),
        );
      } catch {
        await this.replyTransientInGroup(
          ctx,
          this.botT(lang, 'dm.cannotWriteOpenStartShort'),
        );
      }
      return;
    }
    const rows = await this.booking.listOpenLookingSlots({
      telegramChatId: groupChatId,
    });
    if (rows.length === 0) {
      try {
        await ctx.telegram.sendMessage(
          ctx.from.id,
          this.botT(lang, 'book.freeSlotsEmpty'),
          await this.mainMenuReplyMarkupForDmUser(ctx.telegram, ctx.from.id),
        );
      } catch {
        await this.replyTransientInGroup(
          ctx,
          this.botT(lang, 'dm.cannotWriteOpenStartShort'),
        );
      }
      return;
    }
    const listItems = rows.map((r) => ({
      startTime: r.startTime,
      endTime: r.endTime,
      timeZone: r.resource.timeZone,
      resourceName: r.resource.name,
      sportKindCode: r.sportKindCode,
      playersNeeded: r.requiredPlayers,
    }));
    const rowLabels = listItems.map((item) =>
      this.buildFreeSlotButtonLabel(item),
    );
    this.menuStates.set(this.setupSk(groupChatId, ctx.from.id), {
      t: 'free_slots',
      bookingIds: rows.map((r) => r.id),
      rowLabels,
    });
    try {
      await ctx.telegram.sendMessage(
        ctx.from.id,
        this.botT(lang, 'book.freeSlotsIntro'),
        this.freeSlotsReplyMarkup(listItems),
      );
    } catch {
      await this.replyTransientInGroup(
        ctx,
        this.botT(lang, 'dm.cannotWriteOpenStartShort'),
      );
    }
  }

  private async tryDeleteTriggerTextMessage(ctx: Context) {
    if (
      !ctx.chat?.id ||
      !ctx.message ||
      !('message_id' in ctx.message) ||
      !isGroupChat(ctx)
    ) {
      return;
    }
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id);
    } catch {
      /* no rights to delete user message */
    }
  }

  private deleteMessageLater(
    telegram: Context['telegram'],
    chatId: number,
    messageId: number,
    delayMs: number,
  ) {
    setTimeout(() => {
      void telegram.deleteMessage(chatId, messageId).catch(() => {
        /* no rights or message already removed */
      });
    }, delayMs);
  }

  private async sendMessageWithBackoff(
    telegram: Context['telegram'],
    chatId: number | string,
    text: string,
    kind: 'dm' | 'group',
  ): Promise<void> {
    let attempt = 0;
    while (true) {
      try {
        await telegram.sendMessage(chatId, text);
        this.metrics.incTelegramSend('success', kind);
        return;
      } catch (e) {
        const err = e as {
          response?: {
            error_code?: number;
            parameters?: { retry_after?: number };
          };
        };
        const retryAfterSec = err.response?.parameters?.retry_after ?? 1;
        const isRateLimit = err.response?.error_code === 429;
        if (!isRateLimit || attempt >= TELEGRAM_MAX_429_RETRIES) {
          this.metrics.incTelegramSend('error', kind);
          throw e;
        }
        this.metrics.incTelegramRetry(kind);
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(1, retryAfterSec) * 1000),
        );
        attempt += 1;
      }
    }
  }

  private async sendMessageBatchBestEffort(
    telegram: Context['telegram'],
    chatIds: Array<number | string>,
    text: string,
    kind: 'dm' | 'group',
    onError: (chatId: number | string, error: unknown) => void,
  ): Promise<void> {
    for (let i = 0; i < chatIds.length; i += TELEGRAM_SEND_BATCH_SIZE) {
      const batch = chatIds.slice(i, i + TELEGRAM_SEND_BATCH_SIZE);
      await Promise.all(
        batch.map(async (chatId) => {
          try {
            await this.sendMessageWithBackoff(telegram, chatId, text, kind);
          } catch (e) {
            onError(chatId, e);
          }
        }),
      );
    }
  }

  private async replyTransientInGroup(
    ctx: Context,
    text: string,
    delayMs = 5000,
  ) {
    let sent: Awaited<ReturnType<Context['reply']>>;
    try {
      sent = await ctx.reply(text);
    } catch (e) {
      const err = e as {
        response?: { error_code?: number; description?: string };
      };
      const code = err.response?.error_code;
      const description = (err.response?.description ?? '').toLowerCase();
      const expectedForbidden =
        code === 403 &&
        (description.includes('bot was kicked') ||
          description.includes('bot is not a member'));
      if (expectedForbidden) {
        this.logger.warn(
          `replyTransientInGroup skipped (chat unavailable): ${err.response?.description ?? 'Forbidden'}`,
        );
        return;
      }
      throw e;
    }
    if (!isGroupChat(ctx) || !ctx.chat?.id) {
      return;
    }
    this.deleteMessageLater(
      ctx.telegram,
      Number(ctx.chat.id),
      sent.message_id,
      delayMs,
    );
  }

  /** User has not opened a private chat with the bot (no /start in DM yet). */
  private isTelegramBotCannotInitiateDmError(error: unknown): boolean {
    const err = error as {
      response?: { error_code?: number; description?: string };
    };
    if (err.response?.error_code !== 403) {
      return false;
    }
    const d = (err.response?.description ?? '').toLowerCase();
    return d.includes('initiate conversation');
  }

  private async resolveActiveGroupChatId(ctx: Context): Promise<bigint | null> {
    if (isGroupChat(ctx) && ctx.chat?.id) {
      return BigInt(ctx.chat.id);
    }
    if (!ctx.from) {
      return null;
    }
    const gid = this.activeGroupByUser.get(ctx.from.id);
    if (gid != null) {
      try {
        const m = await ctx.telegram.getChatMember(gid.toString(), ctx.from.id);
        if (TelegramMembersService.isStatusInChat(m.status)) {
          return gid;
        }
      } catch {
        /* stale/invalid active group in DM */
      }
      this.activeGroupByUser.delete(ctx.from.id);
      this.groupPickerLabelsByUser.delete(ctx.from.id);
    }
    return this.promptGroupPickerInDm(ctx);
  }

  private async isAdminInContextGroup(
    ctx: Context,
    groupChatId: bigint,
  ): Promise<boolean> {
    if (!ctx.from) {
      return false;
    }
    if (isGroupChat(ctx)) {
      return isGroupAdmin(ctx);
    }
    return isUserAdminOfGroupChat(ctx.telegram, groupChatId, ctx.from.id);
  }

  private dayPickReplyMarkup() {
    const lbl = this.kb();
    return Markup.keyboard([
      [lbl.menuDayToday, lbl.menuDayTomorrow],
      [lbl.menuBack, lbl.menuMain],
    ])
      .resize()
      .persistent(true);
  }

  /** Day schedule (grid): same day switchers as booking, plus «Book» like the main menu. */
  private gridDayReplyMarkup() {
    const lbl = this.kb();
    return Markup.keyboard([
      [lbl.menuDayToday, lbl.menuDayTomorrow],
      [lbl.menuBook],
      [lbl.menuBack, lbl.menuMain],
    ])
      .resize()
      .persistent(true);
  }

  private hoursPickReplyMarkup(slots: BookingStartSlot[]) {
    const lbl = this.kb();
    const labels = slots.map(
      (s) =>
        `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`,
    );
    const rows = kbRowsPaired(labels);
    rows.push([lbl.menuBack, lbl.menuMain]);
    return Markup.keyboard(rows).resize().persistent(true);
  }

  private durationLabel(min: number): string {
    const lbl = this.kb();
    if (min === 60) {
      return lbl.duration1h;
    }
    if (min === 90) {
      return lbl.duration90m;
    }
    return lbl.duration2h;
  }

  private durationPickReplyMarkup(minutes: number[]) {
    const lbl = this.kb();
    const rows = kbRowsPaired(minutes.map((m) => this.durationLabel(m)));
    rows.push([lbl.menuBack, lbl.menuMain]);
    return Markup.keyboard(rows).resize().persistent(true);
  }

  private lookingForPlayersReplyMarkup() {
    const lbl = this.kb();
    return Markup.keyboard([
      [lbl.bookLookingYes, lbl.bookLookingNo],
      [lbl.menuBack, lbl.menuMain],
    ])
      .resize()
      .persistent(true);
  }

  private playersCountPromptReplyMarkup() {
    const lbl = this.kb();
    return Markup.keyboard([[lbl.menuBack, lbl.menuMain]])
      .resize()
      .persistent(true);
  }

  /**
   * Текст рядка «Мої бронювання»: дата, час, майданчик.
   * `includeCancelSuffix` — лише для reply-кнопок (ліміт 64 символи); у повідомленні чату — false.
   */
  private buildListBookingButtonLabel(
    item: {
      startTime: Date;
      endTime: Date;
      timeZone: string;
      resourceName: string;
    },
    opts?: { includeCancelSuffix?: boolean },
  ): string {
    const lbl = this.kb();
    const r = item;
    const day = formatInTimeZone(r.startTime, r.timeZone, 'dd.MM.yyyy');
    const a = formatInTimeZone(r.startTime, r.timeZone, 'HH:mm');
    const z = formatInTimeZone(r.endTime, r.timeZone, 'HH:mm');
    const timePart = `${day} ${a}–${z}`;
    const includeCancel = opts?.includeCancelSuffix !== false;
    const cancelSuffix = includeCancel ? lbl.listCancelSuffix : '';
    const sep = ' · ';
    let res = r.resourceName.trim() || '—';
    let label = `${timePart}${sep}${res}${cancelSuffix}`;
    if (label.length > 64) {
      const maxRes = Math.max(
        0,
        64 - timePart.length - cancelSuffix.length - sep.length,
      );
      res =
        maxRes > 0 && res.length > maxRes
          ? `${res.slice(0, Math.max(0, maxRes - 1))}…`
          : res.slice(0, maxRes);
      label = `${timePart}${sep}${res}${cancelSuffix}`.slice(0, 64);
    }
    return label;
  }

  /** Кнопка в «Свободные места» (лимит Telegram — 64 символа). */
  private buildFreeSlotButtonLabel(item: {
    startTime: Date;
    endTime: Date;
    timeZone: string;
    resourceName: string;
    sportKindCode: SportKindCode;
    playersNeeded: number;
  }): string {
    const lbl = this.kb();
    const day = formatInTimeZone(item.startTime, item.timeZone, 'dd.MM');
    const a = formatInTimeZone(item.startTime, item.timeZone, 'HH:mm');
    const z = formatInTimeZone(item.endTime, item.timeZone, 'HH:mm');
    const sport = this.botT(lbl.lang, `sport.${item.sportKindCode}`);
    const res =
      item.resourceName.trim() || this.botT(lbl.lang, 'common.emDash');
    const tail = this.botT(lbl.lang, 'freeSlot.morePlayers', {
      n: item.playersNeeded,
    });
    let label = `${day} ${a}–${z} · ${sport} · ${res} · ${tail}`;
    if (label.length > 64) {
      label = `${day} ${a}–${z} · … · ${tail}`.slice(0, 64);
    }
    return label;
  }

  private listBookingsReplyMarkup(
    items: {
      startTime: Date;
      endTime: Date;
      timeZone: string;
      resourceName: string;
    }[],
  ) {
    const lbl = this.kb();
    const labels = items.map((it) => this.buildListBookingButtonLabel(it));
    const rows = labels.map((label) => [label]);
    rows.push([lbl.menuBack, lbl.menuMain]);
    return Markup.keyboard(rows).resize().persistent(true);
  }

  private freeSlotsReplyMarkup(
    items: {
      startTime: Date;
      endTime: Date;
      timeZone: string;
      resourceName: string;
      sportKindCode: SportKindCode;
      playersNeeded: number;
    }[],
  ) {
    const lbl = this.kb();
    const labels = items.map((it) => this.buildFreeSlotButtonLabel(it));
    const rows = kbRowsPaired(labels);
    rows.push([lbl.menuBack, lbl.menuMain]);
    return Markup.keyboard(rows).resize().persistent(true);
  }

  /** Подпись кнопки выбора площадки: имя и при необходимости адрес в скобках (/setup, бронь, расписание). */
  private resourcePickButtonLabel(
    r: {
      name: string;
      address?: string | null;
      visibility?: ResourceVisibility;
    },
    i: number,
    opts?: { markInactive?: boolean },
  ): string {
    const lbl = this.kb();
    const prefix = `${i + 1}. ${r.name}`;
    const addr = r.address?.trim();
    let line = addr ? `${prefix} (${addr})` : prefix;
    if (opts?.markInactive && r.visibility === ResourceVisibility.INACTIVE) {
      line = `${line} · ${lbl.resourceInactiveMark}`;
    }
    return line.slice(0, 64);
  }

  private resourcePickReplyMarkup(
    list: {
      id: string;
      name: string;
      address?: string | null;
      visibility?: ResourceVisibility;
    }[],
    markInactive = false,
  ) {
    const lbl = this.kb();
    const labels = list.map((r, i) =>
      this.resourcePickButtonLabel(r, i, { markInactive }),
    );
    const rows = kbRowsPaired(labels);
    rows.push([lbl.menuBack, lbl.menuMain]);
    return Markup.keyboard(rows).resize().persistent(true);
  }

  /** Все виды спорта из каталога (кнопки при выборе вида при бронировании). */
  private allSportKindCodesForPicker(): SportKindCode[] {
    return [...SPORT_ORDER];
  }

  private resourceSportKindCodes(resource: {
    sportKinds?: { sportKindCode: SportKindCode }[];
  }): SportKindCode[] {
    const codes = resource.sportKinds?.map((x) => x.sportKindCode) ?? [];
    return codes.length > 0 ? codes : [SportKindCode.TENNIS];
  }

  private sportPickReplyMarkup(types: SportKindCode[]) {
    const lbl = this.kb();
    const rows = kbRowsPaired(
      types.map((t) => this.botT(lbl.lang, `sport.${t}`)),
    );
    rows.push([lbl.menuBack, lbl.menuMain]);
    return Markup.keyboard(rows).resize().persistent(true);
  }

  /** Одно сообщение: текст + главное меню внизу (без второго «Меню»). */
  private async replyWithMainMenu(ctx: Context, text: string) {
    this.resetMenuState(ctx);
    await ctx.reply(text, await this.mainMenuReplyMarkup(ctx));
  }

  /**
   * Окно booking_window_* в communities только для обычных участников.
   * Админы/creator группы в Telegram проходят без проверки (могут бронировать всегда).
   */
  private async ensureParticipantBookingWindowOpen(
    ctx: Context,
    groupChatId: bigint,
    comm: NonNullable<
      Awaited<ReturnType<CommunityService['findByTelegramChatId']>>
    >,
  ): Promise<boolean> {
    if (await this.isAdminInContextGroup(ctx, groupChatId)) {
      return true;
    }
    if (
      isLocalTimeWithinBookingWindow({
        now: new Date(),
        timeZone: comm.bookingWindowTimeZone,
        startHour: comm.bookingWindowStartHour,
        endHour: comm.bookingWindowEndHour,
      })
    ) {
      return true;
    }
    this.resetMenuState(ctx);
    await ctx.reply(
      this.kb().msgNoSlotsBookingWindow,
      await this.mainMenuReplyMarkup(ctx),
    );
    return false;
  }

  private async handleMenuBack(ctx: Context) {
    const s = this.getMenuState(ctx);
    const chatId = await this.resolveActiveGroupChatId(ctx);
    if (chatId == null) {
      return;
    }
    const admin = await this.isAdminInContextGroup(ctx, chatId);

    switch (s.t) {
      case 'main':
        return;
      case 'book_sport':
        this.pendingBookSportResourceByUser.delete(ctx.from!.id);
        this.pendingBookDayOffsetAfterSportByUser.delete(ctx.from!.id);
        {
          const list = await this.resourcesForBookingUi(chatId, admin);
          if (list.length <= 1) {
            this.resetMenuState(ctx);
            await ctx.reply(
              this.botT(this.kb().lang, 'menu.title'),
              await this.mainMenuReplyMarkup(ctx),
            );
            return;
          }
          this.setMenuState(ctx, { t: 'book_res' });
          await ctx.reply(
            this.botT(this.kb().lang, 'book.pickResource'),
            this.resourcePickReplyMarkup(list, admin),
          );
        }
        return;
      case 'book_res': {
        this.resetMenuState(ctx);
        await ctx.reply(
          this.botT(this.kb().lang, 'menu.title'),
          await this.mainMenuReplyMarkup(ctx),
        );
        return;
      }
      case 'grid_res':
        this.resetMenuState(ctx);
        await ctx.reply(
          this.botT(this.kb().lang, 'menu.title'),
          await this.mainMenuReplyMarkup(ctx),
        );
        return;
      case 'book_day': {
        const comm = await this.community.findByTelegramChatId(chatId);
        if (!comm) {
          return;
        }
        if (s.sportKindCode !== undefined) {
          const list = await this.resourcesForBookingUi(chatId, admin);
          const selected = list.find((x) => x.id === s.resourceId);
          if (selected) {
            const sportKinds = this.resourceSportKindCodes(selected);
            if (sportKinds.length > 1) {
              if (
                !(await this.ensureParticipantBookingWindowOpen(
                  ctx,
                  chatId,
                  comm,
                ))
              ) {
                return;
              }
              this.pendingBookSportResourceByUser.set(
                ctx.from!.id,
                selected.id,
              );
              this.setMenuState(ctx, { t: 'book_sport' });
              await ctx.reply(
                this.botT(this.kb().lang, 'book.pickSport'),
                this.sportPickReplyMarkup(sportKinds),
              );
              return;
            }
          }
          if (list.length <= 1) {
            this.resetMenuState(ctx);
            await ctx.reply(
              this.botT(this.kb().lang, 'menu.title'),
              await this.mainMenuReplyMarkup(ctx),
            );
            return;
          }
          this.setMenuState(ctx, {
            t: 'book_res',
          });
          await ctx.reply(
            this.botT(this.kb().lang, 'book.pickResource'),
            this.resourcePickReplyMarkup(list, admin),
          );
          return;
        }
        const visible = this.bookableResources(comm.resources, admin);
        if (visible.length <= 1) {
          this.resetMenuState(ctx);
          await ctx.reply(
            this.botT(this.kb().lang, 'menu.title'),
            await this.mainMenuReplyMarkup(ctx),
          );
        } else {
          this.setMenuState(ctx, { t: 'book_res' });
          const list = await this.resourcesForBookingUi(chatId, admin);
          await ctx.reply(
            this.botT(this.kb().lang, 'book.pickResource'),
            this.resourcePickReplyMarkup(list, admin),
          );
        }
        return;
      }
      case 'book_hour': {
        this.setMenuState(ctx, {
          t: 'book_day',
          resourceId: s.resourceId,
          ...(s.sportKindCode !== undefined
            ? { sportKindCode: s.sportKindCode }
            : {}),
        });
        await ctx.reply(
          this.botT(this.kb().lang, 'book.pickDay'),
          this.dayPickReplyMarkup(),
        );
        return;
      }
      case 'book_dur': {
        const starts = await this.booking.getAvailableStartSlots({
          resourceId: s.resourceId,
          telegramChatId: chatId,
          dayOffset: s.dayOffset,
          telegramGroupAdmin: admin,
          telegramUserId: ctx.from?.id,
        });
        if (starts.length === 0) {
          this.resetMenuState(ctx);
          await ctx.reply(
            this.botT(this.kb().lang, 'book.noFreeIntervals'),
            await this.mainMenuReplyMarkup(ctx),
          );
          return;
        }
        this.setMenuState(ctx, {
          t: 'book_hour',
          resourceId: s.resourceId,
          dayOffset: s.dayOffset,
          ...(s.sportKindCode !== undefined
            ? { sportKindCode: s.sportKindCode }
            : {}),
        });
        await ctx.reply(
          s.dayOffset === 0
            ? this.botT(this.kb().lang, 'book.pickStartToday')
            : this.botT(this.kb().lang, 'book.pickStartTomorrow'),
          this.hoursPickReplyMarkup(starts),
        );
        return;
      }
      case 'book_looking': {
        const starts = await this.booking.getAvailableStartSlots({
          resourceId: s.resourceId,
          telegramChatId: chatId,
          dayOffset: s.dayOffset,
          telegramGroupAdmin: admin,
          telegramUserId: ctx.from?.id,
        });
        if (starts.length === 0) {
          this.resetMenuState(ctx);
          await ctx.reply(
            this.botT(this.kb().lang, 'book.noFreeIntervals'),
            await this.mainMenuReplyMarkup(ctx),
          );
          return;
        }
        const durs = await this.booking.getAvailableDurationsMinutes({
          resourceId: s.resourceId,
          telegramChatId: chatId,
          dayOffset: s.dayOffset,
          startHour: s.hour,
          startMinute: s.startMinute,
          telegramGroupAdmin: admin,
          telegramUserId: ctx.from!.id,
        });
        if (durs.length === 0) {
          this.setMenuState(ctx, {
            t: 'book_day',
            resourceId: s.resourceId,
            ...(s.sportKindCode !== undefined
              ? { sportKindCode: s.sportKindCode }
              : {}),
          });
          await ctx.reply(
            this.botT(this.kb().lang, 'book.noMatchingDuration'),
            this.dayPickReplyMarkup(),
          );
          return;
        }
        if (
          await this.bookingSkipsDurationOneHourDailyLimit(
            ctx,
            chatId,
            admin,
            {
              resourceId: s.resourceId,
              dayOffset: s.dayOffset,
              hour: s.hour,
              startMinute: s.startMinute,
            },
            durs,
          )
        ) {
          this.setMenuState(ctx, {
            t: 'book_hour',
            resourceId: s.resourceId,
            dayOffset: s.dayOffset,
            ...(s.sportKindCode !== undefined
              ? { sportKindCode: s.sportKindCode }
              : {}),
          });
          await ctx.reply(
            s.dayOffset === 0
              ? this.botT(this.kb().lang, 'book.pickStartToday')
              : this.botT(this.kb().lang, 'book.pickStartTomorrow'),
            this.hoursPickReplyMarkup(starts),
          );
          return;
        }
        this.setMenuState(ctx, {
          t: 'book_dur',
          resourceId: s.resourceId,
          dayOffset: s.dayOffset,
          hour: s.hour,
          startMinute: s.startMinute,
          ...(s.sportKindCode !== undefined
            ? { sportKindCode: s.sportKindCode }
            : {}),
        });
        await ctx.reply(
          this.botT(this.kb().lang, 'book.pickDuration', {
            time: `${String(s.hour).padStart(2, '0')}:${String(s.startMinute).padStart(2, '0')}`,
          }),
          this.durationPickReplyMarkup(durs),
        );
        return;
      }
      case 'book_players': {
        this.setMenuState(ctx, {
          t: 'book_looking',
          resourceId: s.resourceId,
          dayOffset: s.dayOffset,
          hour: s.hour,
          startMinute: s.startMinute,
          durationMinutes: s.durationMinutes,
          ...(s.sportKindCode !== undefined
            ? { sportKindCode: s.sportKindCode }
            : {}),
        });
        await ctx.reply(
          this.botT(this.kb().lang, 'book.askLookingForPartners'),
          this.lookingForPlayersReplyMarkup(),
        );
        return;
      }
      case 'grid_day': {
        const comm = await this.community.findByTelegramChatId(chatId);
        if (!comm) {
          return;
        }
        const visible = this.bookableResources(comm.resources, admin);
        if (visible.length <= 1) {
          this.resetMenuState(ctx);
          await ctx.reply(
            this.botT(this.kb().lang, 'menu.title'),
            await this.mainMenuReplyMarkup(ctx),
          );
        } else {
          this.setMenuState(ctx, { t: 'grid_res' });
          const list = await this.resourcesForBookingUi(chatId, admin);
          await ctx.reply(
            this.botT(this.kb().lang, 'book.pickResourceGrid'),
            this.resourcePickReplyMarkup(list, admin),
          );
        }
        return;
      }
      case 'list':
      case 'free_slots':
        this.resetMenuState(ctx);
        await ctx.reply(
          this.botT(this.kb().lang, 'menu.title'),
          await this.mainMenuReplyMarkup(ctx),
        );
        return;
      default:
        this.resetMenuState(ctx);
        await ctx.reply(
          this.botT(this.kb().lang, 'menu.title'),
          await this.mainMenuReplyMarkup(ctx),
        );
    }
  }

  private async handleMainMenuButtons(ctx: Context, text: string) {
    if (text === this.kb().menuSwitchGroup && !isGroupChat(ctx)) {
      await this.promptGroupPickerInDm(ctx, { force: true });
      return;
    }
    const chatId = await this.resolveActiveGroupChatId(ctx);
    if (chatId == null) {
      return;
    }

    const isAdminInGroup = await this.isAdminInContextGroup(ctx, chatId);
    if (!isAdminInGroup) {
      const canProceed = await this.ensureParticipantGroupOnboarding(
        ctx,
        chatId,
      );
      if (!canProceed) {
        await ctx.reply(
          this.botT(this.kb().lang, 'onboarding.needLanguageRulesDm'),
          await this.mainMenuReplyMarkup(ctx),
        );
        return;
      }
    }

    if (text === this.kb().menuBook) {
      const comm = await this.community.findByTelegramChatId(chatId);
      const admin = isAdminInGroup;
      const visible = comm ? this.bookableResources(comm.resources, admin) : [];
      if (!comm || visible.length === 0) {
        await ctx.reply(
          this.botT(this.kb().lang, 'book.platformNotConfigured'),
          await this.mainMenuReplyMarkup(ctx),
        );
        return;
      }
      if (!admin) {
        if (
          !(await this.ensureParticipantBookingWindowOpen(ctx, chatId, comm))
        ) {
          return;
        }
      }
      const list = await this.resourcesForBookingUi(chatId, admin);
      if (list.length === 1) {
        const only = list[0];
        const sportKinds = this.resourceSportKindCodes(only);
        if (sportKinds.length <= 1) {
          this.pendingBookSportResourceByUser.delete(ctx.from!.id);
          this.setMenuState(ctx, {
            t: 'book_day',
            resourceId: only.id,
            sportKindCode: sportKinds[0],
          });
          await ctx.reply(
            this.botT(this.kb().lang, 'book.pickDay'),
            this.dayPickReplyMarkup(),
          );
          return;
        }
        this.pendingBookSportResourceByUser.set(ctx.from!.id, only.id);
        this.setMenuState(ctx, { t: 'book_sport' });
        await ctx.reply(
          this.botT(this.kb().lang, 'book.pickSport'),
          this.sportPickReplyMarkup(sportKinds),
        );
        return;
      }
      this.pendingBookSportResourceByUser.delete(ctx.from!.id);
      this.setMenuState(ctx, { t: 'book_res' });
      await ctx.reply(
        this.botT(this.kb().lang, 'book.pickResource'),
        this.resourcePickReplyMarkup(list, admin),
      );
      return;
    }

    if (text === this.kb().menuList) {
      const rows = await this.booking.listMyBookingsNotFinishedOrCancelled({
        telegramChatId: chatId,
        telegramUserId: ctx.from!.id,
      });
      if (rows.length === 0) {
        await ctx.reply(
          this.botT(this.kb().lang, 'book.myBookingsEmpty'),
          await this.mainMenuReplyMarkup(ctx),
        );
        return;
      }
      const listItems = rows.map((r) => ({
        startTime: r.startTime,
        endTime: r.endTime,
        timeZone: r.resource.timeZone,
        resourceName: r.resource.name,
      }));
      const rowLabels = listItems.map((item) =>
        this.buildListBookingButtonLabel(item),
      );
      this.setMenuState(ctx, {
        t: 'list',
        bookingIds: rows.map((r) => r.id),
        rowLabels,
      });
      const intro = this.botT(this.kb().lang, 'book.myBookingsIntro');
      const listText = listItems
        .map((item) =>
          this.buildListBookingButtonLabel(item, {
            includeCancelSuffix: false,
          }),
        )
        .join('\n');
      await ctx.reply(
        `${intro}\n\n${listText}`,
        this.listBookingsReplyMarkup(listItems),
      );
      return;
    }

    if (text === this.kb().menuGrid) {
      const comm = await this.community.findByTelegramChatId(chatId);
      const admin = isAdminInGroup;
      const list = comm ? await this.resourcesForBookingUi(chatId, admin) : [];
      if (!comm || list.length === 0) {
        await ctx.reply(
          this.botT(this.kb().lang, 'book.venueNotConfigured'),
          await this.mainMenuReplyMarkup(ctx),
        );
        return;
      }
      if (list.length === 1) {
        this.setMenuState(ctx, {
          t: 'grid_day',
          resourceId: list[0].id,
        });
        await ctx.reply(
          this.botT(this.kb().lang, 'book.pickDayGrid'),
          this.gridDayReplyMarkup(),
        );
        return;
      }
      this.setMenuState(ctx, { t: 'grid_res' });
      await ctx.reply(
        this.botT(this.kb().lang, 'book.pickResourceGrid'),
        this.resourcePickReplyMarkup(list, admin),
      );
      return;
    }

    if (text === this.kb().menuFreeSlots) {
      const comm = await this.community.findByTelegramChatId(chatId);
      if (!comm) {
        await ctx.reply(
          this.botT(this.kb().lang, 'book.venueNotConfiguredShort'),
          await this.mainMenuReplyMarkup(ctx),
        );
        return;
      }
      const rows = await this.booking.listOpenLookingSlots({
        telegramChatId: chatId,
      });
      if (rows.length === 0) {
        await ctx.reply(
          this.botT(this.kb().lang, 'book.freeSlotsEmpty'),
          await this.mainMenuReplyMarkup(ctx),
        );
        return;
      }
      const listItems = rows.map((r) => ({
        startTime: r.startTime,
        endTime: r.endTime,
        timeZone: r.resource.timeZone,
        resourceName: r.resource.name,
        sportKindCode: r.sportKindCode,
        playersNeeded: r.requiredPlayers,
      }));
      const rowLabels = listItems.map((item) =>
        this.buildFreeSlotButtonLabel(item),
      );
      this.setMenuState(ctx, {
        t: 'free_slots',
        bookingIds: rows.map((r) => r.id),
        rowLabels,
      });
      await ctx.reply(
        this.botT(this.kb().lang, 'book.freeSlotsIntro'),
        this.freeSlotsReplyMarkup(listItems),
      );
      return;
    }
  }

  private async handleBookResourcePick(ctx: Context, text: string) {
    const state = this.getMenuState(ctx);
    if (state.t !== 'book_res') {
      return;
    }
    const m = text.match(/^(\d+)\.\s/);
    if (!m) {
      return;
    }
    const idx = Number(m[1]) - 1;
    const chatId = await this.resolveActiveGroupChatId(ctx);
    if (chatId == null) {
      return;
    }
    const admin = await this.isAdminInContextGroup(ctx, chatId);
    const list = await this.resourcesForBookingUi(chatId, admin);
    const r = list[idx];
    if (!r) {
      await ctx.reply(this.botT(this.kb().lang, 'book.pickNumberFromList'));
      return;
    }
    const comm = await this.community.findByTelegramChatId(chatId);
    if (!comm) {
      return;
    }
    if (!(await this.ensureParticipantBookingWindowOpen(ctx, chatId, comm))) {
      return;
    }
    const sportKinds = this.resourceSportKindCodes(r);
    if (sportKinds.length <= 1) {
      this.pendingBookSportResourceByUser.delete(ctx.from!.id);
      this.setMenuState(ctx, {
        t: 'book_day',
        resourceId: r.id,
        sportKindCode: sportKinds[0],
      });
      await ctx.reply(
        this.botT(this.kb().lang, 'book.pickDay'),
        this.dayPickReplyMarkup(),
      );
      return;
    }
    this.pendingBookSportResourceByUser.set(ctx.from!.id, r.id);
    this.setMenuState(ctx, { t: 'book_sport' });
    await ctx.reply(
      this.botT(this.kb().lang, 'book.pickSport'),
      this.sportPickReplyMarkup(sportKinds),
    );
  }

  private async handleBookSportPick(ctx: Context, text: string) {
    const state = this.getMenuState(ctx);
    if (state.t !== 'book_sport') {
      return;
    }
    const chatId = await this.resolveActiveGroupChatId(ctx);
    if (chatId == null) {
      return;
    }
    const comm = await this.community.findByTelegramChatId(chatId);
    if (!comm) {
      return;
    }
    const kindCode = sportLabelToCodeMap(this.i18n, this.kb().lang).get(text);
    if (!kindCode) {
      return;
    }
    const admin = await this.isAdminInContextGroup(ctx, chatId);
    const resourceId = this.pendingBookSportResourceByUser.get(ctx.from!.id);
    if (!resourceId) {
      return;
    }
    const list = await this.resourcesForBookingUi(chatId, admin);
    const resource = list.find((x) => x.id === resourceId);
    if (!resource) {
      await ctx.reply(
        this.botT(this.kb().lang, 'book.noResourcesAskAdmin'),
        await this.mainMenuReplyMarkup(ctx),
      );
      return;
    }
    if (!(await this.ensureParticipantBookingWindowOpen(ctx, chatId, comm))) {
      return;
    }
    const skipDayOffset = this.pendingBookDayOffsetAfterSportByUser.get(
      ctx.from!.id,
    );
    this.pendingBookSportResourceByUser.delete(ctx.from!.id);
    if (skipDayOffset !== undefined) {
      this.pendingBookDayOffsetAfterSportByUser.delete(ctx.from!.id);
      await this.goToBookHourFromDayOffset(ctx, {
        resourceId: resource.id,
        dayOffset: skipDayOffset,
        sportKindCode: kindCode,
      });
      return;
    }
    this.setMenuState(ctx, {
      t: 'book_day',
      resourceId: resource.id,
      sportKindCode: kindCode,
    });
    await ctx.reply(
      this.botT(this.kb().lang, 'book.pickDay'),
      this.dayPickReplyMarkup(),
    );
  }

  private async handleGridResourcePick(ctx: Context, text: string) {
    const m = text.match(/^(\d+)\.\s/);
    if (!m) {
      return;
    }
    const idx = Number(m[1]) - 1;
    const chatId = await this.resolveActiveGroupChatId(ctx);
    if (chatId == null) {
      return;
    }
    const admin = await this.isAdminInContextGroup(ctx, chatId);
    const list = await this.resourcesForBookingUi(chatId, admin);
    const r = list[idx];
    if (!r) {
      await ctx.reply(this.botT(this.kb().lang, 'book.pickNumberFromList'));
      return;
    }
    this.setMenuState(ctx, { t: 'grid_day', resourceId: r.id });
    await ctx.reply(
      this.botT(this.kb().lang, 'book.pickDayGrid'),
      this.gridDayReplyMarkup(),
    );
  }

  private async goToBookHourFromDayOffset(
    ctx: Context,
    params: {
      resourceId: string;
      dayOffset: 0 | 1;
      sportKindCode?: SportKindCode;
    },
  ): Promise<void> {
    const chatId = await this.resolveActiveGroupChatId(ctx);
    if (chatId == null) {
      return;
    }
    const admin = await this.isAdminInContextGroup(ctx, chatId);
    const starts = await this.booking.getAvailableStartSlots({
      resourceId: params.resourceId,
      telegramChatId: chatId,
      dayOffset: params.dayOffset,
      telegramGroupAdmin: admin,
      telegramUserId: ctx.from?.id,
    });
    if (starts.length === 0) {
      this.resetMenuState(ctx);
      await ctx.reply(
        this.botT(this.kb().lang, 'book.noFreeIntervals'),
        await this.mainMenuReplyMarkup(ctx),
      );
      return;
    }
    this.setMenuState(ctx, {
      t: 'book_hour',
      resourceId: params.resourceId,
      dayOffset: params.dayOffset,
      ...(params.sportKindCode !== undefined
        ? { sportKindCode: params.sportKindCode }
        : {}),
    });
    await ctx.reply(
      params.dayOffset === 0
        ? this.botT(this.kb().lang, 'book.pickStartToday')
        : this.botT(this.kb().lang, 'book.pickStartTomorrow'),
      this.hoursPickReplyMarkup(starts),
    );
  }

  private async handleBookDayPick(
    ctx: Context,
    text: string,
    state: Extract<MenuState, { t: 'book_day' }>,
  ) {
    let dayOffset: 0 | 1 | undefined;
    if (text === this.kb().menuDayToday) {
      dayOffset = 0;
    } else if (text === this.kb().menuDayTomorrow) {
      dayOffset = 1;
    }
    if (dayOffset === undefined) {
      return;
    }
    await this.goToBookHourFromDayOffset(ctx, {
      resourceId: state.resourceId,
      dayOffset,
      sportKindCode: state.sportKindCode,
    });
  }

  /**
   * One-hour daily cap: only 60m fits and is allowed — skip duration picker (forward and back from «looking»).
   */
  private async bookingSkipsDurationOneHourDailyLimit(
    ctx: Context,
    chatId: bigint,
    admin: boolean,
    p: {
      resourceId: string;
      dayOffset: 0 | 1;
      hour: number;
      startMinute: number;
    },
    durs: BookingDurationMinutes[],
  ): Promise<boolean> {
    if (admin || !ctx.from || durs.length !== 1 || durs[0] !== 60) {
      return false;
    }
    const cap = await this.booking.getConfiguredDailyBookingLimitCapMinutes({
      resourceId: p.resourceId,
      telegramChatId: chatId,
      dayOffset: p.dayOffset,
      telegramGroupAdmin: admin,
    });
    return cap === 60;
  }

  private async handleBookHourPick(
    ctx: Context,
    text: string,
    state: Extract<MenuState, { t: 'book_hour' }>,
  ) {
    const hm = text.match(/^(\d{1,2}):(00|30)$/);
    if (!hm) {
      return;
    }
    const hour = Number(hm[1]);
    const startMinute = Number(hm[2]);
    const chatId = await this.resolveActiveGroupChatId(ctx);
    if (chatId == null) {
      return;
    }
    const admin = await this.isAdminInContextGroup(ctx, chatId);
    const starts = await this.booking.getAvailableStartSlots({
      resourceId: state.resourceId,
      telegramChatId: chatId,
      dayOffset: state.dayOffset,
      telegramGroupAdmin: admin,
      telegramUserId: ctx.from?.id,
    });
    const picked = starts.find(
      (s) => s.hour === hour && s.minute === startMinute,
    );
    if (!picked) {
      await ctx.reply(this.botT(this.kb().lang, 'book.slotUnavailable'));
      return;
    }
    const durs = await this.booking.getAvailableDurationsMinutes({
      resourceId: state.resourceId,
      telegramChatId: chatId,
      dayOffset: state.dayOffset,
      startHour: hour,
      startMinute,
      telegramGroupAdmin: admin,
      telegramUserId: ctx.from!.id,
    });
    if (durs.length === 0) {
      this.setMenuState(ctx, {
        t: 'book_day',
        resourceId: state.resourceId,
        ...(state.sportKindCode !== undefined
          ? { sportKindCode: state.sportKindCode }
          : {}),
      });
      await ctx.reply(
        this.botT(this.kb().lang, 'book.noDurationForThisSlot'),
        this.dayPickReplyMarkup(),
      );
      return;
    }
    if (
      await this.bookingSkipsDurationOneHourDailyLimit(
        ctx,
        chatId,
        admin,
        {
          resourceId: state.resourceId,
          dayOffset: state.dayOffset,
          hour,
          startMinute,
        },
        durs,
      )
    ) {
      this.setMenuState(ctx, {
        t: 'book_looking',
        resourceId: state.resourceId,
        dayOffset: state.dayOffset,
        hour,
        startMinute,
        durationMinutes: 60,
        ...(state.sportKindCode !== undefined
          ? { sportKindCode: state.sportKindCode }
          : {}),
      });
      await ctx.reply(
        this.botT(this.kb().lang, 'book.askLookingForPartners'),
        this.lookingForPlayersReplyMarkup(),
      );
      return;
    }
    this.setMenuState(ctx, {
      t: 'book_dur',
      resourceId: state.resourceId,
      dayOffset: state.dayOffset,
      hour,
      startMinute,
      ...(state.sportKindCode !== undefined
        ? { sportKindCode: state.sportKindCode }
        : {}),
    });
    await ctx.reply(
      this.botT(this.kb().lang, 'book.pickDuration', {
        time: `${String(hour).padStart(2, '0')}:${String(startMinute).padStart(2, '0')}`,
      }),
      this.durationPickReplyMarkup(durs),
    );
  }

  private async finalizeGroupBooking(
    ctx: Context,
    flow: {
      resourceId: string;
      dayOffset: 0 | 1;
      hour: number;
      startMinute: number;
      sportKindCode?: SportKindCode;
      durationMinutes: BookingDurationMinutes;
    },
    players: { isLookingForPlayers: boolean; requiredPlayers: number },
  ) {
    const chatId = await this.resolveActiveGroupChatId(ctx);
    if (chatId == null) {
      return;
    }
    const admin = await this.isAdminInContextGroup(ctx, chatId);
    const lbl = this.kb();
    try {
      const { resourceId, startTime, endTime, resourceName, timeZone } =
        await this.booking.createBooking({
          resourceId: flow.resourceId,
          telegramChatId: chatId,
          from: {
            id: ctx.from!.id,
            username: ctx.from!.username,
            first_name: ctx.from!.first_name,
          },
          dayOffset: flow.dayOffset,
          startHour: flow.hour,
          startMinute: flow.startMinute,
          ...(flow.sportKindCode !== undefined
            ? { sportKindCode: flow.sportKindCode }
            : {}),
          durationMinutes: flow.durationMinutes,
          telegramGroupAdmin: admin,
          isLookingForPlayers: players.isLookingForPlayers,
          requiredPlayers: players.requiredPlayers,
          displayLocale: lbl.lang,
        });
      const a = formatInTimeZone(startTime, timeZone, 'HH:mm');
      const z = formatInTimeZone(endTime, timeZone, 'HH:mm');
      const looking =
        players.isLookingForPlayers && players.requiredPlayers > 0
          ? this.botT(lbl.lang, 'book.bookingAddedLooking', {
              n: String(players.requiredPlayers),
            })
          : '';
      const day = formatInTimeZone(startTime, timeZone, 'dd.MM.yyyy');
      const whoRaw = ctx.from?.username?.trim()
        ? ctx.from.username.trim()
        : (ctx.from?.first_name?.trim() ??
          this.botT(lbl.lang, 'setup.adminPlayerFallback'));
      const sportLabel = this.bookingSportLabel(flow.sportKindCode);
      const lookingBroadcast =
        players.isLookingForPlayers && players.requiredPlayers > 0
          ? this.botT(lbl.lang, 'book.groupBroadcastLooking', {
              n: String(players.requiredPlayers),
            })
          : '';
      const groupBroadcast = this.botT(lbl.lang, 'book.groupBroadcastNew', {
        resource: resourceName,
        day,
        timeFrom: a,
        timeTo: z,
        tz: timeZone,
        who: whoRaw,
        sport: sportLabel,
        looking: lookingBroadcast,
      });
      await this.broadcastToResourceGroups(ctx, resourceId, groupBroadcast);
      await this.replyWithMainMenu(
        ctx,
        this.botT(lbl.lang, 'book.bookingAdded', {
          resource: resourceName,
          timeFrom: a,
          timeTo: z,
          looking,
        }),
      );
    } catch (e) {
      const lang = this.kb().lang;
      if (e instanceof SlotTakenError) {
        const starts = await this.booking.getAvailableStartSlots({
          resourceId: flow.resourceId,
          telegramChatId: chatId,
          dayOffset: flow.dayOffset,
          telegramGroupAdmin: admin,
          telegramUserId: ctx.from?.id,
        });
        if (starts.length === 0) {
          this.resetMenuState(ctx);
          await ctx.reply(
            this.botT(lang, 'book.noFreeIntervals'),
            await this.mainMenuReplyMarkup(ctx),
          );
          return;
        }
        this.setMenuState(ctx, {
          t: 'book_hour',
          resourceId: flow.resourceId,
          dayOffset: flow.dayOffset,
          ...(flow.sportKindCode !== undefined
            ? { sportKindCode: flow.sportKindCode }
            : {}),
        });
        await ctx.reply(this.botT(lang, 'book.slotTaken'));
        await ctx.reply(
          flow.dayOffset === 0
            ? this.botT(lang, 'book.pickStartToday')
            : this.botT(lang, 'book.pickStartTomorrow'),
          this.hoursPickReplyMarkup(starts),
        );
        return;
      }
      if (e instanceof SlotInPastError) {
        this.setMenuState(ctx, {
          t: 'book_day',
          resourceId: flow.resourceId,
          ...(flow.sportKindCode !== undefined
            ? { sportKindCode: flow.sportKindCode }
            : {}),
        });
        await ctx.reply(
          this.botT(lang, 'book.timeSlotInPastPickDay'),
          this.dayPickReplyMarkup(),
        );
        return;
      }
      if (e instanceof BookingWindowClosedError) {
        await this.replyWithMainMenu(
          ctx,
          this.botT(lang, 'book.bookingWindowClosed'),
        );
        return;
      }
      if (e instanceof UserDailyBookingLimitExceededError) {
        await this.replyWithMainMenu(
          ctx,
          this.botT(lang, 'book.dailyLimitExceeded'),
        );
        return;
      }
      this.logger.error(e instanceof Error ? e.message : e);
      await this.replyWithMainMenu(
        ctx,
        this.botT(lang, 'book.createBookingFailed'),
      );
    }
  }

  private async handleBookDurPick(
    ctx: Context,
    text: string,
    state: Extract<MenuState, { t: 'book_dur' }>,
  ) {
    const durationMinutes = durationMinutesFromReplyLabel(this.kb(), text);
    if (!durationMinutes) {
      return;
    }
    this.setMenuState(ctx, {
      t: 'book_looking',
      resourceId: state.resourceId,
      dayOffset: state.dayOffset,
      hour: state.hour,
      startMinute: state.startMinute,
      durationMinutes,
      ...(state.sportKindCode !== undefined
        ? { sportKindCode: state.sportKindCode }
        : {}),
    });
    await ctx.reply(
      this.botT(this.kb().lang, 'book.askLookingForPartners'),
      this.lookingForPlayersReplyMarkup(),
    );
  }

  private async handleBookLookingPick(
    ctx: Context,
    text: string,
    state: Extract<MenuState, { t: 'book_looking' }>,
  ) {
    if (text === this.kb().bookLookingNo) {
      await this.finalizeGroupBooking(ctx, state, {
        isLookingForPlayers: false,
        requiredPlayers: 0,
      });
      return;
    }
    if (text === this.kb().bookLookingYes) {
      this.setMenuState(ctx, {
        t: 'book_players',
        resourceId: state.resourceId,
        dayOffset: state.dayOffset,
        hour: state.hour,
        startMinute: state.startMinute,
        durationMinutes: state.durationMinutes,
        ...(state.sportKindCode !== undefined
          ? { sportKindCode: state.sportKindCode }
          : {}),
      });
      await ctx.reply(
        this.botT(this.kb().lang, 'book.askPlayersCount'),
        this.playersCountPromptReplyMarkup(),
      );
      return;
    }
    await ctx.reply(
      this.botT(this.kb().lang, 'book.lookingTapYesNo'),
      this.lookingForPlayersReplyMarkup(),
    );
  }

  private async handleBookPlayersPick(
    ctx: Context,
    text: string,
    state: Extract<MenuState, { t: 'book_players' }>,
  ) {
    const raw = text.trim();
    if (!/^\d+$/.test(raw)) {
      await ctx.reply(
        this.botT(this.kb().lang, 'book.playersCountInvalid'),
        this.playersCountPromptReplyMarkup(),
      );
      return;
    }
    const n = Number(raw);
    if (n < 1 || n > 50) {
      await ctx.reply(
        this.botT(this.kb().lang, 'book.playersCountInvalid'),
        this.playersCountPromptReplyMarkup(),
      );
      return;
    }
    await this.finalizeGroupBooking(ctx, state, {
      isLookingForPlayers: true,
      requiredPlayers: n,
    });
  }

  private async startBookFromGridDay(
    ctx: Context,
    state: Extract<MenuState, { t: 'grid_day' }>,
  ): Promise<void> {
    if (state.viewedDayOffset === undefined) {
      await this.handleMainMenuButtons(ctx, this.kb().menuBook);
      return;
    }
    const chatId = await this.resolveActiveGroupChatId(ctx);
    if (chatId == null) {
      return;
    }
    const isAdminInGroup = await this.isAdminInContextGroup(ctx, chatId);
    if (!isAdminInGroup) {
      const canProceed = await this.ensureParticipantGroupOnboarding(
        ctx,
        chatId,
      );
      if (!canProceed) {
        await ctx.reply(
          this.botT(this.kb().lang, 'onboarding.needLanguageRulesDm'),
          await this.mainMenuReplyMarkup(ctx),
        );
        return;
      }
    }
    const comm = await this.community.findByTelegramChatId(chatId);
    const admin = isAdminInGroup;
    const visible = comm ? this.bookableResources(comm.resources, admin) : [];
    if (!comm || visible.length === 0) {
      await ctx.reply(
        this.botT(this.kb().lang, 'book.platformNotConfigured'),
        await this.mainMenuReplyMarkup(ctx),
      );
      return;
    }
    if (!admin) {
      if (!(await this.ensureParticipantBookingWindowOpen(ctx, chatId, comm))) {
        return;
      }
    }
    const list = await this.resourcesForBookingUi(chatId, admin);
    const resource = list.find((x) => x.id === state.resourceId);
    if (!resource) {
      await this.handleMainMenuButtons(ctx, this.kb().menuBook);
      return;
    }
    const dayOffset = state.viewedDayOffset;
    const sportKinds = this.resourceSportKindCodes(resource);
    if (sportKinds.length <= 1) {
      await this.goToBookHourFromDayOffset(ctx, {
        resourceId: resource.id,
        dayOffset,
        sportKindCode: sportKinds[0],
      });
      return;
    }
    this.pendingBookSportResourceByUser.set(ctx.from!.id, resource.id);
    this.pendingBookDayOffsetAfterSportByUser.set(ctx.from!.id, dayOffset);
    this.setMenuState(ctx, { t: 'book_sport' });
    await ctx.reply(
      this.botT(this.kb().lang, 'book.pickSport'),
      this.sportPickReplyMarkup(sportKinds),
    );
  }

  private async handleGridDayPick(
    ctx: Context,
    text: string,
    state: Extract<MenuState, { t: 'grid_day' }>,
  ) {
    if (text === this.kb().menuBook) {
      await this.startBookFromGridDay(ctx, state);
      return;
    }
    let dayOffset: 0 | 1 | undefined;
    if (text === this.kb().menuDayToday) {
      dayOffset = 0;
    } else if (text === this.kb().menuDayTomorrow) {
      dayOffset = 1;
    }
    if (dayOffset === undefined) {
      return;
    }
    const chatId = await this.resolveActiveGroupChatId(ctx);
    if (chatId == null) {
      return;
    }
    const admin = await this.isAdminInContextGroup(ctx, chatId);
    const gridText = await this.booking.buildDayGridText({
      resourceId: state.resourceId,
      telegramChatId: chatId,
      dayOffset,
      telegramGroupAdmin: admin,
      displayLocale: this.kb().lang,
    });
    this.setMenuState(ctx, {
      t: 'grid_day',
      resourceId: state.resourceId,
      viewedDayOffset: dayOffset,
    });
    await ctx.reply(gridText, this.gridDayReplyMarkup());
  }

  private async sendBookingCancellationAlerts(
    ctx: Context,
    notify: {
      recipientTelegramIds: number[];
      cancelNoticeText: string;
      resourceId: string;
      resourceName: string;
      timeZone: string;
      startTime: Date;
      endTime: Date;
      sportKindCode: SportKindCode;
    },
  ) {
    await this.sendMessageBatchBestEffort(
      ctx.telegram,
      notify.recipientTelegramIds,
      notify.cancelNoticeText,
      'dm',
      (uid, e) => {
        this.logger.warn(
          `booking_cancel_dm failed user=${uid}: ${e instanceof Error ? e.message : String(e)}`,
        );
      },
    );
    const cDay = formatInTimeZone(
      notify.startTime,
      notify.timeZone,
      'dd.MM.yyyy',
    );
    const cA = formatInTimeZone(notify.startTime, notify.timeZone, 'HH:mm');
    const cZ = formatInTimeZone(notify.endTime, notify.timeZone, 'HH:mm');
    const lang = await this.langForCtx(ctx);
    const rawWho = ctx.from?.username?.trim()
      ? ctx.from.username.trim()
      : (ctx.from?.first_name?.trim() ??
        this.botT(lang, 'setup.adminPlayerFallback'));
    const cancelledBy = rawWho.replace(/^@+/, '');
    const sportLabel = this.botT(lang, `sport.${notify.sportKindCode}`);
    const cancelBroadcast = this.botT(lang, 'book.groupBroadcastCancelled', {
      resource: notify.resourceName,
      day: cDay,
      timeFrom: cA,
      timeTo: cZ,
      tz: notify.timeZone,
      sport: sportLabel,
      by: cancelledBy,
    });
    await this.broadcastToResourceGroups(
      ctx,
      notify.resourceId,
      cancelBroadcast,
    );
  }

  private async handleListCancel(
    ctx: Context,
    text: string,
    state: Extract<MenuState, { t: 'list' }>,
  ) {
    const idx = state.rowLabels.indexOf(text);
    if (idx === -1) {
      return;
    }
    const bookingId = state.bookingIds[idx];
    if (!bookingId) {
      return;
    }
    const chatId = await this.resolveActiveGroupChatId(ctx);
    if (chatId == null) {
      return;
    }
    try {
      const notify = await this.booking.cancelBooking({
        bookingId,
        telegramChatId: chatId,
        telegramUserId: ctx.from!.id,
        noticeLocale: this.kb().lang,
      });
      await this.sendBookingCancellationAlerts(ctx, notify);
      await this.replyWithMainMenu(
        ctx,
        this.botT(this.kb().lang, 'book.bookingCancelled'),
      );
    } catch (e) {
      if (e instanceof BookingNotFoundError) {
        await this.replyWithMainMenu(
          ctx,
          this.botT(this.kb().lang, 'book.listCancelNotFound'),
        );
        return;
      }
      throw e;
    }
  }

  private escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private telegramUserHtmlLink(telegramUserId: number, label: string): string {
    const safe = this.escapeHtml(label);
    return `<a href="tg://user?id=${telegramUserId}">${safe}</a>`;
  }

  private lookingJoinParticipantLabel(
    lang: string,
    from: NonNullable<Context['from']>,
  ): string {
    const u = from.username?.trim();
    if (u) {
      return `@${u}`;
    }
    const fn = from.first_name?.trim();
    if (fn) {
      return fn;
    }
    return this.botT(lang, 'setup.adminPlayerFallback');
  }

  private formatLookingSlotDmText(params: {
    dm: {
      resourceName: string;
      address: string | null;
      timeZone: string;
      startTime: Date;
      endTime: Date;
      sportKindCode: SportKindCode;
    };
    yourPeopleCount: number;
    organizer: {
      telegramUserId: number;
      storedDisplayName: string | null;
    };
  }): string {
    const { dm, yourPeopleCount, organizer } = params;
    const lang = this.kb().lang;
    const day = formatInTimeZone(dm.startTime, dm.timeZone, 'dd.MM.yyyy');
    const a = formatInTimeZone(dm.startTime, dm.timeZone, 'HH:mm');
    const z = formatInTimeZone(dm.endTime, dm.timeZone, 'HH:mm');
    const addrRaw = dm.address?.trim()
      ? dm.address.trim()
      : this.botT(lang, 'slotDm.addressUnknown');
    const peopleLine =
      yourPeopleCount === 1
        ? this.botT(lang, 'slotDm.peopleYou')
        : this.botT(lang, 'slotDm.peopleMany', {
            n: String(yourPeopleCount),
          });
    const when = `${day} ${a}–${z} (${dm.timeZone})`;
    const orgLabel =
      organizer.storedDisplayName?.trim() ||
      this.botT(lang, 'slotDm.organizerUnknown');
    const organizerLine = this.botT(lang, 'slotDm.organizerLine', {
      link: this.telegramUserHtmlLink(organizer.telegramUserId, orgLabel),
    });
    return this.botT(lang, 'slotDm.full', {
      organizerLine,
      peopleLine: this.escapeHtml(peopleLine),
      resource: this.escapeHtml(dm.resourceName),
      address: this.escapeHtml(addrRaw),
      when: this.escapeHtml(when),
      sport: this.escapeHtml(this.botT(lang, `sport.${dm.sportKindCode}`)),
    });
  }

  private async sendLookingSlotDm(
    ctx: Context,
    bookingId: string,
    joinResult: {
      previousDmMessageId: number | null;
      organizer: {
        telegramUserId: number;
        storedDisplayName: string | null;
      };
      dm: {
        resourceName: string;
        address: string | null;
        timeZone: string;
        startTime: Date;
        endTime: Date;
        sportKindCode: SportKindCode;
      };
      yourPeopleCount: number;
    },
  ) {
    if (!ctx.from) {
      return;
    }
    const userId = ctx.from.id;
    const text = this.formatLookingSlotDmText({
      dm: joinResult.dm,
      yourPeopleCount: joinResult.yourPeopleCount,
      organizer: joinResult.organizer,
    });
    let sentId: number;
    try {
      const sent = await ctx.telegram.sendMessage(userId, text, {
        parse_mode: 'HTML',
      });
      sentId = sent.message_id;
    } catch (e) {
      this.logger.warn(
        `looking slot DM failed user=${userId}: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }
    await this.booking.setLookingParticipantDmMessageId({
      bookingId,
      telegramUserId: userId,
      messageId: sentId,
    });
    if (joinResult.previousDmMessageId != null) {
      try {
        await ctx.telegram.deleteMessage(
          userId,
          joinResult.previousDmMessageId,
        );
      } catch {
        /* уже удалено или нет прав */
      }
    }
  }

  private async notifyOrganizerOfLookingJoin(params: {
    ctx: Context;
    groupChatId: bigint;
    joinResult: {
      organizer: {
        telegramUserId: number;
        storedDisplayName: string | null;
      };
      dm: {
        resourceName: string;
        address: string | null;
        timeZone: string;
        startTime: Date;
        endTime: Date;
        sportKindCode: SportKindCode;
      };
      yourPeopleCount: number;
    };
    joiner: NonNullable<Context['from']>;
  }) {
    const { organizer, dm, yourPeopleCount } = params.joinResult;
    if (params.joiner.id === organizer.telegramUserId) {
      return;
    }
    const lang = await this.langForDmUser(
      organizer.telegramUserId,
      params.groupChatId,
    );
    const participantLabel = this.lookingJoinParticipantLabel(
      lang,
      params.joiner,
    );
    const participantLink = this.telegramUserHtmlLink(
      params.joiner.id,
      participantLabel,
    );
    const peopleThemLine =
      yourPeopleCount === 1
        ? this.botT(lang, 'slotDm.peopleThemOne')
        : this.botT(lang, 'slotDm.peopleThemMany', {
            n: String(yourPeopleCount),
          });
    const day = formatInTimeZone(dm.startTime, dm.timeZone, 'dd.MM.yyyy');
    const a = formatInTimeZone(dm.startTime, dm.timeZone, 'HH:mm');
    const z = formatInTimeZone(dm.endTime, dm.timeZone, 'HH:mm');
    const addrRaw = dm.address?.trim()
      ? dm.address.trim()
      : this.botT(lang, 'slotDm.addressUnknown');
    const when = `${day} ${a}–${z} (${dm.timeZone})`;
    const text = this.botT(lang, 'slotDm.organizerJoinNotify', {
      participantLink,
      peopleThemLine: this.escapeHtml(peopleThemLine),
      resource: this.escapeHtml(dm.resourceName),
      address: this.escapeHtml(addrRaw),
      when: this.escapeHtml(when),
      sport: this.escapeHtml(this.botT(lang, `sport.${dm.sportKindCode}`)),
    });
    try {
      await params.ctx.telegram.sendMessage(organizer.telegramUserId, text, {
        parse_mode: 'HTML',
      });
    } catch (e) {
      this.logger.warn(
        `organizer looking-join DM failed user=${organizer.telegramUserId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private async handleFreeSlotJoin(
    ctx: Context,
    text: string,
    state: Extract<MenuState, { t: 'free_slots' }>,
  ) {
    const idx = state.rowLabels.indexOf(text);
    if (idx === -1) {
      return;
    }
    const bookingId = state.bookingIds[idx];
    if (!bookingId) {
      return;
    }
    const chatId = await this.resolveActiveGroupChatId(ctx);
    if (chatId == null) {
      return;
    }
    let joinResult: Awaited<
      ReturnType<BookingService['volunteerForLookingSlot']>
    >;
    try {
      joinResult = await this.booking.volunteerForLookingSlot({
        bookingId,
        telegramChatId: chatId,
        telegramUserId: ctx.from!.id,
      });
    } catch (e) {
      if (e instanceof BookingNotFoundError) {
        const rows = await this.booking.listOpenLookingSlots({
          telegramChatId: chatId,
        });
        if (rows.length === 0) {
          await this.replyWithMainMenu(
            ctx,
            this.botT(this.kb().lang, 'freeSlot.gameFull'),
          );
          return;
        }
        const listItems = rows.map((r) => ({
          startTime: r.startTime,
          endTime: r.endTime,
          timeZone: r.resource.timeZone,
          resourceName: r.resource.name,
          sportKindCode: r.sportKindCode,
          playersNeeded: r.requiredPlayers,
        }));
        const rowLabels = listItems.map((item) =>
          this.buildFreeSlotButtonLabel(item),
        );
        this.setMenuState(ctx, {
          t: 'free_slots',
          bookingIds: rows.map((r) => r.id),
          rowLabels,
        });
        await ctx.reply(
          this.botT(this.kb().lang, 'freeSlot.listStale'),
          this.freeSlotsReplyMarkup(listItems),
        );
        return;
      }
      throw e;
    }

    await this.sendLookingSlotDm(ctx, bookingId, joinResult);
    await this.notifyOrganizerOfLookingJoin({
      ctx,
      groupChatId: chatId,
      joinResult,
      joiner: ctx.from!,
    });

    const rows = await this.booking.listOpenLookingSlots({
      telegramChatId: chatId,
    });
    if (rows.length === 0) {
      await this.replyWithMainMenu(
        ctx,
        this.botT(this.kb().lang, 'freeSlot.joinedNoMoreOpenings'),
      );
      return;
    }
    const listItems = rows.map((r) => ({
      startTime: r.startTime,
      endTime: r.endTime,
      timeZone: r.resource.timeZone,
      resourceName: r.resource.name,
      sportKindCode: r.sportKindCode,
      playersNeeded: r.requiredPlayers,
    }));
    const rowLabels = listItems.map((item) =>
      this.buildFreeSlotButtonLabel(item),
    );
    this.setMenuState(ctx, {
      t: 'free_slots',
      bookingIds: rows.map((r) => r.id),
      rowLabels,
    });
    await ctx.reply(
      this.botT(this.kb().lang, 'freeSlot.joinedSeeDmOrMenu'),
      this.freeSlotsReplyMarkup(listItems),
    );
  }

  private whPickDayReplyMarkup() {
    return Markup.keyboard([
      ...kbRowsPaired([...this.whIsoLabels()]),
      [this.kb().menuWhDoneToMenu],
    ])
      .resize()
      .persistent(true);
  }

  private whDayActionsReplyMarkup() {
    return Markup.keyboard([
      [this.kb().whDayClosed, this.kb().whDaySetHours],
      [this.kb().menuBack],
    ])
      .resize()
      .persistent(true);
  }

  private async handleWhDmText(ctx: Context, text: string) {
    const uid = ctx.from!.id;
    const st = this.whDmStateByUser.get(uid);
    if (!st) {
      return;
    }

    const adminOk = (g: bigint) => isUserAdminOfGroupChat(ctx.telegram, g, uid);

    const mainKb = async (g: bigint) =>
      this.dmAdminReplyMarkup(ctx.telegram, g, uid);

    if (st.kind === 'offer') {
      if (text === this.kb().menuWhSkip || text === this.kb().menuMain) {
        this.whDmStateByUser.delete(uid);
        await ctx.reply(
          text === this.kb().menuWhSkip
            ? this.botT(this.kb().lang, 'whDm.allDaysUnchanged')
            : this.botT(this.kb().lang, 'whDm.menuPlain'),
          await mainKb(st.groupChatId),
        );
        return;
      }
      if (text === this.kb().menuWhPerDay) {
        if (!(await adminOk(st.groupChatId))) {
          this.whDmStateByUser.delete(uid);
          await ctx.reply(
            this.botT(this.kb().lang, 'whDm.noAdmin'),
            await mainKb(st.groupChatId),
          );
          return;
        }
        this.whDmStateByUser.set(uid, {
          kind: 'pick_day',
          groupChatId: st.groupChatId,
          resourceId: st.resourceId,
        });
        await ctx.reply(
          this.botT(this.kb().lang, 'whDm.pickWeekdayPreamble'),
          this.whPickDayReplyMarkup(),
        );
        return;
      }
      await ctx.reply(this.botT(this.kb().lang, 'whDm.skipOrPerDayFirst'));
      return;
    }

    if (st.kind === 'pick_day') {
      if (text === this.kb().menuWhDoneToMenu || text === this.kb().menuMain) {
        this.whDmStateByUser.delete(uid);
        await ctx.reply(
          this.botT(this.kb().lang, 'whDm.menuPlain'),
          await mainKb(st.groupChatId),
        );
        return;
      }
      const isoIdx = this.whIsoLabels().indexOf(text);
      if (isoIdx >= 0) {
        if (!(await adminOk(st.groupChatId))) {
          this.whDmStateByUser.delete(uid);
          await ctx.reply(
            this.botT(this.kb().lang, 'whDm.noPermission'),
            await mainKb(st.groupChatId),
          );
          return;
        }
        const weekday = isoIdx + 1;
        this.whDmStateByUser.set(uid, {
          kind: 'day_menu',
          groupChatId: st.groupChatId,
          resourceId: st.resourceId,
          weekday,
        });
        const res = await this.community.getResourceWorkingHoursForChat({
          telegramChatId: st.groupChatId,
          resourceId: st.resourceId,
        });
        const row = res?.workingHours.find((w) => w.weekday === weekday);
        const dayName = this.whIsoLabels()[isoIdx];
        const body =
          `${dayName}.\n${this.whDayStatusLine(row)}\n\n` +
          this.botT(this.kb().lang, 'whDm.dayRowHint');
        await ctx.reply(body, this.whDayActionsReplyMarkup());
        return;
      }
      await ctx.reply(this.botT(this.kb().lang, 'whDm.pickDayOrDone'));
      return;
    }

    if (st.kind === 'day_menu') {
      if (text === this.kb().menuBack) {
        this.whDmStateByUser.set(uid, {
          kind: 'pick_day',
          groupChatId: st.groupChatId,
          resourceId: st.resourceId,
        });
        await ctx.reply(
          this.botT(this.kb().lang, 'whDm.pickWeekday'),
          this.whPickDayReplyMarkup(),
        );
        return;
      }
      if (text === this.kb().whDayClosed) {
        if (!(await adminOk(st.groupChatId))) {
          this.whDmStateByUser.delete(uid);
          await ctx.reply(
            this.botT(this.kb().lang, 'whDm.noPermission'),
            await mainKb(st.groupChatId),
          );
          return;
        }
        try {
          await this.community.updateResourceWeekdayHours({
            telegramChatId: st.groupChatId,
            resourceId: st.resourceId,
            weekday: st.weekday,
            isClosed: true,
          });
        } catch (e) {
          this.logger.error(e instanceof Error ? e.message : e);
          await ctx.reply(this.botT(this.kb().lang, 'whDm.saveFailed'));
          return;
        }
        this.whDmStateByUser.set(uid, {
          kind: 'pick_day',
          groupChatId: st.groupChatId,
          resourceId: st.resourceId,
        });
        await ctx.reply(
          this.botT(this.kb().lang, 'whDm.dayClosedSaved'),
          this.whPickDayReplyMarkup(),
        );
        return;
      }
      if (text === this.kb().whDaySetHours) {
        if (!(await adminOk(st.groupChatId))) {
          this.whDmStateByUser.delete(uid);
          await ctx.reply(
            this.botT(this.kb().lang, 'whDm.noPermission'),
            await mainKb(st.groupChatId),
          );
          return;
        }
        this.whDmStateByUser.delete(uid);
        this.whPerDayEditByUser.set(uid, {
          groupChatId: st.groupChatId,
          resourceId: st.resourceId,
          weekday: st.weekday,
          phase: 'start',
        });
        await ctx.reply(
          this.botT(this.kb().lang, 'setup.whPerDayStartPrompt', {
            day: this.whIsoLabels()[st.weekday - 1],
          }),
          this.setupStartHourReplyMarkup(),
        );
        return;
      }
      await ctx.reply(this.botT(this.kb().lang, 'whDm.tapBottomButton'));
    }
  }

  private async handleWhPerDayEditText(
    ctx: Context,
    text: string,
    draft: WhPerDayEditDraft,
  ) {
    const uid = ctx.from!.id;
    if (
      text.trim() === this.kb().setupCancel ||
      text === this.kb().menuMain ||
      (text === this.kb().menuBack && draft.phase === 'start')
    ) {
      this.whPerDayEditByUser.delete(uid);
      this.whDmStateByUser.set(uid, {
        kind: 'pick_day',
        groupChatId: draft.groupChatId,
        resourceId: draft.resourceId,
      });
      await ctx.telegram.sendMessage(
        uid,
        this.botT(this.kb().lang, 'whDm.pickWeekday'),
        this.whPickDayReplyMarkup(),
      );
      return;
    }
    if (text === this.kb().menuBack && draft.phase === 'end') {
      draft.phase = 'start';
      delete draft.slotStart;
      this.whPerDayEditByUser.set(uid, draft);
      await ctx.reply(
        this.botT(this.kb().lang, 'setup.whPerDayStartPrompt', {
          day: this.whIsoLabels()[draft.weekday - 1],
        }),
        this.setupStartHourReplyMarkup(),
      );
      return;
    }
    if (draft.phase === 'start') {
      const hm = text.match(/^(\d{1,2}):00$/);
      if (!hm) {
        await ctx.reply(this.botT(this.kb().lang, 'whDm.pickOpeningByButtons'));
        return;
      }
      const hour = Number(hm[1]);
      if (!Number.isInteger(hour) || hour < 0 || hour > 22) {
        await ctx.reply(
          this.botT(this.kb().lang, 'whDm.pickOpeningRangeInline'),
        );
        return;
      }
      draft.slotStart = hour;
      draft.phase = 'end';
      this.whPerDayEditByUser.set(uid, draft);
      await ctx.reply(
        this.botT(this.kb().lang, 'setup.whPerDayEndPrompt', {
          day: this.whIsoLabels()[draft.weekday - 1],
          hour: String(hour).padStart(2, '0'),
        }),
        this.setupClosingHourReplyMarkup(hour),
      );
      return;
    }
    const hm = text.match(/^(\d{1,2}):00$/);
    if (!hm) {
      await ctx.reply(this.botT(this.kb().lang, 'whDm.pickEndByButtons'));
      return;
    }
    const closeHour = Number(hm[1]);
    const start = draft.slotStart;
    if (
      start === undefined ||
      !Number.isInteger(closeHour) ||
      closeHour < 0 ||
      closeHour > 23
    ) {
      return;
    }
    if (closeHour <= start) {
      await ctx.reply(this.botT(this.kb().lang, 'whDm.endAfterStart'));
      return;
    }
    const slotEnd = closeHour - 1;
    try {
      await this.community.updateResourceWeekdayHours({
        telegramChatId: draft.groupChatId,
        resourceId: draft.resourceId,
        weekday: draft.weekday,
        isClosed: false,
        slotStartHour: start,
        slotEndHour: slotEnd,
      });
    } catch (e) {
      this.logger.error(e instanceof Error ? e.message : e);
      await ctx.reply(this.botT(this.kb().lang, 'whDm.genericSaveFailedRetry'));
      return;
    }
    this.whPerDayEditByUser.delete(uid);
    this.whDmStateByUser.set(uid, {
      kind: 'pick_day',
      groupChatId: draft.groupChatId,
      resourceId: draft.resourceId,
    });
    await ctx.telegram.sendMessage(
      uid,
      this.botT(this.kb().lang, 'setup.whPerDaySaved', {
        day: this.whIsoLabels()[draft.weekday - 1],
        start: String(start).padStart(2, '0'),
        done: this.kb().menuWhDoneToMenu,
      }),
      this.whPickDayReplyMarkup(),
    );
  }

  /** ЛС: кнопка «Настройки» — снова открыть мастер для последней группы. */
  @On('text')
  async onPrivateDmSettings(
    @Ctx() ctx: Context,
    @Next() next: () => Promise<void>,
  ) {
    if (
      !ctx.message ||
      !('text' in ctx.message) ||
      !ctx.chat?.id ||
      !ctx.from
    ) {
      return next();
    }
    if (isGroupChat(ctx)) {
      return next();
    }
    const textRaw = ctx.message.text.trim();
    const from = ctx.from;
    const lang = await this.langForCtx(ctx);
    const lbl = this.L(lang);
    if (textRaw !== lbl.menuSetup) {
      return next();
    }

    return this.withBotLabels(lbl, async () => {
      const uid = from.id;
      this.whDmStateByUser.delete(uid);
      this.whPerDayEditByUser.delete(uid);
      this.pendingDmPickerActionByUser.set(uid, 'setup');

      const bridged = this.setupBridgeGroupByUser.get(uid);
      if (bridged) {
        const sk = `${bridged}:${uid}`;
        if (this.setupDrafts.has(sk)) {
          await ctx.reply(
            this.botT(lbl.lang, 'setup.wizardAlreadyOpen', {
              cancel: lbl.setupCancel,
            }),
          );
          return;
        }
        this.setupBridgeGroupByUser.delete(uid);
      }

      const gid = await this.promptGroupPickerInDm(ctx, {
        force: true,
        hint: this.botT(lbl.lang, 'setup.pickGroupForSetup'),
      });
      if (gid == null) {
        return;
      }
      this.pendingDmPickerActionByUser.delete(uid);
      const gidStr = gid.toString();

      if (!(await isUserAdminOfGroupChat(ctx.telegram, BigInt(gidStr), uid))) {
        await ctx.reply(this.botT(lbl.lang, 'setup.adminOnly'));
        return;
      }

      let chatTitle = this.botT(lbl.lang, 'setup.chatTitleFallback');
      try {
        const chat = await ctx.telegram.getChat(gidStr);
        if (chat && 'title' in chat && chat.title) {
          chatTitle = chat.title;
        }
      } catch {
        /* название неизвестно */
      }

      try {
        await this.openSetupDmSession({
          telegram: ctx.telegram,
          from,
          groupChatId: BigInt(gidStr),
          chatTitle,
        });
      } catch (e) {
        this.logger.warn(
          e instanceof Error ? e.message : 'openSetup from DM failed',
        );
        await ctx.reply(this.botT(lbl.lang, 'setup.openSetupFailedFromGroup'));
      }
    });
  }

  @On('text')
  async onPrivateWhScheduleText(
    @Ctx() ctx: Context,
    @Next() next: () => Promise<void>,
  ) {
    if (
      !ctx.message ||
      !('text' in ctx.message) ||
      !ctx.chat?.id ||
      !ctx.from
    ) {
      return next();
    }
    if (isGroupChat(ctx)) {
      return next();
    }
    const textRaw = ctx.message.text.trim();
    if (textRaw.startsWith('/')) {
      return next();
    }
    if (this.whPerDayEditByUser.has(ctx.from.id)) {
      return next();
    }
    if (!this.whDmStateByUser.has(ctx.from.id)) {
      return next();
    }
    await this.withUserLabels(ctx, async () => {
      await this.handleWhDmText(ctx, textRaw);
    });
  }

  @On('text')
  async onPrivateWhPerDayText(
    @Ctx() ctx: Context,
    @Next() next: () => Promise<void>,
  ) {
    if (
      !ctx.message ||
      !('text' in ctx.message) ||
      !ctx.chat?.id ||
      !ctx.from
    ) {
      return next();
    }
    if (isGroupChat(ctx)) {
      return next();
    }
    const textRaw = ctx.message.text.trim();
    if (textRaw.startsWith('/')) {
      return next();
    }
    const whDraft = this.whPerDayEditByUser.get(ctx.from.id);
    if (!whDraft) {
      return next();
    }
    await this.withUserLabels(ctx, async () => {
      await this.handleWhPerDayEditText(ctx, textRaw, whDraft);
    });
  }

  @On('text')
  async onPrivateSetupText(
    @Ctx() ctx: Context,
    @Next() next: () => Promise<void>,
  ) {
    if (
      !ctx.message ||
      !('text' in ctx.message) ||
      !ctx.chat?.id ||
      !ctx.from
    ) {
      return next();
    }
    if (isGroupChat(ctx)) {
      return next();
    }
    const textRaw = ctx.message.text.trim();
    if (textRaw.startsWith('/')) {
      return next();
    }
    const gid = this.setupBridgeGroupByUser.get(ctx.from.id);
    if (gid === undefined) {
      return next();
    }
    const sk = `${gid}:${ctx.from.id}`;
    const draft = this.setupDrafts.get(sk);
    if (draft === undefined) {
      this.setupBridgeGroupByUser.delete(ctx.from.id);
      return next();
    }
    await this.withUserLabels(ctx, async () => {
      await this.handleSetupText(ctx, textRaw, BigInt(gid));
    });
  }

  @On('text')
  async onGroupMenuText(
    @Ctx() ctx: Context,
    @Next() next: () => Promise<void>,
  ) {
    if (
      !ctx.message ||
      !('text' in ctx.message) ||
      !ctx.chat?.id ||
      !ctx.from
    ) {
      return next();
    }
    const textRaw = ctx.message.text.trim();
    if (textRaw.startsWith('/')) {
      return next();
    }
    const text = textRaw;

    const from = ctx.from;
    return this.withUserLabels(ctx, async () => {
      if (isGroupChat(ctx) && text === this.kb().menuSetup) {
        await this.runGroupSetup(ctx);
        return;
      }

      if (isGroupChat(ctx) && isGroupReplyChatBotPress(text)) {
        await this.openDmMenuForGroupFromGroupContext(ctx);
        await this.tryDeleteTriggerTextMessage(ctx);
        return;
      }

      if (isGroupChat(ctx) && isGroupReplyFreeSlotsPress(text)) {
        await this.openDmFreeSlotsForGroupFromGroupContext(ctx);
        await this.tryDeleteTriggerTextMessage(ctx);
        return;
      }

      if (!isGroupChat(ctx)) {
        const picked = this.groupPickerLabelsByUser.get(from.id)?.get(text);
        if (picked != null) {
          this.activeGroupByUser.set(from.id, picked);
          this.groupPickerLabelsByUser.delete(from.id);
          const pendingPickerAction = this.pendingDmPickerActionByUser.get(
            from.id,
          );
          if (pendingPickerAction === 'setup') {
            this.pendingDmPickerActionByUser.delete(from.id);
            if (
              !(await isUserAdminOfGroupChat(ctx.telegram, picked, from.id))
            ) {
              await ctx.reply(this.botT(this.kb().lang, 'setup.adminOnly'));
              return;
            }
            let chatTitle = this.botT(
              this.kb().lang,
              'setup.chatTitleFallback',
            );
            try {
              const chat = await ctx.telegram.getChat(picked.toString());
              if (chat && 'title' in chat && chat.title) {
                chatTitle = chat.title;
              }
            } catch {
              /* title unavailable */
            }
            try {
              await this.openSetupDmSession({
                telegram: ctx.telegram,
                from,
                groupChatId: picked,
                chatTitle,
              });
            } catch (e) {
              this.logger.warn(
                e instanceof Error
                  ? e.message
                  : 'openSetup after group pick failed',
              );
              await ctx.reply(
                this.botT(this.kb().lang, 'setup.openSetupFailedRetry'),
              );
            }
            return;
          }
          this.resetMenuState(ctx);
          await ctx.reply(
            this.botT(this.kb().lang, 'menu.title'),
            await this.mainMenuReplyMarkup(ctx),
          );
          return;
        }
        if (text === this.kb().menuSwitchGroup) {
          await this.promptGroupPickerInDm(ctx, { force: true });
          return;
        }
        if (text === this.kb().menuChangeLanguage) {
          let gid = this.activeGroupByUser.get(from.id);
          if (gid == null) {
            const groups = await this.listAvailableGroupsForUser(
              ctx.telegram,
              from.id,
            );
            if (groups.length === 1) {
              gid = groups[0].telegramChatId;
              this.activeGroupByUser.set(from.id, gid);
              this.groupPickerLabelsByUser.delete(from.id);
            }
          }
          if (gid == null) {
            await ctx.reply(
              this.botT(this.kb().lang, 'menu.changeLanguagePickGroup'),
            );
            return;
          }
          try {
            await this.sendLanguagePickerMessages(ctx.telegram, gid, from.id);
          } catch (e) {
            this.logger.warn(
              `DM change language picker: ${e instanceof Error ? e.message : String(e)}`,
            );
            await ctx.reply(
              this.botT(this.kb().lang, 'menu.changeLanguageFailed'),
            );
          }
          return;
        }
        if (text === this.kb().menuChatBot) {
          const gid = await this.promptGroupPickerInDm(ctx, { force: true });
          if (gid != null) {
            this.resetMenuState(ctx);
            await ctx.reply(
              this.botT(this.kb().lang, 'menu.title'),
              await this.mainMenuReplyMarkup(ctx),
            );
          }
          return;
        }
      }

      if (text === this.kb().menuMain) {
        if (isGroupChat(ctx)) {
          this.clearSetupBridgeForGroup(from.id, String(ctx.chat!.id));
          this.setupDrafts.delete(this.setupSk(ctx.chat!.id, from.id));
        } else {
          const bridgedGid = this.setupBridgeGroupByUser.get(from.id);
          if (bridgedGid !== undefined) {
            this.setupDrafts.delete(this.setupSk(BigInt(bridgedGid), from.id));
            this.setupBridgeGroupByUser.delete(from.id);
          }
        }
        this.resetMenuState(ctx);
        await ctx.reply(
          this.botT(this.kb().lang, 'menu.title'),
          await this.mainMenuReplyMarkup(ctx),
        );
        return;
      }

      const setupDraft = this.setupDrafts.get(this.sk(ctx));
      if (setupDraft != null) {
        if (
          isGroupChat(ctx) &&
          this.setupBridgeGroupByUser.get(from.id) === String(ctx.chat!.id)
        ) {
          return;
        }
        this.setupDrafts.delete(this.sk(ctx));
      }

      if (text === this.kb().menuBack) {
        await this.handleMenuBack(ctx);
        return;
      }

      const state = this.getMenuState(ctx);

      if (state.t === 'list') {
        if (state.rowLabels.includes(text)) {
          await this.handleListCancel(ctx, text, state);
        } else if (
          text === this.kb().menuBook ||
          text === this.kb().menuList ||
          text === this.kb().menuGrid ||
          text === this.kb().menuFreeSlots ||
          text === this.kb().menuSwitchGroup
        ) {
          this.resetMenuState(ctx);
          if (text === this.kb().menuSwitchGroup) {
            await this.promptGroupPickerInDm(ctx, { force: true });
          } else {
            await this.handleMainMenuButtons(ctx, text);
          }
        }
        return;
      }
      if (state.t === 'free_slots') {
        if (state.rowLabels.includes(text)) {
          await this.handleFreeSlotJoin(ctx, text, state);
        } else if (
          text === this.kb().menuBook ||
          text === this.kb().menuList ||
          text === this.kb().menuGrid ||
          text === this.kb().menuFreeSlots ||
          text === this.kb().menuSwitchGroup
        ) {
          this.resetMenuState(ctx);
          if (text === this.kb().menuSwitchGroup) {
            await this.promptGroupPickerInDm(ctx, { force: true });
          } else {
            await this.handleMainMenuButtons(ctx, text);
          }
        }
        return;
      }
      if (state.t === 'book_sport') {
        if (
          text === this.kb().menuBook ||
          text === this.kb().menuList ||
          text === this.kb().menuGrid ||
          text === this.kb().menuFreeSlots ||
          text === this.kb().menuSwitchGroup
        ) {
          this.resetMenuState(ctx);
          if (text === this.kb().menuSwitchGroup) {
            await this.promptGroupPickerInDm(ctx, { force: true });
          } else {
            await this.handleMainMenuButtons(ctx, text);
          }
          return;
        }
        await this.handleBookSportPick(ctx, text);
        return;
      }
      if (state.t === 'book_res') {
        await this.handleBookResourcePick(ctx, text);
        return;
      }
      if (state.t === 'book_day') {
        await this.handleBookDayPick(ctx, text, state);
        return;
      }
      if (state.t === 'book_hour') {
        await this.handleBookHourPick(ctx, text, state);
        return;
      }
      if (state.t === 'book_looking') {
        if (
          text === this.kb().menuBook ||
          text === this.kb().menuList ||
          text === this.kb().menuGrid ||
          text === this.kb().menuFreeSlots ||
          text === this.kb().menuSwitchGroup
        ) {
          this.resetMenuState(ctx);
          if (text === this.kb().menuSwitchGroup) {
            await this.promptGroupPickerInDm(ctx, { force: true });
          } else {
            await this.handleMainMenuButtons(ctx, text);
          }
          return;
        }
        await this.handleBookLookingPick(ctx, text, state);
        return;
      }
      if (state.t === 'book_players') {
        if (
          text === this.kb().menuBook ||
          text === this.kb().menuList ||
          text === this.kb().menuGrid ||
          text === this.kb().menuFreeSlots ||
          text === this.kb().menuSwitchGroup
        ) {
          this.resetMenuState(ctx);
          if (text === this.kb().menuSwitchGroup) {
            await this.promptGroupPickerInDm(ctx, { force: true });
          } else {
            await this.handleMainMenuButtons(ctx, text);
          }
          return;
        }
        await this.handleBookPlayersPick(ctx, text, state);
        return;
      }
      if (state.t === 'book_dur') {
        await this.handleBookDurPick(ctx, text, state);
        return;
      }
      if (state.t === 'grid_res') {
        await this.handleGridResourcePick(ctx, text);
        return;
      }
      if (state.t === 'grid_day') {
        await this.handleGridDayPick(ctx, text, state);
        return;
      }

      const isMainMenuButton =
        text === this.kb().menuBook ||
        text === this.kb().menuList ||
        text === this.kb().menuGrid ||
        text === this.kb().menuFreeSlots ||
        text === this.kb().menuSwitchGroup ||
        text === this.kb().menuChatBot ||
        text === this.kb().menuChangeLanguage ||
        text === this.kb().menuSetup;
      if (isMainMenuButton) {
        await this.handleMainMenuButtons(ctx, text);
        return;
      }
      if (!isGroupChat(ctx)) {
        this.resetMenuState(ctx);
        await ctx.reply(
          this.botT(this.kb().lang, 'menu.title'),
          await this.mainMenuReplyMarkup(ctx),
        );
      }
    });
  }

  private setupStep1Opts(
    draft: SetupDraft,
  ): { newResource?: true; showDeleteVenue?: true } | undefined {
    if (draft.creatingNewResource && !draft.setupResourceLabel) {
      return { newResource: true };
    }
    if (draft.resourceId && !draft.creatingNewResource) {
      return { showDeleteVenue: true };
    }
    return undefined;
  }

  private setupStep1ReplyMarkup(
    backToResourcePick = false,
    existingBotName?: string,
    opts?: { newResource?: boolean; showDeleteVenue?: boolean },
  ) {
    const rows: string[][] = [];
    if (!opts?.newResource) {
      const primary = existingBotName
        ? this.kb().setupKeepBotName
        : this.kb().setupUseChatTitle;
      if (opts?.showDeleteVenue) {
        rows.push([primary, this.kb().setupDeleteResource]);
      } else {
        rows.push([primary]);
      }
    }
    if (backToResourcePick) {
      rows.push([this.kb().menuBack, this.kb().menuMain]);
      rows.push([this.kb().setupCancel]);
    } else {
      rows.push([this.kb().menuMain, this.kb().setupCancel]);
    }
    return Markup.keyboard(rows).resize().persistent(true);
  }

  private setupResourceDeleteConfirmReplyMarkup() {
    return Markup.keyboard([
      [this.kb().menuBack, this.kb().setupConfirmDeleteResource],
      [this.kb().setupCancel],
    ])
      .resize()
      .persistent(true);
  }

  private setupVenuesHubReplyMarkup() {
    return Markup.keyboard([
      [this.kb().setupVenues, this.kb().setupGroupRules],
      [this.kb().setupBookingWindow, this.kb().setupBookingLimit],
      [this.kb().setupAllBookings, this.kb().setupRecurringBookings],
      [this.kb().setupLinkExistingResource],
      [this.kb().setupCancel],
    ])
      .resize()
      .persistent(true);
  }

  private setupRulesLanguageReplyMarkup(
    langs: { id: string; nameNative: string }[],
  ) {
    const labels = langs.map((l, i) =>
      `${i + 1}. ${l.nameNative} (${l.id})`.slice(0, 64),
    );
    const rows = kbRowsPaired(labels);
    rows.push([this.kb().menuBack, this.kb().menuMain]);
    rows.push([this.kb().setupCancel]);
    return Markup.keyboard(rows).resize().persistent(true);
  }

  private setupSportKindsReplyMarkup(selected: SportKindCode[]) {
    const picked = new Set(selected);
    const rows = kbRowsPaired(
      this.allSportKindCodesForPicker().map((code) => {
        const label = this.botT(this.kb().lang, `sport.${code}`);
        return `${picked.has(code) ? '✅ ' : ''}${label}`.slice(0, 64);
      }),
    );
    rows.push([this.botT(this.kb().lang, 'setup.sportKindsDone')]);
    rows.push([this.kb().menuBack, this.kb().menuMain]);
    rows.push([this.kb().setupCancel]);
    return Markup.keyboard(rows).resize().persistent(true);
  }

  private setupHubButtonsHintText(): string {
    const lbl = this.kb();
    return this.botT(lbl.lang, 'setup.hubHint', {
      venues: lbl.setupVenues,
      groupRules: lbl.setupGroupRules,
      allBookings: lbl.setupAllBookings,
      recurringBookings: lbl.setupRecurringBookings,
      linkExisting: lbl.setupLinkExistingResource,
      bookingWindow: lbl.setupBookingWindow,
      bookingLimit: lbl.setupBookingLimit,
    });
  }

  private setupAllBookingsDayReplyMarkup() {
    return Markup.keyboard([
      [this.kb().menuDayToday, this.kb().menuDayTomorrow],
      [this.kb().menuBack, this.kb().menuMain],
      [this.kb().setupCancel],
    ])
      .resize()
      .persistent(true);
  }

  /**
   * Підпис кнопки «Усі бронювання» (64 символи). У тексті повідомлення — `includeCancelSuffix: false`.
   */
  private buildAdminAllBookingButtonLabel(
    item: {
      startTime: Date;
      endTime: Date;
      timeZone: string;
      resourceName: string;
      sportKindCode: SportKindCode;
      userName: string;
    },
    opts?: { includeCancelSuffix?: boolean },
  ): string {
    const lbl = this.kb();
    const day = formatInTimeZone(item.startTime, item.timeZone, 'dd.MM');
    const a = formatInTimeZone(item.startTime, item.timeZone, 'HH:mm');
    const z = formatInTimeZone(item.endTime, item.timeZone, 'HH:mm');
    const sport = this.botT(lbl.lang, `sport.${item.sportKindCode}`);
    const res =
      item.resourceName.trim() || this.botT(lbl.lang, 'common.emDash');
    const rawWho = item.userName.trim();
    const fallbackWho = this.botT(lbl.lang, 'setup.adminPlayerFallback');
    const who = rawWho ? rawWho.replace(/^@+/, '@') : fallbackWho;
    const includeCancel = opts?.includeCancelSuffix !== false;
    const cancelSuffix = includeCancel
      ? this.botT(lbl.lang, 'setup.adminCancelSuffix')
      : '';
    const baseLabel = `${day} ${a}–${z} · ${res} · ${sport} · ${who}`;
    let label = `${baseLabel}${cancelSuffix}`;
    if (label.length > 64) {
      const shortBase = `${day} ${a}–${z} · ${res} · ${sport} · …`;
      const maxBaseLen = Math.max(0, 64 - cancelSuffix.length);
      label = `${shortBase.slice(0, maxBaseLen)}${cancelSuffix}`;
    }
    return label;
  }

  private adminAllBookingsReplyMarkup(labels: string[]) {
    const rows = labels.map((label) => [label]);
    rows.push([this.kb().menuDayToday, this.kb().menuDayTomorrow]);
    rows.push([this.kb().menuBack, this.kb().menuMain]);
    rows.push([this.kb().setupCancel]);
    return Markup.keyboard(rows).resize().persistent(true);
  }

  private setupRecurringPickResourceReplyMarkup(
    list: {
      id: string;
      name: string;
      address?: string | null;
      visibility: ResourceVisibility;
    }[],
  ) {
    const labels = list.map((r, i) =>
      this.resourcePickButtonLabel(r, i, { markInactive: true }),
    );
    const rows = kbRowsPaired(labels);
    rows.push([this.kb().menuBack, this.kb().menuMain]);
    rows.push([this.kb().setupCancel]);
    return Markup.keyboard(rows).resize().persistent(true);
  }

  private setupRecurringActionReplyMarkup() {
    return Markup.keyboard([
      [this.kb().setupRecurringCreate, this.kb().setupRecurringDelete],
      [this.kb().menuBack, this.kb().menuMain],
      [this.kb().setupCancel],
    ])
      .resize()
      .persistent(true);
  }

  private setupRecurringWeekdayReplyMarkup() {
    return Markup.keyboard([
      ...kbRowsPaired([...this.whIsoLabels()]),
      [this.kb().menuBack, this.kb().menuMain],
      [this.kb().setupCancel],
    ])
      .resize()
      .persistent(true);
  }

  private setupRecurringStartTimeReplyMarkup() {
    const labels: string[] = [];
    for (let h = 0; h <= 23; h++) {
      labels.push(`${String(h).padStart(2, '0')}:00`);
      labels.push(`${String(h).padStart(2, '0')}:30`);
    }
    const rows = kbRowsPaired(labels);
    rows.push([this.kb().menuBack, this.kb().menuMain]);
    rows.push([this.kb().setupCancel]);
    return Markup.keyboard(rows).resize().persistent(true);
  }

  private setupRecurringDurationReplyMarkup() {
    const rows = kbRowsPaired([
      this.kb().duration1h,
      this.kb().duration90m,
      this.kb().duration2h,
    ]);
    rows.push([this.kb().menuBack, this.kb().menuMain]);
    rows.push([this.kb().setupCancel]);
    return Markup.keyboard(rows).resize().persistent(true);
  }

  private recurringRuleLabel(item: {
    weekday: number;
    startMinuteOfDay: number;
    durationMinutes: number;
    endDate: Date;
    sportKindCode: SportKindCode;
  }): string {
    const day = this.whIsoLabels()[item.weekday - 1];
    const h = Math.floor(item.startMinuteOfDay / 60);
    const m = item.startMinuteOfDay % 60;
    const start = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    const sport = this.botT(this.kb().lang, `sport.${item.sportKindCode}`);
    const dur =
      item.durationMinutes === 60
        ? this.kb().duration1h
        : item.durationMinutes === 90
          ? this.kb().duration90m
          : this.kb().duration2h;
    const endDate = formatInTimeZone(item.endDate, 'UTC', 'yyyy-MM-dd');
    return `${day} ${start} · ${dur} · ${sport} · ${endDate}`.slice(0, 64);
  }

  private setupRecurringDeleteReplyMarkup(labels: string[]) {
    const rows = kbRowsPaired(labels);
    rows.push([this.kb().menuBack, this.kb().menuMain]);
    rows.push([this.kb().setupCancel]);
    return Markup.keyboard(rows).resize().persistent(true);
  }

  private setupHubPromptText(chatTitle: string): string {
    const lbl = this.kb();
    const intro = this.botT(lbl.lang, 'setup.dmSessionIntroParagraph', {
      title: chatTitle,
    });
    return this.botT(lbl.lang, 'setup.hubPrompt', {
      intro,
      hint: this.setupHubButtonsHintText(),
    });
  }

  private formatUserBookingLimitsSummary(
    rows: { weekday: number; maxMinutes: number | null }[],
  ): string {
    const lbl = this.kb();
    const byDay = new Map(rows.map((r) => [r.weekday, r.maxMinutes]));
    const lines: string[] = [];
    for (let w = 1; w <= 7; w++) {
      const label = this.whIsoLabels()[w - 1];
      const m = byDay.get(w);
      const v =
        m === undefined || m === null
          ? this.botT(lbl.lang, 'setup.limitUnlimitedValue')
          : m === 0
            ? this.botT(lbl.lang, 'setup.limitZeroBlocked')
            : this.botT(lbl.lang, 'setup.limitHoursUnit', {
                hours: String(m / 60),
              });
      lines.push(`${label}: ${v}`);
    }
    return lines.join('\n');
  }

  private setupLimitWeekdayReplyMarkup() {
    return Markup.keyboard([
      ...kbRowsPaired([...this.whIsoLabels()]),
      [this.kb().menuBack, this.kb().menuMain],
      [this.kb().setupCancel],
    ])
      .resize()
      .persistent(true);
  }

  private setupLimitHoursReplyMarkup() {
    const lbl = this.kb();
    const labels = [
      lbl.limitUnlimited,
      ...Array.from({ length: 25 }, (_, h) =>
        this.botT(lbl.lang, 'setup.limitHoursOption', { hours: String(h) }),
      ),
    ];
    const rows = kbRowsPaired(labels);
    rows.push([this.kb().menuBack, this.kb().menuMain]);
    rows.push([this.kb().setupCancel]);
    return Markup.keyboard(rows).resize().persistent(true);
  }

  private async handleSetupBookingLimitFlow(
    ctx: Context,
    text: string,
    draft: SetupDraft,
    sk: string,
    targetGroupChatId: bigint,
    chatTitle: string,
  ): Promise<boolean> {
    const sub = draft.venuesSubstep;
    if (sub !== 'limit_pick_day' && sub !== 'limit_pick_hours') {
      return false;
    }

    const toHub = async () => {
      draft.venuesSubstep = 'hub';
      delete draft.bwTzDraft;
      delete draft.bwStartHourDraft;
      delete draft.limitWeekdayDraft;
      this.setupDrafts.set(sk, draft);
      await this.sendSetupDm(
        ctx,
        this.setupHubPromptText(chatTitle),
        this.setupVenuesHubReplyMarkup(),
      );
    };

    if (text === this.kb().menuMain) {
      await toHub();
      return true;
    }

    if (sub === 'limit_pick_day') {
      if (text === this.kb().menuBack) {
        await toHub();
        return true;
      }
      const wi = this.whIsoLabels().findIndex((l) => l === text);
      if (wi < 0) {
        await this.sendSetupDm(
          ctx,
          this.botT(this.kb().lang, 'setup.pickWeekdayOrBack', {
            back: this.kb().menuBack,
          }),
        );
        return true;
      }
      draft.limitWeekdayDraft = wi + 1;
      draft.venuesSubstep = 'limit_pick_hours';
      this.setupDrafts.set(sk, draft);
      const limits =
        await this.community.getUserBookingLimitsForChat(targetGroupChatId);
      const row = limits.find((l) => l.weekday === draft.limitWeekdayDraft);
      const lbl = this.kb();
      const cur =
        row?.maxMinutes == null
          ? this.botT(lbl.lang, 'setup.limitUnlimitedValue')
          : row.maxMinutes === 0
            ? this.botT(lbl.lang, 'setup.limitZeroBlocked')
            : this.botT(lbl.lang, 'setup.limitHoursUnit', {
                hours: String(row.maxMinutes / 60),
              });
      await this.sendSetupDm(
        ctx,
        this.botT(lbl.lang, 'setup.limitHoursTitle', {
          weekday: this.whIsoLabels()[wi],
          current: cur,
        }) +
          this.botT(lbl.lang, 'setup.limitHoursLongIntro') +
          '\n\n' +
          this.botT(lbl.lang, 'setup.limitPickShort'),
        this.setupLimitHoursReplyMarkup(),
      );
      return true;
    }

    if (text === this.kb().menuBack) {
      draft.venuesSubstep = 'limit_pick_day';
      delete draft.limitWeekdayDraft;
      this.setupDrafts.set(sk, draft);
      const limits =
        await this.community.getUserBookingLimitsForChat(targetGroupChatId);
      await this.sendSetupDm(
        ctx,
        this.botT(this.kb().lang, 'setup.limitsWeekdayPickerTitle', {
          summary: this.formatUserBookingLimitsSummary(limits),
        }),
        this.setupLimitWeekdayReplyMarkup(),
      );
      return true;
    }

    const wd = draft.limitWeekdayDraft;
    if (wd === undefined || wd < 1 || wd > 7) {
      await toHub();
      return true;
    }

    let maxMinutes: number | null;
    if (text === this.kb().limitUnlimited) {
      maxMinutes = null;
    } else {
      const m = text.match(/^(\d+)\s*(?:ч|h)$/i);
      if (!m) {
        await this.sendSetupDm(
          ctx,
          this.botT(this.kb().lang, 'setup.pickOptionFromList'),
        );
        return true;
      }
      const h = Number(m[1]);
      if (!Number.isInteger(h) || h < 0 || h > 24) {
        await this.sendSetupDm(
          ctx,
          this.botT(this.kb().lang, 'setup.limitHoursAllowedRange'),
        );
        return true;
      }
      maxMinutes = h * 60;
    }

    try {
      await this.community.updateCommunityUserBookingLimitWeekday({
        telegramChatId: targetGroupChatId,
        weekday: wd,
        maxMinutes,
      });
    } catch (e) {
      this.logger.error(e instanceof Error ? e.message : e);
      await this.sendSetupDm(
        ctx,
        this.botT(this.kb().lang, 'whDm.genericSaveFailedRetry'),
      );
      return true;
    }

    draft.venuesSubstep = 'limit_pick_day';
    delete draft.limitWeekdayDraft;
    this.setupDrafts.set(sk, draft);
    const limitsAfter =
      await this.community.getUserBookingLimitsForChat(targetGroupChatId);
    await this.sendSetupDm(
      ctx,
      this.botT(this.kb().lang, 'setup.limitsSavedPickWeekday', {
        summary: this.formatUserBookingLimitsSummary(limitsAfter),
        back: this.kb().menuBack,
      }),
      this.setupLimitWeekdayReplyMarkup(),
    );
    return true;
  }

  private formatBookingWindowSummary(c: {
    bookingWindowTimeZone: string;
    bookingWindowStartHour: number;
    bookingWindowEndHour: number;
  }): string {
    const lang = this.kb().lang;
    const sh = c.bookingWindowStartHour;
    const eh = c.bookingWindowEndHour;
    const endLabel =
      eh >= 24
        ? this.botT(lang, 'bw.endClockMidnight')
        : `${String(eh).padStart(2, '0')}:00`;
    return this.botT(lang, 'bw.summaryLine', {
      start: String(sh).padStart(2, '0'),
      end: endLabel,
      tz: c.bookingWindowTimeZone,
    });
  }

  private setupBwStartHourReplyMarkup() {
    const labels = Array.from(
      { length: 24 },
      (_, h) => `${String(h).padStart(2, '0')}:00`,
    );
    const rows = kbRowsPaired(labels);
    rows.push([this.kb().menuBack, this.kb().menuMain]);
    rows.push([this.kb().setupCancel]);
    return Markup.keyboard(rows).resize().persistent(true);
  }

  private setupBwEndHourReplyMarkup(slotStart: number) {
    const labels: string[] = [];
    for (let h = slotStart + 1; h <= 23; h++) {
      labels.push(`${String(h).padStart(2, '0')}:00`);
    }
    const rows = kbRowsPaired(labels);
    rows.push([this.kb().bwEndMidnight]);
    rows.push([this.kb().menuBack, this.kb().menuMain]);
    rows.push([this.kb().setupCancel]);
    return Markup.keyboard(rows).resize().persistent(true);
  }

  /**
   * Мастер окна бронирования (шаг 0). Возвращает true, если сообщение обработано
   * (в т.ч. при неверном вводе — уже ответили в ЛС).
   */
  private async handleSetupBookingWindowFlow(
    ctx: Context,
    text: string,
    draft: SetupDraft,
    sk: string,
    targetGroupChatId: bigint,
    chatTitle: string,
  ): Promise<boolean> {
    const sub = draft.venuesSubstep;
    if (sub !== 'bw_tz' && sub !== 'bw_start' && sub !== 'bw_end') {
      return false;
    }

    const toHub = async () => {
      draft.venuesSubstep = 'hub';
      delete draft.bwTzDraft;
      delete draft.bwStartHourDraft;
      delete draft.limitWeekdayDraft;
      this.setupDrafts.set(sk, draft);
      await this.sendSetupDm(
        ctx,
        this.setupHubPromptText(chatTitle),
        this.setupVenuesHubReplyMarkup(),
      );
    };

    if (text === this.kb().menuMain) {
      await toHub();
      return true;
    }

    if (sub === 'bw_tz') {
      if (text === this.kb().menuBack) {
        await toHub();
        return true;
      }
      const tzIdx = this.setupTzLabelIndex(text);
      if (tzIdx < 0) {
        await this.sendSetupDm(
          ctx,
          this.botT(this.kb().lang, 'setup.bwPickTzOrBack', {
            back: this.kb().menuBack,
          }),
        );
        return true;
      }
      draft.bwTzDraft = SETUP_TIMEZONES[tzIdx];
      draft.venuesSubstep = 'bw_start';
      this.setupDrafts.set(sk, draft);
      await this.sendSetupDm(
        ctx,
        this.botT(this.kb().lang, 'setup.bwStep2StartInTz', {
          tz: draft.bwTzDraft ?? '',
        }),
        this.setupBwStartHourReplyMarkup(),
      );
      return true;
    }

    if (sub === 'bw_start') {
      if (text === this.kb().menuBack) {
        draft.venuesSubstep = 'bw_tz';
        delete draft.bwTzDraft;
        this.setupDrafts.set(sk, draft);
        const comm =
          await this.community.findByTelegramChatId(targetGroupChatId);
        const current = comm
          ? this.formatBookingWindowSummary(comm)
          : this.botT(this.kb().lang, 'common.emDash');
        await this.sendSetupDm(
          ctx,
          this.botT(this.kb().lang, 'setup.bwStep1TzWithCurrent', {
            current,
          }),
          this.setupTzReplyMarkup(),
        );
        return true;
      }
      const hm = text.match(/^(\d{1,2}):00$/);
      if (!hm) {
        await this.sendSetupDm(
          ctx,
          this.botT(this.kb().lang, 'setup.bwPickHourFromList'),
        );
        return true;
      }
      const hour = Number(hm[1]);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
        await this.sendSetupDm(
          ctx,
          this.botT(this.kb().lang, 'setup.bwPickHour00to23'),
        );
        return true;
      }
      draft.bwStartHourDraft = hour;
      draft.venuesSubstep = 'bw_end';
      this.setupDrafts.set(sk, draft);
      await this.sendSetupDm(
        ctx,
        this.botT(this.kb().lang, 'setup.bwStep3EndWithStart', {
          hour: String(hour).padStart(2, '0'),
        }),
        this.setupBwEndHourReplyMarkup(hour),
      );
      return true;
    }

    if (text === this.kb().menuBack) {
      draft.venuesSubstep = 'bw_start';
      delete draft.bwStartHourDraft;
      this.setupDrafts.set(sk, draft);
      await this.sendSetupDm(
        ctx,
        this.botT(this.kb().lang, 'setup.bwStep2StartInTz', {
          tz: draft.bwTzDraft ?? '',
        }),
        this.setupBwStartHourReplyMarkup(),
      );
      return true;
    }

    const start = draft.bwStartHourDraft;
    const tz = draft.bwTzDraft;
    if (start === undefined || !tz) {
      await toHub();
      return true;
    }

    let endHour: number;
    if (text === this.kb().bwEndMidnight) {
      endHour = 24;
    } else {
      const hm = text.match(/^(\d{1,2}):00$/);
      if (!hm) {
        await this.sendSetupDm(
          ctx,
          this.botT(this.kb().lang, 'setup.bwPickHourFromList'),
        );
        return true;
      }
      endHour = Number(hm[1]);
      if (!Number.isInteger(endHour) || endHour < 1 || endHour > 23) {
        await this.sendSetupDm(
          ctx,
          this.botT(this.kb().lang, 'setup.bwInvalidHour'),
        );
        return true;
      }
      if (endHour <= start) {
        await this.sendSetupDm(
          ctx,
          this.botT(this.kb().lang, 'setup.bwEndMustAfterStartWithMidnight', {
            midnight: this.kb().bwEndMidnight,
          }),
        );
        return true;
      }
    }

    if (endHour <= start) {
      await this.sendSetupDm(
        ctx,
        this.botT(this.kb().lang, 'setup.bwEndWindowAfterStart'),
      );
      return true;
    }

    try {
      await this.community.updateCommunityBookingWindow({
        telegramChatId: targetGroupChatId,
        bookingWindowTimeZone: tz,
        bookingWindowStartHour: start,
        bookingWindowEndHour: endHour,
      });
    } catch (e) {
      this.logger.error(e instanceof Error ? e.message : e);
      await this.sendSetupDm(
        ctx,
        this.botT(this.kb().lang, 'setup.persistSetupFailed'),
      );
      return true;
    }

    draft.venuesSubstep = 'hub';
    delete draft.bwTzDraft;
    delete draft.bwStartHourDraft;
    this.setupDrafts.set(sk, draft);
    await this.sendSetupDm(
      ctx,
      this.botT(this.kb().lang, 'bw.doneLine', {
        summary: this.formatBookingWindowSummary({
          bookingWindowTimeZone: tz,
          bookingWindowStartHour: start,
          bookingWindowEndHour: endHour,
        }),
      }),
      this.setupVenuesHubReplyMarkup(),
    );
    return true;
  }

  private clearRecurringDraft(draft: SetupDraft): void {
    delete draft.recurringResourceIdDraft;
    delete draft.recurringSportKindCodeDraft;
    delete draft.recurringWeekdayDraft;
    delete draft.recurringStartMinuteOfDayDraft;
    delete draft.recurringDurationMinutesDraft;
    delete draft.recurringRuleIdsDraft;
    delete draft.recurringRuleLabelsDraft;
  }

  private async validateRecurringSlotAgainstWorkingHours(params: {
    telegramChatId: bigint;
    resourceId: string;
    weekday: number;
    startMinuteOfDay: number;
    durationMinutes: number;
  }): Promise<boolean> {
    const resource = await this.resources.findByIdForChat(
      params.resourceId,
      params.telegramChatId,
    );
    if (!resource) {
      return false;
    }
    const row = resource.workingHours.find((w) => w.weekday === params.weekday);
    if (
      !row ||
      row.isClosed ||
      row.slotStartHour == null ||
      row.slotEndHour == null
    ) {
      return false;
    }
    const start = params.startMinuteOfDay;
    const end = params.startMinuteOfDay + params.durationMinutes;
    const minStart = row.slotStartHour * 60;
    const maxEnd = (row.slotEndHour + 1) * 60;
    return start >= minStart && end <= maxEnd;
  }

  private async handleSetupRecurringFlow(
    ctx: Context,
    text: string,
    draft: SetupDraft,
    sk: string,
    targetGroupChatId: bigint,
    chatTitle: string,
    list: {
      id: string;
      name: string;
      address?: string | null;
      visibility: ResourceVisibility;
      sportKinds?: { sportKindCode: SportKindCode }[];
    }[],
  ): Promise<boolean> {
    const sub = draft.venuesSubstep;
    if (
      sub !== 'recurring_pick_resource' &&
      sub !== 'recurring_pick_action' &&
      sub !== 'recurring_pick_sport' &&
      sub !== 'recurring_pick_weekday' &&
      sub !== 'recurring_pick_start' &&
      sub !== 'recurring_pick_duration' &&
      sub !== 'recurring_pick_end_date' &&
      sub !== 'recurring_list_delete'
    ) {
      return false;
    }
    const toHub = async () => {
      draft.venuesSubstep = 'hub';
      this.clearRecurringDraft(draft);
      this.setupDrafts.set(sk, draft);
      await this.sendSetupDm(
        ctx,
        this.setupHubPromptText(chatTitle),
        this.setupVenuesHubReplyMarkup(),
      );
    };
    if (text === this.kb().menuMain) {
      await toHub();
      return true;
    }
    if (sub === 'recurring_pick_resource') {
      if (text === this.kb().menuBack) {
        await toHub();
        return true;
      }
      const m = text.match(/^(\d+)\.\s/);
      if (!m) {
        await this.sendSetupDm(
          ctx,
          this.botT(this.kb().lang, 'setup.pickNumberOrBackButton', {
            back: this.kb().menuBack,
          }),
        );
        return true;
      }
      const idx = Number(m[1]) - 1;
      const picked = list[idx];
      if (!picked) {
        await this.sendSetupDm(
          ctx,
          this.botT(this.kb().lang, 'setup.pickNumberOrBackButton', {
            back: this.kb().menuBack,
          }),
        );
        return true;
      }
      draft.venuesSubstep = 'recurring_pick_action';
      this.clearRecurringDraft(draft);
      draft.recurringResourceIdDraft = picked.id;
      this.setupDrafts.set(sk, draft);
      await this.sendSetupDm(
        ctx,
        this.botT(this.kb().lang, 'setup.recurringPickAction', {
          venue: picked.name,
        }),
        this.setupRecurringActionReplyMarkup(),
      );
      return true;
    }
    const resourceId = draft.recurringResourceIdDraft;
    if (!resourceId) {
      await toHub();
      return true;
    }
    const pickedResource = list.find((r) => r.id === resourceId);
    const resourceName =
      pickedResource?.name ?? this.botT(this.kb().lang, 'common.emDash');
    if (sub === 'recurring_pick_action') {
      if (text === this.kb().menuBack) {
        draft.venuesSubstep = 'recurring_pick_resource';
        this.clearRecurringDraft(draft);
        this.setupDrafts.set(sk, draft);
        await this.sendSetupDm(
          ctx,
          this.botT(this.kb().lang, 'setup.recurringPickVenue'),
          this.setupRecurringPickResourceReplyMarkup(list),
        );
        return true;
      }
      if (text === this.kb().setupRecurringCreate) {
        draft.venuesSubstep = 'recurring_pick_sport';
        delete draft.recurringSportKindCodeDraft;
        this.setupDrafts.set(sk, draft);
        const sportKinds = this.allSportKindCodesForPicker();
        await this.sendSetupDm(
          ctx,
          this.botT(this.kb().lang, 'setup.recurringPickSport', {
            venue: resourceName,
          }),
          this.sportPickReplyMarkup(sportKinds),
        );
        return true;
      }
      if (text === this.kb().setupRecurringDelete) {
        const rules =
          await this.recurringBookings.listRulesForCommunityResource({
            telegramChatId: targetGroupChatId,
            resourceId,
          });
        if (rules.length === 0) {
          await this.sendSetupDm(
            ctx,
            this.botT(this.kb().lang, 'setup.recurringNoRulesForVenue', {
              venue: resourceName,
            }),
            this.setupRecurringActionReplyMarkup(),
          );
          return true;
        }
        const labels = rules.map((r) => this.recurringRuleLabel(r));
        draft.venuesSubstep = 'recurring_list_delete';
        draft.recurringRuleIdsDraft = rules.map((r) => r.id);
        draft.recurringRuleLabelsDraft = labels;
        this.setupDrafts.set(sk, draft);
        await this.sendSetupDm(
          ctx,
          this.botT(this.kb().lang, 'setup.recurringDeletePrompt', {
            venue: resourceName,
          }),
          this.setupRecurringDeleteReplyMarkup(labels),
        );
        return true;
      }
      await this.sendSetupDm(
        ctx,
        this.botT(this.kb().lang, 'setup.pickOptionFromList'),
      );
      return true;
    }
    if (sub === 'recurring_pick_sport') {
      if (text === this.kb().menuBack) {
        draft.venuesSubstep = 'recurring_pick_action';
        delete draft.recurringSportKindCodeDraft;
        this.setupDrafts.set(sk, draft);
        await this.sendSetupDm(
          ctx,
          this.botT(this.kb().lang, 'setup.recurringPickAction', {
            venue: resourceName,
          }),
          this.setupRecurringActionReplyMarkup(),
        );
        return true;
      }
      const code = sportLabelToCodeMap(this.i18n, this.kb().lang).get(text);
      if (!code) {
        await this.sendSetupDm(
          ctx,
          this.botT(this.kb().lang, 'setup.pickOptionFromList'),
        );
        return true;
      }
      draft.venuesSubstep = 'recurring_pick_weekday';
      draft.recurringSportKindCodeDraft = code;
      this.setupDrafts.set(sk, draft);
      await this.sendSetupDm(
        ctx,
        this.botT(this.kb().lang, 'setup.recurringPickWeekday'),
        this.setupRecurringWeekdayReplyMarkup(),
      );
      return true;
    }
    if (sub === 'recurring_pick_weekday') {
      if (text === this.kb().menuBack) {
        draft.venuesSubstep = 'recurring_pick_sport';
        delete draft.recurringWeekdayDraft;
        this.setupDrafts.set(sk, draft);
        const sportKinds = this.allSportKindCodesForPicker();
        await this.sendSetupDm(
          ctx,
          this.botT(this.kb().lang, 'setup.recurringPickSport', {
            venue: resourceName,
          }),
          this.sportPickReplyMarkup(sportKinds),
        );
        return true;
      }
      const weekdayIdx = this.whIsoLabels().findIndex(
        (dayLabel) => dayLabel === text,
      );
      if (weekdayIdx < 0) {
        await this.sendSetupDm(
          ctx,
          this.botT(this.kb().lang, 'setup.pickWeekdayOrBack', {
            back: this.kb().menuBack,
          }),
        );
        return true;
      }
      draft.venuesSubstep = 'recurring_pick_start';
      draft.recurringWeekdayDraft = weekdayIdx + 1;
      this.setupDrafts.set(sk, draft);
      await this.sendSetupDm(
        ctx,
        this.botT(this.kb().lang, 'setup.recurringPickStartTime'),
        this.setupRecurringStartTimeReplyMarkup(),
      );
      return true;
    }
    if (sub === 'recurring_pick_start') {
      if (text === this.kb().menuBack) {
        draft.venuesSubstep = 'recurring_pick_weekday';
        delete draft.recurringStartMinuteOfDayDraft;
        this.setupDrafts.set(sk, draft);
        await this.sendSetupDm(
          ctx,
          this.botT(this.kb().lang, 'setup.recurringPickWeekday'),
          this.setupRecurringWeekdayReplyMarkup(),
        );
        return true;
      }
      const hm = text.match(/^(\d{1,2}):(00|30)$/);
      if (!hm) {
        await this.sendSetupDm(
          ctx,
          this.botT(this.kb().lang, 'setup.recurringPickHalfHour'),
        );
        return true;
      }
      const hour = Number(hm[1]);
      const minute = Number(hm[2]);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
        await this.sendSetupDm(
          ctx,
          this.botT(this.kb().lang, 'setup.recurringPickHalfHour'),
        );
        return true;
      }
      draft.venuesSubstep = 'recurring_pick_duration';
      draft.recurringStartMinuteOfDayDraft = hour * 60 + minute;
      this.setupDrafts.set(sk, draft);
      await this.sendSetupDm(
        ctx,
        this.botT(this.kb().lang, 'setup.recurringPickDuration'),
        this.setupRecurringDurationReplyMarkup(),
      );
      return true;
    }
    if (sub === 'recurring_pick_duration') {
      if (text === this.kb().menuBack) {
        draft.venuesSubstep = 'recurring_pick_start';
        delete draft.recurringDurationMinutesDraft;
        this.setupDrafts.set(sk, draft);
        await this.sendSetupDm(
          ctx,
          this.botT(this.kb().lang, 'setup.recurringPickStartTime'),
          this.setupRecurringStartTimeReplyMarkup(),
        );
        return true;
      }
      const durationMinutes = durationMinutesFromReplyLabel(this.kb(), text);
      if (!durationMinutes) {
        await this.sendSetupDm(
          ctx,
          this.botT(this.kb().lang, 'setup.pickOptionFromList'),
        );
        return true;
      }
      draft.venuesSubstep = 'recurring_pick_end_date';
      draft.recurringDurationMinutesDraft = durationMinutes;
      this.setupDrafts.set(sk, draft);
      await this.sendSetupDm(
        ctx,
        this.botT(this.kb().lang, 'setup.recurringPickEndDate'),
        Markup.keyboard([
          [this.kb().menuBack, this.kb().menuMain],
          [this.kb().setupCancel],
        ])
          .resize()
          .persistent(true),
      );
      return true;
    }
    if (sub === 'recurring_pick_end_date') {
      if (text === this.kb().menuBack) {
        draft.venuesSubstep = 'recurring_pick_duration';
        this.setupDrafts.set(sk, draft);
        await this.sendSetupDm(
          ctx,
          this.botT(this.kb().lang, 'setup.recurringPickDuration'),
          this.setupRecurringDurationReplyMarkup(),
        );
        return true;
      }
      const m = text.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) {
        await this.sendSetupDm(
          ctx,
          this.botT(this.kb().lang, 'setup.recurringDateFormatInvalid'),
        );
        return true;
      }
      const endDate = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`);
      if (Number.isNaN(endDate.getTime())) {
        await this.sendSetupDm(
          ctx,
          this.botT(this.kb().lang, 'setup.recurringDateFormatInvalid'),
        );
        return true;
      }
      const weekday = draft.recurringWeekdayDraft;
      const startMinute = draft.recurringStartMinuteOfDayDraft;
      const duration = draft.recurringDurationMinutesDraft;
      const sportKindCode = draft.recurringSportKindCodeDraft;
      if (
        weekday == null ||
        startMinute == null ||
        duration == null ||
        sportKindCode == null
      ) {
        await toHub();
        return true;
      }
      const fitsWorkingHours =
        await this.validateRecurringSlotAgainstWorkingHours({
          telegramChatId: targetGroupChatId,
          resourceId,
          weekday,
          startMinuteOfDay: startMinute,
          durationMinutes: duration,
        });
      if (!fitsWorkingHours) {
        await this.sendSetupDm(
          ctx,
          this.botT(this.kb().lang, 'setup.recurringOutsideWorkingHours'),
        );
        return true;
      }
      try {
        await this.recurringBookings.createRule({
          telegramChatId: targetGroupChatId,
          resourceId,
          createdByTelegramUserId: ctx.from!.id,
          sportKindCode,
          weekday,
          startMinuteOfDay: startMinute,
          durationMinutes: duration,
          endDate,
        });
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        if (code === 'RECURRING_RULE_DUPLICATE') {
          await this.sendSetupDm(
            ctx,
            this.botT(this.kb().lang, 'setup.recurringDuplicateRule'),
          );
          return true;
        }
        if (code === 'RECURRING_RULE_OVERLAP') {
          await this.sendSetupDm(
            ctx,
            this.botT(this.kb().lang, 'setup.recurringOverlapRule'),
          );
          return true;
        }
        if (code === 'END_DATE_IN_PAST') {
          await this.sendSetupDm(
            ctx,
            this.botT(this.kb().lang, 'setup.recurringEndDateInPast'),
          );
          return true;
        }
        this.logger.error(error instanceof Error ? error.message : error);
        await this.sendSetupDm(
          ctx,
          this.botT(this.kb().lang, 'setup.persistSetupFailed'),
        );
        return true;
      }
      draft.venuesSubstep = 'recurring_pick_action';
      delete draft.recurringSportKindCodeDraft;
      delete draft.recurringWeekdayDraft;
      delete draft.recurringStartMinuteOfDayDraft;
      delete draft.recurringDurationMinutesDraft;
      this.setupDrafts.set(sk, draft);
      await this.sendSetupDm(
        ctx,
        this.botT(this.kb().lang, 'setup.recurringSaved', {
          venue: resourceName,
        }),
        this.setupRecurringActionReplyMarkup(),
      );
      return true;
    }
    if (sub === 'recurring_list_delete') {
      if (text === this.kb().menuBack) {
        draft.venuesSubstep = 'recurring_pick_action';
        delete draft.recurringRuleIdsDraft;
        delete draft.recurringRuleLabelsDraft;
        this.setupDrafts.set(sk, draft);
        await this.sendSetupDm(
          ctx,
          this.botT(this.kb().lang, 'setup.recurringPickAction', {
            venue: resourceName,
          }),
          this.setupRecurringActionReplyMarkup(),
        );
        return true;
      }
      const labels = draft.recurringRuleLabelsDraft ?? [];
      const ids = draft.recurringRuleIdsDraft ?? [];
      const idx = labels.indexOf(text);
      if (idx < 0 || !ids[idx]) {
        await this.sendSetupDm(
          ctx,
          this.botT(this.kb().lang, 'setup.pickOptionFromList'),
        );
        return true;
      }
      const deleted = await this.recurringBookings.deleteRule({
        telegramChatId: targetGroupChatId,
        resourceId,
        ruleId: ids[idx],
      });
      if (!deleted) {
        await this.sendSetupDm(
          ctx,
          this.botT(this.kb().lang, 'setup.recurringRuleAlreadyDeleted'),
        );
      }
      const rules = await this.recurringBookings.listRulesForCommunityResource({
        telegramChatId: targetGroupChatId,
        resourceId,
      });
      if (rules.length === 0) {
        draft.venuesSubstep = 'recurring_pick_action';
        delete draft.recurringRuleIdsDraft;
        delete draft.recurringRuleLabelsDraft;
        this.setupDrafts.set(sk, draft);
        await this.sendSetupDm(
          ctx,
          this.botT(this.kb().lang, 'setup.recurringNoRulesForVenue', {
            venue: resourceName,
          }),
          this.setupRecurringActionReplyMarkup(),
        );
        return true;
      }
      const newLabels = rules.map((r) => this.recurringRuleLabel(r));
      draft.venuesSubstep = 'recurring_list_delete';
      draft.recurringRuleIdsDraft = rules.map((r) => r.id);
      draft.recurringRuleLabelsDraft = newLabels;
      this.setupDrafts.set(sk, draft);
      await this.sendSetupDm(
        ctx,
        this.botT(this.kb().lang, 'setup.recurringDeletedPrompt', {
          venue: resourceName,
        }),
        this.setupRecurringDeleteReplyMarkup(newLabels),
      );
      return true;
    }
    return true;
  }

  private setupPickResourceReplyMarkup(
    list: {
      id: string;
      name: string;
      address?: string | null;
      visibility: ResourceVisibility;
    }[],
  ) {
    const labels = list.map((r, i) =>
      this.resourcePickButtonLabel(r, i, { markInactive: true }),
    );
    const rows = kbRowsPaired(labels);
    rows.push([this.kb().setupNewResource, this.kb().menuBack]);
    rows.push([this.kb().menuMain, this.kb().setupCancel]);
    return Markup.keyboard(rows).resize().persistent(true);
  }

  private setupLinkExistingResourceReplyMarkup(
    list: {
      id: string;
      name: string;
      address?: string | null;
      visibility: ResourceVisibility;
    }[],
  ) {
    const labels = list.map((r, i) =>
      this.resourcePickButtonLabel(r, i, { markInactive: true }),
    );
    const rows = kbRowsPaired(labels);
    rows.push([this.kb().menuBack, this.kb().menuMain]);
    rows.push([this.kb().setupCancel]);
    return Markup.keyboard(rows).resize().persistent(true);
  }

  /** Step 1 copy: existing venue shows DB name, not chat title. */
  private setupStep1PromptText(
    chatTitle: string,
    opts: {
      existingResourceName?: string;
      multiFlow?: boolean;
      /** New venue — text only, no “same as chat” button. */
      newResource?: boolean;
      stepMax?: 5 | 6;
    },
  ): string {
    const lang = this.kb().lang;
    const lbl = this.kb();
    const sm = String(opts.stepMax ?? 5);
    if (opts.newResource) {
      return this.botT(lang, 'setup.step1NewResource', { stepMax: sm });
    }
    const ctShort =
      chatTitle.length > 80 ? `${chatTitle.slice(0, 80)}…` : chatTitle;
    const ex = opts.existingResourceName;
    if (ex) {
      return this.botT(lang, 'setup.step1RenameExisting', {
        stepMax: sm,
        existingName: ex,
        keepBotName: lbl.setupKeepBotName,
      });
    }
    return this.botT(lang, 'setup.step1FromChatTitle', {
      stepMax: sm,
      chatTitle: ctShort,
    });
  }

  private setupAddressPromptText(
    setupResourceAddressLabel?: string | null,
    stepMax: 5 | 6 = 5,
  ): string {
    const lang = this.kb().lang;
    const lbl = this.kb();
    const sm = String(stepMax);
    const cur = setupResourceAddressLabel?.trim();
    if (cur) {
      return this.botT(lang, 'setup.step2AddressWithCurrent', {
        stepMax: sm,
        current: cur,
        keepAddress: lbl.setupKeepAddress,
        noAddress: lbl.setupNoAddress,
      });
    }
    return this.botT(lang, 'setup.step2AddressEmpty', {
      stepMax: sm,
      noAddress: lbl.setupNoAddress,
    });
  }

  private setupAddressReplyMarkup(showKeepCurrent: boolean) {
    const rows: string[][] = showKeepCurrent
      ? [[this.kb().setupKeepAddress, this.kb().setupNoAddress]]
      : [[this.kb().setupNoAddress]];
    rows.push([this.kb().menuBack, this.kb().menuMain]);
    rows.push([this.kb().setupCancel]);
    return Markup.keyboard(rows).resize().persistent(true);
  }

  private setupTzReplyMarkup() {
    const labels = SETUP_TIMEZONES.map((tz) =>
      (tz.split('/').pop() ?? tz).slice(0, 64),
    );
    const rows = kbRowsPaired(labels);
    rows.push([this.kb().menuBack, this.kb().menuMain]);
    rows.push([this.kb().setupCancel]);
    return Markup.keyboard(rows).resize().persistent(true);
  }

  private setupStartHourReplyMarkup() {
    const labels = Array.from(
      { length: 23 },
      (_, h) => `${String(h).padStart(2, '0')}:00`,
    );
    const rows = kbRowsPaired(labels);
    rows.push([this.kb().menuBack, this.kb().menuMain]);
    rows.push([this.kb().setupCancel]);
    return Markup.keyboard(rows).resize().persistent(true);
  }

  private setupClosingHourReplyMarkup(slotStart: number) {
    const labels: string[] = [];
    for (let h = slotStart + 1; h <= 23; h++) {
      labels.push(`${String(h).padStart(2, '0')}:00`);
    }
    const rows = kbRowsPaired(labels);
    rows.push([this.kb().menuBack, this.kb().menuMain]);
    rows.push([this.kb().setupCancel]);
    return Markup.keyboard(rows).resize().persistent(true);
  }

  private setupResourceVisibilityReplyMarkup() {
    return Markup.keyboard([
      [this.kb().setupResourceActive, this.kb().setupResourceInactive],
      [this.kb().menuBack, this.kb().menuMain],
      [this.kb().setupCancel],
    ])
      .resize()
      .persistent(true);
  }

  private setupTzLabelIndex(text: string): number {
    return SETUP_TIMEZONES.findIndex((tz) => {
      const label = (tz.split('/').pop() ?? tz).slice(0, 64);
      return label === text;
    });
  }

  private async broadcastToResourceGroups(
    ctx: Context,
    resourceId: string,
    text: string,
  ): Promise<void> {
    const chatIds =
      await this.resources.listTelegramChatIdsForResource(resourceId);
    await this.sendMessageBatchBestEffort(
      ctx.telegram,
      chatIds.map((gid) => gid.toString()),
      text,
      'group',
      (gid, e) => {
        this.logger.warn(
          `resource_group_broadcast failed chat=${gid}: ${e instanceof Error ? e.message : String(e)}`,
        );
      },
    );
  }

  private bookingSportLabel(kindCode?: SportKindCode): string {
    const lbl = this.kb();
    if (kindCode == null) {
      return this.botT(lbl.lang, 'sport.TENNIS');
    }
    return this.botT(lbl.lang, `sport.${kindCode}`) ?? String(kindCode);
  }

  private whDayStatusLine(
    row:
      | {
          isClosed: boolean;
          slotStartHour: number | null;
          slotEndHour: number | null;
        }
      | undefined,
  ): string {
    const lang = this.kb().lang;
    if (
      !row ||
      row.isClosed ||
      row.slotStartHour == null ||
      row.slotEndHour == null
    ) {
      return this.botT(lang, 'whDm.statusClosedNow');
    }
    const s = row.slotStartHour;
    const e = row.slotEndHour;
    return this.botT(lang, 'whDm.statusSlotsNow', {
      start: String(s).padStart(2, '0'),
      end: String(e).padStart(2, '0'),
    });
  }

  private async persistSetupDraft(
    ctx: Context,
    draft: SetupDraft,
    resourceVisibility: ResourceVisibility,
    targetGroupChatId: bigint,
    opts?: { startPerDayImmediately?: boolean },
  ) {
    const uid = ctx.from!.id;
    const sk = this.setupSk(targetGroupChatId, uid);
    if (
      !draft.name ||
      draft.resourceAddress === undefined ||
      !draft.timeZone ||
      draft.slotStart === undefined ||
      draft.slotEnd === undefined ||
      !draft.sportKindCodes ||
      draft.sportKindCodes.length === 0
    ) {
      this.setupDrafts.delete(sk);
      this.setupBridgeGroupByUser.delete(uid);
      await this.replyWithMainMenuInDmForGroup(
        ctx,
        targetGroupChatId,
        this.botT(this.kb().lang, 'setup.sessionStale'),
      );
      return;
    }
    try {
      const source =
        draft.communityNameSource ?? PrismaClient.CommunityNameSource.AUTO;
      const groupTitle = draft.groupChatTitleForPrompt?.trim();
      const communityName =
        source === PrismaClient.CommunityNameSource.AUTO
          ? groupTitle || draft.name
          : draft.name;
      const { resource } = await this.community.createOrUpdateFromSetup({
        telegramChatId: targetGroupChatId,
        name: communityName,
        nameSource: source,
        address: draft.resourceAddress,
        timeZone: draft.timeZone,
        slotStartHour: draft.slotStart,
        slotEndHour: draft.slotEnd,
        resourceName: draft.name,
        ...(draft.resourceId && !draft.creatingNewResource
          ? { resourceId: draft.resourceId }
          : {}),
        updateCommunityName: !draft.multiResourceFlow,
        createNewResource: draft.creatingNewResource === true,
        resourceVisibility,
        sportKindCodes: draft.sportKindCodes,
      });
      this.setupDrafts.delete(sk);
      this.setupBridgeGroupByUser.delete(uid);
      const editingExisting = !!draft.resourceId && !draft.creatingNewResource;
      let tail = '';
      if (editingExisting) {
        tail =
          resourceVisibility === ResourceVisibility.INACTIVE
            ? this.botT(this.kb().lang, 'setup.visibilityNoteInactive')
            : this.botT(this.kb().lang, 'setup.visibilityNoteActive');
      }
      const baseDone = draft.creatingNewResource
        ? this.botT(this.kb().lang, 'setup.doneAddedVenueActive', {
            name: draft.name ?? '',
          })
        : this.botT(this.kb().lang, 'setup.doneVenueSaved', {
            name: draft.name ?? '',
          }) + tail;
      const offered =
        ctx.from != null &&
        (await isUserAdminOfGroupChat(
          ctx.telegram,
          targetGroupChatId,
          ctx.from.id,
        ));
      this.lastSetupGroupByUser.set(uid, String(targetGroupChatId));
      if (opts?.startPerDayImmediately) {
        this.whDmStateByUser.set(uid, {
          kind: 'pick_day',
          groupChatId: targetGroupChatId,
          resourceId: resource.id,
        });
        await this.replyWithMainMenuInDmForGroup(
          ctx,
          targetGroupChatId,
          this.botT(this.kb().lang, 'whDm.pickWeekdayPreamble'),
        );
        await this.sendSetupDm(
          ctx,
          this.botT(this.kb().lang, 'whDm.pickWeekday'),
          this.whPickDayReplyMarkup(),
        );
        return;
      }
      if (offered) {
        this.whDmStateByUser.set(uid, {
          kind: 'offer',
          groupChatId: targetGroupChatId,
          resourceId: resource.id,
        });
      }
      await this.replyWithMainMenuInDmForGroup(
        ctx,
        targetGroupChatId,
        offered
          ? this.botT(this.kb().lang, 'setup.perDayKeyboardHint', {
              base: baseDone,
              whPerDay: this.kb().menuWhPerDay,
              whSkip: this.kb().menuWhSkip,
            })
          : baseDone,
        { perDayOffer: offered },
      );
    } catch (e) {
      this.logger.error(e instanceof Error ? e.message : e);
      this.setupDrafts.delete(sk);
      this.setupBridgeGroupByUser.delete(uid);
      await this.replyWithMainMenuInDmForGroup(
        ctx,
        targetGroupChatId,
        this.botT(this.kb().lang, 'setup.persistSetupFailedRetryGroup'),
      );
    }
  }

  /** Leave /setup DM session and show the usual main menu (reply keyboard). */
  private async leaveSetupSessionToMainMenu(
    ctx: Context,
    targetGroupChatId: bigint,
  ): Promise<void> {
    if (!ctx.from) {
      return;
    }
    const sk = this.setupSk(targetGroupChatId, ctx.from.id);
    this.setupDrafts.delete(sk);
    this.setupBridgeGroupByUser.delete(ctx.from.id);
    this.resetMenuState(ctx);
    await ctx.reply(
      this.botT(this.kb().lang, 'menu.title'),
      await this.mainMenuReplyMarkup(ctx),
    );
  }

  private async handleSetupText(
    ctx: Context,
    text: string,
    targetGroupChatId: bigint,
  ) {
    if (!ctx.from) {
      return;
    }
    const sk = this.setupSk(targetGroupChatId, ctx.from.id);
    const draft = this.setupDrafts.get(sk);
    if (!draft) {
      return;
    }

    const finishCancel = async () => {
      this.setupDrafts.delete(sk);
      this.setupBridgeGroupByUser.delete(ctx.from!.id);
      this.resetMenuStateForGroup(targetGroupChatId, ctx.from!.id);
      await this.replyWithMainMenuInDmForGroup(
        ctx,
        targetGroupChatId,
        this.botT(this.kb().lang, 'setup.settingsCancelledMain'),
      );
    };

    if (text.trim() === this.kb().setupCancel) {
      await finishCancel();
      return;
    }

    const chatTitle =
      draft.groupChatTitleForPrompt ??
      this.botT(this.kb().lang, 'setup.chatTitleFallback');

    if (draft.venuesSubstep === 'sport_kinds_pick') {
      const doneLabel = this.botT(this.kb().lang, 'setup.sportKindsDone');
      if (text === this.kb().menuBack) {
        draft.venuesSubstep = undefined;
        this.setupDrafts.set(sk, draft);
        await this.sendSetupDm(
          ctx,
          this.setupAddressPromptText(
            draft.setupResourceAddressLabel,
            this.setupStepMax(draft),
          ),
          this.setupAddressReplyMarkup(
            !!draft.setupResourceAddressLabel?.trim(),
          ),
        );
        return;
      }
      if (text === this.kb().menuMain) {
        await this.leaveSetupSessionToMainMenu(ctx, targetGroupChatId);
        return;
      }
      if (text === doneLabel) {
        const picked = draft.sportKindCodes ?? [];
        if (picked.length === 0) {
          await this.sendSetupDm(
            ctx,
            this.botT(this.kb().lang, 'setup.sportKindsNeedOne'),
            this.setupSportKindsReplyMarkup([]),
          );
          return;
        }
        draft.venuesSubstep = undefined;
        draft.step = 3;
        this.setupDrafts.set(sk, draft);
        await this.sendSetupDm(
          ctx,
          this.botT(this.kb().lang, 'setup.step3TzCaption', {
            stepLine: this.setupStepLine(3, draft),
          }),
          this.setupTzReplyMarkup(),
        );
        return;
      }
      const code = sportLabelToCodeMap(this.i18n, this.kb().lang).get(
        text.replace(/^✅\s+/, ''),
      );
      if (!code) {
        return;
      }
      const set = new Set(draft.sportKindCodes ?? []);
      if (set.has(code)) {
        set.delete(code);
      } else {
        set.add(code);
      }
      draft.sportKindCodes = [...set];
      this.setupDrafts.set(sk, draft);
      await this.sendSetupDm(
        ctx,
        this.botT(this.kb().lang, 'setup.sportKindsTitle'),
        this.setupSportKindsReplyMarkup(draft.sportKindCodes),
      );
      return;
    }

    switch (draft.step) {
      case 0: {
        if (draft.venuesSubstep === 'rules_lang_pick') {
          if (text === this.kb().menuMain) {
            draft.venuesSubstep = 'hub';
            delete draft.rulesLanguageIdDraft;
            delete draft.rulesLanguageNameDraft;
            this.setupDrafts.set(sk, draft);
            await this.sendSetupDm(
              ctx,
              this.setupHubPromptText(chatTitle),
              this.setupVenuesHubReplyMarkup(),
            );
            return;
          }
          if (text === this.kb().menuBack) {
            draft.venuesSubstep = 'hub';
            delete draft.rulesLanguageIdDraft;
            delete draft.rulesLanguageNameDraft;
            this.setupDrafts.set(sk, draft);
            await this.sendSetupDm(
              ctx,
              this.setupHubPromptText(chatTitle),
              this.setupVenuesHubReplyMarkup(),
            );
            return;
          }
          const langs = await this.telegramMembers.listLanguagesForPicker();
          const m = text.match(/^(\d+)\.\s/);
          if (!m) {
            await this.sendSetupDm(
              ctx,
              this.botT(this.kb().lang, 'setup.rulesPickNumberOrBack', {
                back: this.kb().menuBack,
              }),
              this.setupRulesLanguageReplyMarkup(langs),
            );
            return;
          }
          const idx = Number(m[1]) - 1;
          const rulesLangRow = langs[idx];
          if (!rulesLangRow) {
            await this.sendSetupDm(
              ctx,
              this.botT(this.kb().lang, 'setup.rulesPickNumberOrBack', {
                back: this.kb().menuBack,
              }),
              this.setupRulesLanguageReplyMarkup(langs),
            );
            return;
          }
          const currentRules = await this.community.getCommunityRulesForChat(
            targetGroupChatId,
            rulesLangRow.id,
          );
          draft.venuesSubstep = 'rules_edit';
          draft.rulesLanguageIdDraft = rulesLangRow.id;
          draft.rulesLanguageNameDraft = rulesLangRow.nameNative;
          this.setupDrafts.set(sk, draft);
          await this.sendSetupDm(
            ctx,
            currentRules
              ? this.botT(this.kb().lang, 'setup.rulesEditReplace', {
                  native: rulesLangRow.nameNative,
                  id: rulesLangRow.id,
                  rules: currentRules,
                })
              : this.botT(this.kb().lang, 'setup.rulesEditCreate', {
                  native: rulesLangRow.nameNative,
                  id: rulesLangRow.id,
                }),
            Markup.keyboard([
              [this.kb().menuBack, this.kb().menuMain],
              [this.kb().setupCancel],
            ])
              .resize()
              .persistent(true),
          );
          return;
        }

        if (draft.venuesSubstep === 'rules_edit') {
          if (text === this.kb().menuMain) {
            draft.venuesSubstep = 'hub';
            delete draft.rulesLanguageIdDraft;
            delete draft.rulesLanguageNameDraft;
            this.setupDrafts.set(sk, draft);
            await this.sendSetupDm(
              ctx,
              this.setupHubPromptText(chatTitle),
              this.setupVenuesHubReplyMarkup(),
            );
            return;
          }
          if (text === this.kb().menuBack) {
            draft.venuesSubstep = 'rules_lang_pick';
            this.setupDrafts.set(sk, draft);
            const langs = await this.telegramMembers.listLanguagesForPicker();
            await this.sendSetupDm(
              ctx,
              this.botT(this.kb().lang, 'setup.rulesPickEditLanguage'),
              this.setupRulesLanguageReplyMarkup(langs),
            );
            return;
          }
          const rulesText = text.trim();
          if (!rulesText) {
            await this.sendSetupDm(
              ctx,
              this.botT(this.kb().lang, 'setup.rulesEmptyBody', {
                back: this.kb().menuBack,
              }),
            );
            return;
          }
          if (rulesText.length > 12000) {
            await this.sendSetupDm(
              ctx,
              this.botT(this.kb().lang, 'setup.rulesTooLong'),
            );
            return;
          }
          try {
            await this.community.upsertCommunityRulesForChat({
              telegramChatId: targetGroupChatId,
              text: rulesText,
              languageId: draft.rulesLanguageIdDraft ?? 'ua',
            });
          } catch (e) {
            this.logger.error(e instanceof Error ? e.message : e);
            await this.sendSetupDm(
              ctx,
              this.botT(this.kb().lang, 'setup.rulesSaveFailed'),
            );
            return;
          }
          draft.venuesSubstep = 'hub';
          this.setupDrafts.set(sk, draft);
          await this.sendSetupDm(
            ctx,
            this.botT(this.kb().lang, 'rules.rulesSaved', {
              lang:
                draft.rulesLanguageNameDraft ??
                draft.rulesLanguageIdDraft ??
                'ua',
            }),
            this.setupVenuesHubReplyMarkup(),
          );
          return;
        }
        if (
          draft.venuesSubstep === 'all_bookings_pick_day' ||
          draft.venuesSubstep === 'all_bookings_list'
        ) {
          if (text === this.kb().menuMain || text === this.kb().menuBack) {
            draft.venuesSubstep = 'hub';
            delete draft.allBookingsDayOffsetDraft;
            delete draft.allBookingsRowLabelsDraft;
            delete draft.allBookingsBookingIdsDraft;
            this.setupDrafts.set(sk, draft);
            await this.sendSetupDm(
              ctx,
              this.setupHubPromptText(chatTitle),
              this.setupVenuesHubReplyMarkup(),
            );
            return;
          }
          let dayOffset: 0 | 1 | undefined;
          if (text === this.kb().menuDayToday) {
            dayOffset = 0;
          } else if (text === this.kb().menuDayTomorrow) {
            dayOffset = 1;
          }
          if (dayOffset !== undefined) {
            const rows = await this.booking.listAllBookingsForChatDay({
              telegramChatId: targetGroupChatId,
              dayOffset,
            });
            if (rows.length === 0) {
              draft.venuesSubstep = 'all_bookings_pick_day';
              draft.allBookingsDayOffsetDraft = dayOffset;
              draft.allBookingsRowLabelsDraft = [];
              draft.allBookingsBookingIdsDraft = [];
              this.setupDrafts.set(sk, draft);
              await this.sendSetupDm(
                ctx,
                dayOffset === 0
                  ? this.botT(this.kb().lang, 'setup.allBookingsEmptyToday')
                  : this.botT(this.kb().lang, 'setup.allBookingsEmptyTomorrow'),
                this.setupAllBookingsDayReplyMarkup(),
              );
              return;
            }
            const items = rows.map((r) => ({
              startTime: r.startTime,
              endTime: r.endTime,
              timeZone: r.resource.timeZone,
              resourceName: r.resource.name,
              sportKindCode: r.sportKindCode,
              userName:
                r.userName?.trim() ||
                this.botT(this.kb().lang, 'setup.adminPlayerFallback'),
            }));
            const rowLabels = items.map((it) =>
              this.buildAdminAllBookingButtonLabel(it),
            );
            const bookingIds = rows.map((r) => r.id);
            draft.venuesSubstep = 'all_bookings_list';
            draft.allBookingsDayOffsetDraft = dayOffset;
            draft.allBookingsRowLabelsDraft = rowLabels;
            draft.allBookingsBookingIdsDraft = bookingIds;
            this.setupDrafts.set(sk, draft);
            const header =
              dayOffset === 0
                ? this.botT(this.kb().lang, 'setup.allBookingsHeaderToday')
                : this.botT(this.kb().lang, 'setup.allBookingsHeaderTomorrow');
            const listText = items
              .map((it) =>
                this.buildAdminAllBookingButtonLabel(it, {
                  includeCancelSuffix: false,
                }),
              )
              .join('\n');
            await this.sendSetupDm(
              ctx,
              `${header}\n\n${listText}`,
              this.adminAllBookingsReplyMarkup(rowLabels),
            );
            return;
          }
          if (draft.venuesSubstep === 'all_bookings_list') {
            const labels = draft.allBookingsRowLabelsDraft;
            const ids = draft.allBookingsBookingIdsDraft;
            if (labels?.length && ids?.length === labels.length) {
              const bIdx = labels.indexOf(text);
              if (bIdx !== -1 && ids[bIdx]) {
                if (
                  !(await this.isAdminInContextGroup(ctx, targetGroupChatId))
                ) {
                  await this.sendSetupDm(
                    ctx,
                    this.botT(
                      this.kb().lang,
                      'setup.adminCancelBookingNoPermission',
                    ),
                  );
                  return;
                }
                const bookingId = ids[bIdx];
                const dayKeep = draft.allBookingsDayOffsetDraft ?? 0;
                try {
                  const notify = await this.booking.cancelBooking({
                    bookingId,
                    telegramChatId: targetGroupChatId,
                    telegramUserId: ctx.from.id,
                    asGroupAdmin: true,
                    noticeLocale: this.kb().lang,
                  });
                  await this.sendBookingCancellationAlerts(ctx, notify);
                  const rowsAfter =
                    await this.booking.listAllBookingsForChatDay({
                      telegramChatId: targetGroupChatId,
                      dayOffset: dayKeep,
                    });
                  if (rowsAfter.length === 0) {
                    draft.venuesSubstep = 'all_bookings_pick_day';
                    draft.allBookingsDayOffsetDraft = dayKeep;
                    delete draft.allBookingsRowLabelsDraft;
                    delete draft.allBookingsBookingIdsDraft;
                    this.setupDrafts.set(sk, draft);
                    await this.sendSetupDm(
                      ctx,
                      this.botT(
                        this.kb().lang,
                        'setup.allBookingsCanceledPickDay',
                      ),
                      this.setupAllBookingsDayReplyMarkup(),
                    );
                    return;
                  }
                  const itemsAfter = rowsAfter.map((r) => ({
                    startTime: r.startTime,
                    endTime: r.endTime,
                    timeZone: r.resource.timeZone,
                    resourceName: r.resource.name,
                    sportKindCode: r.sportKindCode,
                    userName:
                      r.userName?.trim() ||
                      this.botT(this.kb().lang, 'setup.adminPlayerFallback'),
                  }));
                  const rowLabelsAfter = itemsAfter.map((it) =>
                    this.buildAdminAllBookingButtonLabel(it),
                  );
                  draft.venuesSubstep = 'all_bookings_list';
                  draft.allBookingsDayOffsetDraft = dayKeep;
                  draft.allBookingsRowLabelsDraft = rowLabelsAfter;
                  draft.allBookingsBookingIdsDraft = rowsAfter.map((r) => r.id);
                  this.setupDrafts.set(sk, draft);
                  const headerAfter =
                    dayKeep === 0
                      ? this.botT(
                          this.kb().lang,
                          'setup.allBookingsCanceledHeaderToday',
                        )
                      : this.botT(
                          this.kb().lang,
                          'setup.allBookingsCanceledHeaderTomorrow',
                        );
                  const listTextAfter = itemsAfter
                    .map((it) =>
                      this.buildAdminAllBookingButtonLabel(it, {
                        includeCancelSuffix: false,
                      }),
                    )
                    .join('\n');
                  await this.sendSetupDm(
                    ctx,
                    `${headerAfter}\n\n${listTextAfter}`,
                    this.adminAllBookingsReplyMarkup(rowLabelsAfter),
                  );
                  return;
                } catch (e) {
                  if (e instanceof BookingNotFoundError) {
                    await this.sendSetupDm(
                      ctx,
                      this.botT(
                        this.kb().lang,
                        'setup.allBookingsNotFoundRefresh',
                        {
                          today: this.kb().menuDayToday,
                          tomorrow: this.kb().menuDayTomorrow,
                        },
                      ),
                      this.setupAllBookingsDayReplyMarkup(),
                    );
                    return;
                  }
                  throw e;
                }
              }
            }
          }
          await this.sendSetupDm(
            ctx,
            this.botT(this.kb().lang, 'setup.allBookingsPickDayHint', {
              today: this.kb().menuDayToday,
              tomorrow: this.kb().menuDayTomorrow,
            }),
            this.setupAllBookingsDayReplyMarkup(),
          );
          return;
        }
        if (
          await this.handleSetupBookingLimitFlow(
            ctx,
            text,
            draft,
            sk,
            targetGroupChatId,
            chatTitle,
          )
        ) {
          return;
        }
        if (
          await this.handleSetupBookingWindowFlow(
            ctx,
            text,
            draft,
            sk,
            targetGroupChatId,
            chatTitle,
          )
        ) {
          return;
        }
        const list = await this.resources.listForChat(targetGroupChatId);
        if (
          await this.handleSetupRecurringFlow(
            ctx,
            text,
            draft,
            sk,
            targetGroupChatId,
            chatTitle,
            list,
          )
        ) {
          return;
        }

        let linkable: {
          id: string;
          name: string;
          address?: string | null;
          visibility: ResourceVisibility;
        }[] = [];
        const venuesSub = draft.venuesSubstep ?? 'list';

        if (venuesSub === 'hub') {
          if (text === this.kb().setupVenues) {
            draft.venuesSubstep = 'list';
            this.setupDrafts.set(sk, draft);
            await this.sendSetupDm(
              ctx,
              this.botT(this.kb().lang, 'setup.venuesPickIntro'),
              this.setupPickResourceReplyMarkup(list),
            );
            return;
          }
          if (text === this.kb().setupGroupRules) {
            const langs = await this.telegramMembers.listLanguagesForPicker();
            if (langs.length === 0) {
              await this.sendSetupDm(
                ctx,
                this.botT(this.kb().lang, 'setup.noLanguagesInDb'),
              );
              return;
            }
            draft.venuesSubstep = 'rules_lang_pick';
            delete draft.rulesLanguageIdDraft;
            delete draft.rulesLanguageNameDraft;
            this.setupDrafts.set(sk, draft);
            await this.sendSetupDm(
              ctx,
              this.botT(this.kb().lang, 'setup.rulesPickCreateLanguage'),
              this.setupRulesLanguageReplyMarkup(langs),
            );
            return;
          }
          if (text === this.kb().setupBookingWindow) {
            const comm =
              await this.community.findByTelegramChatId(targetGroupChatId);
            if (!comm) {
              await this.sendSetupDm(
                ctx,
                this.botT(this.kb().lang, 'setup.configureVenueFirst', {
                  venues: this.kb().setupVenues,
                }),
              );
              return;
            }
            draft.venuesSubstep = 'bw_tz';
            delete draft.bwTzDraft;
            delete draft.bwStartHourDraft;
            this.setupDrafts.set(sk, draft);
            await this.sendSetupDm(
              ctx,
              this.botT(this.kb().lang, 'setup.bookingWindowWizardIntro', {
                current: this.formatBookingWindowSummary(comm),
              }),
              this.setupTzReplyMarkup(),
            );
            return;
          }
          if (text === this.kb().setupBookingLimit) {
            const comm =
              await this.community.findByTelegramChatId(targetGroupChatId);
            if (!comm) {
              await this.sendSetupDm(
                ctx,
                this.botT(this.kb().lang, 'setup.configureVenueFirst', {
                  venues: this.kb().setupVenues,
                }),
              );
              return;
            }
            const limits =
              await this.community.getUserBookingLimitsForChat(
                targetGroupChatId,
              );
            draft.venuesSubstep = 'limit_pick_day';
            delete draft.limitWeekdayDraft;
            this.setupDrafts.set(sk, draft);
            await this.sendSetupDm(
              ctx,
              this.botT(this.kb().lang, 'setup.limitWizardIntro', {
                summary: this.formatUserBookingLimitsSummary(limits),
              }),
              this.setupLimitWeekdayReplyMarkup(),
            );
            return;
          }
          if (text === this.kb().setupAllBookings) {
            draft.venuesSubstep = 'all_bookings_pick_day';
            delete draft.allBookingsDayOffsetDraft;
            delete draft.allBookingsRowLabelsDraft;
            delete draft.allBookingsBookingIdsDraft;
            this.setupDrafts.set(sk, draft);
            await this.sendSetupDm(
              ctx,
              this.botT(this.kb().lang, 'setup.allBookingsPickDayTitle'),
              this.setupAllBookingsDayReplyMarkup(),
            );
            return;
          }
          if (text === this.kb().setupRecurringBookings) {
            if (list.length === 0) {
              await this.sendSetupDm(
                ctx,
                this.botT(this.kb().lang, 'setup.configureVenueFirst', {
                  venues: this.kb().setupVenues,
                }),
              );
              return;
            }
            draft.venuesSubstep = 'recurring_pick_resource';
            this.clearRecurringDraft(draft);
            this.setupDrafts.set(sk, draft);
            await this.sendSetupDm(
              ctx,
              this.botT(this.kb().lang, 'setup.recurringPickVenue'),
              this.setupRecurringPickResourceReplyMarkup(list),
            );
            return;
          }
          if (text === this.kb().setupLinkExistingResource) {
            const raw = await this.resources.listLinkableForChatAdmin({
              telegramChatId: targetGroupChatId,
              adminTelegramUserId: ctx.from.id,
            });
            const allowed: typeof raw = [];
            for (const row of raw) {
              let ok = false;
              for (const rel of row.communityResources) {
                const gid = rel.community.telegramChatId;
                if (gid === targetGroupChatId) {
                  continue;
                }
                if (
                  await isUserAdminOfGroupChat(ctx.telegram, gid, ctx.from.id)
                ) {
                  ok = true;
                  break;
                }
              }
              if (ok) {
                allowed.push(row);
              }
            }
            linkable = allowed.map((r) => ({
              id: r.id,
              name: r.name,
              address: r.address,
              visibility: r.visibility,
            }));
            if (linkable.length === 0) {
              await this.sendSetupDm(
                ctx,
                this.botT(this.kb().lang, 'setup.linkNoCandidates'),
              );
              return;
            }
            draft.venuesSubstep = 'link_pick';
            this.setupDrafts.set(sk, draft);
            await this.sendSetupDm(
              ctx,
              this.botT(this.kb().lang, 'setup.linkPickPrompt'),
              this.setupLinkExistingResourceReplyMarkup(linkable),
            );
            return;
          }
          await this.sendSetupDm(ctx, this.setupHubPromptText(chatTitle));
          return;
        }

        if (venuesSub === 'list' && text === this.kb().menuMain) {
          await this.leaveSetupSessionToMainMenu(ctx, targetGroupChatId);
          return;
        }

        if (venuesSub === 'link_pick') {
          if (text === this.kb().menuMain) {
            await this.leaveSetupSessionToMainMenu(ctx, targetGroupChatId);
            return;
          }
          if (text === this.kb().menuBack) {
            draft.venuesSubstep = 'hub';
            this.setupDrafts.set(sk, draft);
            await this.sendSetupDm(
              ctx,
              this.setupHubPromptText(chatTitle),
              this.setupVenuesHubReplyMarkup(),
            );
            return;
          }
          const raw = await this.resources.listLinkableForChatAdmin({
            telegramChatId: targetGroupChatId,
            adminTelegramUserId: ctx.from.id,
          });
          const allowed: typeof raw = [];
          for (const row of raw) {
            let ok = false;
            for (const rel of row.communityResources) {
              const gid = rel.community.telegramChatId;
              if (gid === targetGroupChatId) {
                continue;
              }
              if (
                await isUserAdminOfGroupChat(ctx.telegram, gid, ctx.from.id)
              ) {
                ok = true;
                break;
              }
            }
            if (ok) {
              allowed.push(row);
            }
          }
          linkable = allowed.map((r) => ({
            id: r.id,
            name: r.name,
            address: r.address,
            visibility: r.visibility,
          }));
          const m = text.match(/^(\d+)\.\s/);
          if (!m) {
            await this.sendSetupDm(
              ctx,
              this.botT(this.kb().lang, 'setup.pickNumberOrBackButton', {
                back: this.kb().menuBack,
              }),
            );
            return;
          }
          const idx = Number(m[1]) - 1;
          const picked = linkable[idx];
          if (!picked) {
            await this.sendSetupDm(
              ctx,
              this.botT(this.kb().lang, 'setup.pickNumberOrBackButton', {
                back: this.kb().menuBack,
              }),
            );
            return;
          }
          try {
            await this.community.linkExistingResourceToCommunityFromSetup({
              telegramChatId: targetGroupChatId,
              adminTelegramUserId: ctx.from.id,
              resourceId: picked.id,
            });
          } catch (e) {
            this.logger.error(e instanceof Error ? e.message : e);
            await this.sendSetupDm(
              ctx,
              this.botT(this.kb().lang, 'setup.linkFailed'),
            );
            return;
          }
          draft.venuesSubstep = 'hub';
          this.setupDrafts.set(sk, draft);
          await this.sendSetupDm(
            ctx,
            this.botT(this.kb().lang, 'setup.linkDone', { name: picked.name }),
            this.setupVenuesHubReplyMarkup(),
          );
          return;
        }

        if (text === this.kb().menuBack) {
          draft.venuesSubstep = 'hub';
          delete draft.resourceId;
          delete draft.multiResourceFlow;
          delete draft.creatingNewResource;
          delete draft.setupResourceLabel;
          delete draft.setupResourceAddressLabel;
          delete draft.setupResourceVisibility;
          delete draft.name;
          this.setupDrafts.set(sk, draft);
          await this.sendSetupDm(
            ctx,
            this.setupHubPromptText(chatTitle),
            this.setupVenuesHubReplyMarkup(),
          );
          return;
        }

        if (text === this.kb().setupNewResource) {
          draft.creatingNewResource = true;
          delete draft.resourceId;
          delete draft.multiResourceFlow;
          delete draft.setupResourceLabel;
          draft.setupResourceAddressLabel = null;
          draft.step = 1;
          this.setupDrafts.set(sk, draft);
          await this.sendSetupDm(
            ctx,
            this.botT(this.kb().lang, 'setup.newVenueIntro') +
              this.setupStep1PromptText(chatTitle, {
                newResource: true,
                stepMax: this.setupStepMax(draft),
              }),
            this.setupStep1ReplyMarkup(true, undefined, { newResource: true }),
          );
          return;
        }
        const m = text.match(/^(\d+)\.\s/);
        if (!m) {
          await this.sendSetupDm(
            ctx,
            this.botT(this.kb().lang, 'setup.pickNumberOrNewResource', {
              newResource: this.kb().setupNewResource,
            }),
          );
          return;
        }
        const idx = Number(m[1]) - 1;
        const r = list[idx];
        if (!r) {
          await this.sendSetupDm(
            ctx,
            this.botT(this.kb().lang, 'setup.pickNumberOrNewResource', {
              newResource: this.kb().setupNewResource,
            }),
          );
          return;
        }
        draft.resourceId = r.id;
        draft.multiResourceFlow = list.length >= 2;
        delete draft.creatingNewResource;
        draft.setupResourceLabel = r.name;
        draft.setupResourceAddressLabel = r.address ?? null;
        draft.setupResourceVisibility = r.visibility;
        draft.sportKindCodes = this.resourceSportKindCodes(r);
        draft.step = 1;
        this.setupDrafts.set(sk, draft);
        await this.sendSetupDm(
          ctx,
          this.botT(this.kb().lang, 'setup.pickedVenueHeader', {
            name: r.name,
          }) +
            this.setupStep1PromptText(chatTitle, {
              existingResourceName: r.name,
              multiFlow: draft.multiResourceFlow,
              stepMax: this.setupStepMax(draft),
            }),
          this.setupStep1ReplyMarkup(true, r.name, { showDeleteVenue: true }),
        );
        return;
      }
      case 1: {
        if (text === this.kb().menuMain) {
          await this.leaveSetupSessionToMainMenu(ctx, targetGroupChatId);
          return;
        }
        if (draft.setupResourceDeleteConfirm) {
          if (text === this.kb().menuBack) {
            delete draft.setupResourceDeleteConfirm;
            this.setupDrafts.set(sk, draft);
            await this.sendSetupDm(
              ctx,
              this.botT(this.kb().lang, 'setup.pickedVenueHeader', {
                name: draft.setupResourceLabel ?? '\u2026',
              }) +
                this.setupStep1PromptText(chatTitle, {
                  existingResourceName: draft.setupResourceLabel,
                  multiFlow: !!draft.multiResourceFlow,
                  stepMax: this.setupStepMax(draft),
                }),
              this.setupStep1ReplyMarkup(
                !!(draft.multiResourceFlow || draft.creatingNewResource),
                draft.setupResourceLabel,
                this.setupStep1Opts(draft),
              ),
            );
            return;
          }
          if (text === this.kb().setupConfirmDeleteResource) {
            if (!draft.resourceId) {
              delete draft.setupResourceDeleteConfirm;
              this.setupDrafts.set(sk, draft);
              return;
            }
            if (!(await this.isAdminInContextGroup(ctx, targetGroupChatId))) {
              await this.sendSetupDm(
                ctx,
                this.botT(this.kb().lang, 'setup.deleteResourceNoPermission'),
              );
              return;
            }
            try {
              const result =
                await this.resources.deleteResourceForCommunityFromSetup({
                  telegramChatId: targetGroupChatId,
                  resourceId: draft.resourceId,
                });
              draft.step = 0;
              delete draft.resourceId;
              delete draft.multiResourceFlow;
              delete draft.creatingNewResource;
              delete draft.setupResourceLabel;
              delete draft.setupResourceAddressLabel;
              delete draft.setupResourceVisibility;
              delete draft.name;
              delete draft.setupResourceDeleteConfirm;
              draft.venuesSubstep = 'list';
              this.setupDrafts.set(sk, draft);
              const listBack =
                await this.resources.listForChat(targetGroupChatId);
              const doneMsg =
                result.mode === 'unlinked'
                  ? this.botT(this.kb().lang, 'setup.deleteUnlinkedResult', {
                      name: result.resourceName,
                    })
                  : this.botT(this.kb().lang, 'setup.deleteFullRemovedResult', {
                      name: result.resourceName,
                    });
              await this.sendSetupDm(
                ctx,
                this.botT(this.kb().lang, 'setup.pickVenueOrAddAfterChange', {
                  done: doneMsg,
                }),
                this.setupPickResourceReplyMarkup(listBack),
              );
            } catch (e) {
              const msg =
                e instanceof Error &&
                e.message === 'RESOURCE_NOT_LINKED_TO_CHAT'
                  ? this.botT(this.kb().lang, 'setup.deleteNotLinkedOrRemoved')
                  : this.botT(this.kb().lang, 'setup.deleteFailedTryLater');
              if (
                !(
                  e instanceof Error &&
                  e.message === 'RESOURCE_NOT_LINKED_TO_CHAT'
                )
              ) {
                this.logger.error(e instanceof Error ? e.message : e);
              }
              delete draft.setupResourceDeleteConfirm;
              this.setupDrafts.set(sk, draft);
              await this.sendSetupDm(
                ctx,
                msg,
                this.setupStep1ReplyMarkup(
                  !!(draft.multiResourceFlow || draft.creatingNewResource),
                  draft.setupResourceLabel,
                  this.setupStep1Opts(draft),
                ),
              );
            }
            return;
          }
          await this.sendSetupDm(
            ctx,
            this.botT(this.kb().lang, 'setup.deleteConfirmInstruction', {
              confirm: this.kb().setupConfirmDeleteResource,
              back: this.kb().menuBack,
            }),
            this.setupResourceDeleteConfirmReplyMarkup(),
          );
          return;
        }

        if (
          text === this.kb().setupDeleteResource &&
          draft.resourceId &&
          !draft.creatingNewResource
        ) {
          if (!(await this.isAdminInContextGroup(ctx, targetGroupChatId))) {
            await this.sendSetupDm(
              ctx,
              this.botT(this.kb().lang, 'setup.deleteResourceNoPermission'),
            );
            return;
          }
          draft.setupResourceDeleteConfirm = true;
          this.setupDrafts.set(sk, draft);
          await this.sendSetupDm(
            ctx,
            this.botT(this.kb().lang, 'setup.deleteConfirmTitle', {
              name: draft.setupResourceLabel ?? '',
            }) +
              this.botT(this.kb().lang, 'setup.deleteConfirmBody1') +
              this.botT(this.kb().lang, 'setup.deleteConfirmBody2') +
              this.botT(this.kb().lang, 'setup.deleteConfirmBody3'),
            this.setupResourceDeleteConfirmReplyMarkup(),
          );
          return;
        }

        if (
          text === this.kb().menuBack &&
          (draft.multiResourceFlow || draft.creatingNewResource)
        ) {
          draft.step = 0;
          delete draft.resourceId;
          delete draft.multiResourceFlow;
          delete draft.creatingNewResource;
          delete draft.setupResourceLabel;
          delete draft.setupResourceAddressLabel;
          delete draft.setupResourceVisibility;
          delete draft.name;
          delete draft.setupResourceDeleteConfirm;
          draft.venuesSubstep = 'list';
          this.setupDrafts.set(sk, draft);
          const listBack = await this.resources.listForChat(targetGroupChatId);
          await this.sendSetupDm(
            ctx,
            this.botT(this.kb().lang, 'setup.venuesPickIntro'),
            this.setupPickResourceReplyMarkup(listBack),
          );
          return;
        }
        let name: string;
        let communityNameSource: PrismaClient.CommunityNameSource;
        if (text === this.kb().setupKeepBotName) {
          if (!draft.setupResourceLabel) {
            if (draft.creatingNewResource) {
              await this.sendSetupDm(
                ctx,
                this.botT(this.kb().lang, 'setup.step1NameNewResourceText'),
              );
            }
            return;
          }
          name = draft.setupResourceLabel;
          communityNameSource = PrismaClient.CommunityNameSource.MANUAL;
        } else if (text === this.kb().setupUseChatTitle) {
          if (draft.creatingNewResource) {
            await this.sendSetupDm(
              ctx,
              this.botT(this.kb().lang, 'setup.step1NameFromChatNotForNew'),
            );
            return;
          }
          const t = draft.groupChatTitleForPrompt?.trim();
          if (!t) {
            await this.sendSetupDm(
              ctx,
              this.botT(this.kb().lang, 'setup.step1ChatTitleMissing'),
            );
            return;
          }
          name = t;
          communityNameSource = PrismaClient.CommunityNameSource.AUTO;
        } else {
          const trimmed = text.trim();
          if (!trimmed) {
            await this.sendSetupDm(
              ctx,
              draft.setupResourceLabel
                ? this.botT(this.kb().lang, 'setup.step1NameOrKeep', {
                    keep: this.kb().setupKeepBotName,
                  })
                : draft.creatingNewResource
                  ? this.botT(this.kb().lang, 'setup.step1NameRequired')
                  : this.botT(this.kb().lang, 'setup.step1NameOrChatTitle', {
                      useChatTitle: this.kb().setupUseChatTitle,
                    }),
            );
            return;
          }
          if (trimmed.length > 200) {
            await this.sendSetupDm(
              ctx,
              this.botT(this.kb().lang, 'setup.nameTooLong'),
            );
            return;
          }
          name = trimmed;
          communityNameSource = PrismaClient.CommunityNameSource.MANUAL;
        }
        draft.name = name;
        draft.communityNameSource = communityNameSource;
        draft.step = 2;
        delete draft.resourceAddress;
        this.setupDrafts.set(sk, draft);
        await this.sendSetupDm(
          ctx,
          this.setupAddressPromptText(
            draft.setupResourceAddressLabel,
            this.setupStepMax(draft),
          ),
          this.setupAddressReplyMarkup(
            !!draft.setupResourceAddressLabel?.trim(),
          ),
        );
        return;
      }
      case 2: {
        if (text === this.kb().menuMain) {
          await this.leaveSetupSessionToMainMenu(ctx, targetGroupChatId);
          return;
        }
        if (text === this.kb().menuBack) {
          draft.step = 1;
          delete draft.name;
          delete draft.resourceAddress;
          delete draft.timeZone;
          delete draft.slotStart;
          delete draft.slotEnd;
          this.setupDrafts.set(sk, draft);
          await this.sendSetupDm(
            ctx,
            draft.creatingNewResource && !draft.setupResourceLabel
              ? this.botT(this.kb().lang, 'setup.newVenueIntro') +
                  this.setupStep1PromptText(chatTitle, {
                    newResource: true,
                    stepMax: this.setupStepMax(draft),
                  })
              : this.setupStep1PromptText(chatTitle, {
                  existingResourceName: draft.setupResourceLabel,
                  multiFlow: !!draft.multiResourceFlow,
                  stepMax: this.setupStepMax(draft),
                }),
            this.setupStep1ReplyMarkup(
              !!(draft.multiResourceFlow || draft.creatingNewResource),
              draft.setupResourceLabel,
              this.setupStep1Opts(draft),
            ),
          );
          return;
        }
        let addr: string | null;
        if (text === this.kb().setupKeepAddress) {
          const cur = draft.setupResourceAddressLabel?.trim();
          if (!cur) {
            return;
          }
          addr = draft.setupResourceAddressLabel!.trim();
        } else if (text === this.kb().setupNoAddress) {
          addr = null;
        } else {
          const trimmed = text.trim();
          if (!trimmed) {
            await this.sendSetupDm(
              ctx,
              draft.setupResourceAddressLabel?.trim()
                ? this.botT(this.kb().lang, 'setup.addressTextOrButton')
                : this.botT(this.kb().lang, 'setup.addressTextOrNoAddress', {
                    noAddress: this.kb().setupNoAddress,
                  }),
            );
            return;
          }
          if (trimmed.length > 300) {
            await this.sendSetupDm(
              ctx,
              this.botT(this.kb().lang, 'setup.addressTooLong'),
            );
            return;
          }
          addr = trimmed;
        }
        draft.resourceAddress = addr;
        draft.venuesSubstep = 'sport_kinds_pick';
        draft.sportKindCodes =
          draft.sportKindCodes && draft.sportKindCodes.length > 0
            ? draft.sportKindCodes
            : this.allSportKindCodesForPicker();
        this.setupDrafts.set(sk, draft);
        await this.sendSetupDm(
          ctx,
          this.botT(this.kb().lang, 'setup.sportKindsTitle'),
          this.setupSportKindsReplyMarkup(draft.sportKindCodes),
        );
        return;
      }
      case 3: {
        if (text === this.kb().menuMain) {
          await this.leaveSetupSessionToMainMenu(ctx, targetGroupChatId);
          return;
        }
        if (text === this.kb().menuBack) {
          draft.step = 2;
          delete draft.timeZone;
          delete draft.slotStart;
          delete draft.slotEnd;
          delete draft.resourceAddress;
          this.setupDrafts.set(sk, draft);
          await this.sendSetupDm(
            ctx,
            this.setupAddressPromptText(
              draft.setupResourceAddressLabel,
              this.setupStepMax(draft),
            ),
            this.setupAddressReplyMarkup(
              !!draft.setupResourceAddressLabel?.trim(),
            ),
          );
          return;
        }
        const tzIdx = this.setupTzLabelIndex(text);
        if (tzIdx < 0) {
          return;
        }
        draft.timeZone = SETUP_TIMEZONES[tzIdx];
        // Тимчасовий однаковий графік для БД; далі адмін налаштовує кожен день окремо.
        draft.slotStart = 8;
        draft.slotEnd = 21;
        const isEditExisting = !!draft.resourceId && !draft.creatingNewResource;
        if (isEditExisting) {
          draft.postTzVisibilityOnly = true;
          draft.step = 6;
          this.setupDrafts.set(sk, draft);
          const cur =
            draft.setupResourceVisibility === ResourceVisibility.INACTIVE
              ? this.botT(this.kb().lang, 'setup.visibilityCurrentInactive')
              : this.botT(this.kb().lang, 'setup.visibilityCurrentActive');
          await this.sendSetupDm(
            ctx,
            this.botT(this.kb().lang, 'setup.step6StatusAfterTz', {
              stepLine: this.setupStepLine(6, draft),
              current: cur,
            }),
            this.setupResourceVisibilityReplyMarkup(),
          );
          return;
        }
        this.setupDrafts.set(sk, draft);
        await this.persistSetupDraft(
          ctx,
          draft,
          ResourceVisibility.ACTIVE,
          targetGroupChatId,
          { startPerDayImmediately: true },
        );
        return;
      }
      case 4: {
        if (text === this.kb().menuMain) {
          await this.leaveSetupSessionToMainMenu(ctx, targetGroupChatId);
          return;
        }
        if (text === this.kb().menuBack) {
          draft.step = 3;
          delete draft.timeZone;
          delete draft.slotStart;
          delete draft.slotEnd;
          this.setupDrafts.set(sk, draft);
          await this.sendSetupDm(
            ctx,
            this.botT(this.kb().lang, 'setup.step3TzCaption', {
              stepLine: this.setupStepLine(3, draft),
            }),
            this.setupTzReplyMarkup(),
          );
          return;
        }
        const hm = text.match(/^(\d{1,2}):00$/);
        if (!hm) {
          return;
        }
        const hour = Number(hm[1]);
        if (!Number.isInteger(hour) || hour < 0 || hour > 22) {
          await this.sendSetupDm(
            ctx,
            this.botT(this.kb().lang, 'setup.workingHoursPickRange'),
          );
          return;
        }
        draft.slotStart = hour;
        delete draft.slotEnd;
        draft.step = 5;
        this.setupDrafts.set(sk, draft);
        await this.sendSetupDm(
          ctx,
          this.botT(this.kb().lang, 'setup.step5ClosingHours', {
            stepLine: this.setupStepLine(5, draft),
            hour: String(hour).padStart(2, '0'),
          }),
          this.setupClosingHourReplyMarkup(hour),
        );
        return;
      }
      case 5: {
        if (text === this.kb().menuMain) {
          await this.leaveSetupSessionToMainMenu(ctx, targetGroupChatId);
          return;
        }
        if (text === this.kb().menuBack) {
          draft.step = 4;
          delete draft.slotStart;
          delete draft.slotEnd;
          this.setupDrafts.set(sk, draft);
          await this.sendSetupDm(
            ctx,
            this.botT(this.kb().lang, 'setup.step4OpeningHours', {
              stepLine: this.setupStepLine(4, draft),
            }),
            this.setupStartHourReplyMarkup(),
          );
          return;
        }
        const hm = text.match(/^(\d{1,2}):00$/);
        if (!hm) {
          return;
        }
        const closeHour = Number(hm[1]);
        const start = draft.slotStart;
        if (
          start === undefined ||
          !Number.isInteger(closeHour) ||
          closeHour < 0 ||
          closeHour > 23
        ) {
          return;
        }
        if (closeHour <= start) {
          await this.sendSetupDm(
            ctx,
            this.botT(this.kb().lang, 'setup.endAfterStartPickOther'),
          );
          return;
        }
        draft.slotEnd = closeHour - 1;
        if (
          !draft.name ||
          draft.resourceAddress === undefined ||
          !draft.timeZone ||
          draft.slotStart === undefined ||
          draft.slotEnd === undefined
        ) {
          this.setupDrafts.delete(sk);
          this.setupBridgeGroupByUser.delete(ctx.from.id);
          await this.replyWithMainMenuInDmForGroup(
            ctx,
            targetGroupChatId,
            this.botT(this.kb().lang, 'setup.sessionStale'),
          );
          return;
        }
        const isEditExisting = !!draft.resourceId && !draft.creatingNewResource;
        if (isEditExisting) {
          draft.step = 6;
          this.setupDrafts.set(sk, draft);
          const cur =
            draft.setupResourceVisibility === ResourceVisibility.INACTIVE
              ? this.botT(this.kb().lang, 'setup.visibilityCurrentInactive')
              : this.botT(this.kb().lang, 'setup.visibilityCurrentActive');
          await this.sendSetupDm(
            ctx,
            this.botT(this.kb().lang, 'setup.step6StatusWithHours', {
              stepLine: this.setupStepLine(6, draft),
              current: cur,
            }),
            this.setupResourceVisibilityReplyMarkup(),
          );
          return;
        }
        await this.persistSetupDraft(
          ctx,
          draft,
          ResourceVisibility.ACTIVE,
          targetGroupChatId,
        );
        return;
      }
      case 6: {
        if (text === this.kb().menuMain) {
          await this.leaveSetupSessionToMainMenu(ctx, targetGroupChatId);
          return;
        }
        if (draft.postTzVisibilityOnly) {
          if (text === this.kb().menuBack) {
            delete draft.postTzVisibilityOnly;
            draft.step = 3;
            delete draft.timeZone;
            delete draft.slotStart;
            delete draft.slotEnd;
            this.setupDrafts.set(sk, draft);
            await this.sendSetupDm(
              ctx,
              this.botT(this.kb().lang, 'setup.step3TzCaption', {
                stepLine: this.setupStepLine(3, draft),
              }),
              this.setupTzReplyMarkup(),
            );
            return;
          }
          let vis: ResourceVisibility | undefined;
          if (text === this.kb().setupResourceActive) {
            vis = ResourceVisibility.ACTIVE;
          } else if (text === this.kb().setupResourceInactive) {
            vis = ResourceVisibility.INACTIVE;
          }
          if (vis === undefined) {
            return;
          }
          delete draft.postTzVisibilityOnly;
          this.setupDrafts.set(sk, draft);
          await this.persistSetupDraft(ctx, draft, vis, targetGroupChatId, {
            startPerDayImmediately: true,
          });
          return;
        }
        if (text === this.kb().menuBack) {
          draft.step = 5;
          delete draft.slotEnd;
          this.setupDrafts.set(sk, draft);
          const hour = draft.slotStart;
          if (hour === undefined) {
            this.setupDrafts.delete(sk);
            this.setupBridgeGroupByUser.delete(ctx.from.id);
            await this.replyWithMainMenuInDmForGroup(
              ctx,
              targetGroupChatId,
              this.botT(this.kb().lang, 'setup.sessionStale'),
            );
            return;
          }
          await this.sendSetupDm(
            ctx,
            this.botT(this.kb().lang, 'setup.step5ClosingHours', {
              stepLine: this.setupStepLine(5, draft),
              hour: String(hour).padStart(2, '0'),
            }),
            this.setupClosingHourReplyMarkup(hour),
          );
          return;
        }
        let vis: ResourceVisibility | undefined;
        if (text === this.kb().setupResourceActive) {
          vis = ResourceVisibility.ACTIVE;
        } else if (text === this.kb().setupResourceInactive) {
          vis = ResourceVisibility.INACTIVE;
        }
        if (vis === undefined) {
          return;
        }
        await this.persistSetupDraft(ctx, draft, vis, targetGroupChatId);
        return;
      }
      default:
        return;
    }
  }

  private rulesWelcomeIntro(languageId: string | null | undefined): string {
    const lang = resolveUiLang(languageId);
    return this.botT(lang, 'rules.welcomeIntro');
  }

  /**
   * Rules in DM; if that fails (no /start, bot blocked) — to the group.
   * Callback includes groupChatId so the button works from private chat.
   */
  private async sendCommunityRulesMessages(
    telegram: Context['telegram'],
    groupChatId: bigint,
    targetUserId: number,
    rulesText: string,
    opts?: {
      allowGroupFallback?: boolean;
      /** Membership language used for the intro text only. */
      rulesLocaleLanguageId?: string | null;
    },
  ): Promise<{ usedDm: boolean }> {
    const intro = this.rulesWelcomeIntro(opts?.rulesLocaleLanguageId);
    const full = `${intro}${rulesText}`;
    const chunks: string[] = [];
    for (let i = 0; i < full.length; i += RULES_MESSAGE_CHUNK) {
      chunks.push(full.slice(i, i + RULES_MESSAGE_CHUNK));
    }
    const groupStr = groupChatId.toString();
    const cbData = `gr:${targetUserId}:${groupStr}`;
    const rulesLang = resolveUiLang(opts?.rulesLocaleLanguageId);
    const rulesAcceptLabel = this.botT(rulesLang, 'rules.accept');
    const lastExtra = {
      reply_markup: {
        inline_keyboard: [[{ text: rulesAcceptLabel, callback_data: cbData }]],
      },
    };

    const sendAll = async (dest: number) => {
      for (let i = 0; i < chunks.length; i++) {
        const last = i === chunks.length - 1;
        await telegram.sendMessage(
          dest,
          chunks[i],
          last ? lastExtra : undefined,
        );
      }
    };

    try {
      await sendAll(targetUserId);
      return { usedDm: true };
    } catch (e) {
      if (opts?.allowGroupFallback === false) {
        throw e;
      }
      this.logger.warn(
        `rules to DM failed user=${targetUserId}, fallback to group: ${e instanceof Error ? e.message : String(e)}`,
      );
      const me = await telegram.getMe();
      const deepLink = `https://t.me/${me.username}?start=${START_RULES_PREFIX}${groupStr}`;
      const sent = await telegram.sendMessage(
        Number(groupChatId),
        this.botT(rulesLang, 'rules.openBotForRules'),
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: this.botT(rulesLang, 'rules.openBotButton'),
                  url: deepLink,
                },
              ],
            ],
          },
        },
      );
      this.rulesPromptMessageByUserGroup.set(
        this.rulesPromptSk(groupChatId, targetUserId),
        sent.message_id,
      );
      return { usedDm: false };
    }
  }

  /**
   * Language picker only in DM. If Telegram blocks first contact, posts a hint in the group with an open-bot link.
   */
  /** First-time DM /start: pick global default UI language (stored on TelegramUser). */
  private async sendUserDefaultLanguagePicker(
    telegram: Context['telegram'],
    targetUserId: number,
  ): Promise<void> {
    const langs = await this.telegramMembers.listLanguagesForPicker();
    const rows = langs.map((l) => [
      {
        text: l.nameNative,
        callback_data: `userlang:${targetUserId}:${l.id}`,
      },
    ]);
    const effId = await this.telegramMembers.getEffectiveLanguageId({
      telegramChatId: null,
      telegramUserId: targetUserId,
    });
    const introLang =
      effId != null && effId.length > 0
        ? resolveUiLang(effId)
        : UI_LANGUAGE_PROMPT_NEUTRAL_LANG;
    const intro = this.botT(introLang, 'rules.languagePickerIntro');
    await telegram.sendMessage(targetUserId, intro, {
      reply_markup: { inline_keyboard: rows },
    });
  }

  private async finishDmStartAfterUserProfile(ctx: Context): Promise<void> {
    if (!ctx.from) {
      return;
    }
    this.resetMenuState(ctx);
    const lang = await this.langForCtx(ctx);
    const gid = await this.promptGroupPickerInDm(ctx, {
      hint: this.botT(lang, 'dm.pickGroupHint'),
    });
    if (gid == null) {
      return;
    }
    await ctx.reply(
      this.botT(lang, 'menu.title'),
      await this.mainMenuReplyMarkup(ctx),
    );
  }

  /**
   * Sends the language inline keyboard in DM. If Telegram forbids first contact,
   * posts a short hint in the group with an "open bot" link (no language buttons in group).
   */
  private async sendLanguagePickerMessages(
    telegram: Context['telegram'],
    groupChatId: bigint,
    targetUserId: number,
  ): Promise<'dm' | 'group_hint'> {
    const langs = await this.telegramMembers.listLanguagesForPicker();
    const groupStr = groupChatId.toString();
    const rows = langs.map((l) => [
      {
        text: l.nameNative,
        callback_data: `lang:${targetUserId}:${groupStr}:${l.id}`,
      },
    ]);
    const effId = await this.telegramMembers.getEffectiveLanguageId({
      telegramChatId: groupChatId,
      telegramUserId: targetUserId,
    });
    const introLang =
      effId != null && effId.length > 0
        ? resolveUiLang(effId)
        : UI_LANGUAGE_PROMPT_NEUTRAL_LANG;
    const intro = this.botT(introLang, 'rules.languagePickerIntro');
    const extra = {
      reply_markup: { inline_keyboard: rows },
    };
    try {
      await telegram.sendMessage(targetUserId, intro, extra);
      return 'dm';
    } catch (e) {
      if (!this.isTelegramBotCannotInitiateDmError(e)) {
        throw e;
      }
      this.logger.warn(
        `language picker: DM blocked (user must open bot first); user=${targetUserId} group=${groupChatId}`,
      );
      const me = await telegram.getMe();
      if (!me.username) {
        throw e;
      }
      const neutral = UI_LANGUAGE_PROMPT_NEUTRAL_LANG;
      const hint = `${this.botT(neutral, 'rules.chooseLanguageInDm')}\n\n${this.botT(neutral, 'menu.openDmAndStart')}`;
      await telegram.sendMessage(Number(groupChatId), hint, {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: this.botT(neutral, 'rules.openBotButton'),
                url: `https://t.me/${me.username}`,
              },
            ],
          ],
        },
      });
      return 'group_hint';
    }
  }

  /**
   * For non-admins: sync join, then require language (in community chats) and rules before menu actions.
   * @returns true if the user may continue; false if onboarding messages were sent / user must finish first.
   */
  private async ensureParticipantGroupOnboarding(
    ctx: Context,
    groupChatId: bigint,
  ): Promise<boolean> {
    if (!ctx.from) {
      return true;
    }
    if (await isUserAdminOfGroupChat(ctx.telegram, groupChatId, ctx.from.id)) {
      return true;
    }
    const joinResult = await this.telegramMembers.recordJoin({
      telegramChatId: groupChatId,
      telegramUserId: ctx.from.id,
      username: ctx.from.username,
      firstName: ctx.from.first_name,
      lastName: ctx.from.last_name,
    });
    if (joinResult.pendingLanguageSelection) {
      try {
        await this.sendLanguagePickerMessages(
          ctx.telegram,
          groupChatId,
          ctx.from.id,
        );
      } catch (e) {
        this.logger.warn(
          `language picker: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      return false;
    }
    if (joinResult.pendingGroupRules && joinResult.rulesText) {
      try {
        const localeId = await this.telegramMembers.getEffectiveLanguageId({
          telegramChatId: groupChatId,
          telegramUserId: ctx.from.id,
        });
        await this.sendCommunityRulesMessages(
          ctx.telegram,
          groupChatId,
          ctx.from.id,
          joinResult.rulesText,
          {
            allowGroupFallback: true,
            rulesLocaleLanguageId: localeId,
          },
        );
      } catch (e) {
        this.logger.warn(
          `rules send in onboarding gate: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      return false;
    }
    if (
      await this.telegramMembers.participantMustAcceptGroupRules({
        telegramChatId: groupChatId,
        telegramUserId: ctx.from.id,
      })
    ) {
      const rulesText = await this.telegramMembers.getGroupRulesText(
        groupChatId,
        ctx.from.id,
      );
      if (rulesText) {
        try {
          const localeId = await this.telegramMembers.getEffectiveLanguageId({
            telegramChatId: groupChatId,
            telegramUserId: ctx.from.id,
          });
          await this.sendCommunityRulesMessages(
            ctx.telegram,
            groupChatId,
            ctx.from.id,
            rulesText,
            {
              allowGroupFallback: true,
              rulesLocaleLanguageId: localeId,
            },
          );
        } catch (e) {
          this.logger.warn(
            `rules resend in onboarding gate: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      return false;
    }
    return true;
  }

  @On('chat_member')
  async onChatMember(@Ctx() ctx: Context) {
    const up = ctx.chatMember;
    if (!up?.chat?.id) {
      return;
    }
    const { chat } = up;
    if (chat.type !== 'group' && chat.type !== 'supergroup') {
      return;
    }
    const newM = up.new_chat_member;
    const oldM = up.old_chat_member;
    if (newM.user.is_bot) {
      return;
    }
    const chatId = BigInt(chat.id);
    const u = newM.user;
    const wasIn = TelegramMembersService.isStatusInChat(oldM.status);
    const nowIn = TelegramMembersService.isStatusInChat(newM.status);
    await this.syncAutoCommunityNameFromChat(
      chatId,
      'title' in chat ? chat.title : undefined,
    );

    if (!nowIn && wasIn) {
      await this.telegramMembers.recordLeave({
        telegramChatId: chatId,
        telegramUserId: u.id,
      });
      return;
    }

    if (nowIn) {
      const joinResult = await this.telegramMembers.recordJoin({
        telegramChatId: chatId,
        telegramUserId: u.id,
        username: u.username,
        firstName: u.first_name,
        lastName: u.last_name,
      });

      if (!wasIn) {
        const memberLbl = await this.labelsForUserInGroup(chatId, u.id);
        if (joinResult.pendingLanguageSelection) {
          try {
            const where = await this.sendLanguagePickerMessages(
              ctx.telegram,
              chatId,
              u.id,
            );
            if (where === 'dm') {
              try {
                const sent = await ctx.telegram.sendMessage(
                  chat.id,
                  this.botT(
                    UI_LANGUAGE_PROMPT_NEUTRAL_LANG,
                    'rules.chooseLanguageInDm',
                  ),
                );
                this.deleteMessageLater(
                  ctx.telegram,
                  Number(chat.id),
                  sent.message_id,
                  5000,
                );
              } catch (e) {
                this.logger.warn(
                  `chat_member language ping: ${e instanceof Error ? e.message : String(e)}`,
                );
              }
            }
          } catch (e) {
            this.logger.warn(
              `chat_member language picker: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
          return;
        }

        if (joinResult.pendingGroupRules && joinResult.rulesText) {
          try {
            const localeId = await this.telegramMembers.getEffectiveLanguageId({
              telegramChatId: chatId,
              telegramUserId: u.id,
            });
            const { usedDm } = await this.sendCommunityRulesMessages(
              ctx.telegram,
              chatId,
              u.id,
              joinResult.rulesText,
              {
                allowGroupFallback: true,
                rulesLocaleLanguageId: localeId,
              },
            );
            if (usedDm) {
              try {
                const sent = await ctx.telegram.sendMessage(
                  chat.id,
                  this.botT(memberLbl.lang, 'rules.rulesSentToDmPing'),
                );
                this.deleteMessageLater(
                  ctx.telegram,
                  Number(chat.id),
                  sent.message_id,
                  5000,
                );
              } catch (e) {
                this.logger.warn(
                  `chat_member rules ping: ${e instanceof Error ? e.message : String(e)}`,
                );
              }
            }
          } catch (e) {
            this.logger.warn(
              `chat_member rules: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
          return;
        }

        const comm = await this.community.findByTelegramChatId(chatId);
        const ready = comm && comm.resources.length > 0;
        if (ready) {
          this.resetMenuStateForGroup(chatId, u.id);
        }
        const text = ready
          ? this.botT(memberLbl.lang, 'groupWelcome.ready', {
              chatBot: GROUP_REPLY_CHAT_BOT,
            })
          : this.botT(memberLbl.lang, 'groupWelcome.notReady');
        try {
          const kb = this.groupEntryReplyMarkupForChatUser();
          await ctx.telegram.sendMessage(chat.id, text, kb);
        } catch (e) {
          this.logger.warn(
            `chat_member welcome: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }
  }

  @On('my_chat_member')
  async onMyChatMember(@Ctx() ctx: Context) {
    const up = ctx.myChatMember;
    if (!up || !ctx.chat?.id) {
      return;
    }
    const bot = await ctx.telegram.getMe();
    const nu = up.new_chat_member;
    if (nu.user.id !== bot.id) {
      return;
    }
    if (!['member', 'administrator'].includes(nu.status)) {
      return;
    }
    const groupChatId = BigInt(ctx.chat.id);
    await this.syncAutoCommunityNameFromChat(
      groupChatId,
      'title' in ctx.chat ? ctx.chat.title : undefined,
    );
    const actorId = up.from?.id ?? ctx.from?.id;
    const actorEffLang =
      actorId != null
        ? await this.telegramMembers.getEffectiveLanguageId({
            telegramChatId: groupChatId,
            telegramUserId: actorId,
          })
        : null;
    const actorLbl =
      actorId != null
        ? await this.labelsForUserInGroup(groupChatId, actorId)
        : this.L(UI_LANGUAGE_PROMPT_NEUTRAL_LANG);
    if (nu.status === 'administrator') {
      if (actorId != null && actorEffLang == null) {
        try {
          const where = await this.sendLanguagePickerMessages(
            ctx.telegram,
            groupChatId,
            actorId,
          );
          if (where === 'dm') {
            try {
              const sent = await ctx.reply(
                this.botT(
                  UI_LANGUAGE_PROMPT_NEUTRAL_LANG,
                  'rules.chooseLanguageInDm',
                ),
              );
              this.deleteMessageLater(
                ctx.telegram,
                Number(ctx.chat.id),
                sent.message_id,
                5000,
              );
            } catch (e) {
              this.logger.warn(
                `my_chat_member language ping: ${e instanceof Error ? e.message : String(e)}`,
              );
            }
          }
        } catch (e) {
          this.logger.warn(
            `my_chat_member language picker: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        return;
      }
      await ctx.reply(
        this.botT(actorLbl.lang, 'group.botAddedIntro'),
        this.groupEntryReplyMarkupForChatUser(),
      );
      return;
    }
    const needsAdminLbl =
      actorId != null && actorEffLang != null
        ? actorLbl
        : this.L(UI_LANGUAGE_PROMPT_NEUTRAL_LANG);
    await ctx.reply(
      this.botT(needsAdminLbl.lang, 'group.botNeedsAdmin'),
      this.groupEntryReplyMarkupForChatUser(),
    );
  }

  @Start()
  async onStart(@Ctx() ctx: Context) {
    if (!ctx.from) {
      return;
    }

    if (ctx.chat && !isGroupChat(ctx)) {
      const startPayload =
        ctx.message &&
        'text' in ctx.message &&
        typeof ctx.message.text === 'string'
          ? (ctx.message.text.trim().split(/\s+/, 2)[1] ?? '')
          : '';
      if (startPayload.startsWith(START_RULES_PREFIX)) {
        const gidStr = startPayload.slice(START_RULES_PREFIX.length);
        if (/^-?\d+$/.test(gidStr)) {
          const groupChatId = BigInt(gidStr);
          const rulesPromptSk = this.rulesPromptSk(groupChatId, ctx.from.id);
          const rulesPromptMsgId =
            this.rulesPromptMessageByUserGroup.get(rulesPromptSk);
          if (rulesPromptMsgId != null) {
            this.rulesPromptMessageByUserGroup.delete(rulesPromptSk);
            try {
              await ctx.telegram.deleteMessage(
                Number(groupChatId),
                rulesPromptMsgId,
              );
            } catch {
              /* message already deleted or no rights */
            }
          }
          const rulesText = await this.telegramMembers.getGroupRulesText(
            groupChatId,
            ctx.from.id,
          );
          const localeId = await this.telegramMembers.getEffectiveLanguageId({
            telegramChatId: groupChatId,
            telegramUserId: ctx.from.id,
          });
          if (!rulesText) {
            await ctx.reply(
              this.botT(resolveUiLang(localeId), 'rules.groupRulesNotFound'),
            );
            return;
          }
          this.activeGroupByUser.set(ctx.from.id, groupChatId);
          try {
            await this.sendCommunityRulesMessages(
              ctx.telegram,
              groupChatId,
              ctx.from.id,
              rulesText,
              {
                allowGroupFallback: false,
                rulesLocaleLanguageId: localeId,
              },
            );
          } catch {
            const lbl = this.L(localeId);
            await ctx.reply(
              this.botT(lbl.lang, 'rules.sendRulesFailedRetry', {
                chatBot: GROUP_REPLY_CHAT_BOT,
              }),
            );
          }
          return;
        }
      }
      const { defaultLanguageId } =
        await this.telegramMembers.upsertTelegramUser({
          telegramUserId: ctx.from.id,
          username: ctx.from.username,
          firstName: ctx.from.first_name,
          lastName: ctx.from.last_name,
        });
      if (defaultLanguageId == null) {
        try {
          await this.sendUserDefaultLanguagePicker(ctx.telegram, ctx.from.id);
        } catch (e) {
          this.logger.warn(
            `user default language picker: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        return;
      }
      await this.finishDmStartAfterUserProfile(ctx);
      return;
    }

    if (!isGroupChat(ctx) || !ctx.chat) {
      return;
    }

    if (ctx.message && 'message_id' in ctx.message) {
      this.deleteMessageLater(
        ctx.telegram,
        Number(ctx.chat.id),
        ctx.message.message_id,
        5000,
      );
    }

    const startLbl = await this.labelsForUserInGroup(
      BigInt(ctx.chat.id),
      ctx.from.id,
    );
    await ctx.reply(
      this.botT(startLbl.lang, 'group.startInGroupHint', {
        chatBot: GROUP_REPLY_CHAT_BOT,
      }),
      this.groupEntryReplyMarkupForChatUser(),
    );
  }

  @Command('setup')
  async onSetup(@Ctx() ctx: Context) {
    await this.runGroupSetup(ctx);
  }

  /** Мастер настройки в ЛС: из группы (/setup, кнопка) или из ЛС («Настройки»). */
  private async openSetupDmSession(params: {
    telegram: Context['telegram'];
    from: NonNullable<Context['from']>;
    groupChatId: bigint;
    chatTitle: string;
    deleteTriggerMessage?: { chatId: number; messageId: number };
  }): Promise<void> {
    const { telegram, from, groupChatId, chatTitle, deleteTriggerMessage } =
      params;
    // Ensure admin is present in memberships for this group even if no chat_member event was received.
    await this.telegramMembers.recordJoin({
      telegramChatId: groupChatId,
      telegramUserId: from.id,
      username: from.username,
      firstName: from.first_name,
      lastName: from.last_name,
    });
    const groupIdStr = groupChatId.toString();
    this.lastSetupGroupByUser.set(from.id, groupIdStr);
    this.resetMenuStateForGroup(groupChatId, from.id);
    const sk = this.setupSk(groupChatId, from.id);

    const tryDeleteTriggerMessage = async () => {
      if (!deleteTriggerMessage) {
        return;
      }
      try {
        await telegram.deleteMessage(
          deleteTriggerMessage.chatId,
          deleteTriggerMessage.messageId,
        );
      } catch {
        /* нет прав на удаление */
      }
    };

    const startDm = async (
      draft: SetupDraft,
      firstText: string,
      firstExtra: NonNullable<Parameters<Context['reply']>[1]>,
    ) => {
      this.setupDrafts.set(sk, draft);
      this.setupBridgeGroupByUser.set(from.id, groupIdStr);
      await telegram.sendMessage(from.id, firstText, { ...firstExtra });
      await tryDeleteTriggerMessage();
    };

    const setupLbl = await this.labelsForUserInGroup(groupChatId, from.id);
    this.activeGroupByUser.set(from.id, groupChatId);

    await this.withBotLabels(setupLbl, async () => {
      try {
        const comm = await this.community.findByTelegramChatId(groupChatId);
        if (comm && comm.resources.length >= 1) {
          await startDm(
            {
              step: 0,
              groupChatTitleForPrompt: chatTitle,
              venuesSubstep: 'hub',
            },
            this.setupHubPromptText(chatTitle),
            this.setupVenuesHubReplyMarkup(),
          );
          return;
        }

        const resourceId =
          comm?.resources.length === 1 ? comm.resources[0].id : undefined;
        const setupResourceLabel = comm?.resources[0]?.name;
        const setupResourceAddressLabel = comm?.resources[0]?.address ?? null;
        const setupResourceVisibility = comm?.resources[0]?.visibility;
        const draftOne: SetupDraft = {
          step: 1,
          communityNameSource: PrismaClient.CommunityNameSource.AUTO,
          groupChatTitleForPrompt: chatTitle,
          setupResourceAddressLabel,
          ...(resourceId ? { resourceId } : {}),
          ...(setupResourceLabel ? { setupResourceLabel } : {}),
          ...(setupResourceVisibility !== undefined
            ? { setupResourceVisibility }
            : {}),
        };
        const intro = this.botT(
          this.kb().lang,
          'setup.dmSessionIntroParagraph',
          { title: chatTitle },
        );
        await startDm(
          draftOne,
          `${intro}\n\n${this.setupStep1PromptText(chatTitle, {
            existingResourceName: setupResourceLabel,
            multiFlow: false,
            stepMax: this.setupStepMax(draftOne),
          })}`,
          this.setupStep1ReplyMarkup(
            false,
            setupResourceLabel,
            resourceId ? { showDeleteVenue: true } : undefined,
          ),
        );
      } catch (e) {
        this.setupDrafts.delete(sk);
        this.setupBridgeGroupByUser.delete(from.id);
        throw e;
      }
    });
  }

  /** Запуск настройки из группы: команда /setup или кнопка «Настройки». */
  private async runGroupSetup(ctx: Context) {
    if (!ctx.from || !ctx.chat?.id || !isGroupChat(ctx)) {
      return;
    }
    if (!(await isGroupAdmin(ctx))) {
      const adminLbl = await this.labelsForUserInGroup(
        BigInt(ctx.chat.id),
        ctx.from.id,
      );
      await this.replyTransientInGroup(
        ctx,
        this.botT(adminLbl.lang, 'group.setupAdminOnly'),
      );
      return;
    }
    if (!(await this.isBotAdminInGroup(ctx.telegram, BigInt(ctx.chat.id)))) {
      const userLbl = await this.labelsForUserInGroup(
        BigInt(ctx.chat.id),
        ctx.from.id,
      );
      await this.replyTransientInGroup(
        ctx,
        this.botT(userLbl.lang, 'group.botNeedsAdmin'),
      );
      return;
    }

    const titleLbl = await this.labelsForUserInGroup(
      BigInt(ctx.chat.id),
      ctx.from.id,
    );
    const chatTitle =
      ctx.chat && 'title' in ctx.chat && ctx.chat.title
        ? ctx.chat.title
        : this.botT(titleLbl.lang, 'setup.chatTitleFallback');

    const groupChatId = BigInt(ctx.chat.id);

    this.resetMenuState(ctx);

    try {
      await this.openSetupDmSession({
        telegram: ctx.telegram,
        from: ctx.from,
        groupChatId,
        chatTitle,
        deleteTriggerMessage:
          ctx.message && 'message_id' in ctx.message
            ? {
                chatId: Number(ctx.chat.id),
                messageId: ctx.message.message_id,
              }
            : undefined,
      });
    } catch (e) {
      this.logger.warn(e instanceof Error ? e.message : 'setup DM failed');
      await this.replyTransientInGroup(
        ctx,
        this.botT(titleLbl.lang, 'group.setupDmOpenFailed'),
      );
    }
  }

  /** userlang:userId:languageId — set global default UI language (private /start). */
  @Action(USERLANG_CALLBACK_RE)
  async onPickUserDefaultLanguage(@Ctx() ctx: Context) {
    const q = ctx.callbackQuery;
    if (!q || !('data' in q) || typeof q.data !== 'string' || !ctx.from) {
      return;
    }
    const parsed = parseUserlangCallback(q.data);
    if (!parsed) {
      return;
    }
    const { telegramUserId: expectedUserId, languageId } = parsed;
    const cbLang = await this.langForDmUser(ctx.from.id, null);
    if (ctx.from.id !== expectedUserId) {
      await ctx.answerCbQuery(this.botT(cbLang, 'callbacks.wrongUser'), {
        show_alert: true,
      });
      return;
    }
    await ctx.answerCbQuery();
    const saved = await this.telegramMembers.setUserDefaultLanguage({
      telegramUserId: ctx.from.id,
      languageId,
      username: ctx.from.username,
      firstName: ctx.from.first_name,
      lastName: ctx.from.last_name,
    });
    if (!saved.ok) {
      await ctx.reply(this.botT(cbLang, 'callbacks.saveLanguageFailed'));
      return;
    }
    try {
      await ctx.editMessageText(
        this.botT(resolveUiLang(languageId), 'rules.languageSaved'),
      );
    } catch {
      /* not a text message or already edited */
    }
    await this.finishDmStartAfterUserProfile(ctx);
  }

  /** lang:userId:groupChatId:languageId — pick UI language for this group membership. */
  @Action(/^lang:(\d+):(-?\d+):([\w-]+)$/)
  async onPickGroupLanguage(@Ctx() ctx: Context) {
    const q = ctx.callbackQuery;
    if (!q || !('data' in q) || typeof q.data !== 'string' || !ctx.from) {
      return;
    }
    const mm = /^lang:(\d+):(-?\d+):([\w-]+)$/.exec(q.data);
    if (!mm) {
      return;
    }
    const expectedUserId = Number(mm[1]);
    const groupChatId = BigInt(mm[2]);
    const languageId = mm[3];
    const pickLang = await this.langForDmUser(ctx.from.id, groupChatId);
    if (ctx.from.id !== expectedUserId) {
      await ctx.answerCbQuery(this.botT(pickLang, 'callbacks.wrongUser'), {
        show_alert: true,
      });
      return;
    }
    try {
      const member = await ctx.telegram.getChatMember(
        groupChatId.toString(),
        ctx.from.id,
      );
      if (!TelegramMembersService.isStatusInChat(member.status)) {
        await ctx.answerCbQuery(
          this.botT(pickLang, 'callbacks.notGroupMember'),
          {
            show_alert: true,
          },
        );
        return;
      }
    } catch {
      await ctx.answerCbQuery(
        this.botT(pickLang, 'callbacks.groupOrMemberUnavailable'),
        {
          show_alert: true,
        },
      );
      return;
    }
    await ctx.answerCbQuery();
    const previousLang = await this.telegramMembers.getMembershipLanguageId({
      telegramChatId: groupChatId,
      telegramUserId: ctx.from.id,
    });
    const saved = await this.telegramMembers.setMembershipLanguage({
      telegramChatId: groupChatId,
      telegramUserId: ctx.from.id,
      languageId,
    });
    if (!saved.ok) {
      await ctx.reply(this.botT(pickLang, 'callbacks.saveLanguageFailed'));
      return;
    }
    try {
      await ctx.editMessageText(
        this.botT(resolveUiLang(languageId), 'rules.languageSaved'),
      );
    } catch {
      /* not a text message or already edited */
    }

    const joinResult = await this.telegramMembers.recordJoin({
      telegramChatId: groupChatId,
      telegramUserId: ctx.from.id,
      username: ctx.from.username,
      firstName: ctx.from.first_name,
      lastName: ctx.from.last_name,
    });

    if (joinResult.pendingGroupRules && joinResult.rulesText) {
      try {
        await this.sendCommunityRulesMessages(
          ctx.telegram,
          groupChatId,
          ctx.from.id,
          joinResult.rulesText,
          {
            allowGroupFallback: true,
            rulesLocaleLanguageId: languageId,
          },
        );
      } catch (e) {
        this.logger.warn(
          `after language pick, rules send: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      return;
    }

    const cbMsg = ctx.callbackQuery?.message;
    const isPrivateLangPick =
      cbMsg != null &&
      'chat' in cbMsg &&
      cbMsg.chat != null &&
      cbMsg.chat.type === 'private';

    if (previousLang == null) {
      await this.withLabelsLang(languageId, async () => {
        const from = ctx.from!;
        const comm = await this.community.findByTelegramChatId(groupChatId);
        const ready = comm && comm.resources.length > 0;
        if (ready) {
          this.resetMenuStateForGroup(groupChatId, from.id);
        }
        const lbl = this.kb();
        const welcomeText = ready
          ? this.botT(lbl.lang, 'groupWelcome.ready', {
              chatBot: GROUP_REPLY_CHAT_BOT,
            })
          : this.botT(lbl.lang, 'groupWelcome.notReady');
        try {
          const kb = this.groupEntryReplyMarkupForChatUser();
          await ctx.telegram.sendMessage(Number(groupChatId), welcomeText, kb);
        } catch (e) {
          this.logger.warn(
            `after language pick, group welcome: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      });
    }

    if (
      isPrivateLangPick &&
      languageId !== previousLang &&
      !joinResult.pendingGroupRules
    ) {
      const from = ctx.from;
      const ui = resolveUiLang(languageId);
      this.activeGroupByUser.set(from.id, groupChatId);
      try {
        await ctx.telegram.sendMessage(
          from.id,
          this.botT(ui, 'menu.languageChanged'),
          await this.mainMenuReplyMarkupForDmUser(ctx.telegram, from.id),
        );
      } catch (e) {
        this.logger.warn(
          `after language pick, DM menu: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  /** gr:userId или gr:userId:groupChatId (второй вариант — кнопка из ЛС). */
  @Action(/^gr:(\d+)(?::(-?\d+))?$/)
  async onAcceptGroupRules(@Ctx() ctx: Context) {
    const q = ctx.callbackQuery;
    if (!q || !('data' in q) || typeof q.data !== 'string' || !ctx.from) {
      return;
    }
    const mm = /^gr:(\d+)(?::(-?\d+))?$/.exec(q.data);
    if (!mm) {
      return;
    }
    const expectedUserId = Number(mm[1]);
    const groupIdStr = mm[2];
    const rulesCbLangEarly = await this.langForDmUser(ctx.from.id, null);
    if (ctx.from.id !== expectedUserId) {
      await ctx.answerCbQuery(
        this.botT(rulesCbLangEarly, 'callbacks.wrongUser'),
        {
          show_alert: true,
        },
      );
      return;
    }
    let groupChatId: bigint | null = null;
    if (groupIdStr != null && groupIdStr !== '') {
      groupChatId = BigInt(groupIdStr);
    } else if (ctx.chat && isGroupChat(ctx)) {
      groupChatId = BigInt(ctx.chat.id);
    }
    if (groupChatId === null) {
      await ctx.answerCbQuery(
        this.botT(rulesCbLangEarly, 'callbacks.groupNotResolved'),
        { show_alert: true },
      );
      return;
    }
    const rulesCbLang = await this.langForDmUser(ctx.from.id, groupChatId);
    try {
      const member = await ctx.telegram.getChatMember(
        groupChatId.toString(),
        ctx.from.id,
      );
      if (!TelegramMembersService.isStatusInChat(member.status)) {
        await ctx.answerCbQuery(
          this.botT(rulesCbLang, 'callbacks.notGroupMember'),
          {
            show_alert: true,
          },
        );
        await ctx.reply(
          this.botT(rulesCbLang, 'rules.acceptConfirmOnlyForMember'),
        );
        return;
      }
    } catch {
      await ctx.answerCbQuery(
        this.botT(rulesCbLang, 'callbacks.groupOrMemberUnavailable'),
        {
          show_alert: true,
        },
      );
      return;
    }
    await ctx.answerCbQuery();
    const r = await this.telegramMembers.acceptGroupRules({
      telegramChatId: groupChatId,
      telegramUserId: ctx.from.id,
    });
    if (!r.ok) {
      await ctx.reply(this.botT(rulesCbLang, 'callbacks.rulesAcceptFailed'));
      return;
    }
    try {
      await ctx.editMessageText(this.botT(rulesCbLang, 'rules.acceptDoneLine'));
    } catch {
      /* не текст / нет прав */
    }
    const comm = await this.community.findByTelegramChatId(groupChatId);
    const ready = comm && comm.resources.length > 0;
    if (ready) {
      this.resetMenuStateForGroup(groupChatId, ctx.from.id);
    }
    if (ready) {
      this.activeGroupByUser.set(ctx.from.id, groupChatId);
    }
    const welcomeText = ready
      ? this.botT(rulesCbLang, 'rules.welcomeAfterAcceptReady')
      : this.botT(rulesCbLang, 'rules.welcomeAfterAcceptNotReady');
    try {
      await ctx.telegram.sendMessage(
        ctx.from.id,
        welcomeText,
        await this.mainMenuReplyMarkupForDmUser(ctx.telegram, ctx.from.id),
      );
    } catch (e) {
      this.logger.warn(
        `rules accept welcome: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  @Action('m')
  async onMenu(@Ctx() ctx: Context) {
    await ctx.answerCbQuery();
    if (!ctx.from) {
      return;
    }
    if (!isGroupChat(ctx) || !ctx.chat) {
      const dmLang = await this.langForDmUser(ctx.from.id, null);
      await ctx.reply(this.botT(dmLang, 'menu.actionOnlyInGroup'));
      return;
    }
    const menuLbl = await this.labelsForUserInGroup(
      BigInt(ctx.chat.id),
      ctx.from.id,
    );
    await ctx.reply(
      this.botT(menuLbl.lang, 'menu.openDmAndStart'),
      await this.mainMenuReplyMarkup(ctx),
    );
  }
}
