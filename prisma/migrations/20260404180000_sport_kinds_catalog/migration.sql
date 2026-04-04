-- CreateTable
CREATE TABLE "sport_kinds" (
    "code" "SportType" NOT NULL,
    "name_ru" TEXT NOT NULL,
    CONSTRAINT "sport_kinds_pkey" PRIMARY KEY ("code")
);

-- Записи справочника: теннис, футбол, баскетбол
INSERT INTO "sport_kinds" ("code", "name_ru") VALUES
    ('TENNIS', 'Теннис'),
    ('FOOTBALL', 'Футбол'),
    ('BASKETBALL', 'Баскетбол');

-- AddForeignKey
ALTER TABLE "resources" ADD CONSTRAINT "resources_type_fkey" FOREIGN KEY ("type") REFERENCES "sport_kinds"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_sport_type_fkey" FOREIGN KEY ("sport_type") REFERENCES "sport_kinds"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
