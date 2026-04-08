/* eslint-disable no-console */
require('dotenv').config();

const { PrismaClient, BookingStatus, SportKindCode } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is required for smoke-load script.');
}
const pool = new Pool({ connectionString });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
const SMOKE_TAG = '__smoke_load__';

function plusMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function percentile(values, p) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((p / 100) * sorted.length)),
  );
  return sorted[idx];
}

async function getBaseResource() {
  const row = await prisma.communityResource.findFirst({
    include: { resource: true },
  });
  if (!row) {
    throw new Error(
      'No community_resource rows found. Create at least one resource via /setup before smoke-load.',
    );
  }
  return row;
}

async function scenarioConcurrentSameSlot(base) {
  const startTime = plusMinutes(new Date(), 24 * 60);
  startTime.setSeconds(0, 0);
  const endTime = plusMinutes(startTime, 60);
  const total = 20;

  const settled = await Promise.allSettled(
    Array.from({ length: total }, (_, i) =>
      prisma.booking.create({
        data: {
          communityResourceId: base.id,
          resourceId: base.resourceId,
          sportKindCode: SportKindCode.TENNIS,
          userId: BigInt(900000000 + i),
          userName: `${SMOKE_TAG}_same_slot_${i}`,
          startTime,
          endTime,
          status: BookingStatus.PENDING,
        },
      }),
    ),
  );

  const successes = settled.filter((x) => x.status === 'fulfilled').length;
  if (successes !== 1) {
    throw new Error(
      `Concurrent same-slot protection failed. Expected 1 success, got ${successes}.`,
    );
  }
}

async function scenarioConcurrentVolunteer(base) {
  const startTime = plusMinutes(new Date(), 48 * 60);
  startTime.setSeconds(0, 0);
  const endTime = plusMinutes(startTime, 60);

  const booking = await prisma.booking.create({
    data: {
      communityResourceId: base.id,
      resourceId: base.resourceId,
      sportKindCode: SportKindCode.TENNIS,
      userId: BigInt(910000000),
      userName: `${SMOKE_TAG}_volunteer_owner`,
      startTime,
      endTime,
      status: BookingStatus.PENDING,
      isLookingForPlayers: true,
      requiredPlayers: 10,
    },
  });

  const clicks = 25;
  const results = await Promise.all(
    Array.from({ length: clicks }, (_, i) =>
      prisma.$transaction(async (tx) => {
        const dec = await tx.booking.updateMany({
          where: {
            id: booking.id,
            status: { in: [BookingStatus.PENDING, BookingStatus.ACTIVE] },
            isLookingForPlayers: true,
            requiredPlayers: { gt: 0 },
          },
          data: {
            requiredPlayers: { decrement: 1 },
          },
        });
        if (dec.count === 0) {
          return false;
        }
        const current = await tx.booking.findUniqueOrThrow({
          where: { id: booking.id },
          select: { requiredPlayers: true },
        });
        if (current.requiredPlayers <= 0) {
          await tx.booking.update({
            where: { id: booking.id },
            data: { isLookingForPlayers: false },
          });
        }
        await tx.bookingLookingParticipant.upsert({
          where: {
            bookingId_telegramUserId: {
              bookingId: booking.id,
              telegramUserId: BigInt(920000000 + i),
            },
          },
          create: {
            bookingId: booking.id,
            telegramUserId: BigInt(920000000 + i),
            peopleCount: 1,
          },
          update: { peopleCount: { increment: 1 } },
        });
        return true;
      }),
    ),
  );

  const successfulClicks = results.filter(Boolean).length;
  const fresh = await prisma.booking.findUniqueOrThrow({
    where: { id: booking.id },
    select: { requiredPlayers: true, isLookingForPlayers: true },
  });
  if (fresh.requiredPlayers < 0) {
    throw new Error('requiredPlayers dropped below zero.');
  }
  if (fresh.requiredPlayers !== Math.max(0, 10 - successfulClicks)) {
    throw new Error('requiredPlayers mismatch after concurrent volunteer flow.');
  }
  if (fresh.requiredPlayers === 0 && fresh.isLookingForPlayers) {
    throw new Error('isLookingForPlayers should be false when requiredPlayers is zero.');
  }
}

async function scenarioReminderWindowQuery() {
  const samples = [];
  for (let i = 0; i < 20; i += 1) {
    const now = Date.now();
    const from = new Date(now + 14 * 60 * 1000);
    const to = new Date(now + 16 * 60 * 1000);
    const t0 = Date.now();
    await prisma.booking.findMany({
      where: {
        status: { in: [BookingStatus.PENDING, BookingStatus.ACTIVE] },
        endTime: { gt: new Date(now) },
        startTime: { gte: from, lte: to },
      },
      select: { id: true },
      take: 500,
    });
    samples.push(Date.now() - t0);
  }
  return {
    p95Ms: percentile(samples, 95),
    maxMs: Math.max(...samples),
    avgMs: Math.round(samples.reduce((a, b) => a + b, 0) / samples.length),
  };
}

async function cleanupSmokeData() {
  const rows = await prisma.booking.findMany({
    where: { userName: { startsWith: SMOKE_TAG } },
    select: { id: true },
  });
  const ids = rows.map((x) => x.id);
  if (ids.length === 0) {
    return;
  }
  await prisma.bookingLookingParticipant.deleteMany({
    where: { bookingId: { in: ids } },
  });
  await prisma.booking.deleteMany({
    where: { id: { in: ids } },
  });
}

async function main() {
  const base = await getBaseResource();
  await cleanupSmokeData();
  await scenarioConcurrentSameSlot(base);
  await scenarioConcurrentVolunteer(base);
  const reminderStats = await scenarioReminderWindowQuery();
  await cleanupSmokeData();

  console.log('Smoke-load passed.');
  console.log(
    JSON.stringify(
      {
        slo: {
          noInconsistentRows: true,
          reminderQueryP95Ms: reminderStats.p95Ms,
        },
        reminderQueryStats: reminderStats,
      },
      null,
      2,
    ),
  );
}

main()
  .catch(async (e) => {
    console.error('Smoke-load failed:', e instanceof Error ? e.message : String(e));
    await cleanupSmokeData().catch(() => undefined);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
