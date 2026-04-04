-- CreateTable
CREATE TABLE "sport_kinds" (
    "code" "SportType" NOT NULL,
    "name_ua" TEXT NOT NULL,
    CONSTRAINT "sport_kinds_pkey" PRIMARY KEY ("code")
);

-- Directory entries: tennis, soccer, basketball
INSERT INTO "sport_kinds" ("code", "name_ua") VALUES
    ('TENNIS', 'Теніс'),
    ('FOOTBALL', 'Футбол'),
    ('BASKETBALL', 'Баскетбол');

-- AddForeignKey
ALTER TABLE "resources" ADD CONSTRAINT "resources_type_fkey" FOREIGN KEY ("type") REFERENCES "sport_kinds"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_sport_type_fkey" FOREIGN KEY ("sport_type") REFERENCES "sport_kinds"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
