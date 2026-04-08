/* eslint-disable no-console */
require('dotenv').config();

const { PrismaClient, BookingStatus, SportKindCode } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is required.');
}

const pool = new Pool({ connectionString });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
const TAG = '__load_db__';
const RUN_TAG = `${TAG}${Date.now()}_`;

const DEFAULT_CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 40);
const DEFAULT_SECONDS = Number(process.env.LOAD_SECONDS ?? 180);
const DEFAULT_MIX = (process.env.LOAD_MIX ?? '50,30,20')
  .split(',')
  .map((x) => Number(x.trim()));
const SLO_SYSTEM_ERROR_RATE_MAX = Number(
  process.env.LOAD_SLO_SYSTEM_ERROR_RATE_MAX ?? 0.01,
);
const SLO_QUERY_P95_MAX_MS = Number(process.env.LOAD_SLO_QUERY_P95_MAX_MS ?? 120);
const SLO_VOLUNTEER_P95_MAX_MS = Number(
  process.env.LOAD_SLO_VOLUNTEER_P95_MAX_MS ?? 120,
);

function classifyError(errorText) {
  const text = (errorText ?? '').toLowerCase();
  if (
    text.includes('unique constraint failed') ||
    text.includes('bookings_overlap_blocked') ||
    text.includes('slottakenerror')
  ) {
    return 'business_conflict';
  }
  return 'system_error';
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function isBusinessConflictError(error) {
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    text.includes('bookings_overlap_blocked') ||
    text.includes('unique constraint failed')
  );
}

function plusMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function parseMix(mix) {
  if (mix.length !== 3 || mix.some((x) => !Number.isFinite(x) || x < 0)) {
    throw new Error(
      'LOAD_MIX must contain three non-negative numbers, e.g. 50,30,20',
    );
  }
  const sum = mix.reduce((a, b) => a + b, 0);
  if (sum <= 0) {
    throw new Error('LOAD_MIX sum must be > 0');
  }
  return mix.map((x) => x / sum);
}

