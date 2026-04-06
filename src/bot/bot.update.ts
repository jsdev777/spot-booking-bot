import { Logger } from '@nestjs/common';
import { formatInTimeZone } from 'date-fns-tz';
import { Action, Command, Ctx, Next, On, Start, Update } from 'nestjs-telegraf';
import { Markup } from 'telegraf';
import type { Context } from 'telegraf';
import type { BookingDurationMinutes } from '../booking/booking-intervals';
import { isLocalTimeWithinBookingWindow } from '../booking/booking-window';
import {
  BookingService,
  type BookingStartSlot,
} from '../booking/booking.service';
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
import * as PrismaClient from '@prisma/client';
import {
  isGroupAdmin,
  isGroupChat,
  isUserAdminOfGroupChat,
} from './bot.helpers';
import { type MenuState, defaultMenuState } from './menu-state';

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

const SPORT_LABEL = {
  TENNIS: 'Теніс',
  FOOTBALL: 'Футбол',
  BASKETBALL: 'Баскетбол',
  VOLLEYBALL: 'Волейбол',
} as const satisfies Record<SportKindCode, string>;

const SPORT_ORDER: SportKindCode[] = [
  SportKindCode.TENNIS,
  SportKindCode.FOOTBALL,
  SportKindCode.BASKETBALL,
  SportKindCode.VOLLEYBALL,
];

const KIND_LABEL_TO_CODE = new Map<string, SportKindCode>(
  (Object.keys(SPORT_LABEL) as SportKindCode[]).map((t) => [SPORT_LABEL[t], t]),
);

/** Подписи reply keyboard (должны совпадать с обработчиком @On('text')). */
const MENU_KB_BOOK = 'Забронювати';
const MENU_KB_LIST = 'Мої бронювання';
const MENU_KB_GRID = 'Розклад дня';
const MENU_KB_FREE_SLOTS = 'Вільні місця';
/** Reply keyboard: текст «Настройки» + команда /setup обрабатываются одинаково. */
const MENU_KB_SETUP = 'Налаштування';
const MENU_KB_CHAT_BOT = 'Чат Бот';
const MENU_KB_SWITCH_GROUP = 'Змінити групу';
const MENU_KB_BACK = '« Назад';
const MENU_KB_MAIN = 'Головне меню';
/** Reply-меню после /setup: настройка часов по дням недели. */
const MENU_KB_WH_PER_DAY = 'Налаштувати годинник за днями';
const MENU_KB_WH_SKIP = 'Пропустити';
const MENU_KB_WH_DONE_TO_MENU = 'Готово — меню';
const WH_KB_DAY_CLOSED = 'Вихідний';
const WH_KB_DAY_SET_HOURS = 'Налаштувати годинник';
const MENU_DAY_TODAY = 'Сьогодні';
const MENU_DAY_TOMORROW = 'Завтра';
/** Шаг брони: ищете партнёров. */
const BOOK_KB_LOOKING_YES = 'Так';
const BOOK_KB_LOOKING_NO = 'Ні';
const RULES_ACCEPT_KB = 'Погоджуюся з правилами';
/** Макс. длина одного сообщения с фрагментом правил (запас под лимит Telegram). */
const RULES_MESSAGE_CHUNK = 3800;
const START_RULES_PREFIX = 'rules_';

/** Участнику при закрытом окне бронирования (сразу после «Забронировать» и перед выбором дня). */
const MSG_NO_SLOTS_BOOKING_WINDOW = 'Наразі бронювання недоступне.';

const SETUP_KB_USE_CHAT_TITLE = 'Назва, як у чаті';
/** При повторном /setup: оставить имя площадки из БД, не подставлять название чата Telegram. */
const SETUP_KB_KEEP_BOT_NAME = 'Залишити назву без змін';
const SETUP_KB_KEEP_ADDRESS = 'Залишити адресу без змін';
const SETUP_KB_NO_ADDRESS = 'Без адреси';
/** Без зайвих пробілів на кінці — інакше після `.trim()` у ЛС текст кнопки не збігається. */
const SETUP_KB_CANCEL = '« Скасування';
const SETUP_KB_VENUES = 'Усі майданчики';
const SETUP_KB_BOOKING_WINDOW = 'Час бронювання в групі';
const SETUP_KB_BOOKING_LIMIT = 'Ліміт на бронювання';
const LIMIT_KB_UNLIMITED = 'Без обмежень';
const BW_KB_END_MIDNIGHT = '24:00 — кінець дня';
const SETUP_KB_NEW_RESOURCE = '➕ Додати майданчик';
const SETUP_KB_LINK_EXISTING_RESOURCE = 'Привʼязати існуючий майданчик';
const SETUP_KB_RESOURCE_ACTIVE = 'Активна';
const SETUP_KB_RESOURCE_INACTIVE = 'Не активна';

/** ISO weekday 1–7 → подпись (Пн…Вс). */
const WH_ISO_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'] as const;

