-- AlterTable
ALTER TABLE "telegram_users" ADD COLUMN "default_language_id" TEXT;

-- CreateIndex
CREATE INDEX "telegram_users_default_language_id_idx" ON "telegram_users"("default_language_id");

-- AddForeignKey
ALTER TABLE "telegram_users" ADD CONSTRAINT "telegram_users_default_language_id_fkey" FOREIGN KEY ("default_language_id") REFERENCES "languages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
