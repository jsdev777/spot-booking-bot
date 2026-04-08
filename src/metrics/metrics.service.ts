import { Injectable } from '@nestjs/common';
import {
  Counter,
  Histogram,
  Registry,
  collectDefaultMetrics,
  register,
} from 'prom-client';

type BookingCreateResult = 'success' | 'conflict' | 'error';
type TelegramSendResult = 'success' | 'error';
type TelegramSendKind = 'dm' | 'group' | 'reminder';

@Injectable()
export class MetricsService {
  private static initialized = false;
  private readonly registry: Registry;

  private readonly bookingCreateTotal: Counter<'result'>;
  private readonly bookingCreateDuration: Histogram<string>;
  private readonly bookingSlotsBuildDuration: Histogram<string>;
  private readonly reminderBatchDuration: Histogram<string>;
  private readonly telegramSendTotal: Counter<'result' | 'kind'>;
  private readonly telegramSendRetryTotal: Counter<'kind'>;
  private readonly bookingCreateConflictTotal: Counter<string>;
  private readonly bookingCreateSystemErrorTotal: Counter<string>;

  constructor() {
    this.registry = register;
    if (!MetricsService.initialized) {
      collectDefaultMetrics({
        register: this.registry,
        prefix: 'spot_booking_',
      });
      MetricsService.initialized = true;
    }

    this.bookingCreateTotal = this.getOrCreateCounter(
      'spot_booking_booking_create_total',
      'Total booking create attempts by result.',
      ['result'],
    );
    this.bookingCreateDuration = this.getOrCreateHistogram(
      'spot_booking_booking_create_duration_ms',
      'Booking create duration in milliseconds.',
      [5, 10, 20, 40, 80, 120, 200, 400, 800, 1600],
    );
    this.bookingSlotsBuildDuration = this.getOrCreateHistogram(
      'spot_booking_booking_slots_build_duration_ms',
      'Build available slots duration in milliseconds.',
      [5, 10, 20, 40, 80, 120, 200, 400, 800, 1600],
    );
    this.reminderBatchDuration = this.getOrCreateHistogram(
      'spot_booking_reminder_batch_duration_ms',
      'Reminder batch duration in milliseconds.',
      [10, 20, 40, 80, 120, 200, 400, 800, 1600, 3000, 6000],
    );
    this.telegramSendTotal = this.getOrCreateCounter(
      'spot_booking_telegram_send_total',
      'Telegram send attempts by result and kind.',
      ['result', 'kind'],
    );
    this.telegramSendRetryTotal = this.getOrCreateCounter(
      'spot_booking_telegram_send_retry_total',
      'Telegram send retries by message kind.',
      ['kind'],
    );
    this.bookingCreateConflictTotal = this.getOrCreateCounter(
      'spot_booking_booking_create_conflict_total',
      'Booking create conflicts total.',
      [],
    );
    this.bookingCreateSystemErrorTotal = this.getOrCreateCounter(
      'spot_booking_booking_create_system_error_total',
      'Booking create system errors total.',
      [],
    );
  }

  private getOrCreateCounter<TLabels extends string>(
    name: string,
    help: string,
    labelNames: TLabels[],
  ): Counter<TLabels> {
    const existing = this.registry.getSingleMetric(name);
    if (existing) {
      return existing as Counter<TLabels>;
    }
    return new Counter({
      name,
      help,
      labelNames,
      registers: [this.registry],
    });
  }

  private getOrCreateHistogram(
    name: string,
    help: string,
    buckets: number[],
  ): Histogram<string> {
    const existing = this.registry.getSingleMetric(name);
    if (existing) {
      return existing as Histogram<string>;
    }
    return new Histogram({
      name,
      help,
      buckets,
      registers: [this.registry],
    });
  }

  async metricsText(): Promise<string> {
    return this.registry.metrics();
  }

  metricsContentType(): string {
    return this.registry.contentType;
  }

  incBookingCreate(result: BookingCreateResult): void {
    this.bookingCreateTotal.inc({ result }, 1);
  }

  observeBookingCreateDuration(ms: number): void {
    this.bookingCreateDuration.observe(ms);
  }

  observeBookingSlotsBuildDuration(ms: number): void {
    this.bookingSlotsBuildDuration.observe(ms);
  }

  observeReminderBatchDuration(ms: number): void {
    this.reminderBatchDuration.observe(ms);
  }

  incTelegramSend(result: TelegramSendResult, kind: TelegramSendKind): void {
    this.telegramSendTotal.inc({ result, kind }, 1);
  }

  incTelegramRetry(kind: TelegramSendKind): void {
    this.telegramSendRetryTotal.inc({ kind }, 1);
  }

  incBookingCreateConflict(): void {
    this.bookingCreateConflictTotal.inc(1);
  }

  incBookingCreateSystemError(): void {
    this.bookingCreateSystemErrorTotal.inc(1);
  }
}
