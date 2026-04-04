CREATE TABLE "telegram_users" (
    "id" TEXT NOT NULL,
    "telegram_user_id" BIGINT NOT NULL,
    "username" TEXT,
    "first_name" TEXT,
    "last_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_users_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "telegram_users_telegram_user_id_key" ON "telegram_users"("telegram_user_id");

CREATE TABLE "group_chat_memberships" (
    "id" TEXT NOT NULL,
    "telegram_chat_id" BIGINT NOT NULL,
    "user_id" TEXT NOT NULL,
    "community_id" TEXT,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMP(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "group_chat_memberships_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "group_chat_memberships_telegram_chat_id_user_id_key" ON "group_chat_memberships"("telegram_chat_id", "user_id");

CREATE INDEX "group_chat_memberships_telegram_chat_id_idx" ON "group_chat_memberships"("telegram_chat_id");

CREATE INDEX "group_chat_memberships_community_id_idx" ON "group_chat_memberships"("community_id");

CREATE INDEX "group_chat_memberships_is_active_idx" ON "group_chat_memberships"("is_active");

ALTER TABLE "group_chat_memberships" ADD CONSTRAINT "group_chat_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "telegram_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "group_chat_memberships" ADD CONSTRAINT "group_chat_memberships_community_id_fkey" FOREIGN KEY ("community_id") REFERENCES "communities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
