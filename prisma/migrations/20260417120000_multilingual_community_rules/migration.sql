-- Add English to the language catalog (Ukrainian was seeded in a prior migration).
INSERT INTO "languages" ("id", "name_native")
VALUES ('en', 'English')
ON CONFLICT ("id") DO NOTHING;

-- Add language dimension to community rules (one row per community + language).
ALTER TABLE "community_rules" ADD COLUMN "language_id" TEXT;

UPDATE "community_rules" SET "language_id" = 'ua' WHERE "language_id" IS NULL;

ALTER TABLE "community_rules" ALTER COLUMN "language_id" SET NOT NULL;

ALTER TABLE "community_rules" DROP CONSTRAINT "community_rules_pkey";

ALTER TABLE "community_rules" ADD CONSTRAINT "community_rules_pkey" PRIMARY KEY ("community_id", "language_id");

ALTER TABLE "community_rules" ADD CONSTRAINT "community_rules_language_id_fkey" FOREIGN KEY ("language_id") REFERENCES "languages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
