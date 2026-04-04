-- AlterTable
ALTER TABLE "bookings" ADD COLUMN "sport_type" "SportType";

UPDATE "bookings" AS b
SET "sport_type" = r.type
FROM "resources" AS r
WHERE r.id = b.resource_id;

ALTER TABLE "bookings" ALTER COLUMN "sport_type" SET NOT NULL;
