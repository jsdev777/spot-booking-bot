-- Вид спорта хранится только у брони, не у объекта площадки
ALTER TABLE "resources" DROP CONSTRAINT IF EXISTS "resources_sport_kind_code_fkey";
ALTER TABLE "resources" DROP COLUMN IF EXISTS "sport_kind_code";
