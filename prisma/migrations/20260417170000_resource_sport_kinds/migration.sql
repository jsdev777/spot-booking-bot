CREATE TABLE "resource_sport_kinds" (
    "resource_id" TEXT NOT NULL,
    "sport_kind_code" "SportType" NOT NULL,
    CONSTRAINT "resource_sport_kinds_pkey" PRIMARY KEY ("resource_id","sport_kind_code")
);

CREATE INDEX "resource_sport_kinds_sport_kind_code_idx" ON "resource_sport_kinds"("sport_kind_code");

ALTER TABLE "resource_sport_kinds"
ADD CONSTRAINT "resource_sport_kinds_resource_id_fkey"
FOREIGN KEY ("resource_id") REFERENCES "resources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "resource_sport_kinds"
ADD CONSTRAINT "resource_sport_kinds_sport_kind_code_fkey"
FOREIGN KEY ("sport_kind_code") REFERENCES "sport_kinds"("sport_kind_code") ON DELETE RESTRICT ON UPDATE CASCADE;
