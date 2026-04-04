-- Расписание по дням недели: 7 строк на ресурс; колонки slot_* с resources убираем.

CREATE TABLE "resource_working_hours" (
    "id" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "is_closed" BOOLEAN NOT NULL DEFAULT false,
    "slot_start_hour" INTEGER,
    "slot_end_hour" INTEGER,

    CONSTRAINT "resource_working_hours_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "resource_working_hours_resource_id_weekday_key" ON "resource_working_hours"("resource_id", "weekday");
CREATE INDEX "resource_working_hours_resource_id_idx" ON "resource_working_hours"("resource_id");

ALTER TABLE "resource_working_hours" ADD CONSTRAINT "resource_working_hours_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "resources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "resource_working_hours" ("id", "resource_id", "weekday", "is_closed", "slot_start_hour", "slot_end_hour")
SELECT gen_random_uuid()::text, r."id", d.wd, false, r."slot_start_hour", r."slot_end_hour"
FROM "resources" AS r
CROSS JOIN (VALUES (1), (2), (3), (4), (5), (6), (7)) AS d(wd);

ALTER TABLE "resources" DROP COLUMN "slot_start_hour";
ALTER TABLE "resources" DROP COLUMN "slot_end_hour";
