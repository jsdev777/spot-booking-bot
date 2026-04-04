-- The sport type is stored only with the armor, not with the map object
ALTER TABLE "resources" DROP CONSTRAINT IF EXISTS "resources_sport_kind_code_fkey";
ALTER TABLE "resources" DROP COLUMN IF EXISTS "sport_kind_code";
