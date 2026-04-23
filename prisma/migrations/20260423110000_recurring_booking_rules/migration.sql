CREATE TABLE "recurring_booking_rules" (
    "id" TEXT NOT NULL,
    "community_resource_id" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "sport_kind_code" "SportType" NOT NULL,
    "weekday" INTEGER NOT NULL,
    "start_minute_of_day" INTEGER NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "end_date" DATE NOT NULL,
    "created_by_telegram_user_id" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "recurring_booking_rules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "recurring_booking_rules_weekday_check" CHECK ("weekday" BETWEEN 1 AND 7),
    CONSTRAINT "recurring_booking_rules_start_minute_of_day_check" CHECK ("start_minute_of_day" BETWEEN 0 AND 1439),
    CONSTRAINT "recurring_booking_rules_duration_minutes_check" CHECK ("duration_minutes" IN (60, 90, 120))
);

CREATE UNIQUE INDEX "recurring_booking_rules_unique_slot"
ON "recurring_booking_rules"(
    "community_resource_id",
    "weekday",
    "start_minute_of_day",
    "duration_minutes",
    "end_date"
);

CREATE INDEX "recurring_booking_rules_resource_id_weekday_idx"
ON "recurring_booking_rules"("resource_id", "weekday");

CREATE INDEX "recurring_booking_rules_community_resource_id_idx"
ON "recurring_booking_rules"("community_resource_id");

CREATE INDEX "recurring_booking_rules_end_date_idx"
ON "recurring_booking_rules"("end_date");

ALTER TABLE "recurring_booking_rules"
ADD CONSTRAINT "recurring_booking_rules_community_resource_id_fkey"
FOREIGN KEY ("community_resource_id") REFERENCES "community_resources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "recurring_booking_rules"
ADD CONSTRAINT "recurring_booking_rules_resource_id_fkey"
FOREIGN KEY ("resource_id") REFERENCES "resources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "recurring_booking_rules"
ADD CONSTRAINT "recurring_booking_rules_sport_kind_code_fkey"
FOREIGN KEY ("sport_kind_code") REFERENCES "sport_kinds"("sport_kind_code") ON DELETE RESTRICT ON UPDATE CASCADE;
