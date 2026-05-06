CREATE TYPE "community_name_source" AS ENUM ('AUTO', 'MANUAL');

ALTER TABLE "communities"
ADD COLUMN "name_source" "community_name_source" NOT NULL DEFAULT 'AUTO';
