-- Drop old schema (dev migration; existing data will be lost)
DROP INDEX IF EXISTS "bookings_chat_id_start_time_active_unique";
DROP TABLE IF EXISTS "bookings";
DROP TABLE IF EXISTS "users";

-- CreateEnum
CREATE TYPE "SportType" AS ENUM ('TENNIS', 'FOOTBALL', 'BASKETBALL');

-- CreateTable
CREATE TABLE "communities" (
    "id" TEXT NOT NULL,
    "telegram_chat_id" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "time_zone" TEXT NOT NULL,
    "slot_start_hour" INTEGER NOT NULL,
    "slot_end_hour" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "communities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resources" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "SportType" NOT NULL,
    "community_id" TEXT NOT NULL,

    CONSTRAINT "resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookings" (
    "id" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "user_id" BIGINT NOT NULL,
    "user_name" TEXT,
    "start_time" TIMESTAMP(3) NOT NULL,
    "end_time" TIMESTAMP(3) NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'ACTIVE',
    "reminder_sent" BOOLEAN NOT NULL DEFAULT false,
    "is_looking_for_players" BOOLEAN NOT NULL DEFAULT false,
    "required_players" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "communities_telegram_chat_id_key" ON "communities"("telegram_chat_id");

-- CreateIndex
CREATE INDEX "resources_community_id_idx" ON "resources"("community_id");

-- CreateIndex
CREATE INDEX "bookings_resource_id_status_idx" ON "bookings"("resource_id", "status");

-- AddForeignKey
ALTER TABLE "resources" ADD CONSTRAINT "resources_community_id_fkey" FOREIGN KEY ("community_id") REFERENCES "communities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "resources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One ACTIVE booking per resource and slot start
CREATE UNIQUE INDEX "bookings_resource_id_start_time_active_unique" ON "bookings" ("resource_id", "start_time") WHERE "status" = 'ACTIVE';
