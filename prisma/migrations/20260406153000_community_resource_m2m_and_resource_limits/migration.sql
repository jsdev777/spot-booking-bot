CREATE TABLE "community_resources" (
    "id" TEXT NOT NULL,
    "community_id" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,

    CONSTRAINT "community_resources_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "community_resources_community_id_resource_id_key"
ON "community_resources"("community_id", "resource_id");

CREATE INDEX "community_resources_community_id_idx"
ON "community_resources"("community_id");

CREATE INDEX "community_resources_resource_id_idx"
ON "community_resources"("resource_id");

ALTER TABLE "community_resources"
ADD CONSTRAINT "community_resources_community_id_fkey"
FOREIGN KEY ("community_id") REFERENCES "communities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "community_resources"
ADD CONSTRAINT "community_resources_resource_id_fkey"
FOREIGN KEY ("resource_id") REFERENCES "resources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "community_resources" ("id", "community_id", "resource_id")
SELECT gen_random_uuid()::text, r."community_id", r."id"
FROM "resources" r
WHERE r."community_id" IS NOT NULL;

CREATE TABLE "community_resource_user_booking_limits" (
    "id" TEXT NOT NULL,
    "community_resource_id" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "max_minutes" INTEGER,

    CONSTRAINT "community_resource_user_booking_limits_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "community_resource_user_booking_limits_crid_weekday_key"
ON "community_resource_user_booking_limits"("community_resource_id", "weekday");

CREATE INDEX "community_resource_user_booking_limits_community_resource_id_idx"
ON "community_resource_user_booking_limits"("community_resource_id");

ALTER TABLE "community_resource_user_booking_limits"
ADD CONSTRAINT "community_resource_user_booking_limits_community_resource_id_fkey"
FOREIGN KEY ("community_resource_id") REFERENCES "community_resources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "community_resource_user_booking_limits" ("id", "community_resource_id", "weekday", "max_minutes")
SELECT gen_random_uuid()::text, cr."id", cubl."weekday", cubl."max_minutes"
FROM "community_resources" cr
JOIN "community_user_booking_limits" cubl ON cubl."community_id" = cr."community_id";

ALTER TABLE "bookings"
ADD COLUMN "community_resource_id" TEXT;

UPDATE "bookings" b
SET "community_resource_id" = cr."id"
FROM "resources" r
JOIN "community_resources" cr
  ON cr."resource_id" = r."id"
 AND cr."community_id" = r."community_id"
WHERE b."resource_id" = r."id"
  AND b."community_resource_id" IS NULL;

ALTER TABLE "bookings"
ALTER COLUMN "community_resource_id" SET NOT NULL;

ALTER TABLE "bookings"
ADD CONSTRAINT "bookings_community_resource_id_fkey"
FOREIGN KEY ("community_resource_id") REFERENCES "community_resources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "bookings_community_resource_id_status_idx"
ON "bookings"("community_resource_id", "status");

DROP INDEX IF EXISTS "resources_community_id_idx";
ALTER TABLE "resources" DROP COLUMN "community_id";