/** Дві кнопки в ряд — з `resize` займають приблизно половину ширини екрана. */
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
  /** Название группы для текстов шага 1 (мастер ведётся в ЛС). */
  groupChatTitleForPrompt?: string;
  /** Шаг 0: хаб, список площадок или мастер «время бронирования в группе». */
  venuesSubstep?:
    | 'hub'
    | 'list'
    | 'link_pick'
    | 'bw_tz'
    | 'bw_start'
    | 'bw_end'
    | 'limit_pick_day'
    | 'limit_pick_hours';
  bwTzDraft?: string;
  bwStartHourDraft?: number;
  /** ISO 1–7 для мастера лимита по дням. */
  limitWeekdayDraft?: number;
  /** Після часового поясу одразу крок видимості (істотує майданчик), без вибору єдиного «годинника». */
  postTzVisibilityOnly?: boolean;
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
  private readonly groupPickerLabelsByUser = new Map<number, Map<string, bigint>>();
  private readonly pendingDmPickerActionByUser = new Map<number, 'setup'>();
  private readonly rulesPromptMessageByUserGroup = new Map<string, number>();
  /** ЛС: предложение после /setup или выбор дня / меню дня (reply-клавиатура внизу). */
  private readonly whDmStateByUser = new Map<number, WhDmState>();
  private readonly whPerDayEditByUser = new Map<number, WhPerDayEditDraft>();
  /** Последняя группа, из которой админ вёл /setup (ЛС «Настройки» открывает её снова). */
  private readonly lastSetupGroupByUser = new Map<number, string>();

  constructor(
    private readonly booking: BookingService,
    private readonly community: CommunityService,
    private readonly resources: ResourceService,
    private readonly telegramMembers: TelegramMembersService,
  ) {}

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
    const rows: string[][] = [[MENU_KB_CHAT_BOT, MENU_KB_SETUP]];
    if (opts?.perDayOffer) {
      rows.push([MENU_KB_WH_PER_DAY, MENU_KB_WH_SKIP]);
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
    return `Крок ${step}/${this.setupStepMax(draft)}`;
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

  /**
   * Reply-меню в группе для конкретного пользователя (например новый участник по chat_member).
   * «Настройки» — только если этот пользователь админ группы.
   */
  private async mainMenuReplyMarkupForChatUser(
    telegram: Context['telegram'],
    chatId: bigint,
    forUserId: number,
  ) {
    const keys = [
      MENU_KB_BOOK,
      MENU_KB_LIST,
      MENU_KB_GRID,
      MENU_KB_FREE_SLOTS,
    ];
    if (await isUserAdminOfGroupChat(telegram, chatId, forUserId)) {
      keys.push(MENU_KB_SETUP);
    }
    keys.push(MENU_KB_MAIN);
    return Markup.keyboard(kbRowsPaired(keys)).resize().persistent(true);
  }

  /** Меню внизу экрана (reply keyboard). У админов группы — «Настройки». */
  private async mainMenuReplyMarkupForDmUser(
    telegram: Context['telegram'],
    userId: number,
  ) {
    const gid = this.activeGroupByUser.get(userId);
    const keys = [
      MENU_KB_BOOK,
      MENU_KB_LIST,
      MENU_KB_GRID,
      MENU_KB_FREE_SLOTS,
      MENU_KB_SWITCH_GROUP,
    ];
    if (
      gid != null &&
      (await isUserAdminOfGroupChat(telegram, gid, userId))
    ) {
      keys.push(MENU_KB_SETUP);
    }
    keys.push(MENU_KB_MAIN);
    return Markup.keyboard(kbRowsPaired(keys)).resize().persistent(true);
  }

  private async groupEntryReplyMarkupForChatUser(
    telegram: Context['telegram'],
    chatId: bigint,
    userId: number,
  ) {
    const rows: string[][] = [[MENU_KB_CHAT_BOT, MENU_KB_FREE_SLOTS]];
    if (await isUserAdminOfGroupChat(telegram, chatId, userId)) {
      rows[0].push(MENU_KB_SETUP);
    }
    return Markup.keyboard(rows).resize().persistent(true);
  }

  private async mainMenuReplyMarkup(ctx: Context) {
    if (ctx.from && !isGroupChat(ctx)) {
      return this.mainMenuReplyMarkupForDmUser(ctx.telegram, ctx.from.id);
    }
    if (isGroupChat(ctx) && ctx.from) {
      return this.groupEntryReplyMarkupForChatUser(
        ctx.telegram,
        BigInt(ctx.chat!.id),
        ctx.from.id,
      );
    }
    return Markup.keyboard([[MENU_KB_CHAT_BOT]])
      .resize()
      .persistent(true);
  }

  private async listAvailableGroupsForUser(
    telegram: Context['telegram'],
    userId: number,
  ) {
    const byMembership = await this.telegramMembers.listActiveUserCommunities(userId);
    const map = new Map<bigint, { telegramChatId: bigint; communityName: string | null }>();
    for (const g of byMembership) {
      map.set(g.telegramChatId, {
        telegramChatId: g.telegramChatId,
        communityName: g.communityName,
      });
    }
    const communities = await this.community.listAllCommunitiesBasic();
    for (const c of communities) {
      if (map.has(c.telegramChatId)) {
        continue;
      }
      try {
        const m = await telegram.getChatMember(c.telegramChatId.toString(), userId);
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

  private groupPickerReplyMarkup(
    items: { telegramChatId: bigint; communityName: string | null }[],
  ) {
    const rows = kbRowsPaired(
      items.map((g, i) => {
        const name = g.communityName?.trim() || `Група ${String(g.telegramChatId)}`;
        return `#${i + 1} ${name}`.slice(0, 64);
      }),
    );
    rows.push([MENU_KB_MAIN]);
    return Markup.keyboard(rows).resize().persistent(true);
  }

  private async promptGroupPickerInDm(
    ctx: Context,
    opts?: { force?: boolean; hint?: string },
  ): Promise<bigint | null> {
    if (!ctx.from || isGroupChat(ctx)) {
      return null;
    }
    const groups = await this.listAvailableGroupsForUser(
      ctx.telegram,
      ctx.from.id,
    );
    if (groups.length === 0) {
      await ctx.reply(
        'Не знайдено доступних груп. Додайте бота в групу або натисніть «Чат Бот» у потрібній групі.',
      );
      return null;
    }
    if (groups.length === 1 && !opts?.force) {
      const only = groups[0].telegramChatId;
      this.activeGroupByUser.set(ctx.from.id, only);
      this.groupPickerLabelsByUser.delete(ctx.from.id);
      return only;
    }
    const labels = new Map<string, bigint>();
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const name = g.communityName?.trim() || `Група ${String(g.telegramChatId)}`;
      labels.set(`#${i + 1} ${name}`.slice(0, 64), g.telegramChatId);
    }
    this.groupPickerLabelsByUser.set(ctx.from.id, labels);
    this.activeGroupByUser.delete(ctx.from.id);
    await ctx.reply(
      opts?.hint ?? 'Оберіть групу, для якої виконувати дії:',
      this.groupPickerReplyMarkup(groups),
    );
    return null;
  }

  private async openDmMenuForGroupFromGroupContext(ctx: Context) {
    if (!ctx.from || !ctx.chat?.id || !isGroupChat(ctx)) {
      return;
    }
    const groupChatId = BigInt(ctx.chat.id);
    this.activeGroupByUser.set(ctx.from.id, groupChatId);
    this.groupPickerLabelsByUser.delete(ctx.from.id);
    this.resetMenuStateForGroup(groupChatId, ctx.from.id);
    const comm = await this.community.findByTelegramChatId(groupChatId);
    const ready = comm && comm.resources.length > 0;
    const text = ready
      ? 'Головне меню для цієї групи:'
      : 'Група ще не налаштована. Адміністратору: /setup у групі.';
    try {
      await ctx.telegram.sendMessage(
        ctx.from.id,
        text,
        await this.mainMenuReplyMarkupForDmUser(ctx.telegram, ctx.from.id),
      );
    } catch {
      await this.replyTransientInGroup(
        ctx,
        'Не можу написати в ЛС. Відкрийте діалог зі мною, натисніть Start і знову натисніть «Чат Бот» у групі.',
      );
    }
  }

  private async openDmFreeSlotsForGroupFromGroupContext(ctx: Context) {
    if (!ctx.from || !ctx.chat?.id || !isGroupChat(ctx)) {
      return;
    }
    const groupChatId = BigInt(ctx.chat.id);
    this.activeGroupByUser.set(ctx.from.id, groupChatId);
    this.groupPickerLabelsByUser.delete(ctx.from.id);
    this.resetMenuStateForGroup(groupChatId, ctx.from.id);
    const comm = await this.community.findByTelegramChatId(groupChatId);
    if (!comm) {
      try {
        await ctx.telegram.sendMessage(
          ctx.from.id,
          'Майданчик не налаштований. Адміністратору: /setup.',
          await this.mainMenuReplyMarkupForDmUser(ctx.telegram, ctx.from.id),
        );
      } catch {
        await this.replyTransientInGroup(
          ctx,
          'Не можу написати в ЛС. Відкрийте діалог зі мною, натисніть Start і повторіть.',
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
          'Наразі ніхто не шукає партнерів для майбутніх ігор у цій групі.',
          await this.mainMenuReplyMarkupForDmUser(ctx.telegram, ctx.from.id),
        );
      } catch {
        await this.replyTransientInGroup(
          ctx,
          'Не можу написати в ЛС. Відкрийте діалог зі мною, натисніть Start і повторіть.',
        );
      }
      return;
    }
    const listItems = rows.map((r) => ({
      startTime: r.startTime,
      endTime: r.endTime,
      timeZone: r.resource.timeZone,
      resourceName: r.resource.name,
      sportNameUa: r.sportKind.nameUa,
      playersNeeded: r.requiredPlayers,
    }));
    const rowLabels = listItems.map((item) => this.buildFreeSlotButtonLabel(item));
    this.menuStates.set(this.setupSk(groupChatId, ctx.from.id), {
      t: 'free_slots',
      bookingIds: rows.map((r) => r.id),
      rowLabels,
    });
    try {
      await ctx.telegram.sendMessage(
        ctx.from.id,
        'Вільні місця — натисніть на рядок, щоб приєднатися до гри (список оновиться):',
        this.freeSlotsReplyMarkup(listItems),
      );
    } catch {
      await this.replyTransientInGroup(
        ctx,
        'Не можу написати в ЛС. Відкрийте діалог зі мною, натисніть Start і повторіть.',
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

  private async replyTransientInGroup(
    ctx: Context,
    text: string,
    delayMs = 5000,
  ) {
    const sent = await ctx.reply(text);
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
    return Markup.keyboard([
      [MENU_DAY_TODAY, MENU_DAY_TOMORROW],
      [MENU_KB_BACK, MENU_KB_MAIN],
    ])
      .resize()
      .persistent(true);
  }

  private hoursPickReplyMarkup(slots: BookingStartSlot[]) {
    const labels = slots.map(
      (s) =>
        `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`,
    );
    const rows = kbRowsPaired(labels);
    rows.push([MENU_KB_BACK, MENU_KB_MAIN]);
    return Markup.keyboard(rows).resize().persistent(true);
  }

  private durationLabel(min: number): string {
    if (min === 60) {
      return '1 г';
    }
    if (min === 90) {
      return '1.5 г';
    }
    return '2 г';
  }

  private durationPickReplyMarkup(minutes: number[]) {
    const rows = kbRowsPaired(minutes.map((m) => this.durationLabel(m)));
    rows.push([MENU_KB_BACK, MENU_KB_MAIN]);
    return Markup.keyboard(rows).resize().persistent(true);
  }

  private lookingForPlayersReplyMarkup() {
    return Markup.keyboard([
      [BOOK_KB_LOOKING_YES, BOOK_KB_LOOKING_NO],
      [MENU_KB_BACK, MENU_KB_MAIN],
    ])
      .resize()
      .persistent(true);
  }

  private playersCountPromptReplyMarkup() {
    return Markup.keyboard([[MENU_KB_BACK, MENU_KB_MAIN]])
      .resize()
      .persistent(true);
  }

  /** Текст кнопки в «Мои бронирования» (лимит Telegram — 64 символа). */
  private buildListBookingButtonLabel(item: {
    startTime: Date;
    endTime: Date;
    timeZone: string;
    resourceName: string;
  }): string {
    const r = item;
    const day = formatInTimeZone(r.startTime, r.timeZone, 'dd.MM.yyyy');
    const a = formatInTimeZone(r.startTime, r.timeZone, 'HH:mm');
    const z = formatInTimeZone(r.endTime, r.timeZone, 'HH:mm');
    const timePart = `${day} ${a}–${z}`;
    const cancelSuffix = ` · Скасувати?`;
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
    sportNameUa: string;
    playersNeeded: number;
  }): string {
    const day = formatInTimeZone(item.startTime, item.timeZone, 'dd.MM');
    const a = formatInTimeZone(item.startTime, item.timeZone, 'HH:mm');
    const z = formatInTimeZone(item.endTime, item.timeZone, 'HH:mm');
    const sport = item.sportNameUa.trim() || '—';
    const res = item.resourceName.trim() || '—';
    const tail = `ще ${item.playersNeeded}`;
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
    const labels = items.map((it) => this.buildListBookingButtonLabel(it));
    const rows = kbRowsPaired(labels);
    rows.push([MENU_KB_BACK, MENU_KB_MAIN]);
    return Markup.keyboard(rows).resize().persistent(true);
  }

  private freeSlotsReplyMarkup(
    items: {
      startTime: Date;
      endTime: Date;
      timeZone: string;
      resourceName: string;
      sportNameUa: string;
      playersNeeded: number;
    }[],
  ) {
    const labels = items.map((it) => this.buildFreeSlotButtonLabel(it));
    const rows = kbRowsPaired(labels);
    rows.push([MENU_KB_BACK, MENU_KB_MAIN]);
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
    const prefix = `${i + 1}. ${r.name}`;
    const addr = r.address?.trim();
    let line = addr ? `${prefix} (${addr})` : prefix;
    if (opts?.markInactive && r.visibility === ResourceVisibility.INACTIVE) {
      line = `${line} · Неактивна`;
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
    const labels = list.map((r, i) =>
      this.resourcePickButtonLabel(r, i, { markInactive }),
    );
    const rows = kbRowsPaired(labels);
    rows.push([MENU_KB_BACK, MENU_KB_MAIN]);
    return Markup.keyboard(rows).resize().persistent(true);
  }

  /** Все виды спорта из каталога (кнопки при выборе вида при бронировании). */
  private allSportKindCodesForPicker(): SportKindCode[] {
    return [...SPORT_ORDER];
  }

  private sportPickReplyMarkup(types: SportKindCode[]) {
    const rows = kbRowsPaired(types.map((t) => SPORT_LABEL[t]));
    rows.push([MENU_KB_BACK, MENU_KB_MAIN]);
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
      MSG_NO_SLOTS_BOOKING_WINDOW,
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
        this.resetMenuState(ctx);
        await ctx.reply('Головне меню:', await this.mainMenuReplyMarkup(ctx));
        return;
      case 'book_res': {
        if (s.sportKindCode !== undefined) {
          const comm = await this.community.findByTelegramChatId(chatId);
          if (!comm) {
            return;
          }
          if (!(await this.ensureParticipantBookingWindowOpen(ctx, chatId, comm))) {
            return;
          }
          this.setMenuState(ctx, { t: 'book_sport' });
          await ctx.reply(
            'Оберіть вид спорту:',
            this.sportPickReplyMarkup(this.allSportKindCodesForPicker()),
          );
          return;
        }
        this.resetMenuState(ctx);
        await ctx.reply('Головне меню:', await this.mainMenuReplyMarkup(ctx));
        return;
      }
      case 'grid_res':
        this.resetMenuState(ctx);
        await ctx.reply('Головне меню:', await this.mainMenuReplyMarkup(ctx));
        return;
      case 'book_day': {
        const comm = await this.community.findByTelegramChatId(chatId);
        if (!comm) {
          return;
        }
        if (s.sportKindCode !== undefined) {
          const list = await this.resourcesForBookingUi(chatId, admin);
          if (list.length <= 1) {
            if (!(await this.ensureParticipantBookingWindowOpen(ctx, chatId, comm))) {
              return;
            }
            this.setMenuState(ctx, { t: 'book_sport' });
            await ctx.reply(
              'Оберіть вид спорту:',
              this.sportPickReplyMarkup(this.allSportKindCodesForPicker()),
            );
            return;
          }
          this.setMenuState(ctx, {
            t: 'book_res',
            sportKindCode: s.sportKindCode,
          });
          await ctx.reply(
            'Оберіть майданчик:',
            this.resourcePickReplyMarkup(list, admin),
          );
          return;
        }
        const visible = this.bookableResources(comm.resources, admin);
        if (visible.length <= 1) {
          this.resetMenuState(ctx);
          await ctx.reply('Головне меню:', await this.mainMenuReplyMarkup(ctx));
        } else {
          this.setMenuState(ctx, { t: 'book_res' });
          const list = await this.resourcesForBookingUi(chatId, admin);
          await ctx.reply(
            'Оберіть майданчик:',
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
        await ctx.reply('Виберіть день:', this.dayPickReplyMarkup());
        return;
      }
      case 'book_dur': {
        const starts = await this.booking.getAvailableStartSlots({
          resourceId: s.resourceId,
          telegramChatId: chatId,
          dayOffset: s.dayOffset,
          telegramGroupAdmin: admin,
        });
        if (starts.length === 0) {
          this.resetMenuState(ctx);
          await ctx.reply(
            'Немає вільних інтервалів.',
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
            ? 'Сьогодні — виберіть час початку:'
            : 'Завтра — оберіть час початку:',
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
        });
        if (starts.length === 0) {
          this.resetMenuState(ctx);
          await ctx.reply(
            'Немає вільних інтервалів.',
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
            'Наразі немає відповідного періоду. Оберіть інший день.',
            this.dayPickReplyMarkup(),
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
          `Початок ${String(s.hour).padStart(2, '0')}:${String(s.startMinute).padStart(2, '0')} — виберіть тривалість:`,
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
          'Шукаєте партнерів для цієї броні?',
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
          await ctx.reply('Головне меню:', await this.mainMenuReplyMarkup(ctx));
        } else {
          this.setMenuState(ctx, { t: 'grid_res' });
          const list = await this.resourcesForBookingUi(chatId, admin);
          await ctx.reply(
            'Розклад — оберіть майданчик:',
            this.resourcePickReplyMarkup(list, admin),
          );
        }
        return;
      }
      case 'list':
      case 'free_slots':
        this.resetMenuState(ctx);
        await ctx.reply('Головне меню:', await this.mainMenuReplyMarkup(ctx));
        return;
      default:
        this.resetMenuState(ctx);
        await ctx.reply('Головне меню:', await this.mainMenuReplyMarkup(ctx));
    }
  }

  private async handleMainMenuButtons(ctx: Context, text: string) {
    if (text === MENU_KB_SWITCH_GROUP && !isGroupChat(ctx)) {
      await this.promptGroupPickerInDm(ctx, { force: true });
      return;
    }
    const chatId = await this.resolveActiveGroupChatId(ctx);
    if (chatId == null) {
      return;
    }

    const isAdminInGroup = await this.isAdminInContextGroup(ctx, chatId);
    if (!isAdminInGroup) {
      const joinResult = await this.telegramMembers.recordJoin({
        telegramChatId: chatId,
        telegramUserId: ctx.from!.id,
        username: ctx.from!.username,
        firstName: ctx.from!.first_name,
        lastName: ctx.from!.last_name,
      });
      if (joinResult.pendingGroupRules && joinResult.rulesText) {
        try {
          await this.sendCommunityRulesMessages(
            ctx.telegram,
            chatId,
            ctx.from!.id,
            joinResult.rulesText,
            { allowGroupFallback: true },
          );
        } catch (e) {
          this.logger.warn(
            `rules send after join-sync failed user=${ctx.from!.id}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      if (
        await this.telegramMembers.participantMustAcceptGroupRules({
          telegramChatId: chatId,
          telegramUserId: ctx.from!.id,
        })
      ) {
        if (
          text === MENU_KB_BOOK ||
          text === MENU_KB_LIST ||
          text === MENU_KB_GRID ||
          text === MENU_KB_FREE_SLOTS
        ) {
          const rulesText =
            await this.telegramMembers.getGroupRulesText(chatId);
          if (rulesText) {
            try {
              await this.sendCommunityRulesMessages(
                ctx.telegram,
                chatId,
                ctx.from!.id,
                rulesText,
                { allowGroupFallback: true },
              );
            } catch (e) {
              this.logger.warn(
                `rules resend failed user=${ctx.from!.id}: ${e instanceof Error ? e.message : String(e)}`,
              );
            }
          }
          await ctx.reply(
            'Спочатку прийміть правила спільноти — натисніть кнопку «Приймаю правила» у приватних повідомленнях з ботом (або у групі, якщо правила надійшли туди).',
            await this.mainMenuReplyMarkup(ctx),
          );
          return;
        }
      }
    }

    if (text === MENU_KB_BOOK) {
      const comm = await this.community.findByTelegramChatId(chatId);
      const admin = isAdminInGroup;
      const visible = comm ? this.bookableResources(comm.resources, admin) : [];
      if (!comm || visible.length === 0) {
        await ctx.reply(
          'Платформа не налаштована або немає активних платформ для бронювання. Адміністратору: /setup.',
          await this.mainMenuReplyMarkup(ctx),
        );
        return;
      }
      if (!admin) {
        if (!(await this.ensureParticipantBookingWindowOpen(ctx, chatId, comm))) {
          return;
        }
      }
      this.setMenuState(ctx, { t: 'book_sport' });
      await ctx.reply(
        'Оберіть вид спорту:',
        this.sportPickReplyMarkup(this.allSportKindCodesForPicker()),
      );
      return;
    }

    if (text === MENU_KB_LIST) {
      const rows = await this.booking.listMyBookingsNotFinishedOrCancelled({
        telegramChatId: chatId,
        telegramUserId: ctx.from!.id,
      });
      if (rows.length === 0) {
        await ctx.reply(
          'Немає бронювань у цьому чаті, які ще не завершені.',
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
      await ctx.reply(
        'Ваші бронювання (не завершені) — натисніть на рядок із датою та часом, щоб скасувати:',
        this.listBookingsReplyMarkup(listItems),
      );
      return;
    }

    if (text === MENU_KB_GRID) {
      const comm = await this.community.findByTelegramChatId(chatId);
      const admin = isAdminInGroup;
      const list = comm ? await this.resourcesForBookingUi(chatId, admin) : [];
      if (!comm || list.length === 0) {
        await ctx.reply(
          'Площадка не налаштована або немає активних майданчиків. Адміністратору: /setup.',
          await this.mainMenuReplyMarkup(ctx),
        );
        return;
      }
      if (list.length === 1) {
        this.setMenuState(ctx, {
          t: 'grid_day',
          resourceId: list[0].id,
        });
        await ctx.reply('Розклад на який день?', this.dayPickReplyMarkup());
        return;
      }
      this.setMenuState(ctx, { t: 'grid_res' });
      await ctx.reply(
        'Розклад — оберіть майданчик:',
        this.resourcePickReplyMarkup(list, admin),
      );
      return;
    }

    if (text === MENU_KB_FREE_SLOTS) {
      const comm = await this.community.findByTelegramChatId(chatId);
      if (!comm) {
        await ctx.reply(
          'Майданчик не налаштований. Адміністратору: /setup.',
          await this.mainMenuReplyMarkup(ctx),
        );
        return;
      }
      const rows = await this.booking.listOpenLookingSlots({
        telegramChatId: chatId,
      });
      if (rows.length === 0) {
        await ctx.reply(
          'Наразі ніхто не шукає партнерів для майбутніх ігор у цій групі.',
          await this.mainMenuReplyMarkup(ctx),
        );
        return;
      }
      const listItems = rows.map((r) => ({
        startTime: r.startTime,
        endTime: r.endTime,
        timeZone: r.resource.timeZone,
        resourceName: r.resource.name,
        sportNameUa: r.sportKind.nameUa,
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
        'Вільні місця — натисніть на рядок, щоб приєднатися до гри (список оновиться):',
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
      await ctx.reply('Виберіть номер зі списку.');
      return;
    }
    const comm = await this.community.findByTelegramChatId(chatId);
    if (!comm) {
      return;
    }
    if (!(await this.ensureParticipantBookingWindowOpen(ctx, chatId, comm))) {
      return;
    }
    this.setMenuState(ctx, {
      t: 'book_day',
      resourceId: r.id,
      ...(state.sportKindCode !== undefined
        ? { sportKindCode: state.sportKindCode }
        : {}),
    });
    await ctx.reply('Виберіть день:', this.dayPickReplyMarkup());
  }

  private async handleBookSportPick(ctx: Context, text: string) {
    const chatId = await this.resolveActiveGroupChatId(ctx);
    if (chatId == null) {
      return;
    }
    const comm = await this.community.findByTelegramChatId(chatId);
    if (!comm) {
      return;
    }
    const kindCode = KIND_LABEL_TO_CODE.get(text);
    if (!kindCode) {
      return;
    }
    const admin = await this.isAdminInContextGroup(ctx, chatId);
    const list = await this.resourcesForBookingUi(chatId, admin);
    if (list.length === 0) {
      await ctx.reply(
        'Немає майданчиків для бронювання. Попросіть адміністратора виконати /setup.',
        await this.mainMenuReplyMarkup(ctx),
      );
      return;
    }
    if (list.length === 1) {
      if (!(await this.ensureParticipantBookingWindowOpen(ctx, chatId, comm))) {
        return;
      }
      this.setMenuState(ctx, {
        t: 'book_day',
        resourceId: list[0].id,
        sportKindCode: kindCode,
      });
      await ctx.reply('Виберіть день:', this.dayPickReplyMarkup());
      return;
    }
    this.setMenuState(ctx, { t: 'book_res', sportKindCode: kindCode });
    await ctx.reply(
      'Оберіть майданчик:',
      this.resourcePickReplyMarkup(list, admin),
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
      await ctx.reply('Виберіть номер зі списку.');
      return;
    }
    this.setMenuState(ctx, { t: 'grid_day', resourceId: r.id });
    await ctx.reply('Розклад на який день?', this.dayPickReplyMarkup());
  }

  private async handleBookDayPick(
    ctx: Context,
    text: string,
    state: Extract<MenuState, { t: 'book_day' }>,
  ) {
    let dayOffset: 0 | 1 | undefined;
    if (text === MENU_DAY_TODAY) {
      dayOffset = 0;
    } else if (text === MENU_DAY_TOMORROW) {
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
    const starts = await this.booking.getAvailableStartSlots({
      resourceId: state.resourceId,
      telegramChatId: chatId,
      dayOffset,
      telegramGroupAdmin: admin,
    });
    if (starts.length === 0) {
      this.resetMenuState(ctx);
      await ctx.reply(
        MSG_NO_SLOTS_BOOKING_WINDOW,
        await this.mainMenuReplyMarkup(ctx),
      );
      return;
    }
    this.setMenuState(ctx, {
      t: 'book_hour',
      resourceId: state.resourceId,
      dayOffset,
      ...(state.sportKindCode !== undefined
        ? { sportKindCode: state.sportKindCode }
        : {}),
    });
    await ctx.reply(
      dayOffset === 0
        ? 'Сьогодні — виберіть час початку:'
        : 'Завтра — оберіть час початку:',
      this.hoursPickReplyMarkup(starts),
    );
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
    });
    const picked = starts.find(
      (s) => s.hour === hour && s.minute === startMinute,
    );
    if (!picked) {
      await ctx.reply('Цей час недоступний.');
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
        'Наразі немає відповідної тривалості. Оберіть інший день.',
        this.dayPickReplyMarkup(),
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
      `Початок ${String(hour).padStart(2, '0')}:${String(startMinute).padStart(2, '0')} — виберіть тривалість:`,
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
        });
      const a = formatInTimeZone(startTime, timeZone, 'HH:mm');
      const z = formatInTimeZone(endTime, timeZone, 'HH:mm');
      const tail =
        players.isLookingForPlayers && players.requiredPlayers > 0
          ? ` Шукаю партнерів: потрібно ще ${players.requiredPlayers} чол.`
          : '';
      const day = formatInTimeZone(startTime, timeZone, 'dd.MM.yyyy');
      const whoRaw = ctx.from?.username?.trim()
        ? ctx.from.username.trim()
        : (ctx.from?.first_name?.trim() ?? 'Гравець');
      const sportLabel = this.bookingSportLabel(flow.sportKindCode);
      const groupBroadcast =
        `Нове бронювання\n\n` +
        `Майданчик: «${resourceName}»\n` +
        `Коли: ${day} ${a}–${z} (${timeZone})\n` +
        `Хто: ${whoRaw}\n` +
        `Спорт: ${sportLabel}` +
        (players.isLookingForPlayers && players.requiredPlayers > 0
          ? `\nПошук партнерів: потрібно ще ${players.requiredPlayers} чол.`
          : '');
      await this.broadcastToResourceGroups(ctx, resourceId, groupBroadcast);
      await this.replyWithMainMenu(
        ctx,
        `Бронювання додано: «${resourceName}», ${a}–${z}.${tail}`,
      );
    } catch (e) {
      if (e instanceof SlotTakenError) {
        await this.replyWithMainMenu(
          ctx,
          'Цей час щойно зайнято. Оберіть інший час.',
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
          'Цей час уже минув. Оберіть інший день.',
          this.dayPickReplyMarkup(),
        );
        return;
      }
      if (e instanceof BookingWindowClosedError) {
        await this.replyWithMainMenu(
          ctx,
          'Зараз неможливо оформити бронювання: діє обмеження за часом. Спробуйте в проміжку часу, який встановив адміністратор (Налаштування → «Час бронювання в групі»).',
        );
        return;
      }
      if (e instanceof UserDailyBookingLimitExceededError) {
        await this.replyWithMainMenu(
          ctx,
          'Для вашого облікового запису в групі перевищено ліміт бронювання на цей день. Детальніше — у адміністратора (Налаштування → «Ліміт на бронювання»).',
        );
        return;
      }
      this.logger.error(e instanceof Error ? e.message : e);
      await this.replyWithMainMenu(
        ctx,
        'Не вдалося створити бронювання. Спробуйте ще раз.',
      );
    }
  }

  private async handleBookDurPick(
    ctx: Context,
    text: string,
    state: Extract<MenuState, { t: 'book_dur' }>,
  ) {
    const map: Record<string, BookingDurationMinutes> = {
      '1 г': 60,
      '1.5 г': 90,
      '2 г': 120,
    };
    const durationMinutes = map[text];
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
      'Шукаєте партнерів для цієї броні?',
      this.lookingForPlayersReplyMarkup(),
    );
  }

  private async handleBookLookingPick(
    ctx: Context,
    text: string,
    state: Extract<MenuState, { t: 'book_looking' }>,
  ) {
    if (text === BOOK_KB_LOOKING_NO) {
      await this.finalizeGroupBooking(ctx, state, {
        isLookingForPlayers: false,
        requiredPlayers: 0,
      });
      return;
    }
    if (text === BOOK_KB_LOOKING_YES) {
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
        'Скільки осіб ви шукаєте? Введіть число від 1 до 50.',
        this.playersCountPromptReplyMarkup(),
      );
      return;
    }
    await ctx.reply('Натисніть «Так» або «Ні».', this.lookingForPlayersReplyMarkup());
  }

  private async handleBookPlayersPick(
    ctx: Context,
    text: string,
    state: Extract<MenuState, { t: 'book_players' }>,
  ) {
    const raw = text.trim();
    if (!/^\d+$/.test(raw)) {
      await ctx.reply(
        'Потрібно ціле число від 1 до 50.',
        this.playersCountPromptReplyMarkup(),
      );
      return;
    }
    const n = Number(raw);
    if (n < 1 || n > 50) {
      await ctx.reply(
        'Потрібно ціле число від 1 до 50.',
        this.playersCountPromptReplyMarkup(),
      );
      return;
    }
    await this.finalizeGroupBooking(ctx, state, {
      isLookingForPlayers: true,
      requiredPlayers: n,
    });
  }

  private async handleGridDayPick(
    ctx: Context,
    text: string,
    state: Extract<MenuState, { t: 'grid_day' }>,
  ) {
    let dayOffset: 0 | 1 | undefined;
    if (text === MENU_DAY_TODAY) {
      dayOffset = 0;
    } else if (text === MENU_DAY_TOMORROW) {
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
    });
    this.setMenuState(ctx, { t: 'grid_day', resourceId: state.resourceId });
    await ctx.reply(gridText, this.dayPickReplyMarkup());
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
      });
      for (const uid of notify.recipientTelegramIds) {
        try {
          await ctx.telegram.sendMessage(uid, notify.cancelNoticeText);
        } catch (e) {
          this.logger.warn(
            `booking_cancel_dm failed user=${uid}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      const cDay = formatInTimeZone(notify.startTime, notify.timeZone, 'dd.MM.yyyy');
      const cA = formatInTimeZone(notify.startTime, notify.timeZone, 'HH:mm');
      const cZ = formatInTimeZone(notify.endTime, notify.timeZone, 'HH:mm');
      const cancelledBy = ctx.from?.username?.trim()
        ? ctx.from.username.trim()
        : (ctx.from?.first_name?.trim() ?? 'Гравець');
      const cancelBroadcast =
        `Бронювання скасовано\n\n` +
        `Майданчик: «${notify.resourceName}»\n` +
        `Коли: ${cDay} ${cA}–${cZ} (${notify.timeZone})\n` +
        `Спорт: ${notify.sportNameUa}\n` +
        `Скасував: ${cancelledBy}`;
      await this.broadcastToResourceGroups(ctx, notify.resourceId, cancelBroadcast);
      await this.replyWithMainMenu(ctx, 'Бронювання скасовано.');
    } catch (e) {
      if (e instanceof BookingNotFoundError) {
        await this.replyWithMainMenu(
          ctx,
          'Запис не знайдено або вже скасовано.',
        );
        return;
      }
      throw e;
    }
  }

  private formatLookingSlotDmText(params: {
    dm: {
      resourceName: string;
      address: string | null;
      timeZone: string;
      startTime: Date;
      endTime: Date;
      sportNameUa: string;
    };
    yourPeopleCount: number;
  }): string {
    const { dm, yourPeopleCount } = params;
    const day = formatInTimeZone(dm.startTime, dm.timeZone, 'dd.MM.yyyy');
    const a = formatInTimeZone(dm.startTime, dm.timeZone, 'HH:mm');
    const z = formatInTimeZone(dm.endTime, dm.timeZone, 'HH:mm');
    const addr = dm.address?.trim()
      ? dm.address.trim()
      : 'не вказано — дізнайтеся в організатора у групі';
    const peopleLine =
      yourPeopleCount === 1
        ? 'З вашого боку враховано 1 особу (вас).'
        : `З вашого боку враховано осіб: ${yourPeopleCount}.`;

    return (
      `Ви в списку учасників гри.\n\n${peopleLine}\n\n` +
      `Де: «${dm.resourceName}»\n` +
      `Адреса: ${addr}\n` +
      `Коли: ${day} ${a}–${z} (${dm.timeZone})\n` +
      `Спорт: ${dm.sportNameUa}\n\n` +
      `Збережіть цей діалог — сюди також можуть надходити нагадування.`
    );
  }

  private async sendLookingSlotDm(
    ctx: Context,
    bookingId: string,
    joinResult: {
      previousDmMessageId: number | null;
      dm: {
        resourceName: string;
        address: string | null;
        timeZone: string;
        startTime: Date;
        endTime: Date;
        sportNameUa: string;
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
    });
    let sentId: number;
    try {
      const sent = await ctx.telegram.sendMessage(userId, text);
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
            'Ця гра вже набрала склад або слот недоступний.',
          );
          return;
        }
        const listItems = rows.map((r) => ({
          startTime: r.startTime,
          endTime: r.endTime,
          timeZone: r.resource.timeZone,
          resourceName: r.resource.name,
          sportNameUa: r.sportKind.nameUa,
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
          'Список застарів — його оновлено. Виберіть слот знову:',
          this.freeSlotsReplyMarkup(listItems),
        );
        return;
      }
      throw e;
    }

    await this.sendLookingSlotDm(ctx, bookingId, joinResult);

    const rows = await this.booking.listOpenLookingSlots({
      telegramChatId: chatId,
    });
    if (rows.length === 0) {
      await this.replyWithMainMenu(
        ctx,
        'Вас включили до складу. Деталі гри надіслав у приватних повідомленнях. Вільних місць для набору більше немає.',
      );
      return;
    }
    const listItems = rows.map((r) => ({
      startTime: r.startTime,
      endTime: r.endTime,
      timeZone: r.resource.timeZone,
      resourceName: r.resource.name,
      sportNameUa: r.sportKind.nameUa,
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
      'Вас включили до складу. Коли і де на вас чекають — у особистих повідомленнях від мене. Можна вибрати ще один слот або «Головне меню»:',
      this.freeSlotsReplyMarkup(listItems),
    );
  }

  private whPickDayReplyMarkup() {
    return Markup.keyboard([
      ...kbRowsPaired([...WH_ISO_LABELS]),
      [MENU_KB_WH_DONE_TO_MENU],
    ])
      .resize()
      .persistent(true);
  }

  private whDayActionsReplyMarkup() {
    return Markup.keyboard([
      [WH_KB_DAY_CLOSED, WH_KB_DAY_SET_HOURS],
      [MENU_KB_BACK],
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
      if (text === MENU_KB_WH_SKIP || text === MENU_KB_MAIN) {
        this.whDmStateByUser.delete(uid);
        await ctx.reply(
          text === MENU_KB_WH_SKIP
            ? 'Гаразд, для всіх днів залишається так само, як при збереженні.'
            : 'Меню:',
          await mainKb(st.groupChatId),
        );
        return;
      }
      if (text === MENU_KB_WH_PER_DAY) {
        if (!(await adminOk(st.groupChatId))) {
          this.whDmStateByUser.delete(uid);
          await ctx.reply(
            'Не має прав адміністратора в цій групі.',
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
          'Виберіть день тижня (Пн — понеділок). Зміни зберігаються одразу.',
          this.whPickDayReplyMarkup(),
        );
        return;
      }
      await ctx.reply(
        'Спочатку натисніть «Пропустити» або «Налаштувати годинник за днями».',
      );
      return;
    }

    if (st.kind === 'pick_day') {
      if (text === MENU_KB_WH_DONE_TO_MENU || text === MENU_KB_MAIN) {
        this.whDmStateByUser.delete(uid);
        await ctx.reply('Меню:', await mainKb(st.groupChatId));
        return;
      }
      const isoIdx = WH_ISO_LABELS.indexOf(
        text as (typeof WH_ISO_LABELS)[number],
      );
      if (isoIdx >= 0) {
        if (!(await adminOk(st.groupChatId))) {
          this.whDmStateByUser.delete(uid);
          await ctx.reply('Немає прав.', await mainKb(st.groupChatId));
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
        const dayName = WH_ISO_LABELS[isoIdx];
        const body =
          `${dayName}.\n${this.whDayStatusLine(row)}\n\n` +
          `«Вихідний» — немає слотів. «Встановити годинник» — як в /setup.`;
        await ctx.reply(body, this.whDayActionsReplyMarkup());
        return;
      }
      await ctx.reply('Виберіть день за допомогою кнопки або «Готово — меню».');
      return;
    }

    if (st.kind === 'day_menu') {
      if (text === MENU_KB_BACK) {
        this.whDmStateByUser.set(uid, {
          kind: 'pick_day',
          groupChatId: st.groupChatId,
          resourceId: st.resourceId,
        });
        await ctx.reply('Виберіть день тижня:', this.whPickDayReplyMarkup());
        return;
      }
      if (text === WH_KB_DAY_CLOSED) {
        if (!(await adminOk(st.groupChatId))) {
          this.whDmStateByUser.delete(uid);
          await ctx.reply('Немає прав.', await mainKb(st.groupChatId));
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
          await ctx.reply('Не вдалося зберегти.');
          return;
        }
        this.whDmStateByUser.set(uid, {
          kind: 'pick_day',
          groupChatId: st.groupChatId,
          resourceId: st.resourceId,
        });
        await ctx.reply(
          'Збережено: вихідний. Оберіть інший день або «Готово — меню».',
          this.whPickDayReplyMarkup(),
        );
        return;
      }
      if (text === WH_KB_DAY_SET_HOURS) {
        if (!(await adminOk(st.groupChatId))) {
          this.whDmStateByUser.delete(uid);
          await ctx.reply('Немає прав.', await mainKb(st.groupChatId));
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
          `${WH_ISO_LABELS[st.weekday - 1]}: виберіть час початку (найближчий можливий час початку слоту).`,
          this.setupStartHourReplyMarkup(),
        );
        return;
      }
      await ctx.reply('Натисніть одну з кнопок внизу.');
    }
  }

  private async handleWhPerDayEditText(
    ctx: Context,
    text: string,
    draft: WhPerDayEditDraft,
  ) {
    const uid = ctx.from!.id;
    if (
      text.trim() === SETUP_KB_CANCEL ||
      text === MENU_KB_MAIN ||
      (text === MENU_KB_BACK && draft.phase === 'start')
    ) {
      this.whPerDayEditByUser.delete(uid);
      this.whDmStateByUser.set(uid, {
        kind: 'pick_day',
        groupChatId: draft.groupChatId,
        resourceId: draft.resourceId,
      });
      await ctx.telegram.sendMessage(
        uid,
        'Виберіть день тижня:',
        this.whPickDayReplyMarkup(),
      );
      return;
    }
    if (text === MENU_KB_BACK && draft.phase === 'end') {
      draft.phase = 'start';
      delete draft.slotStart;
      this.whPerDayEditByUser.set(uid, draft);
      await ctx.reply(
        `${WH_ISO_LABELS[draft.weekday - 1]}: виберіть час початку (найближчий можливий час початку слоту).`,
        this.setupStartHourReplyMarkup(),
      );
      return;
    }
    if (draft.phase === 'start') {
      const hm = text.match(/^(\d{1,2}):00$/);
      if (!hm) {
        await ctx.reply('Виберіть час відкриття за допомогою кнопок (00:00–22:00).');
        return;
      }
      const hour = Number(hm[1]);
      if (!Number.isInteger(hour) || hour < 0 || hour > 22) {
        await ctx.reply('Виберіть час відкриття від 00:00 до 22:00.');
        return;
      }
      draft.slotStart = hour;
      draft.phase = 'end';
      this.whPerDayEditByUser.set(uid, draft);
      await ctx.reply(
        `${WH_ISO_LABELS[draft.weekday - 1]}: до якої дати все має завершитися (відкриття: ${String(hour).padStart(2, '0')}:00)?`,
        this.setupClosingHourReplyMarkup(hour),
      );
      return;
    }
    const hm = text.match(/^(\d{1,2}):00$/);
    if (!hm) {
      await ctx.reply('Виберіть час закінчення за допомогою кнопок.');
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
      await ctx.reply(
        'Закінчення має бути пізніше часу початку. Оберіть інший час.',
      );
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
      await ctx.reply('Не вдалося зберегти. Спробуйте ще раз.');
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
      `Збережено: ${WH_ISO_LABELS[draft.weekday - 1]} — слоти з ${String(start).padStart(2, '0')}:00. Виберіть інший день або «Готово — меню».`,
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
    if (textRaw !== MENU_KB_SETUP) {
      return next();
    }

    const uid = ctx.from.id;
    this.whDmStateByUser.delete(uid);
    this.whPerDayEditByUser.delete(uid);
    this.pendingDmPickerActionByUser.set(uid, 'setup');

    const bridged = this.setupBridgeGroupByUser.get(uid);
    if (bridged) {
      const sk = `${bridged}:${uid}`;
      if (this.setupDrafts.has(sk)) {
        await ctx.reply(
          `Налаштування вже відкрито — дайте відповідь на повідомлення майстра вище або натисніть ${SETUP_KB_CANCEL}.`,
        );
        return;
      }
      this.setupBridgeGroupByUser.delete(uid);
    }

    const gid = await this.promptGroupPickerInDm(ctx, {
      force: true,
      hint: 'Оберіть групу для налаштування:',
    });
    if (gid == null) {
      return;
    }
    this.pendingDmPickerActionByUser.delete(uid);
    const gidStr = gid.toString();

    if (
      !(await isUserAdminOfGroupChat(ctx.telegram, BigInt(gidStr), uid))
    ) {
      await ctx.reply('Лише адміністратор може відкривати налаштування.');
      return;
    }

    let chatTitle = 'Чат';
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
        from: ctx.from,
        groupChatId: BigInt(gidStr),
        chatTitle,
      });
    } catch (e) {
      this.logger.warn(
        e instanceof Error ? e.message : 'openSetup from DM failed',
      );
      await ctx.reply(
        'Не вдалося відкрити налаштування. Спробуйте ще раз із групи: /setup.',
      );
    }
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
    await this.handleWhDmText(ctx, textRaw);
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
    await this.handleWhPerDayEditText(ctx, textRaw, whDraft);
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
    await this.handleSetupText(ctx, textRaw, BigInt(gid));
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

    if (isGroupChat(ctx) && text === MENU_KB_SETUP) {
      await this.runGroupSetup(ctx);
      return;
    }

    if (isGroupChat(ctx) && text === MENU_KB_CHAT_BOT) {
      await this.openDmMenuForGroupFromGroupContext(ctx);
      await this.tryDeleteTriggerTextMessage(ctx);
      return;
    }

    if (isGroupChat(ctx) && text === MENU_KB_FREE_SLOTS) {
      await this.openDmFreeSlotsForGroupFromGroupContext(ctx);
      await this.tryDeleteTriggerTextMessage(ctx);
      return;
    }

    if (!isGroupChat(ctx)) {
      const picked = this.groupPickerLabelsByUser.get(ctx.from.id)?.get(text);
      if (picked != null) {
        this.activeGroupByUser.set(ctx.from.id, picked);
        this.groupPickerLabelsByUser.delete(ctx.from.id);
        const pendingPickerAction = this.pendingDmPickerActionByUser.get(
          ctx.from.id,
        );
        if (pendingPickerAction === 'setup') {
          this.pendingDmPickerActionByUser.delete(ctx.from.id);
          if (
            !(await isUserAdminOfGroupChat(
              ctx.telegram,
              picked,
              ctx.from.id,
            ))
          ) {
            await ctx.reply('Лише адміністратор може відкривати налаштування.');
            return;
          }
          let chatTitle = 'Чат';
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
              from: ctx.from,
              groupChatId: picked,
              chatTitle,
            });
          } catch (e) {
            this.logger.warn(
              e instanceof Error ? e.message : 'openSetup after group pick failed',
            );
            await ctx.reply('Не вдалося відкрити налаштування. Спробуйте ще раз.');
          }
          return;
        }
        this.resetMenuState(ctx);
        await ctx.reply('Головне меню:', await this.mainMenuReplyMarkup(ctx));
        return;
      }
      if (text === MENU_KB_SWITCH_GROUP) {
        await this.promptGroupPickerInDm(ctx, { force: true });
        return;
      }
      if (text === MENU_KB_CHAT_BOT) {
        const gid = await this.promptGroupPickerInDm(ctx, { force: true });
        if (gid != null) {
          this.resetMenuState(ctx);
          await ctx.reply('Головне меню:', await this.mainMenuReplyMarkup(ctx));
        }
        return;
      }
    }

    if (text === MENU_KB_MAIN) {
      if (isGroupChat(ctx)) {
        this.clearSetupBridgeForGroup(ctx.from.id, String(ctx.chat.id));
      }
      this.setupDrafts.delete(this.setupSk(ctx.chat.id, ctx.from.id));
      this.resetMenuState(ctx);
      await ctx.reply('Головне меню:', await this.mainMenuReplyMarkup(ctx));
      return;
    }

    const setupDraft = this.setupDrafts.get(this.sk(ctx));
    if (setupDraft != null) {
      if (
        isGroupChat(ctx) &&
        this.setupBridgeGroupByUser.get(ctx.from.id) === String(ctx.chat.id)
      ) {
        await ctx.reply(
          'Продовжуйте налаштування в особистих повідомленнях зі мною — відповіді там не відображаються у групі.',
        );
        return;
      }
      this.setupDrafts.delete(this.sk(ctx));
    }

    if (text === MENU_KB_BACK) {
      await this.handleMenuBack(ctx);
      return;
    }

    const state = this.getMenuState(ctx);

    if (state.t === 'list') {
      if (state.rowLabels.includes(text)) {
        await this.handleListCancel(ctx, text, state);
      } else if (
        text === MENU_KB_BOOK ||
        text === MENU_KB_LIST ||
        text === MENU_KB_GRID ||
        text === MENU_KB_FREE_SLOTS ||
        text === MENU_KB_SWITCH_GROUP
      ) {
        this.resetMenuState(ctx);
        if (text === MENU_KB_SWITCH_GROUP) {
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
        text === MENU_KB_BOOK ||
        text === MENU_KB_LIST ||
        text === MENU_KB_GRID ||
        text === MENU_KB_FREE_SLOTS ||
        text === MENU_KB_SWITCH_GROUP
      ) {
        this.resetMenuState(ctx);
        if (text === MENU_KB_SWITCH_GROUP) {
          await this.promptGroupPickerInDm(ctx, { force: true });
        } else {
          await this.handleMainMenuButtons(ctx, text);
        }
      }
      return;
    }
    if (state.t === 'book_sport') {
      if (
        text === MENU_KB_BOOK ||
        text === MENU_KB_LIST ||
        text === MENU_KB_GRID ||
        text === MENU_KB_FREE_SLOTS ||
        text === MENU_KB_SWITCH_GROUP
      ) {
        this.resetMenuState(ctx);
        if (text === MENU_KB_SWITCH_GROUP) {
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
        text === MENU_KB_BOOK ||
        text === MENU_KB_LIST ||
        text === MENU_KB_GRID ||
        text === MENU_KB_FREE_SLOTS ||
        text === MENU_KB_SWITCH_GROUP
      ) {
        this.resetMenuState(ctx);
        if (text === MENU_KB_SWITCH_GROUP) {
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
        text === MENU_KB_BOOK ||
        text === MENU_KB_LIST ||
        text === MENU_KB_GRID ||
        text === MENU_KB_FREE_SLOTS ||
        text === MENU_KB_SWITCH_GROUP
      ) {
        this.resetMenuState(ctx);
        if (text === MENU_KB_SWITCH_GROUP) {
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

    await this.handleMainMenuButtons(ctx, text);
  }

  private setupStep1ReplyMarkup(
    backToResourcePick = false,
    existingBotName?: string,
    opts?: { newResource?: boolean },
  ) {
    const rows: string[][] = [];
    if (!opts?.newResource) {
      rows.push([
        existingBotName ? SETUP_KB_KEEP_BOT_NAME : SETUP_KB_USE_CHAT_TITLE,
      ]);
    }
    if (backToResourcePick) {
      rows.push([MENU_KB_BACK, MENU_KB_MAIN]);
      rows.push([SETUP_KB_CANCEL]);
    } else {
      rows.push([MENU_KB_MAIN, SETUP_KB_CANCEL]);
    }
    return Markup.keyboard(rows).resize().persistent(true);
  }

  private setupVenuesHubReplyMarkup() {
    return Markup.keyboard([
      [SETUP_KB_VENUES, SETUP_KB_BOOKING_WINDOW],
      [SETUP_KB_BOOKING_LIMIT, SETUP_KB_LINK_EXISTING_RESOURCE],
      [SETUP_KB_CANCEL],
    ])
      .resize()
      .persistent(true);
  }

  private setupHubButtonsHintText(): string {
    return `«${SETUP_KB_VENUES}» — майданчики, «${SETUP_KB_LINK_EXISTING_RESOURCE}» — привʼязати вже існуючий майданчик, «${SETUP_KB_BOOKING_WINDOW}» — коли учасники можуть бронювати, «${SETUP_KB_BOOKING_LIMIT}» — ліміт годин на одного користувача за днями тижня.`;
  }

  private setupHubPromptText(chatTitle: string): string {
    return `Налаштування групи «${chatTitle}». ${this.setupHubButtonsHintText()}`;
  }

  private formatUserBookingLimitsSummary(
    rows: { weekday: number; maxMinutes: number | null }[],
  ): string {
    const byDay = new Map(rows.map((r) => [r.weekday, r.maxMinutes]));
    const lines: string[] = [];
    for (let w = 1; w <= 7; w++) {
      const label = WH_ISO_LABELS[w - 1];
      const m = byDay.get(w);
      const v =
        m === undefined || m === null
          ? 'без обмежень'
          : m === 0
            ? '0 г (не можна)'
            : `${m / 60} г`;
      lines.push(`${label}: ${v}`);
    }
    return lines.join('\n');
  }

  private setupLimitWeekdayReplyMarkup() {
    return Markup.keyboard([
      ...kbRowsPaired([...WH_ISO_LABELS]),
      [MENU_KB_BACK, MENU_KB_MAIN],
      [SETUP_KB_CANCEL],
    ])
      .resize()
      .persistent(true);
  }

  private setupLimitHoursReplyMarkup() {
    const labels = [
      LIMIT_KB_UNLIMITED,
      ...Array.from({ length: 25 }, (_, h) => `${h} ч`),
    ];
    const rows = kbRowsPaired(labels);
    rows.push([MENU_KB_BACK, MENU_KB_MAIN]);
    rows.push([SETUP_KB_CANCEL]);
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

    if (text === MENU_KB_MAIN) {
      await toHub();
      return true;
    }

    if (sub === 'limit_pick_day') {
      if (text === MENU_KB_BACK) {
        await toHub();
        return true;
      }
      const wi = WH_ISO_LABELS.findIndex((l) => l === text);
      if (wi < 0) {
        await this.sendSetupDm(
          ctx,
          `Виберіть день тижня або «${MENU_KB_BACK}».`,
        );
        return true;
      }
      draft.limitWeekdayDraft = wi + 1;
      draft.venuesSubstep = 'limit_pick_hours';
      this.setupDrafts.set(sk, draft);
      const limits =
        await this.community.getUserBookingLimitsForChat(targetGroupChatId);
      const row = limits.find((l) => l.weekday === draft.limitWeekdayDraft);
      const cur =
        row?.maxMinutes == null
          ? 'без обмежень'
          : row.maxMinutes === 0
            ? '0 ч'
            : `${row.maxMinutes / 60} ч`;
      await this.sendSetupDm(
        ctx,
        `${WH_ISO_LABELS[wi]}: зараз ${cur}.\n\n` +
          `Максимальна кількість годин бронювання одним обліковим записом у цей день тижня для кожного майданчика окремо. Під час перевірки враховується день тижня та календарна дата початку бронювання у часовому поясі того майданчика, на якому здійснюється бронювання.\n\nВиберіть ліміт:`,
        this.setupLimitHoursReplyMarkup(),
      );
      return true;
    }

    if (text === MENU_KB_BACK) {
      draft.venuesSubstep = 'limit_pick_day';
      delete draft.limitWeekdayDraft;
      this.setupDrafts.set(sk, draft);
      const limits =
        await this.community.getUserBookingLimitsForChat(targetGroupChatId);
      await this.sendSetupDm(
        ctx,
        `Ліміт на бронювання за днями тижня.\n\n${this.formatUserBookingLimitsSummary(limits)}\n\nВиберіть день тижня:`,
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
    if (text === LIMIT_KB_UNLIMITED) {
      maxMinutes = null;
    } else {
      const m = text.match(/^(\d+) ч$/);
      if (!m) {
        await this.sendSetupDm(ctx, 'Виберіть варіант зі списку.');
        return true;
      }
      const h = Number(m[1]);
      if (!Number.isInteger(h) || h < 0 || h > 24) {
        await this.sendSetupDm(
          ctx,
          'Допустимо від 0 до 24 годин або «Без обмежень».',
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
      await this.sendSetupDm(ctx, 'Не вдалося зберегти. Спробуйте ще раз.');
      return true;
    }

    draft.venuesSubstep = 'limit_pick_day';
    delete draft.limitWeekdayDraft;
    this.setupDrafts.set(sk, draft);
    const limitsAfter =
      await this.community.getUserBookingLimitsForChat(targetGroupChatId);
    await this.sendSetupDm(
      ctx,
      `Збережено. Поточні ліміти:\n\n${this.formatUserBookingLimitsSummary(limitsAfter)}\n\nВиберіть інший день або «${MENU_KB_BACK}» в хаб.`,
      this.setupLimitWeekdayReplyMarkup(),
    );
    return true;
  }

  private formatBookingWindowSummary(c: {
    bookingWindowTimeZone: string;
    bookingWindowStartHour: number;
    bookingWindowEndHour: number;
  }): string {
    const sh = c.bookingWindowStartHour;
    const eh = c.bookingWindowEndHour;
    const endLabel =
      eh >= 24 ? '24:00 (північ)' : `${String(eh).padStart(2, '0')}:00`;
    return `з ${String(sh).padStart(2, '0')}:00 до ${endLabel}, пояс ${c.bookingWindowTimeZone}`;
  }

  private setupBwStartHourReplyMarkup() {
    const labels = Array.from(
      { length: 24 },
      (_, h) => `${String(h).padStart(2, '0')}:00`,
    );
    const rows = kbRowsPaired(labels);
    rows.push([MENU_KB_BACK, MENU_KB_MAIN]);
    rows.push([SETUP_KB_CANCEL]);
    return Markup.keyboard(rows).resize().persistent(true);
  }

  private setupBwEndHourReplyMarkup(slotStart: number) {
    const labels: string[] = [];
    for (let h = slotStart + 1; h <= 23; h++) {
      labels.push(`${String(h).padStart(2, '0')}:00`);
    }
    const rows = kbRowsPaired(labels);
    rows.push([BW_KB_END_MIDNIGHT]);
    rows.push([MENU_KB_BACK, MENU_KB_MAIN]);
    rows.push([SETUP_KB_CANCEL]);
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

    if (text === MENU_KB_MAIN) {
      await toHub();
      return true;
    }

    if (sub === 'bw_tz') {
      if (text === MENU_KB_BACK) {
        await toHub();
        return true;
      }
      const tzIdx = this.setupTzLabelIndex(text);
      if (tzIdx < 0) {
        await this.sendSetupDm(
          ctx,
          `Виберіть часовий пояс зі списку або натисніть кнопку «${MENU_KB_BACK}».`,
        );
        return true;
      }
      draft.bwTzDraft = SETUP_TIMEZONES[tzIdx];
      draft.venuesSubstep = 'bw_start';
      this.setupDrafts.set(sk, draft);
      await this.sendSetupDm(
        ctx,
        `Крок 2/3: час початку вікна (включно), у часовому поясі «${draft.bwTzDraft}»:`,
        this.setupBwStartHourReplyMarkup(),
      );
      return true;
    }

    if (sub === 'bw_start') {
      if (text === MENU_KB_BACK) {
        draft.venuesSubstep = 'bw_tz';
        delete draft.bwTzDraft;
        this.setupDrafts.set(sk, draft);
        const comm =
          await this.community.findByTelegramChatId(targetGroupChatId);
        await this.sendSetupDm(
          ctx,
          `Крок 1/3: часовий пояс у вікні бронювання.\n\nПоточні налаштування: ${comm ? this.formatBookingWindowSummary(comm) : '—'}.\n\nОберіть пояс:`,
          this.setupTzReplyMarkup(),
        );
        return true;
      }
      const hm = text.match(/^(\d{1,2}):00$/);
      if (!hm) {
        await this.sendSetupDm(ctx, 'Виберіть час зі списку.');
        return true;
      }
      const hour = Number(hm[1]);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
        await this.sendSetupDm(ctx, 'Виберіть час від 00:00 до 23:00.');
        return true;
      }
      draft.bwStartHourDraft = hour;
      draft.venuesSubstep = 'bw_end';
      this.setupDrafts.set(sk, draft);
      await this.sendSetupDm(
        ctx,
        `Крок 3/3: час закінчення періоду (кінець не вказується): після цього часу бронювання буде недоступним. Початок періоду: ${String(hour).padStart(2, '0')}:00.`,
        this.setupBwEndHourReplyMarkup(hour),
      );
      return true;
    }

    if (text === MENU_KB_BACK) {
      draft.venuesSubstep = 'bw_start';
      delete draft.bwStartHourDraft;
      this.setupDrafts.set(sk, draft);
      await this.sendSetupDm(
        ctx,
        `Крок 2/3: час початку вікна (включно), у часовому поясі «${draft.bwTzDraft}»:`,
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
    if (text === BW_KB_END_MIDNIGHT) {
      endHour = 24;
    } else {
      const hm = text.match(/^(\d{1,2}):00$/);
      if (!hm) {
        await this.sendSetupDm(ctx, 'Виберіть час зі списку.');
        return true;
      }
      endHour = Number(hm[1]);
      if (!Number.isInteger(endHour) || endHour < 1 || endHour > 23) {
        await this.sendSetupDm(ctx, 'Неправильний час.');
        return true;
      }
      if (endHour <= start) {
        await this.sendSetupDm(
          ctx,
          'Кінець періоду має бути пізніше за початок. Оберіть пізніший час або «24:00 — кінець дня».',
        );
        return true;
      }
    }

    if (endHour <= start) {
      await this.sendSetupDm(ctx, 'Кінець вікна має бути пізніше за початок.');
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
        'Не вдалося зберегти налаштування. Спробуйте ще раз.',
      );
      return true;
    }

    draft.venuesSubstep = 'hub';
    delete draft.bwTzDraft;
    delete draft.bwStartHourDraft;
    this.setupDrafts.set(sk, draft);
    await this.sendSetupDm(
      ctx,
      `Готово: час бронювання в групі — ${this.formatBookingWindowSummary({
        bookingWindowTimeZone: tz,
        bookingWindowStartHour: start,
        bookingWindowEndHour: endHour,
      })}.`,
      this.setupVenuesHubReplyMarkup(),
    );
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
    rows.push([SETUP_KB_NEW_RESOURCE, MENU_KB_BACK]);
    rows.push([SETUP_KB_CANCEL]);
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
    rows.push([MENU_KB_BACK, MENU_KB_MAIN]);
    rows.push([SETUP_KB_CANCEL]);
    return Markup.keyboard(rows).resize().persistent(true);
  }

  /** Текст шага 1: при уже существующей площадке показываем имя из БД, не название чата. */
  private setupStep1PromptText(
    chatTitle: string,
    opts: {
      existingResourceName?: string;
      multiFlow?: boolean;
      /** Новая площадка — только ввод текста, без кнопки «как в чате». */
      newResource?: boolean;
      stepMax?: 5 | 6;
    },
  ): string {
    const sm = opts.stepMax ?? 5;
    if (opts.newResource) {
      return (
        `Крок 1/${sm}: як назвати новий майданчик у боті?\n\n` +
        `Надішліть назву одним повідомленням (не порожнє, до 200 символів).`
      );
    }
    const ctShort =
      chatTitle.length > 80 ? `${chatTitle.slice(0, 80)}…` : chatTitle;
    const ex = opts.existingResourceName;
    const tailExisting =
      'Надішліть нову назву у повідомленні або натисніть «Залишити назву без змін», щоб не змінювати ім’я в боті.';
    if (ex) {
      if (opts.multiFlow) {
        return (
          `Крок 1/${sm}: як назвати цей майданчик у боті?\n` +
          `Зараз у боті вона називається: «${ex}».\n\n` +
          tailExisting
        );
      }
      return (
        `Крок 1/${sm}: як назвати цей майданчик у боті?\n` +
        `Зараз у боті вона називається: «${ex}».\n\n` +
        tailExisting
      );
    }
    return (
      `Крок 1/${sm}: як назвати цей майданчик у боті?\n` +
      `Назва чату в Telegram — «${ctShort}»; його можна замінити за допомогою кнопки нижче.\n\n` +
      `Надішліть свою назву у повідомленні або натисніть кнопку.`
    );
  }

  private setupAddressPromptText(
    setupResourceAddressLabel?: string | null,
    stepMax: 5 | 6 = 5,
  ): string {
    const cur = setupResourceAddressLabel?.trim();
    if (cur) {
      return (
        `Крок 2/${stepMax}: адреса майданчика — у дужках поруч із назвою під час вибору.\n` +
        `Зараз у боті: «${cur}».\n\n` +
        `Надішліть нову адресу у повідомленні, «Залишити адресу як є» або «Без адреси», щоб видалити адресу.`
      );
    }
    return (
      `Крок 2/${stepMax}: адреса майданчика (за бажанням — у дужках поруч із назвою).\n` +
      `Наразі адреса не вказана.\n\n` +
      `Надішліть текстовим повідомленням або натисніть «Без адреси», щоб пропустити.`
    );
  }

  private setupAddressReplyMarkup(showKeepCurrent: boolean) {
    const rows: string[][] = showKeepCurrent
      ? [[SETUP_KB_KEEP_ADDRESS, SETUP_KB_NO_ADDRESS]]
      : [[SETUP_KB_NO_ADDRESS]];
    rows.push([MENU_KB_BACK, MENU_KB_MAIN]);
    rows.push([SETUP_KB_CANCEL]);
    return Markup.keyboard(rows).resize().persistent(true);
  }

  private setupTzReplyMarkup() {
    const labels = SETUP_TIMEZONES.map((tz) =>
      (tz.split('/').pop() ?? tz).slice(0, 64),
    );
    const rows = kbRowsPaired(labels);
    rows.push([MENU_KB_BACK, MENU_KB_MAIN]);
    rows.push([SETUP_KB_CANCEL]);
    return Markup.keyboard(rows).resize().persistent(true);
  }

  private setupStartHourReplyMarkup() {
    const labels = Array.from({ length: 23 }, (_, h) =>
      `${String(h).padStart(2, '0')}:00`,
    );
    const rows = kbRowsPaired(labels);
    rows.push([MENU_KB_BACK, MENU_KB_MAIN]);
    rows.push([SETUP_KB_CANCEL]);
    return Markup.keyboard(rows).resize().persistent(true);
  }

  private setupClosingHourReplyMarkup(slotStart: number) {
    const labels: string[] = [];
    for (let h = slotStart + 1; h <= 23; h++) {
      labels.push(`${String(h).padStart(2, '0')}:00`);
    }
    const rows = kbRowsPaired(labels);
    rows.push([MENU_KB_BACK, MENU_KB_MAIN]);
    rows.push([SETUP_KB_CANCEL]);
    return Markup.keyboard(rows).resize().persistent(true);
  }

  private setupResourceVisibilityReplyMarkup() {
    return Markup.keyboard([
      [SETUP_KB_RESOURCE_ACTIVE, SETUP_KB_RESOURCE_INACTIVE],
      [MENU_KB_BACK, MENU_KB_MAIN],
      [SETUP_KB_CANCEL],
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
    const chatIds = await this.resources.listTelegramChatIdsForResource(resourceId);
    for (const gid of chatIds) {
      try {
        await ctx.telegram.sendMessage(gid.toString(), text);
      } catch (e) {
        this.logger.warn(
          `resource_group_broadcast failed chat=${gid.toString()}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  private bookingSportLabel(kindCode?: SportKindCode): string {
    if (kindCode == null) {
      return SPORT_LABEL[SportKindCode.TENNIS];
    }
    return SPORT_LABEL[kindCode] ?? String(kindCode);
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
    if (
      !row ||
      row.isClosed ||
      row.slotStartHour == null ||
      row.slotEndHour == null
    ) {
      return 'Зараз: вихідний.';
    }
    const s = row.slotStartHour;
    const e = row.slotEndHour;
    return `Зараз: слоти з ${String(s).padStart(2, '0')}:00 до ${String(e).padStart(2, '0')}:30.`;
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
      draft.slotEnd === undefined
    ) {
      this.setupDrafts.delete(sk);
      this.setupBridgeGroupByUser.delete(uid);
      await this.replyWithMainMenuInDmForGroup(
        ctx,
        targetGroupChatId,
        'Сесія налаштування застаріла. Запустіть /setup у групі ще раз.',
      );
      return;
    }
    try {
      const communityName = draft.groupChatTitleForPrompt?.trim() || draft.name;
      const { resource } = await this.community.createOrUpdateFromSetup({
        telegramChatId: targetGroupChatId,
        name: communityName,
        address: draft.resourceAddress,
        timeZone: draft.timeZone,
        slotStartHour: draft.slotStart,
        slotEndHour: draft.slotEnd,
        resourceName: draft.name,
        ...(draft.resourceId && !draft.creatingNewResource
          ? { resourceId: draft.resourceId }
          : {}),
        updateCommunityName: false,
        createNewResource: draft.creatingNewResource === true,
        resourceVisibility,
      });
      this.setupDrafts.delete(sk);
      this.setupBridgeGroupByUser.delete(uid);
      const editingExisting = !!draft.resourceId && !draft.creatingNewResource;
      let tail = '';
      if (editingExisting) {
        tail =
          resourceVisibility === ResourceVisibility.INACTIVE
            ? ' Неактивна — не відображається у списку бронювання для звичайних учасників.'
            : ' Активна — доступна для бронювання всім.';
      }
      const baseDone = draft.creatingNewResource
        ? `Готово: додано майданчик «${draft.name}» (активна). Можна бронювати в групі.`
        : `Готово: майданчик «${draft.name}» збережений.${tail}`;
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
          'Виберіть день тижня (Пн — понеділок). Зміни зберігаються одразу.',
        );
        await this.sendSetupDm(ctx, 'Виберіть день тижня:', this.whPickDayReplyMarkup());
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
          ? `${baseDone}\n\nУ нижній частині клавіатури — «Налаштувати годинник за днями» або «Пропустити» (однаковий час для всіх днів).`
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
        'Не вдалося зберегти налаштування. Спробуйте виконати команду /setup у групі ще раз.',
      );
    }
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
      const uid = ctx.from!.id;
      // Спочатку зняти reply-клавіатуру — інакше деякі клієнти не підміняють велике меню /setup.
      await ctx.telegram.sendMessage(
        uid,
        '\u2060',
        Markup.removeKeyboard(),
      );
      await this.replyWithMainMenuInDmForGroup(ctx, targetGroupChatId, '\u2060');
    };

    if (text.trim() === SETUP_KB_CANCEL) {
      await finishCancel();
      return;
    }

    const chatTitle = draft.groupChatTitleForPrompt ?? 'Чат';

    switch (draft.step) {
      case 0: {
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
        let linkable: {
          id: string;
          name: string;
          address?: string | null;
          visibility: ResourceVisibility;
        }[] = [];
        const venuesSub = draft.venuesSubstep ?? 'list';

        if (venuesSub === 'hub') {
          if (text === SETUP_KB_VENUES) {
            draft.venuesSubstep = 'list';
            this.setupDrafts.set(sk, draft);
            await this.sendSetupDm(
              ctx,
              'Виберіть майданчик або додайте новий. Часовий пояс, час та адреса вказуються для кожного майданчика окремо.',
              this.setupPickResourceReplyMarkup(list),
            );
            return;
          }
          if (text === SETUP_KB_BOOKING_WINDOW) {
            const comm =
              await this.community.findByTelegramChatId(targetGroupChatId);
            if (!comm) {
              await this.sendSetupDm(
                ctx,
                'Спочатку налаштуйте майданчик у розділі «Майданчики».',
              );
              return;
            }
            draft.venuesSubstep = 'bw_tz';
            delete draft.bwTzDraft;
            delete draft.bwStartHourDraft;
            this.setupDrafts.set(sk, draft);
            await this.sendSetupDm(
              ctx,
              `Час бронювання в групі\n\n` +
                `Зараз: ${this.formatBookingWindowSummary(comm)}.\n\n` +
                `Учасники бачать меню завжди, але оформити нове бронювання зможуть лише в цей проміжок часу (за місцевим часом у вибраному часовому поясі).\n\n` +
                `Крок 1/3: часовий пояс для вікна:`,
              this.setupTzReplyMarkup(),
            );
            return;
          }
          if (text === SETUP_KB_BOOKING_LIMIT) {
            const comm =
              await this.community.findByTelegramChatId(targetGroupChatId);
            if (!comm) {
              await this.sendSetupDm(
                ctx,
                'Спочатку налаштуйте майданчик у розділі «Майданчики».',
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
              `Ліміт на бронювання\n\n` +
                `Скільки годин один користувач може забронювати протягом календарного дня для кожного дня тижня (окремо для кожного майданчика). День тижня та дата — за часовим поясом майданчика, на який здійснюється бронювання; одне бронювання не може перевищувати ліміт на цей день.\n\n` +
                `${this.formatUserBookingLimitsSummary(limits)}\n\n` +
                `Виберіть день тижня:`,
              this.setupLimitWeekdayReplyMarkup(),
            );
            return;
          }
          if (text === SETUP_KB_LINK_EXISTING_RESOURCE) {
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
                  await isUserAdminOfGroupChat(
                    ctx.telegram,
                    gid,
                    ctx.from.id,
                  )
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
                `Немає доступних майданчиків для привʼязки. Ви бачите лише ресурси з тих груп, де ви адмін, і які ще не додані в поточну групу.`,
              );
              return;
            }
            draft.venuesSubstep = 'link_pick';
            this.setupDrafts.set(sk, draft);
            await this.sendSetupDm(
              ctx,
              'Виберіть майданчик для привʼязки до цієї групи:',
              this.setupLinkExistingResourceReplyMarkup(linkable),
            );
            return;
          }
          await this.sendSetupDm(ctx, this.setupHubPromptText(chatTitle));
          return;
        }

        if (venuesSub === 'link_pick') {
          if (text === MENU_KB_BACK) {
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
                await isUserAdminOfGroupChat(
                  ctx.telegram,
                  gid,
                  ctx.from.id,
                )
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
              `Виберіть номер зі списку або натисніть «${MENU_KB_BACK}».`,
            );
            return;
          }
          const idx = Number(m[1]) - 1;
          const picked = linkable[idx];
          if (!picked) {
            await this.sendSetupDm(
              ctx,
              `Виберіть номер зі списку або натисніть «${MENU_KB_BACK}».`,
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
              'Не вдалося привʼязати майданчик. Перевірте права доступу та спробуйте ще раз.',
            );
            return;
          }
          draft.venuesSubstep = 'hub';
          this.setupDrafts.set(sk, draft);
          await this.sendSetupDm(
            ctx,
            `Готово: майданчик «${picked.name}» привʼязано до групи.`,
            this.setupVenuesHubReplyMarkup(),
          );
          return;
        }

        if (text === MENU_KB_BACK) {
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

        if (text === SETUP_KB_NEW_RESOURCE) {
          draft.creatingNewResource = true;
          delete draft.resourceId;
          delete draft.multiResourceFlow;
          delete draft.setupResourceLabel;
          draft.setupResourceAddressLabel = null;
          draft.step = 1;
          this.setupDrafts.set(sk, draft);
          await this.sendSetupDm(
            ctx,
            'Новий майданчик.\n\n' +
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
            `Виберіть номер зі списку або натисніть «${SETUP_KB_NEW_RESOURCE}».`,
          );
          return;
        }
        const idx = Number(m[1]) - 1;
        const r = list[idx];
        if (!r) {
          await this.sendSetupDm(
            ctx,
            `Виберіть номер зі списку або натисніть «${SETUP_KB_NEW_RESOURCE}».`,
          );
          return;
        }
        draft.resourceId = r.id;
        draft.multiResourceFlow = list.length >= 2;
        delete draft.creatingNewResource;
        draft.setupResourceLabel = r.name;
        draft.setupResourceAddressLabel = r.address ?? null;
        draft.setupResourceVisibility = r.visibility;
        draft.step = 1;
        this.setupDrafts.set(sk, draft);
        await this.sendSetupDm(
          ctx,
          `Вибраний майданчик «${r.name}».\n\n` +
            this.setupStep1PromptText(chatTitle, {
              existingResourceName: r.name,
              multiFlow: draft.multiResourceFlow,
              stepMax: this.setupStepMax(draft),
            }),
          this.setupStep1ReplyMarkup(true, r.name),
        );
        return;
      }
      case 1: {
        if (
          text === MENU_KB_BACK &&
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
          draft.venuesSubstep = 'list';
          this.setupDrafts.set(sk, draft);
          const listBack = await this.resources.listForChat(targetGroupChatId);
          await this.sendSetupDm(
            ctx,
            'Виберіть майданчик або додайте новий. Часовий пояс, час та адреса вказуються для кожного майданчика окремо.',
            this.setupPickResourceReplyMarkup(listBack),
          );
          return;
        }
        let name: string;
        if (text === SETUP_KB_KEEP_BOT_NAME) {
          if (!draft.setupResourceLabel) {
            if (draft.creatingNewResource) {
              await this.sendSetupDm(
                ctx,
                'Для нового майданчика введіть назву у вигляді тексту (не порожню).',
              );
            }
            return;
          }
          name = draft.setupResourceLabel;
        } else if (text === SETUP_KB_USE_CHAT_TITLE) {
          if (draft.creatingNewResource) {
            await this.sendSetupDm(
              ctx,
              'Для нового майданчика введіть свою назву текстом, а не з назви чату.',
            );
            return;
          }
          const t = draft.groupChatTitleForPrompt?.trim();
          if (!t) {
            await this.sendSetupDm(
              ctx,
              'Не вдалося отримати назву чату. Введіть назву у вигляді тексту.',
            );
            return;
          }
          name = t;
        } else {
          const trimmed = text.trim();
          if (!trimmed) {
            await this.sendSetupDm(
              ctx,
              draft.setupResourceLabel
                ? 'Введіть назву у вигляді тексту або натисніть «Залишити назву без змін».'
                : draft.creatingNewResource
                  ? 'Введіть назву майданчика у вигляді тексту (не порожнє поле).'
                  : 'Введіть назву майданчика у вигляді тексту або натисніть «Назва, як у чаті».',
            );
            return;
          }
          if (trimmed.length > 200) {
            await this.sendSetupDm(
              ctx,
              'Назва занадто довга (максимум 200 символів).',
            );
            return;
          }
          name = trimmed;
        }
        draft.name = name;
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
        if (text === MENU_KB_BACK) {
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
              ? 'Новая площадка.\n\n' +
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
              draft.creatingNewResource && !draft.setupResourceLabel
                ? { newResource: true }
                : undefined,
            ),
          );
          return;
        }
        let addr: string | null;
        if (text === SETUP_KB_KEEP_ADDRESS) {
          const cur = draft.setupResourceAddressLabel?.trim();
          if (!cur) {
            return;
          }
          addr = draft.setupResourceAddressLabel!.trim();
        } else if (text === SETUP_KB_NO_ADDRESS) {
          addr = null;
        } else {
          const trimmed = text.trim();
          if (!trimmed) {
            await this.sendSetupDm(
              ctx,
              draft.setupResourceAddressLabel?.trim()
                ? 'Введіть адресу у текстовому полі або натисніть кнопку нижче.'
                : 'Введіть адресу у вигляді тексту або натисніть «Без адреси».',
            );
            return;
          }
          if (trimmed.length > 300) {
            await this.sendSetupDm(
              ctx,
              'Адреса занадто довга (максимум 300 символів).',
            );
            return;
          }
          addr = trimmed;
        }
        draft.resourceAddress = addr;
        draft.step = 3;
        this.setupDrafts.set(sk, draft);
        await this.sendSetupDm(
          ctx,
          `${this.setupStepLine(3, draft)}: часовий пояс (слоти будуть у цьому поясі)`,
          this.setupTzReplyMarkup(),
        );
        return;
      }
      case 3: {
        if (text === MENU_KB_BACK) {
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
        const isEditExisting =
          !!draft.resourceId && !draft.creatingNewResource;
        if (isEditExisting) {
          draft.postTzVisibilityOnly = true;
          draft.step = 6;
          this.setupDrafts.set(sk, draft);
          const cur =
            draft.setupResourceVisibility === ResourceVisibility.INACTIVE
              ? 'неактивна (у бронюванні для звичайних учасників не відображається)'
              : 'активна';
          await this.sendSetupDm(
            ctx,
            `${this.setupStepLine(6, draft)}: статус майданчика.\n\n` +
              `Зараз у боті: ${cur}.\n\n` +
              `Виберіть статус — далі одразу налаштування годин за днями тижня:`,
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
        if (text === MENU_KB_BACK) {
          draft.step = 3;
          delete draft.timeZone;
          delete draft.slotStart;
          delete draft.slotEnd;
          this.setupDrafts.set(sk, draft);
          await this.sendSetupDm(
            ctx,
            `${this.setupStepLine(3, draft)}: часовий пояс (слоти будуть у цьому поясі)`,
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
            'Оберіть час роботи з 00:00 до 22:00.',
          );
          return;
        }
        draft.slotStart = hour;
        delete draft.slotEnd;
        draft.step = 5;
        this.setupDrafts.set(sk, draft);
        await this.sendSetupDm(
          ctx,
          `${this.setupStepLine(5, draft)}: час закінчення роботи — до обраного часу всі бронювання мають завершитися (відкриття: ${String(hour).padStart(2, '0')}:00)`,
          this.setupClosingHourReplyMarkup(hour),
        );
        return;
      }
      case 5: {
        if (text === MENU_KB_BACK) {
          draft.step = 4;
          delete draft.slotStart;
          delete draft.slotEnd;
          this.setupDrafts.set(sk, draft);
          await this.sendSetupDm(
            ctx,
            `${this.setupStepLine(4, draft)}: час відкриття — найраніший можливий час початку бронювання`,
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
            'Закінчення має бути пізніше за час початку. Оберіть інший час.',
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
            'Сесія налаштування застаріла. Запустіть /setup у групі ще раз.',
          );
          return;
        }
        const isEditExisting = !!draft.resourceId && !draft.creatingNewResource;
        if (isEditExisting) {
          draft.step = 6;
          this.setupDrafts.set(sk, draft);
          const cur =
            draft.setupResourceVisibility === ResourceVisibility.INACTIVE
              ? 'неактивна (у бронюванні для звичайних учасників не відображається)'
              : 'активна';
          await this.sendSetupDm(
            ctx,
            `${this.setupStepLine(6, draft)}: статус майданчика.\n\n` +
              `Зараз у боті: ${cur}.\n\n` +
              `Виберіть статус — він збережеться разом із часом та адресою:`,
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
        if (draft.postTzVisibilityOnly) {
          if (text === MENU_KB_BACK) {
            delete draft.postTzVisibilityOnly;
            draft.step = 3;
            delete draft.timeZone;
            delete draft.slotStart;
            delete draft.slotEnd;
            this.setupDrafts.set(sk, draft);
            await this.sendSetupDm(
              ctx,
              `${this.setupStepLine(3, draft)}: часовий пояс (слоти будуть у цьому поясі)`,
              this.setupTzReplyMarkup(),
            );
            return;
          }
          let vis: ResourceVisibility | undefined;
          if (text === SETUP_KB_RESOURCE_ACTIVE) {
            vis = ResourceVisibility.ACTIVE;
          } else if (text === SETUP_KB_RESOURCE_INACTIVE) {
            vis = ResourceVisibility.INACTIVE;
          }
          if (vis === undefined) {
            return;
          }
          delete draft.postTzVisibilityOnly;
          this.setupDrafts.set(sk, draft);
          await this.persistSetupDraft(
            ctx,
            draft,
            vis,
            targetGroupChatId,
            { startPerDayImmediately: true },
          );
          return;
        }
        if (text === MENU_KB_BACK) {
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
              'Сесія налаштування застаріла. Запустіть /setup у групі ще раз.',
            );
            return;
          }
          await this.sendSetupDm(
            ctx,
            `${this.setupStepLine(5, draft)}: час закінчення роботи — до обраного часу всі бронювання мають завершитися (відкриття: ${String(hour).padStart(2, '0')}:00)`,
            this.setupClosingHourReplyMarkup(hour),
          );
          return;
        }
        let vis: ResourceVisibility | undefined;
        if (text === SETUP_KB_RESOURCE_ACTIVE) {
          vis = ResourceVisibility.ACTIVE;
        } else if (text === SETUP_KB_RESOURCE_INACTIVE) {
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

  /**
   * Правила в ЛС; если не выходит (нет /start, бот заблокирован) — в группу.
   * В callback передаём groupChatId, чтобы кнопка работала из лички.
   */
  private async sendCommunityRulesMessages(
    telegram: Context['telegram'],
    groupChatId: bigint,
    targetUserId: number,
    rulesText: string,
    opts?: { allowGroupFallback?: boolean },
  ): Promise<{ usedDm: boolean }> {
    const intro =
      'Ласкаво просимо! Перед початком ознайомтеся з правилами спільноти.\n\n' +
      'Після прочитання натисніть «Погоджуюсь з правилами» під останнім повідомленням.\n\n—\n\n';
    const full = `${intro}${rulesText}`;
    const chunks: string[] = [];
    for (let i = 0; i < full.length; i += RULES_MESSAGE_CHUNK) {
      chunks.push(full.slice(i, i + RULES_MESSAGE_CHUNK));
    }
    const groupStr = groupChatId.toString();
    const cbData = `gr:${targetUserId}:${groupStr}`;
    const lastExtra = {
      reply_markup: {
        inline_keyboard: [
          [{ text: RULES_ACCEPT_KB, callback_data: cbData }],
        ],
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
        'Щоб переглянути правила та підтвердити їх, відкрийте бота в особистих повідомленнях і натисніть Start.',
        {
          reply_markup: {
            inline_keyboard: [[{ text: 'Відкрити бота', url: deepLink }]],
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
        if (joinResult.pendingGroupRules && joinResult.rulesText) {
          try {
            const { usedDm } = await this.sendCommunityRulesMessages(
              ctx.telegram,
              chatId,
              u.id,
              joinResult.rulesText,
              { allowGroupFallback: true },
            );
            if (usedDm) {
              try {
                const sent = await ctx.telegram.sendMessage(
                  chat.id,
                  'Правила спільноти надіслано вам у приватне повідомлення від бота. Відкрийте діалог із ботом (за потреби натисніть «Start») і підтвердьте натисканням кнопки внизу.',
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
          ? 'Ласкаво просимо!\n\nНатисніть «Чат Бот», щоб працювати з меню в особистих повідомленнях.'
          : 'Ласкаво просимо!\n\nМайданчик ще не налаштований. Адміністратору: команда /setup.';
        try {
          const kb = await this.groupEntryReplyMarkupForChatUser(
            ctx.telegram,
            chatId,
            u.id,
          );
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
    await ctx.reply(
      'Привіт! Усі дії з меню виконуються в особистих повідомленнях з ботом.\n\nАдміністратору: /setup у цій групі (далі налаштування в ЛС).',
      await this.mainMenuReplyMarkup(ctx),
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
          ? ctx.message.text.trim().split(/\s+/, 2)[1] ?? ''
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
          const rulesText =
            await this.telegramMembers.getGroupRulesText(groupChatId);
          if (!rulesText) {
            await ctx.reply('Правила для цієї групи не знайдені.');
            return;
          }
          this.activeGroupByUser.set(ctx.from.id, groupChatId);
          try {
            await this.sendCommunityRulesMessages(
              ctx.telegram,
              groupChatId,
              ctx.from.id,
              rulesText,
              { allowGroupFallback: false },
            );
          } catch {
            await ctx.reply(
              'Не вдалося надіслати правила. Спробуйте ще раз або натисніть «Чат Бот» у групі.',
            );
          }
          return;
        }
      }
      this.resetMenuState(ctx);
      const gid = await this.promptGroupPickerInDm(ctx, {
        hint: 'Оберіть групу для роботи:',
      });
      if (gid == null) {
        return;
      }
      await ctx.reply(
        'Головне меню:',
        await this.mainMenuReplyMarkup(ctx),
      );
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

    await ctx.reply(
      'Меню бота доступне в особистих повідомленнях. Натисніть «Чат Бот» та відкрийте зі мною приватний діалог.',
      await this.mainMenuReplyMarkup(ctx),
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

    try {
      const comm = await this.community.findByTelegramChatId(groupChatId);
      if (comm && comm.resources.length >= 1) {
        await startDm(
          {
            step: 0,
            groupChatTitleForPrompt: chatTitle,
            venuesSubstep: 'hub',
          },
          `Налаштування групи «${chatTitle}». Надалі пишіть лише тут — учасники групи цього не побачать.\n\n${this.setupHubButtonsHintText()}`,
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
        groupChatTitleForPrompt: chatTitle,
        setupResourceAddressLabel,
        ...(resourceId ? { resourceId } : {}),
        ...(setupResourceLabel ? { setupResourceLabel } : {}),
        ...(setupResourceVisibility !== undefined
          ? { setupResourceVisibility }
          : {}),
      };
      await startDm(
        draftOne,
        `Налаштування групи «${chatTitle}». Надалі пишіть лише тут — учасники групи цього не побачать.\n\n${this.setupStep1PromptText(
          chatTitle,
          {
            existingResourceName: setupResourceLabel,
            multiFlow: false,
            stepMax: this.setupStepMax(draftOne),
          },
        )}`,
        this.setupStep1ReplyMarkup(false, setupResourceLabel),
      );
    } catch (e) {
      this.setupDrafts.delete(sk);
      this.setupBridgeGroupByUser.delete(from.id);
      throw e;
    }
  }

  /** Запуск настройки из группы: команда /setup или кнопка «Настройки». */
  private async runGroupSetup(ctx: Context) {
    if (!ctx.from || !ctx.chat?.id || !isGroupChat(ctx)) {
      return;
    }
    if (!(await isGroupAdmin(ctx))) {
      await this.replyTransientInGroup(
        ctx,
        'Лише адміністратор може налаштовувати майданчик.',
      );
      return;
    }

    const chatTitle =
      ctx.chat && 'title' in ctx.chat && ctx.chat.title
        ? ctx.chat.title
        : 'Чат';

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
        'Не вдалося написати вам у приватних повідомленнях. Відкрийте діалог із ботом і натисніть Start, а потім знову виконайте команду /setup у групі або натисніть «Налаштування».',
      );
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
    if (ctx.from.id !== expectedUserId) {
      await ctx.answerCbQuery('Ця кнопка призначена не для вас.', {
        show_alert: true,
      });
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
        'Не вдалося визначити групу. Попросіть надіслати правила ще раз.',
        { show_alert: true },
      );
      return;
    }
    try {
      const member = await ctx.telegram.getChatMember(
        groupChatId.toString(),
        ctx.from.id,
      );
      if (!TelegramMembersService.isStatusInChat(member.status)) {
        await ctx.answerCbQuery('Ви не є учасником цієї групи.', {
          show_alert: true,
        });
        await ctx.reply(
          'Підтвердити правила можна лише для групи, учасником якої ви є зараз.',
        );
        return;
      }
    } catch {
      await ctx.answerCbQuery('Група недоступна або вас немає в групі.', {
        show_alert: true,
      });
      return;
    }
    await ctx.answerCbQuery();
    const r = await this.telegramMembers.acceptGroupRules({
      telegramChatId: groupChatId,
      telegramUserId: ctx.from.id,
    });
    if (!r.ok) {
      await ctx.reply(
        'Не вдалося підтвердити: правила не визначені або вас немає у списку учасників чату.',
      );
      return;
    }
    try {
      await ctx.editMessageText('✅ Правила прийнято.');
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
      ? '✅ Правила прийнято. Відкрийте бота в особистих повідомленнях і натисніть /start.'
      : '✅ Правила прийнято. Майданчик ще не налаштований. Адміністратору: команда /setup.';
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
    if (!isGroupChat(ctx) || !ctx.chat) {
      await ctx.reply('Доступно лише в групі.');
      return;
    }
    await ctx.reply(
      'Відкрийте особисті повідомлення з ботом і натисніть /start.',
      await this.mainMenuReplyMarkup(ctx),
    );
  }
}
