# Spot Booking Bot

**A Telegram bot for group-based sports venue booking.** Members book slots in their community context; admins configure venues, opening hours, booking windows, and limits. Built with **NestJS**, **PostgreSQL** + **Prisma**, and **Telegraf** (`nestjs-telegraf`).

The project covers a full product loop: a real booking model with time zones, background jobs (booking lifecycle, reminders), and CI/CD with Docker deployment on a VPS.

**Live bot:** [@SpotBookingBot](https://t.me/SpotBookingBot)

**Languages:** **English** and **Ukrainian** — UI strings, menus, and reminders follow each user’s effective language (per community, with a personal default).

---

## Why this bot stands out

- **Private-first UX** — almost all interactions happen in **DM with the bot**, so the group chat stays clean while admins still use `/setup` when needed.
- **Fair shared calendar** — the same physical venue can be **linked to several Telegram groups**; occupancy is enforced at **`resource` level**, so cross-community double-booking is blocked. **Booking window, per-user limits, and venue visibility** stay **per community** (`Resource` + `CommunityResource`).
- **Partner matching** — organizers can mark “looking for players”; others join via **Open spots**, with headcount from each participant’s side.
- **Clear accountability** — when someone joins an open spot, **both sides get a private summary** with **tap-to-open Telegram links** to the organizer and the joiner (plus the usual time, place, and sport details).
- **Smarter day grid** — from **Day schedule**, users can tap **Book**; if they already opened **Today** or **Tomorrow**, the bot **skips asking for the day again** and jumps to time (or sport, if the venue has multiple).
- **Bilingual UI** — **English** and **Ukrainian** with per-user language preference (community membership or personal default).

---

## What it does

### Group members

- **Multilingual UI** — **English** or **Ukrainian**; language can be chosen per community and/or as the user’s default, so mixed-language groups still get the right copy in DM.
- **Guided booking** — sport (**tennis, football, basketball, volleyball**), venue, day (today / tomorrow), start time (:00 / :30 grid), duration (1, 1.5, or 2 hours).
- **Looking for partners** — optional flag and “spots needed”; others join through **Open spots** (each tap can represent multiple people on their side).
- **Open spots DMs** — roster confirmation with venue, address (or hint to ask in the group), window, sport, and **organizer contact link**; the **organizer** gets a matching DM with a **link to the joiner**.
- **My bookings** — list and cancel active reservations.
- **Day schedule** — occupancy grid for the selected venue; **Book** on the same keyboard; **day is inferred** when the grid for today/tomorrow is already open.
- **Community rules** — mandatory acceptance of admin-defined rules before the booking menu (DM or group flow).
- **Reminders ~15 minutes before start** — to the organizer and to participants who joined via open spots (users must have started the bot in DM).

### Group admins

- **`/setup` and “Settings”** — a wizard in **private messages** (keeps noise out of the group).
- **Multiple venues per community** — name, address, time zone, **opening hours per weekday**, visibility (active vs hidden for regular members).
- **Booking window** — local-time range when members may create bookings; **group admins book outside the window**.
- **Per-user booking limits**:
  - at **community** level (by weekday);
  - at **community + venue** level — different caps per linked venue.
- **Rules text** — set and update for the group.

### Technical highlights

- **One calendar across communities** — overlap checks use **`resourceId`**, so all linked groups see the same availability.
- **Membership sync** via Telegram **`chat_member`**, user ↔ community link, and rules acceptance tracking.
- **Booking lifecycle** (pending → active → completed / cancelled) driven by schedules and DB constraints.
- **Overlap logic, slots, and booking window** live in focused modules with **unit tests**.
- **`GET /health`** for deploy checks and monitoring.

---

## Stack

| Area | Technologies |
|------|----------------|
| Runtime | Node.js 20+ |
| Framework | NestJS 11, `@nestjs/config`, `@nestjs/schedule` |
| Database | PostgreSQL 16, Prisma 7 (`@prisma/adapter-pg`) |
| Telegram | Telegraf 4, `nestjs-telegraf` |
| Time & TZ | `date-fns`, `date-fns-tz` |
| i18n | `nestjs-i18n` (`en`, `ua` bot strings) |
| Tooling | ESLint 9, Prettier, TypeScript 5 |
| Tests | Jest 30 (unit; e2e with Supertest, `test/jest-e2e.json`) |
| Containers | Docker (multi-stage), Docker Compose for local DB |

---

## Quality & delivery

- **CI (GitHub Actions)** on `main` and PRs: `npm ci`, `prisma generate`, ESLint, **unit tests** (`npm run test`), build; optional Codecov upload. E2E (`npm run test:e2e`) is available for local and release checks.
- **CD** after green CI: image build, deploy to **VPS (Hetzner)** via SSH/SCP, deploy script with **`prisma migrate deploy`**, container start, **`/health`** check.
- Secrets (SSH, `DATABASE_URL`, `BOT_TOKEN`) live in CI/CD and on the server — **not** in the repo.

---

## Requirements

- Node.js 20+
- PostgreSQL
- Docker / Docker Compose (optional)
- Bot token from [@BotFather](https://t.me/BotFather)

---

## Quick start

```bash
git clone <repository-url>
cd spot-booking-bot
npm install
cp .env.example .env
# Set DATABASE_URL, BOT_TOKEN, PORT
npm run prisma:migrate
npm run start:dev
```

**Production:** `npm run build` → `npm run start:prod`.

---

## Tests & load scripts

```bash
npm run test
npm run test:e2e
npm run test:cov
npm run smoke:load
npm run load:db
```

`load:db` can be tuned via env:

```bash
LOAD_SECONDS=300 LOAD_CONCURRENCY=80 LOAD_MIX=50,30,20 npm run load:db
```

Example thresholds (failure if violated):

- `system_error_rate < 1%`
- `query p95 < 120ms`
- `volunteer p95 < 120ms`
- `noNegativeRequiredPlayers = true`
- `noActivePendingOverlaps = true` (for the test rows in the current run)

---

## Prometheus & Grafana

- Metrics: **`GET /metrics`**
- Includes standard runtime metrics plus booking / reminder counters.
- Repo assets:
  - `monitoring/prometheus/prometheus.yml`
  - `monitoring/prometheus/alerts.yml`
  - `monitoring/grafana/spot-booking-dashboard.json`
  - `monitoring/grafana/provisioning/*`

Example scrape config:

```yaml
scrape_configs:
  - job_name: spot-booking-bot
    metrics_path: /metrics
    static_configs:
      - targets: ['<host>:3000']
```

Quick local Prometheus + Grafana:

```bash
docker compose -f docker-compose.yml -f docker-compose.monitoring.yml up -d
```

Then:

- Prometheus: `http://localhost:9090`
- Grafana: `http://localhost:3001` (default login `admin` / `admin`)
- Dashboard is provisioned under **SpotBooking**.

---

## Docker

Local app + PostgreSQL:

```bash
docker-compose up -d
```

Production image: multi-stage build, non-root user in the container, entrypoint waits for PostgreSQL and applies migrations before starting the app.

Pass **`DATABASE_URL`** and **`BOT_TOKEN`** via your orchestrator’s environment — **do not** bake secrets into the image.

---

## CI/CD (secrets)

GitHub Actions secrets typically include: SSH to the server (host, user, private key), `DATABASE_URL`, `BOT_TOKEN`, `DEPLOY_PATH`, and optionally `SSH_PORT` and `PORT`. Exact values are not duplicated in this README.

---

## Links

- [NestJS](https://docs.nestjs.com)
- [Prisma](https://www.prisma.io/docs)
- [Telegraf](https://telegraf.js.org/)
