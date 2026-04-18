import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor(configService: ConfigService) {
    const connectionString = configService.getOrThrow<string>('DATABASE_URL');
    const poolMax = Number(configService.get<string>('PG_POOL_MAX') ?? 20);
    const poolConnectionTimeoutMs = Number(
      configService.get<string>('PG_POOL_CONNECTION_TIMEOUT_MS') ?? 5000,
    );
    const poolIdleTimeoutMs = Number(
      configService.get<string>('PG_POOL_IDLE_TIMEOUT_MS') ?? 120000,
    );
    const pool = new Pool({
      connectionString,
      max: Number.isFinite(poolMax) ? poolMax : 20,
      connectionTimeoutMillis: Number.isFinite(poolConnectionTimeoutMs)
        ? poolConnectionTimeoutMs
        : 5000,
      idleTimeoutMillis: Number.isFinite(poolIdleTimeoutMs)
        ? poolIdleTimeoutMs
        : 120000,
    });
    super({ adapter: new PrismaPg(pool) });
    this.pool = pool;
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    await this.pool.end();
  }
}
