-- Unique column name for the sport type code: sport_kind_code

-- Remove the foreign keys that reference `sport_kinds.code`
ALTER TABLE "resources" DROP CONSTRAINT IF EXISTS "resources_type_fkey";
ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "bookings_sport_type_fkey";

-- Reference: code → sport_kind_code
ALTER TABLE "sport_kinds" RENAME COLUMN "code" TO "sport_kind_code";

-- Resources: type → sport_kind_code
ALTER TABLE "resources" RENAME COLUMN "type" TO "sport_kind_code";

-- Bookings: sport_type → sport_kind_code
ALTER TABLE "bookings" RENAME COLUMN "sport_type" TO "sport_kind_code";

-- FK for the reference guide
ALTER TABLE "resources" ADD CONSTRAINT "resources_sport_kind_code_fkey" FOREIGN KEY ("sport_kind_code") REFERENCES "sport_kinds"("sport_kind_code") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "bookings" ADD CONSTRAINT "bookings_sport_kind_code_fkey" FOREIGN KEY ("sport_kind_code") REFERENCES "sport_kinds"("sport_kind_code") ON DELETE RESTRICT ON UPDATE CASCADE;
