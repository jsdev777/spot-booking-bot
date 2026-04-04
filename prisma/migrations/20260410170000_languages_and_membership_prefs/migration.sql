-- CreateTable
CREATE TABLE "languages" (
    "id" TEXT NOT NULL,
    "name_native" TEXT NOT NULL,

    CONSTRAINT "languages_pkey" PRIMARY KEY ("id")
);

-- Стартовая запись для дальнейшего i18n (можно добавлять en, uk, …)
INSERT INTO "languages" ("id", "name_native") VALUES ('ru', 'Русский');

-- AlterTable
ALTER TABLE "group_chat_memberships" ADD COLUMN "language_id" TEXT;
ALTER TABLE "group_chat_memberships" ADD COLUMN "group_rules_accepted_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "group_chat_memberships_language_id_idx" ON "group_chat_memberships"("language_id");

-- AddForeignKey
ALTER TABLE "group_chat_memberships" ADD CONSTRAINT "group_chat_memberships_language_id_fkey" FOREIGN KEY ("language_id") REFERENCES "languages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
