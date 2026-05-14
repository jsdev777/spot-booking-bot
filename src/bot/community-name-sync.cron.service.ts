import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectBot } from 'nestjs-telegraf';
import { Context, Telegraf } from 'telegraf';
import { CommunityService } from '../community/community.service';

@Injectable()
export class CommunityNameSyncCronService {
  private readonly logger = new Logger(CommunityNameSyncCronService.name);

  constructor(
    private readonly community: CommunityService,
    @InjectBot() private readonly bot: Telegraf<Context>,
  ) {}

  @Cron(CronExpression.EVERY_6_HOURS)
  async syncAutoCommunityNamesDaily(): Promise<void> {
    const rows = await this.community.listAutoNamedCommunitiesBasic();
    for (const row of rows) {
      try {
        const chat = await this.bot.telegram.getChat(
          row.telegramChatId.toString(),
        );
        if (!('title' in chat) || !chat.title?.trim()) {
          continue;
        }
        await this.community.syncAutoCommunityNameWithChatTitle({
          telegramChatId: row.telegramChatId,
          chatTitle: chat.title,
        });
      } catch (e) {
        this.logger.warn(
          `daily auto-name sync failed chat=${row.telegramChatId.toString()}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
  }
}
