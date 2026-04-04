CREATE TABLE "community_user_booking_limits" (
    "id" TEXT NOT NULL,
    "community_id" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "max_minutes" INTEGER,

    CONSTRAINT "community_user_booking_limits_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "community_user_booking_limits_community_id_weekday_key" ON "community_user_booking_limits"("community_id", "weekday");

CREATE INDEX "community_user_booking_limits_community_id_idx" ON "community_user_booking_limits"("community_id");

ALTER TABLE "community_user_booking_limits" ADD CONSTRAINT "community_user_booking_limits_community_id_fkey" FOREIGN KEY ("community_id") REFERENCES "communities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "community_user_booking_limits" ("id", "community_id", "weekday", "max_minutes")
SELECT gen_random_uuid()::text, c.id, d.wd, NULL
FROM "communities" c
CROSS JOIN (VALUES (1), (2), (3), (4), (5), (6), (7)) AS d(wd);
