-- CreateEnum
CREATE TYPE "resource_visibility" AS ENUM ('ACTIVE', 'INACTIVE');

-- AlterTable
ALTER TABLE "resources" ADD COLUMN "visibility" "resource_visibility" NOT NULL DEFAULT 'ACTIVE';
