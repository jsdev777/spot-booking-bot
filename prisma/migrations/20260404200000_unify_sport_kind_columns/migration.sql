-- Единое имя колонки кода вида спорта: sport_kind_code

-- Убираем FK, ссылающиеся на sport_kinds.code
ALTER TABLE "resources" DROP CONSTRAINT IF EXISTS "resources_type_fkey";
ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "bookings_sport_type_fkey";

-- Справочник: code → sport_kind_code
ALTER TABLE "sport_kinds" RENAME COLUMN "code" TO "sport_kind_code";

-- Ресурсы: type → sport_kind_code
ALTER TABLE "resources" RENAME COLUMN "type" TO "sport_kind_code";

-- Брони: sport_type → sport_kind_code
ALTER TABLE "bookings" RENAME COLUMN "sport_type" TO "sport_kind_code";

-- FK на справочник
ALTER TABLE "resources" ADD CONSTRAINT "resources_sport_kind_code_fkey" FOREIGN KEY ("sport_kind_code") REFERENCES "sport_kinds"("sport_kind_code") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "bookings" ADD CONSTRAINT "bookings_sport_kind_code_fkey" FOREIGN KEY ("sport_kind_code") REFERENCES "sport_kinds"("sport_kind_code") ON DELETE RESTRICT ON UPDATE CASCADE;
