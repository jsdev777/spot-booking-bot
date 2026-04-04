-- Перенос часового пояса, часов работы и адреса с сообщества на каждую площадку (resource).

ALTER TABLE "resources" ADD COLUMN "address" TEXT;
ALTER TABLE "resources" ADD COLUMN "time_zone" TEXT;
ALTER TABLE "resources" ADD COLUMN "slot_start_hour" INTEGER;
ALTER TABLE "resources" ADD COLUMN "slot_end_hour" INTEGER;

UPDATE "resources" AS r
SET
  address = c.address,
  time_zone = c.time_zone,
  slot_start_hour = c.slot_start_hour,
  slot_end_hour = c.slot_end_hour
FROM "communities" AS c
WHERE r.community_id = c.id;

UPDATE "resources" SET time_zone = 'UTC' WHERE time_zone IS NULL;
UPDATE "resources" SET slot_start_hour = 9 WHERE slot_start_hour IS NULL;
UPDATE "resources" SET slot_end_hour = 21 WHERE slot_end_hour IS NULL;

ALTER TABLE "resources" ALTER COLUMN "time_zone" SET NOT NULL;
ALTER TABLE "resources" ALTER COLUMN "slot_start_hour" SET NOT NULL;
ALTER TABLE "resources" ALTER COLUMN "slot_end_hour" SET NOT NULL;

ALTER TABLE "communities" DROP COLUMN "address";
ALTER TABLE "communities" DROP COLUMN "time_zone";
ALTER TABLE "communities" DROP COLUMN "slot_start_hour";
ALTER TABLE "communities" DROP COLUMN "slot_end_hour";
