-- CreateTable
CREATE TABLE "community_telegram_users" (
    "id" TEXT NOT NULL,
    "community_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMP(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "community_telegram_users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "community_telegram_users_community_id_user_id_key" ON "community_telegram_users"("community_id", "user_id");

-- CreateIndex
CREATE INDEX "community_telegram_users_community_id_idx" ON "community_telegram_users"("community_id");

-- CreateIndex
CREATE INDEX "community_telegram_users_user_id_idx" ON "community_telegram_users"("user_id");

-- CreateIndex
CREATE INDEX "community_telegram_users_is_active_idx" ON "community_telegram_users"("is_active");

-- AddForeignKey
ALTER TABLE "community_telegram_users" ADD CONSTRAINT "community_telegram_users_community_id_fkey" FOREIGN KEY ("community_id") REFERENCES "communities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_telegram_users" ADD CONSTRAINT "community_telegram_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "telegram_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill using existing group memberships linked to the community
INSERT INTO "community_telegram_users" ("id", "community_id", "user_id", "joined_at", "left_at", "is_active")
SELECT gen_random_uuid()::text, gm."community_id", gm."user_id", gm."joined_at", gm."left_at", gm."is_active"
FROM "group_chat_memberships" gm
WHERE gm."community_id" IS NOT NULL
ON CONFLICT ("community_id", "user_id") DO NOTHING;
