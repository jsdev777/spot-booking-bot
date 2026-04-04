-- PENDING (scheduled) → ACTIVE (in progress) → FINISHED (ended); CANCELLED unchanged.
ALTER TYPE "BookingStatus" ADD VALUE 'PENDING';
ALTER TYPE "BookingStatus" ADD VALUE 'FINISHED';

-- Map legacy ACTIVE rows by time (before new semantics).
UPDATE "bookings"
SET "status" = CASE
  WHEN "end_time" <= NOW() THEN 'FINISHED'::"BookingStatus"
  WHEN "start_time" <= NOW() AND "end_time" > NOW() THEN 'ACTIVE'::"BookingStatus"
  ELSE 'PENDING'::"BookingStatus"
END
WHERE "status" = 'ACTIVE'::"BookingStatus";

ALTER TABLE "bookings" ALTER COLUMN "status" SET DEFAULT 'PENDING';

DROP INDEX IF EXISTS "bookings_resource_id_start_time_active_unique";

CREATE UNIQUE INDEX "bookings_resource_id_start_time_pending_active_unique"
  ON "bookings" ("resource_id", "start_time")
  WHERE "status" IN ('PENDING'::"BookingStatus", 'ACTIVE'::"BookingStatus");