async function cleanupTestData(prefix = TAG) {
  const rows = await prisma.booking.findMany({
    where: { userName: { startsWith: prefix } },
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

async function getBase() {
  const row = await prisma.communityResource.findFirst({
    include: { resource: true },
  });
  if (!row) {
    throw new Error(
      'No community_resource rows found. Create at least one resource via /setup.',
    );
  }
  return row;
}

async function pickOpenLookingBooking(base) {
  const now = new Date();
  const b = await prisma.booking.findFirst({
    where: {
      communityResourceId: base.id,
      resourceId: base.resourceId,
      status: { in: [BookingStatus.PENDING, BookingStatus.ACTIVE] },
      isLookingForPlayers: true,
      requiredPlayers: { gt: 0 },
      startTime: { gt: now },
    },
    select: { id: true },
    orderBy: { startTime: 'asc' },
  });
  if (b) {
    return b.id;
  }
  const maxAttempts = 8;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const slotOffsetMinutes = 120 + (attempt - 1) * 30 + randomInt(0, 2) * 30;
    const startTime = plusMinutes(new Date(), slotOffsetMinutes);
    startTime.setSeconds(0, 0);
    const endTime = plusMinutes(startTime, 60);
    try {
      const created = await prisma.booking.create({
        data: {
          communityResourceId: base.id,
          resourceId: base.resourceId,
          sportKindCode: SportKindCode.TENNIS,
          userId: BigInt(970000001),
          userName: `${RUN_TAG}vol_owner`,
          startTime,
          endTime,
          status: BookingStatus.PENDING,
          isLookingForPlayers: true,
          requiredPlayers: 2000,
        },
        select: { id: true },
      });
      return created.id;
    } catch (e) {
      if (!isBusinessConflictError(e) || attempt === maxAttempts) {
        throw e;
      }
      await sleep(randomInt(40, 140));
    }
  }
  throw new Error('Unable to create initial open looking booking.');
}

async function opCreateBooking(base, seq) {
  const slot = Math.floor(Math.random() * 90);
  const startTime = plusMinutes(new Date(), 24 * 60 + slot * 30);
  startTime.setSeconds(0, 0);
  const endTime = plusMinutes(startTime, 60);
  const t0 = Date.now();
  try {
    await prisma.booking.create({
      data: {
        communityResourceId: base.id,
        resourceId: base.resourceId,
        sportKindCode: SportKindCode.TENNIS,
        userId: BigInt(980000000 + (seq % 100000)),
        userName: `${RUN_TAG}create_${seq}`,
        startTime,
        endTime,
        status: BookingStatus.PENDING,
      },
    });
    return { op: 'create', ok: true, ms: Date.now() - t0 };
  } catch (e) {
    return {
      op: 'create',
      ok: false,
      ms: Date.now() - t0,
      err: e instanceof Error ? e.message : String(e),
    };
  }
}

async function opReminderQuery() {
  const now = Date.now();
  const from = new Date(now + 14 * 60 * 1000);
  const to = new Date(now + 16 * 60 * 1000);
  const t0 = Date.now();
  try {
    await prisma.booking.findMany({
      where: {
        status: { in: [BookingStatus.PENDING, BookingStatus.ACTIVE] },
        endTime: { gt: new Date(now) },
        startTime: { gte: from, lte: to },
      },
      select: { id: true },
      take: 500,
    });
    return { op: 'query', ok: true, ms: Date.now() - t0 };
  } catch (e) {
    return {
      op: 'query',
      ok: false,
      ms: Date.now() - t0,
      err: e instanceof Error ? e.message : String(e),
    };
  }
}

async function opVolunteer(bookingId, seq) {
  const t0 = Date.now();
  try {
    await prisma.$transaction(async (tx) => {
      const dec = await tx.booking.updateMany({
        where: {
          id: bookingId,
          status: { in: [BookingStatus.PENDING, BookingStatus.ACTIVE] },
          isLookingForPlayers: true,
          requiredPlayers: { gt: 0 },
        },
        data: {
          requiredPlayers: { decrement: 1 },
        },
      });
      if (dec.count === 0) {
        return;
      }
      const cur = await tx.booking.findUniqueOrThrow({
        where: { id: bookingId },
        select: { requiredPlayers: true },
      });
      if (cur.requiredPlayers <= 0) {
        await tx.booking.update({
          where: { id: bookingId },
          data: { isLookingForPlayers: false },
        });
      }
      await tx.bookingLookingParticipant.upsert({
        where: {
          bookingId_telegramUserId: {
            bookingId,
            telegramUserId: BigInt(990000000 + (seq % 100000)),
          },
        },
        create: {
          bookingId,
          telegramUserId: BigInt(990000000 + (seq % 100000)),
          peopleCount: 1,
        },
        update: { peopleCount: { increment: 1 } },
      });
    });
    return { op: 'volunteer', ok: true, ms: Date.now() - t0 };
  } catch (e) {
    return {
      op: 'volunteer',
      ok: false,
      ms: Date.now() - t0,
      err: e instanceof Error ? e.message : String(e),
    };
  }
}

function chooseOperation(normalizedMix) {
  const x = Math.random();
  if (x < normalizedMix[0]) {
    return 'create';
  }
  if (x < normalizedMix[0] + normalizedMix[1]) {
    return 'query';
  }
  return 'volunteer';
}

async function verifyInvariants() {
  const negative = await prisma.booking.count({
    where: { requiredPlayers: { lt: 0 }, userName: { startsWith: RUN_TAG } },
  });
  const overlaps = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS cnt
    FROM "bookings" b1
    JOIN "bookings" b2
      ON b1."resource_id" = b2."resource_id"
     AND b1."id" < b2."id"
     AND b1."status" IN ('PENDING', 'ACTIVE')
     AND b2."status" IN ('PENDING', 'ACTIVE')
     AND b1."start_time" < b2."end_time"
     AND b1."end_time" > b2."start_time"
     AND b1."user_name" LIKE ${`${RUN_TAG}%`}
     AND b2."user_name" LIKE ${`${RUN_TAG}%`}
  `;
  return {
    negativeRequiredPlayers: negative,
    overlapsPendingActive: Number(overlaps?.[0]?.cnt ?? 0),
  };
}

async function runLoad() {
  const base = await getBase();
  const normalizedMix = parseMix(DEFAULT_MIX);
  const volunteerBookingId = await pickOpenLookingBooking(base);
  const endAt = Date.now() + DEFAULT_SECONDS * 1000;

  const metrics = {
    total: 0,
    errors: 0,
    businessConflicts: 0,
    systemErrors: 0,
    byOp: {
      create: { n: 0, ok: 0, lat: [] },
      query: { n: 0, ok: 0, lat: [] },
      volunteer: { n: 0, ok: 0, lat: [] },
    },
    errorsTop: new Map(),
  };

  let seq = 0;
  async function worker() {
    while (Date.now() < endAt) {
      const op = chooseOperation(normalizedMix);
      let res;
      seq += 1;
      if (op === 'create') {
        res = await opCreateBooking(base, seq);
      } else if (op === 'query') {
        res = await opReminderQuery();
      } else {
        res = await opVolunteer(volunteerBookingId, seq);
      }

      metrics.total += 1;
      metrics.byOp[res.op].n += 1;
      metrics.byOp[res.op].lat.push(res.ms);
      if (res.ok) {
        metrics.byOp[res.op].ok += 1;
      } else {
        metrics.errors += 1;
        const category = classifyError(res.err ?? '');
        if (category === 'business_conflict') {
          metrics.businessConflicts += 1;
        } else {
          metrics.systemErrors += 1;
        }
        const key = res.err ?? 'unknown_error';
        metrics.errorsTop.set(key, (metrics.errorsTop.get(key) ?? 0) + 1);
      }
      await sleep(5);
    }
  }

  await Promise.all(
    Array.from({ length: DEFAULT_CONCURRENCY }, () => worker()),
  );

  const inv = await verifyInvariants();
  const perOp = {};
  for (const [name, data] of Object.entries(metrics.byOp)) {
    perOp[name] = {
      requests: data.n,
      successRate: data.n === 0 ? 1 : Number((data.ok / data.n).toFixed(4)),
      p95Ms: percentile(data.lat, 95),
      p99Ms: percentile(data.lat, 99),
      maxMs: data.lat.length ? Math.max(...data.lat) : 0,
      avgMs: data.lat.length
        ? Math.round(data.lat.reduce((a, b) => a + b, 0) / data.lat.length)
        : 0,
    };
  }
  const sortedErrors = [...metrics.errorsTop.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([message, count]) => ({ message, count }));

  return {
    config: {
      seconds: DEFAULT_SECONDS,
      concurrency: DEFAULT_CONCURRENCY,
      mix: DEFAULT_MIX,
    },
    totals: {
      requests: metrics.total,
      errorRate:
        metrics.total === 0 ? 0 : Number((metrics.errors / metrics.total).toFixed(4)),
      businessConflictRate:
        metrics.total === 0
          ? 0
          : Number((metrics.businessConflicts / metrics.total).toFixed(4)),
      systemErrorRate:
        metrics.total === 0
          ? 0
          : Number((metrics.systemErrors / metrics.total).toFixed(4)),
    },
    perOperation: perOp,
    topErrors: sortedErrors,
    invariants: inv,
    slo: {
      noNegativeRequiredPlayers: inv.negativeRequiredPlayers === 0,
      noActivePendingOverlaps: inv.overlapsPendingActive === 0,
      systemErrorRateBelowThreshold:
        metrics.total === 0
          ? true
          : metrics.systemErrors / metrics.total < SLO_SYSTEM_ERROR_RATE_MAX,
      queryP95BelowThreshold:
        (perOp.query?.p95Ms ?? 0) <= SLO_QUERY_P95_MAX_MS,
      volunteerP95BelowThreshold:
        (perOp.volunteer?.p95Ms ?? 0) <= SLO_VOLUNTEER_P95_MAX_MS,
    },
  };
}

async function main() {
  await cleanupTestData();
  const result = await runLoad();
  await cleanupTestData();
  console.log('DB load test finished.');
  console.log(JSON.stringify(result, null, 2));
  if (
    !result.slo.noNegativeRequiredPlayers ||
    !result.slo.noActivePendingOverlaps ||
    !result.slo.systemErrorRateBelowThreshold ||
    !result.slo.queryP95BelowThreshold ||
    !result.slo.volunteerP95BelowThreshold
  ) {
    process.exitCode = 1;
  }
}

main()
  .catch(async (e) => {
    console.error('DB load test failed:', e instanceof Error ? e.message : String(e));
    await cleanupTestData().catch(() => undefined);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
